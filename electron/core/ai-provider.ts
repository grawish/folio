import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type {
  AIConnection,
  ConnectionStatus,
  LoginResult,
  ModelCatalog,
  ModelDescriptor,
  ModelSelection,
} from '../../src/shared/ai';
import { ConnectionStore } from './connections';
import { CodexRPC, findProgram, runProgram } from './ai-process';
import { knownModel, modelEffort, resolveModel, validateSelection } from './ai-routing';

export type ModelRequest = {
  system: string;
  prompt: string;
  images: string[];
  schema: Record<string, unknown>;
  effort?: string;
  maxOutputTokens?: number;
  onModel?: (id: string) => void;
  onSetup?: (durationMs: number) => void;
};
export class InvalidModelOutput extends Error {}
export interface AIModel {
  automatic?: boolean;
  route?(capable: boolean, effort: 'low' | 'medium' | 'high', images: boolean): ModelDescriptor;
  close?(): Promise<void>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}
type Credentials = { profile: AIConnection; apiKey?: string };
const parseJSON = (text: string): unknown => {
  try {
    return JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, ''),
    );
  } catch {
    throw new InvalidModelOutput(
      'The AI response was incomplete or was not valid JSON. Your resume is unchanged.',
    );
  }
};
const imageParts = (url: string) => {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw new Error('The PDF image is invalid.');
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
};
const systemPrompt = (request: ModelRequest) =>
  `${request.system}\nReturn only JSON matching this schema: ${JSON.stringify(request.schema)}`;

export async function requestAPI(
  { profile, apiKey }: Credentials,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const format = profile.format ?? 'chat-completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey)
    headers[format === 'anthropic' ? 'x-api-key' : 'Authorization'] =
      format === 'anthropic' ? apiKey : `Bearer ${apiKey}`;
  const strictFormat = {
    type: 'json_schema',
    name: 'folio_response',
    strict: true,
    schema: request.schema,
  };
  let endpoint: string, body: unknown;
  if (format === 'responses') {
    endpoint = '/responses';
    body = {
      model: profile.model,
      store: false,
      instructions: systemPrompt(request),
      max_output_tokens: request.maxOutputTokens ?? 16000,
      ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: request.prompt },
            ...request.images.map((image_url) => ({
              type: 'input_image',
              image_url,
              detail: 'high',
            })),
          ],
        },
      ],
      text: { format: strictFormat },
    };
  } else if (format === 'anthropic') {
    endpoint = '/messages';
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: profile.model,
      max_tokens: request.maxOutputTokens ?? 16000,
      system: systemPrompt(request),
      ...(request.effort ? { output_config: { effort: request.effort } } : {}),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: request.prompt }, ...request.images.map(imageParts)],
        },
      ],
    };
  } else {
    endpoint = '/chat/completions';
    body = {
      model: profile.model,
      max_tokens: request.maxOutputTokens ?? 16000,
      ...(request.effort ? { reasoning_effort: request.effort } : {}),
      messages: [
        { role: 'system', content: systemPrompt(request) },
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            ...request.images.map((url) => ({
              type: 'image_url',
              image_url: { url, detail: 'high' },
            })),
          ],
        },
      ],
    };
  }
  const timeout = AbortSignal.timeout(180_000);
  let response: Response;
  try {
    response = await fetch(`${profile.baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error(
      timeout.aborted
        ? 'The AI request timed out. Try again.'
        : 'Could not reach your AI connection. Check the address and connection in Settings.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new Error('The AI connection needs attention. Check its key or access in Settings.');
    if (response.status === 429)
      throw new Error(
        'Your AI connection reached its usage limit. Wait and try again, or change the connection in Settings.',
      );
    throw new Error(
      `The AI connection rejected the request (HTTP ${response.status}). Check the model, image support, and API format in Settings.`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The AI connection returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('The AI response exceeds the size limit.');
    }
    chunks.push(value);
  }
  const data = parseJSON(Buffer.concat(chunks).toString('utf8')) as any;
  if (typeof data.model === 'string') request.onModel?.(data.model);
  let text: string;
  if (format === 'responses') {
    if (data.status && data.status !== 'completed')
      throw new InvalidModelOutput('The AI response was not completed. Try a smaller change.');
    text =
      data.output_text ??
      data.output
        ?.flatMap((item: any) => item.content ?? [])
        .filter((item: any) => item.type === 'output_text')
        .map((item: any) => item.text)
        .join('\n');
  } else if (format === 'anthropic') {
    if (data.stop_reason === 'max_tokens')
      throw new InvalidModelOutput('The AI response was cut off. Try a smaller change.');
    text = data.content
      ?.filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
  } else {
    if (data.choices?.[0]?.finish_reason !== 'stop')
      throw new InvalidModelOutput('The AI response was not completed. Try a smaller change.');
    text = data.choices?.[0]?.message?.content;
  }
  if (typeof text !== 'string' || !text.trim())
    throw new Error('The AI connection returned no usable response.');
  return parseJSON(text);
}

export async function requestCodex(
  rpc: CodexRPC,
  profile: AIConnection,
  request: ModelRequest,
  signal: AbortSignal,
  context?: { authenticated: boolean; config: Record<string, unknown> },
): Promise<unknown> {
  const setupStarted = performance.now();
  signal.throwIfAborted();
  const account = context?.authenticated
    ? { account: { type: 'chatgpt' } }
    : await rpc.request('account/read', { refreshToken: false });
  if (account.account?.type !== 'chatgpt')
    throw new Error('Sign in with your subscription in Settings before chatting.');
  const thread = await rpc.request('thread/start', {
    cwd: rpc.cwd,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    model: profile.model || undefined,
    baseInstructions: systemPrompt(request),
    config: context?.config ?? (await rpc.isolatedConfig()),
  });
  request.onModel?.(thread.thread.model || thread.model || profile.model || 'Account default');
  signal.throwIfAborted();
  const threadId = thread.thread.id;
  await rpc.assertToolsDisabled(threadId);
  request.onSetup?.(performance.now() - setupStarted);
  return new Promise((resolve, reject) => {
    let text = '',
      turnId: string | undefined,
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      if (turnId) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      finish(new Error('Request cancelled.'));
    };
    const off = rpc.listen((method, params) => {
      if (method === 'folio/closed') {
        finish(params.error);
        return;
      }
      if (params?.threadId !== threadId) return;
      if (method === 'item/completed' && params.item?.type === 'agentMessage')
        text = params.item.text;
      if (method === 'turn/completed') {
        if (params.turn?.status !== 'completed') {
          finish(new Error('The AI request did not complete. Check your connection in Settings.'));
          return;
        }
        try {
          finish(
            undefined,
            parseJSON(
              text ||
                params.turn.items?.filter((i: any) => i.type === 'agentMessage').at(-1)?.text ||
                '',
            ),
          );
        } catch (error) {
          finish(error as Error);
        }
      }
    });
    const timer = setTimeout(() => {
      finish(new Error('The AI request timed out.'));
      rpc.close();
    }, 180_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void rpc
      .request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: request.prompt },
          ...request.images.map((url) => ({ type: 'image', url })),
        ],
        outputSchema: request.schema,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model: profile.model || undefined,
        effort: request.effort,
      })
      .then(
        (result) => {
          turnId = result.turn.id;
          if (signal.aborted)
            void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        },
        (error) => finish(error),
      );
  });
}

export async function requestClaude(
  program: string,
  cwd: string,
  profile: AIConnection,
  request: ModelRequest,
  signal: AbortSignal,
  authenticated = false,
): Promise<unknown> {
  const setupStarted = performance.now();
  signal.throwIfAborted();
  const status = authenticated
    ? { loggedIn: true, authMethod: 'claude.ai' }
    : JSON.parse(
        await runProgram(program, ['auth', 'status'], {
          cwd,
          signal,
          timeoutMs: 20_000,
          allowedExitCodes: [0, 1],
        }),
      );
  if (!status.loggedIn || status.authMethod !== 'claude.ai')
    throw new Error('Sign in with your subscription in Settings before chatting.');
  const args = [
    '--safe-mode',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '-p',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    systemPrompt(request),
    '--json-schema',
    JSON.stringify(request.schema),
  ];
  if (profile.model) args.push('--model', profile.model);
  if (request.effort) args.push('--effort', request.effort);
  const input =
    JSON.stringify({
      type: 'user',
      session_id: randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text: request.prompt }, ...request.images.map(imageParts)],
      },
    }) + '\n';
  if (Buffer.byteLength(input) > 9 * 1024 * 1024)
    throw new Error(
      'These PDF images exceed the local AI app input limit. Use fewer pages or notes.',
    );
  request.onSetup?.(performance.now() - setupStarted);
  const output = await runProgram(program, args, { cwd, signal, input });
  let result: any;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const item = parseJSON(line) as any;
    if (typeof item.message?.model === 'string') request.onModel?.(item.message.model);
    if (item.type === 'result') result = item;
  }
  if (!result || result.is_error || result.subtype !== 'success')
    throw new Error('The local AI request failed. Check your subscription and model in Settings.');
  return result.structured_output ?? parseJSON(result.result ?? '');
}

// A synthetic red square for the user-invoked image-support test. No project data is sent.
function testImage() {
  const crc32 = (bytes: Buffer) => {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(48, 0);
  header.writeUInt32BE(48, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(48 * (48 * 3 + 1));
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) raw[y * 145 + 1 + x * 3] = 255;
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}

export class ProviderService {
  private logins = new Map<string, AbortController>();
  constructor(
    readonly connections: ConnectionStore,
    readonly workRoot: string,
  ) {}
  private async temporary<T>(operation: (cwd: string) => Promise<T>): Promise<T> {
    await fs.mkdir(this.workRoot, { recursive: true });
    const cwd = await fs.mkdtemp(path.join(this.workRoot, 'request-'));
    try {
      return await operation(cwd);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
  private catalogs = new Map<
    string,
    { revision: string; expires: number; catalog: ModelCatalog }
  >();
  private warm?: {
    revision: string;
    rpc: CodexRPC;
    cwd: string;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    uses: number;
  };
  private warmQueue: Promise<unknown> = Promise.resolve();
  private async dropWarm() {
    const warm = this.warm;
    this.warm = undefined;
    if (!warm) return;
    clearTimeout(warm.timer);
    warm.controller.abort();
    warm.rpc.close();
    await warm.rpc.waitClosed();
    await fs.rm(warm.cwd, { recursive: true, force: true });
  }
  invalidate() {
    this.catalogs.clear();
    return this.serializeWarm(() => this.dropWarm());
  }
  private serializeWarm<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.warmQueue.catch(() => {}).then(operation);
    this.warmQueue = next;
    return next;
  }
  private async withCodex<T>(
    credentials: Credentials & { revision: string },
    signal: AbortSignal,
    operation: (rpc: CodexRPC) => Promise<T>,
  ): Promise<T> {
    // A catalog lookup may already own this connection's process. Stop must also
    // interrupt that setup, rather than wait for its timeout behind the queue.
    signal.throwIfAborted();
    const abortSetup = () => {
      if (this.warm?.revision === credentials.revision) this.warm.controller.abort();
    };
    signal.addEventListener('abort', abortSetup, { once: true });
    return this.serializeWarm(async () => {
      signal.throwIfAborted();
      if (this.warm?.revision !== credentials.revision || this.warm.uses >= 20)
        await this.dropWarm();
      const abort = () => this.warm?.controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!this.warm) {
          const program = await findProgram(credentials.profile);
          signal.throwIfAborted();
          await fs.mkdir(this.workRoot, { recursive: true });
          const cwd = await fs.mkdtemp(path.join(this.workRoot, 'session-'));
          const controller = new AbortController();
          const rpc = new CodexRPC(program, cwd, controller.signal);
          this.warm = { revision: credentials.revision, rpc, cwd, controller, uses: 0 };
          if (signal.aborted) abort();
          await rpc.initialize();
        }
        clearTimeout(this.warm.timer);
        this.warm.uses++;
        const value = await operation(this.warm.rpc);
        signal.throwIfAborted();
        this.warm.timer = setTimeout(() => {
          void this.serializeWarm(() => this.dropWarm()).catch(() => {});
        }, 60_000);
        this.warm.timer.unref();
        return value;
      } catch (error) {
        await this.dropWarm();
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }).finally(() => signal.removeEventListener('abort', abortSetup));
  }
  async catalog(id: string): Promise<ModelCatalog> {
    return this.catalogFor(await this.connections.get(id));
  }
  private async catalogFor(
    credentials: Credentials & { revision: string },
    runSignal?: AbortSignal,
  ): Promise<ModelCatalog> {
    const { profile, revision } = credentials;
    const cached = this.catalogs.get(profile.id);
    if (cached?.revision === revision && cached.expires > Date.now()) return cached.catalog;
    const fallback = [
      ...new Set(
        [profile.model, profile.autoModels?.fast, profile.autoModels?.capable].filter(
          (id): id is string => !!id,
        ),
      ),
    ].map((id) => ({
      id,
      name: id,
      ...(profile.kind === 'custom' ? {} : knownModel(id)),
      ...(id === profile.model && profile.vision === 'verified' ? { images: true } : {}),
    }));
    const timeout = AbortSignal.timeout(10_000);
    const signal = runSignal ? AbortSignal.any([timeout, runSignal]) : timeout;
    let models: ModelDescriptor[] = [],
      warning: string | undefined;
    try {
      if (profile.kind === 'codex') {
        models = await this.withCodex(credentials, signal, async (rpc) => {
          const all: ModelDescriptor[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const result = await rpc.request('model/list', {
              limit: 100,
              includeHidden: false,
              cursor,
            });
            if (!Array.isArray(result.data)) throw new Error('Invalid model catalog.');
            for (const m of result.data)
              if (!m.hidden && typeof m.model === 'string' && m.model.length <= 160)
                all.push({
                  id: m.model,
                  name: typeof m.displayName === 'string' ? m.displayName.slice(0, 160) : m.model,
                  images: m.inputModalities ? m.inputModalities.includes('image') : true,
                  isDefault: m.isDefault === true,
                  efforts: m.supportedReasoningEfforts?.map(
                    (e: { reasoningEffort: string }) => e.reasoningEffort,
                  ),
                });
            cursor = result.nextCursor;
            if (!cursor) return all;
          }
          throw new Error('Model catalog exceeds its limit.');
        });
      } else if (profile.kind === 'claude-code') {
        models = ['haiku', 'sonnet', 'opus'].map((id) => ({
          id,
          name: id[0].toUpperCase() + id.slice(1),
          images: true,
          ...(id !== 'haiku' ? { efforts: ['low', 'medium', 'high'] } : {}),
        }));
      } else {
        const headers: Record<string, string> = {};
        if (credentials.apiKey)
          headers[profile.format === 'anthropic' ? 'x-api-key' : 'Authorization'] =
            profile.format === 'anthropic' ? credentials.apiKey : `Bearer ${credentials.apiKey}`;
        if (profile.format === 'anthropic') headers['anthropic-version'] = '2023-06-01';
        let after = '';
        for (let page = 0; page < 20; page++) {
          const suffix =
            profile.format === 'anthropic'
              ? `?limit=100${after ? '&after_id=' + encodeURIComponent(after) : ''}`
              : '';
          const response = await fetch(`${profile.baseUrl}/models${suffix}`, {
            headers,
            signal,
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Model discovery unavailable.');
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error('Empty model catalog.');
          const chunks: Uint8Array[] = [];
          let length = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 2_000_000) {
              await reader.cancel();
              throw new Error('Model catalog exceeds its limit.');
            }
            chunks.push(value);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          const result = JSON.parse(raw);
          if (!Array.isArray(result.data)) throw new Error('Invalid model catalog.');
          for (const m of result.data.slice(0, 2000))
            if (typeof m.id === 'string' && m.id.length <= 160) {
              if (
                profile.kind === 'openai' &&
                (!/^(gpt-|chatgpt-|chat-latest$|o[134](?:-|$)|codex-)/.test(m.id) ||
                  /audio|realtime|transcribe|tts|image|search/.test(m.id))
              )
                continue;
              const efforts = m.capabilities?.effort;
              models.push({
                id: m.id,
                name: typeof m.display_name === 'string' ? m.display_name.slice(0, 160) : m.id,
                ...(profile.kind === 'custom' ? {} : knownModel(m.id)),
                ...(m.capabilities?.image_input
                  ? { images: m.capabilities.image_input.supported === true }
                  : {}),
                ...(efforts
                  ? { efforts: ['low', 'medium', 'high'].filter((e) => efforts[e]?.supported) }
                  : {}),
              });
            }
          if (!result.has_more || profile.format !== 'anthropic') break;
          if (!result.last_id || result.last_id === after || page === 19)
            throw new Error('Model catalog exceeds its limit.');
          after = result.last_id;
        }
      }
    } catch {
      runSignal?.throwIfAborted();
      warning = 'Model discovery is unavailable. Your configured models are still usable.';
    }
    const catalog = {
      models: [...models, ...fallback.filter((m) => !models.some((n) => n.id === m.id))].slice(
        0,
        2000,
      ),
      warning,
    };
    this.catalogs.set(profile.id, {
      revision,
      expires: Date.now() + (warning ? 30_000 : 300_000),
      catalog,
    });
    return catalog;
  }
  async model(
    id?: string,
    selected?: ModelSelection,
    signal = new AbortController().signal,
  ): Promise<AIModel> {
    // Capture credentials and routing preferences once for the entire run.
    const credentials = await this.connections.get(id);
    const selection = validateSelection(
      selected ?? credentials.profile.selection ?? { mode: 'default' },
    );
    signal.throwIfAborted();
    const cached = this.catalogs.get(credentials.profile.id);
    const catalog =
      selection.mode === 'auto'
        ? await this.catalogFor(credentials, signal)
        : cached?.revision === credentials.revision
          ? cached.catalog
          : { models: [] };
    signal.throwIfAborted();
    let chosen = resolveModel(credentials.profile, selection, catalog.models, false);
    let effort: string | undefined,
      program: string | undefined,
      authenticated = false;
    let config: Record<string, unknown> | undefined;
    return {
      automatic: selection.mode === 'auto',
      route: (capable, requested, images) => {
        chosen = resolveModel(credentials.profile, selection, catalog.models, capable);
        if (images && chosen.images === false && selection.mode === 'auto')
          chosen = resolveModel(credentials.profile, selection, catalog.models, true);
        if (images && chosen.images === false)
          throw new Error(
            'This model cannot read PDF images. Choose an image-capable model in Chat or Settings.',
          );
        effort = modelEffort(chosen, requested);
        return chosen;
      },
      complete: async (request, requestSignal) => {
        const setupStarted = performance.now();
        requestSignal.throwIfAborted();
        const profile = { ...credentials.profile, model: chosen.id };
        const body = { ...request, effort };
        if (profile.kind === 'codex')
          return this.withCodex(credentials, requestSignal, async (rpc) => {
            if (!authenticated) {
              const account = await rpc.request('account/read', { refreshToken: false });
              if (account.account?.type !== 'chatgpt')
                throw new Error('Sign in with your subscription in Settings before chatting.');
              config = await rpc.isolatedConfig();
              authenticated = true;
            }
            request.onSetup?.(performance.now() - setupStarted);
            return requestCodex(rpc, profile, body, requestSignal, {
              authenticated,
              config: config!,
            });
          });
        if (profile.kind === 'claude-code')
          return this.temporary(async (cwd) => {
            program ??= await findProgram(profile);
            request.onSetup?.(performance.now() - setupStarted);
            const result = await requestClaude(
              program,
              cwd,
              profile,
              body,
              requestSignal,
              authenticated,
            );
            authenticated = true;
            return result;
          });
        return requestAPI({ ...credentials, profile }, body, requestSignal);
      },
      close: async () => {
        if (signal.aborted) await this.serializeWarm(() => this.dropWarm());
      },
    };
  }
  private createModel(credentials: Credentials): AIModel {
    return {
      complete: (request, signal) =>
        this.temporary(async (cwd) => {
          signal.throwIfAborted();
          if (credentials.profile.kind === 'codex') {
            const rpc = new CodexRPC(await findProgram(credentials.profile), cwd, signal);
            try {
              await rpc.initialize();
              return await requestCodex(rpc, credentials.profile, request, signal);
            } finally {
              rpc.close();
            }
          }
          if (credentials.profile.kind === 'claude-code')
            return requestClaude(
              await findProgram(credentials.profile),
              cwd,
              credentials.profile,
              request,
              signal,
            );
          return requestAPI(credentials, request, signal);
        }),
    };
  }
  async check(id: string, testImages = false): Promise<ConnectionStatus> {
    const credentials = await this.connections.get(id);
    const { profile, revision } = credentials;
    const signal = AbortSignal.timeout(testImages ? 190_000 : 30_000);
    if (testImages) {
      const model = this.createModel(credentials);
      const reply = (await model.complete(
        {
          system: 'Describe the supplied image accurately.',
          prompt: 'What is the main color in this image? Return a lowercase English color name.',
          images: [testImage()],
          schema: {
            type: 'object',
            properties: { color: { type: 'string' } },
            required: ['color'],
            additionalProperties: false,
          },
        },
        signal,
      )) as { color?: string };
      if (reply.color?.toLowerCase() !== 'red')
        throw new Error('The image test did not pass. Choose a model that can read images.');
      await this.connections.verified(id, revision);
      return { ready: true, message: 'Connected. Image support verified.' };
    }
    return this.temporary(async (cwd) => {
      if (profile.kind === 'codex') {
        const rpc = new CodexRPC(await findProgram(profile), cwd, signal);
        try {
          await rpc.initialize();
          const account = await rpc.request('account/read', { refreshToken: false });
          if (account.account?.type !== 'chatgpt')
            return { ready: false, message: 'Sign in with your existing subscription.' };
          const models = await rpc.request('model/list', { limit: 100 });
          return {
            ready: true,
            message: 'Subscription connected. Test image support before using a new model.',
            models: models.data
              ?.filter((m: any) => !m.hidden && m.inputModalities?.includes('image'))
              .map((m: any) => ({ id: m.model, name: m.displayName })),
          };
        } finally {
          rpc.close();
        }
      }
      if (profile.kind === 'claude-code') {
        const status = JSON.parse(
          await runProgram(await findProgram(profile), ['auth', 'status'], {
            cwd,
            signal,
            allowedExitCodes: [0, 1],
          }),
        );
        const ready = !!status.loggedIn && status.authMethod === 'claude.ai';
        return {
          ready,
          message: ready
            ? 'Subscription connected. Use the account default or enter a model name.'
            : 'Sign in with your existing subscription.',
        };
      }
      return {
        ready: false,
        message:
          'Connection saved. Use Test image support to verify your key, endpoint, and model.',
      };
    });
  }
  async login(id: string): Promise<LoginResult> {
    const { profile } = await this.connections.get(id);
    if (profile.kind !== 'codex' && profile.kind !== 'claude-code')
      throw new Error('This connection uses an API key.');
    this.cancelLogin(id);
    const controller = new AbortController();
    this.logins.set(id, controller);
    const program = await findProgram(profile);
    if (profile.kind === 'claude-code') {
      void this.temporary((cwd) =>
        runProgram(program, ['auth', 'login', '--claudeai'], {
          cwd,
          signal: controller.signal,
          timeoutMs: 300_000,
        }),
      )
        .catch(() => {})
        .finally(() => {
          if (this.logins.get(id) === controller) this.logins.delete(id);
        });
      return {
        message:
          'Complete sign-in in the browser opened by the local app, then check the connection.',
      };
    }
    await fs.mkdir(this.workRoot, { recursive: true });
    const rpc = new CodexRPC(program, this.workRoot, controller.signal);
    const timer = setTimeout(() => controller.abort(), 300_000);
    const cleanup = () => {
      clearTimeout(timer);
      rpc.close();
      if (this.logins.get(id) === controller) this.logins.delete(id);
    };
    rpc.listen((method) => {
      if (method === 'account/login/completed' || method === 'folio/closed') cleanup();
    });
    try {
      await rpc.initialize();
      const login = await rpc.request('account/login/start', { type: 'chatgpt' });
      const url = new URL(login.authUrl);
      if (
        url.protocol !== 'https:' ||
        !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)
      )
        throw new Error('The sign-in address was not recognized. Use the local app to sign in.');
      return {
        message: 'Complete sign-in in your browser, then check the connection.',
        url: url.href,
        loginId: login.loginId,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  cancelLogin(id: string) {
    this.logins.get(id)?.abort();
    this.logins.delete(id);
  }
  close() {
    for (const id of this.logins.keys()) this.cancelLogin(id);
    return this.invalidate();
  }
}
