import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { AIConnection, ConnectionStatus, LoginResult } from '../../src/shared/ai';
import { ConnectionStore } from './connections';
import { CodexRPC, findProgram, runProgram } from './ai-process';

export type ModelRequest = {
  system: string;
  prompt: string;
  images: string[];
  schema: Record<string, unknown>;
};
export interface AIModel {
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
    throw new Error(
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
      max_output_tokens: 16000,
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
      max_tokens: 16000,
      system: systemPrompt(request),
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
      max_tokens: 16000,
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
  let text: string;
  if (format === 'responses') {
    if (data.status && data.status !== 'completed')
      throw new Error('The AI response was not completed. Try a smaller change.');
    text =
      data.output_text ??
      data.output
        ?.flatMap((item: any) => item.content ?? [])
        .filter((item: any) => item.type === 'output_text')
        .map((item: any) => item.text)
        .join('\n');
  } else if (format === 'anthropic') {
    if (data.stop_reason === 'max_tokens')
      throw new Error('The AI response was cut off. Try a smaller change.');
    text = data.content
      ?.filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
  } else {
    if (data.choices?.[0]?.finish_reason !== 'stop')
      throw new Error('The AI response was not completed. Try a smaller change.');
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
): Promise<unknown> {
  const account = await rpc.request('account/read', { refreshToken: false });
  if (account.account?.type !== 'chatgpt')
    throw new Error('Sign in with your subscription in Settings before chatting.');
  const thread = await rpc.request('thread/start', {
    cwd: rpc.cwd,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    model: profile.model || undefined,
    baseInstructions: systemPrompt(request),
    config: await rpc.isolatedConfig(),
  });
  const threadId = thread.thread.id;
  await rpc.assertToolsDisabled(threadId);
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
      })
      .then(
        (result) => {
          turnId = result.turn.id;
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
): Promise<unknown> {
  const status = JSON.parse(
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
  const output = await runProgram(program, args, { cwd, signal, input });
  let result: any;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const item = parseJSON(line) as any;
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
  async model(id?: string): Promise<AIModel> {
    // Capture the connection once: changing Settings never changes an in-flight request.
    const credentials = await this.connections.get(id);
    return this.createModel(credentials);
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
  }
}
