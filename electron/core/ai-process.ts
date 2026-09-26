import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AIConnection } from '../../src/shared/ai';

export const codexConfig = {
  model_provider: 'openai',
  web_search: 'disabled',
  mcp_servers: {},
  project_doc_max_bytes: 0,
  features: {
    shell_tool: false,
    unified_exec: false,
    view_image: false,
    apps: false,
    plugins: false,
    hooks: false,
    multi_agent: false,
    browser_use: false,
    browser_use_external: false,
    computer_use: false,
    code_mode: false,
    code_mode_host: false,
    skill_search: false,
    image_generation: false,
    workspace_dependencies: false,
    sleep_tool: false,
  },
};
// Disable host customizations before app-server starts. MCP tables are merged by
// Codex, so isolatedConfig also explicitly disables every inherited server.
const codexOverrides = [
  'mcp_servers={}',
  'model_provider="openai"',
  'web_search="disabled"',
  'project_doc_max_bytes=0',
  ...Object.keys(codexConfig.features).map((feature) => `features.${feature}=false`),
];

export function childEnvironment(): NodeJS.ProcessEnv {
  // Subscription commands must never silently pick up a host API key or cloud credentials.
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'SystemRoot',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ])
    if (process.env[name]) environment[name] = process.env[name];
  environment.HOME ??= homedir();
  environment.PATH = [
    ...new Set([
      path.join(homedir(), '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      ...(environment.PATH ?? '').split(path.delimiter),
    ]),
  ].join(path.delimiter);
  return environment;
}

export async function findProgram(profile: AIConnection): Promise<string> {
  const name = profile.kind === 'codex' ? 'codex' : 'claude';
  const candidates = profile.executable
    ? [profile.executable]
    : (childEnvironment().PATH ?? '')
        .split(path.delimiter)
        .flatMap((directory) =>
          process.platform === 'win32'
            ? [path.join(directory, name + '.exe'), path.join(directory, name + '.cmd')]
            : [path.join(directory, name)],
        );
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next location */
    }
  }
  throw new Error('The local AI app was not found. Install it or choose its location in Settings.');
}

export function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1500);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

export async function runProgram(
  program: string,
  args: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    input?: string;
    timeoutMs?: number;
    allowedExitCodes?: number[];
    onOutput?: (text: string) => void;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: childEnvironment(),
      stdio: 'pipe',
      windowsHide: true,
    });
    let stdout = '',
      size = 0,
      failure: Error | undefined;
    const abort = () => {
      failure = new Error('Request cancelled.');
      stopProcess(child);
    };
    const timer = setTimeout(() => {
      failure = new Error('The AI request timed out. Try again or check Settings.');
      stopProcess(child);
    }, options.timeoutMs ?? 180_000);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
    };
    const output = (chunk: Buffer, keep: boolean) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        failure = new Error('The AI app returned too much data.');
        stopProcess(child);
        return;
      }
      if (keep) stdout += chunk.toString();
      options.onOutput?.(chunk.toString());
    };
    child.stdout.on('data', (chunk) => output(chunk, true));
    child.stderr.on('data', (chunk) => output(chunk, false));
    child.stdin.on('error', () => {});
    child.once('error', () => {
      cleanup();
      reject(new Error('The local AI app could not start. Check its location in Settings.'));
    });
    child.once('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (!(options.allowedExitCodes ?? [0]).includes(code ?? -1))
        reject(
          new Error(
            'The local AI app stopped with an error. Check sign-in and the model in Settings.',
          ),
        );
      else resolve(stdout);
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdin.end(options.input ?? '');
  });
}

type Pending = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export class CodexRPC {
  private exited: Promise<void>;
  private child: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: any) => void>();
  private closed = false;
  private buffer = '';
  private abort: () => void;
  constructor(
    program: string,
    readonly cwd: string,
    private signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.child = spawn(
      program,
      ['app-server', '--listen', 'stdio://', ...codexOverrides.flatMap((value) => ['-c', value])],
      {
        cwd,
        env: childEnvironment(),
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    this.exited = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.abort = () => this.close(new Error('Request cancelled.'));
    signal.addEventListener('abort', this.abort, { once: true });
    this.child.stdin.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.resume();
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.close(new Error('The local AI app returned too much data.'));
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.close(new Error('The local AI app returned an invalid response.'));
        }
      }
    });
    this.child.once('error', () =>
      this.close(new Error('The local AI app could not start. Check its location in Settings.')),
    );
    this.child.once('close', () =>
      this.close(new Error('The local AI app disconnected. Try again.')),
    );
  }
  private receive(message: any) {
    if (message.method) {
      if (message.id !== undefined) {
        // Folio supplies source and images directly. No host tool execution or approvals.
        this.child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Host tools are unavailable in Folio.' },
          }) + '\n',
        );
      } else for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new Error(
          'The local AI app rejected this request. Check its version and connection in Settings.',
        ),
      );
    else pending.resolve(message.result);
  }
  listen(listener: (method: string, params: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('The local AI app is disconnected.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The local AI app did not respond in time.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string, params?: unknown) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'folio', title: 'Folio Resume Studio', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.notify('initialized');
  }
  async isolatedConfig() {
    const configured = await this.request('config/read', { cwd: this.cwd, includeLayers: false });
    if (!configured?.config || typeof configured.config !== 'object')
      throw new Error(
        'The local AI app could not confirm an isolated configuration. Update it and try again.',
      );
    const servers = configured.config.mcp_servers ?? {};
    return {
      ...codexConfig,
      mcp_servers: Object.fromEntries(
        Object.keys(servers).map((name) => [name, { enabled: false }]),
      ),
    };
  }
  async assertToolsDisabled(threadId: string) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const status = await this.request('mcpServerStatus/list', { threadId, limit: 100, cursor });
      if (
        !Array.isArray(status.data) ||
        status.data.some(
          (server: any) =>
            server.runtimeStatus !== 'disabled' || Object.keys(server.tools ?? {}).length,
        )
      )
        throw new Error(
          'The local AI app could not disable inherited tools. Update it before using this connection.',
        );
      if (!status.nextCursor) return;
      cursor = status.nextCursor;
    }
    throw new Error('The local AI tool configuration is too large to verify.');
  }
  close(error = new Error('The local AI connection closed.')) {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener('folio/closed', { error });
    this.listeners.clear();
    stopProcess(this.child);
  }
  waitClosed() {
    return this.exited;
  }
}
