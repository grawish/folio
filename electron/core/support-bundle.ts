import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import {
  numericVersion,
  supportSections,
  type SupportContext,
  type SupportPreview,
  type SupportSection,
} from '../../src/shared/support';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid support summary.');
  return value as Record<string, unknown>;
}
function choice<T>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error('Invalid support summary value.');
  return value as T;
}
function count(value: unknown, max = 10_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new Error('Invalid support summary count.');
  return value as number;
}
const boolean = (value: unknown) => choice(value, [true, false]);

// Construct every output property. Never spread an input object or serialize
// arbitrary logs, project metadata, provider settings or exception messages.
export function validateSupportContext(value: unknown): SupportContext {
  const input = object(value),
    c = object(input.compiler),
    w = object(input.workspace),
    a = object(input.ai);
  return {
    compiler: {
      state: choice(c.state, ['ready', 'needs-attention', 'not-checked']),
      isolation: choice(c.isolation, ['macos-seatbelt', 'unavailable']),
      version: numericVersion(c.version),
      repairAvailable: boolean(c.repairAvailable),
      includedCompiler: choice(c.includedCompiler, [true, false, null]),
      build: choice(c.build, ['success', 'error', 'cancelled', 'not-built']),
      buildMatchesSource: boolean(c.buildMatchesSource),
      runtimeUnavailable: boolean(c.runtimeUnavailable),
      durationMs: count(c.durationMs, 86_400_000),
      errors: count(c.errors),
      warnings: count(c.warnings),
      problem: choice(c.problem, [
        'package',
        'file',
        'font',
        'engine',
        'syntax',
        'limit',
        'unknown',
        'none',
      ]),
    },
    workspace: {
      saved: boolean(w.saved),
      unsavedSource: boolean(w.unsavedSource),
      outsideChanges: boolean(w.outsideChanges),
      sourceFiles: count(w.sourceFiles, 100),
      sourceBytes: count(w.sourceBytes, 5 * 1024 * 1024),
      messages: count(w.messages),
      notes: count(w.notes),
      versions: count(w.versions),
      appearance: choice(w.appearance, ['light', 'dark', 'system']),
      autoCompile: boolean(w.autoCompile),
      autoSave: boolean(w.autoSave),
    },
    ai: {
      configured: count(a.configured, 30),
      activeKind: choice(a.activeKind, [
        'codex',
        'claude-code',
        'openai',
        'anthropic',
        'custom',
        null,
      ]),
      apiFormat: choice(a.apiFormat, ['responses', 'chat-completions', 'anthropic', null]),
      imageCheck: choice(a.imageCheck, ['verified', 'unknown']),
    },
  };
}

type SystemInfo = {
  app: string;
  electron: string;
  chromium: string;
  node: string;
  kernel: string;
  architecture: string;
  platform: string;
  packaged: boolean;
};
const labels: Record<SupportSection, [string, string]> = {
  app: ['App and Mac versions', 'Folio, Electron, browser, Node, macOS kernel and architecture.'],
  compiler: [
    'Compiler and last build',
    'Readiness, isolation, build result, timing and error category. No raw log.',
  ],
  workspace: [
    'Workspace summary',
    'File/message/note counts, save state and display preferences. No contents.',
  ],
  ai: [
    'AI connection summary',
    'Connection count, active provider type and image-check state. No account details.',
  ],
};

export class SupportBundles {
  private preview?: SupportPreview;
  private exporting?: Promise<boolean>;
  constructor(
    private deps: {
      system(): SystemInfo;
      choose(): Promise<string | undefined>;
      write(filename: string, bytes: Uint8Array): Promise<void>;
    },
  ) {}
  prepare(value: unknown): SupportPreview {
    if (this.exporting) throw new Error('Wait for the support ZIP to finish saving.');
    const context = validateSupportContext(value),
      system = this.deps.system();
    const payloads = {
      app: {
        appVersion: numericVersion(system.app),
        electronVersion: numericVersion(system.electron),
        chromiumVersion: numericVersion(system.chromium),
        nodeVersion: numericVersion(system.node),
        macOSKernelVersion: system.platform === 'darwin' ? numericVersion(system.kernel) : null,
        architecture: system.architecture === 'arm64' ? 'arm64' : 'unsupported',
        platform: system.platform === 'darwin' ? 'macOS' : 'unsupported',
        packaged: system.packaged === true,
      },
      ...context,
    };
    const collectedAt = new Date().toISOString();
    this.preview = {
      id: randomUUID(),
      files: supportSections.map((id) => ({
        id,
        name: `${id}.json`,
        label: labels[id][0],
        description: labels[id][1],
        text:
          JSON.stringify({ format: 'folio-support-v1', collectedAt, ...payloads[id] }, null, 2) +
          '\n',
      })),
    };
    // Copies prevent callers from changing the exact reviewed export snapshot.
    return structuredClone(this.preview);
  }
  export(id: string, selected: unknown): Promise<boolean> {
    if (this.exporting) throw new Error('Wait for the support ZIP to finish saving.');
    const preview = this.preview;
    if (!preview || preview.id !== id) throw new Error('Open a new support preview before saving.');
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > supportSections.length ||
      new Set(selected).size !== selected.length ||
      selected.some((item) => !supportSections.includes(item))
    )
      throw new Error('Choose at least one valid support section.');
    const files = preview.files.filter((f) => selected.includes(f.id));
    const save = async () => {
      const filename = await this.deps.choose();
      if (!filename) return false;
      const bytes = zipSync(
        Object.fromEntries(files.map((file) => [file.name, strToU8(file.text)])),
      );
      await this.deps.write(filename, bytes);
      return true;
    };
    const operation = save().finally(() => {
      if (this.exporting === operation) this.exporting = undefined;
    });
    this.exporting = operation;
    return operation;
  }
  async cancel(id?: string) {
    const preview = this.preview;
    if (id && preview?.id !== id) return;
    await this.exporting?.catch(() => {});
    if (this.preview === preview) this.preview = undefined;
  }
}
