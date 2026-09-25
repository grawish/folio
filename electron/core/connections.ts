import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AIConnection, AISettings, ConnectionInput } from '../../src/shared/ai';
import { atomicWrite } from './project';
import { safeId } from './workspace';

export interface SecretStorage {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
type DiskSettings = AISettings & { secrets: Record<string, string> };
function connectionRevision(profile: AIConnection, secret?: string): string {
  const { vision: _vision, ...identity } = profile;
  return createHash('sha256')
    .update(JSON.stringify([identity, secret]))
    .digest('hex');
}
export function validateConnection(input: ConnectionInput, previous?: AIConnection): AIConnection {
  if (
    !input ||
    !['codex', 'claude-code', 'openai', 'anthropic', 'custom'].includes(input.kind) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 80 ||
    typeof input.model !== 'string' ||
    input.model.length > 160
  )
    throw new Error('Choose a provider and give this connection a name.');
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey))
  )
    throw new Error('The API key is invalid.');
  const native = input.kind === 'codex' || input.kind === 'claude-code';
  if (native && input.apiKey?.trim())
    throw new Error('Subscription connections use their own sign-in, not an API key.');
  let baseUrl =
    input.kind === 'openai'
      ? 'https://api.openai.com/v1'
      : input.kind === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : undefined;
  if (input.kind === 'custom') {
    try {
      const url = new URL(input.baseUrl ?? '');
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      baseUrl = url.href.replace(/\/+$/, '');
    } catch {
      throw new Error('Enter an HTTPS API address, or an HTTP address on localhost.');
    }
  }
  if (!native && !input.model.trim()) throw new Error('Enter or choose an image-capable model.');
  if (
    input.executable &&
    (!native || !path.isAbsolute(input.executable) || input.executable.length > 1000)
  )
    throw new Error('The program location must be an absolute path.');
  const format =
    input.kind === 'anthropic'
      ? 'anthropic'
      : input.kind === 'openai'
        ? 'responses'
        : (input.format ?? 'chat-completions');
  if (!['responses', 'chat-completions', 'anthropic'].includes(format))
    throw new Error('Choose a supported API format.');
  const unchanged =
    previous?.kind === input.kind &&
    previous.model === input.model.trim() &&
    previous.baseUrl === baseUrl &&
    previous.executable === (input.executable || undefined) &&
    previous.format === (native ? undefined : format) &&
    !input.clearKey;
  return {
    id: input.id ? safeId(input.id) : randomUUID(),
    name: input.name.trim(),
    kind: input.kind,
    model: input.model.trim(),
    baseUrl,
    format: native ? undefined : format,
    executable: native ? input.executable || undefined : undefined,
    hasKey: false,
    vision: unchanged && !input.apiKey ? previous.vision : 'unknown',
  };
}
export class ConnectionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dataRoot: string,
    private readonly storage: SecretStorage,
  ) {}
  private get filename() {
    return path.join(this.dataRoot, 'ai-connections.json');
  }
  private async read(): Promise<DiskSettings> {
    try {
      const data = JSON.parse(await fs.readFile(this.filename, 'utf8')) as DiskSettings;
      if (!Array.isArray(data.connections) || !data.secrets || data.connections.length > 30)
        throw new Error();
      data.connections = data.connections.map((c) => ({
        ...validateConnection(c, c),
        hasKey: !!data.secrets[c.id],
        vision: c.vision === 'verified' ? 'verified' : 'unknown',
      }));
      data.activeId = data.connections.some((c) => c.id === data.activeId) ? data.activeId : null;
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { connections: [], activeId: null, secrets: {} };
      throw new Error('AI connection settings could not be read.');
    }
  }
  private public(data: DiskSettings): AISettings {
    return { connections: data.connections, activeId: data.activeId };
  }
  private mutate(operation: (data: DiskSettings) => void): Promise<AISettings> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const data = await this.read();
        operation(data);
        await atomicWrite(this.filename, JSON.stringify(data));
        return this.public(data);
      });
    this.queue = next;
    return next;
  }
  async list() {
    await this.queue.catch(() => {});
    return this.public(await this.read());
  }
  save(input: ConnectionInput) {
    return this.mutate((data) => {
      const previous = data.connections.find((c) => c.id === input.id);
      if (input.id && !previous) throw new Error('This connection no longer exists.');
      if (!previous && data.connections.length >= 30)
        throw new Error('Remove an unused connection before adding another.');
      const connection = validateConnection(input, previous);
      if (
        input.clearKey ||
        previous?.kind !== connection.kind ||
        previous?.baseUrl !== connection.baseUrl
      )
        delete data.secrets[connection.id];
      if (input.apiKey?.trim()) {
        if (!this.storage.available())
          throw new Error(
            'Protected credential storage is unavailable. API keys have not been saved.',
          );
        data.secrets[connection.id] = this.storage.encrypt(input.apiKey.trim()).toString('base64');
      }
      connection.hasKey = !!data.secrets[connection.id];
      if (['openai', 'anthropic'].includes(connection.kind) && !connection.hasKey)
        throw new Error('Add your API key to save this connection.');
      data.connections = previous
        ? data.connections.map((c) => (c.id === previous.id ? connection : c))
        : [...data.connections, connection];
    });
  }
  remove(id: string) {
    return this.mutate((data) => {
      safeId(id);
      data.connections = data.connections.filter((c) => c.id !== id);
      delete data.secrets[id];
      if (data.activeId === id) data.activeId = null;
    });
  }
  select(id: string | null) {
    return this.mutate((data) => {
      if (id !== null && !data.connections.some((c) => c.id === id))
        throw new Error('Choose an existing connection.');
      data.activeId = id;
    });
  }
  async get(id?: string) {
    await this.queue.catch(() => {});
    const data = await this.read();
    const profile = data.connections.find((c) => c.id === (id ?? data.activeId));
    if (!profile) throw new Error('Choose an AI connection in Settings to start chatting.');
    let apiKey: string | undefined;
    if (data.secrets[profile.id]) {
      if (!this.storage.available())
        throw new Error('Unlock protected credential storage, then try again.');
      try {
        apiKey = this.storage.decrypt(Buffer.from(data.secrets[profile.id], 'base64'));
      } catch {
        throw new Error(
          'This API key cannot be opened on this computer. Enter it again in Settings.',
        );
      }
    }
    return { profile, apiKey, revision: connectionRevision(profile, data.secrets[profile.id]) };
  }
  verified(id: string, revision: string) {
    return this.mutate((data) => {
      const c = data.connections.find((c) => c.id === id);
      if (!c || connectionRevision(c, data.secrets[id]) !== revision)
        throw new Error('This connection changed during the image test. Test it again.');
      c.vision = 'verified';
    });
  }
}
