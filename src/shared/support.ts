import type { Appearance, BuildResult, Project, RuntimeStatus } from './types';
import type { AISettings, ProviderKind, ApiFormat, WorkspaceState } from './ai';
import { buildHelp, type BuildHelp } from './build-help';

export const supportSections = ['app', 'compiler', 'workspace', 'ai'] as const;
export type SupportSection = (typeof supportSections)[number];
export type SupportContext = {
  compiler: {
    state: 'ready' | 'needs-attention' | 'not-checked';
    isolation: 'macos-seatbelt' | 'unavailable';
    version: string | null;
    repairAvailable: boolean;
    includedCompiler: boolean | null;
    build: 'success' | 'error' | 'cancelled' | 'not-built';
    buildMatchesSource: boolean;
    runtimeUnavailable: boolean;
    durationMs: number;
    errors: number;
    warnings: number;
    problem: BuildHelp['kind'] | 'unknown' | 'none';
  };
  workspace: {
    saved: boolean;
    unsavedSource: boolean;
    outsideChanges: boolean;
    sourceFiles: number;
    sourceBytes: number;
    messages: number;
    notes: number;
    versions: number;
    appearance: Appearance;
    autoCompile: boolean;
    autoSave: boolean;
  };
  ai: {
    configured: number;
    activeKind: ProviderKind | null;
    apiFormat: ApiFormat | null;
    imageCheck: 'verified' | 'unknown';
  };
};
export type SupportPreview = {
  id: string;
  files: { id: SupportSection; name: string; label: string; description: string; text: string }[];
};

export function numericVersion(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value) ? value : null;
}

// Remove free text before crossing IPC. The native process validates this small
// allowlist again; it never receives resume text or raw diagnostics for export.
export function supportSnapshot(input: {
  project: Project;
  result: BuildResult | null;
  runtime: RuntimeStatus | null;
  workspace: WorkspaceState;
  connections: AISettings;
  appearance: Appearance;
  autoSave: boolean;
  autoCompile: boolean;
  dirty: boolean;
  needsDiskReview: boolean;
}): SupportContext {
  const { project, runtime, workspace, connections } = input;
  const result = input.result?.projectId === project.id ? input.result : null;
  const active = connections.connections.find((c) => c.id === connections.activeId);
  return {
    compiler: {
      state: runtime ? (runtime.ready ? 'ready' : 'needs-attention') : 'not-checked',
      isolation: runtime?.isolation ?? 'unavailable',
      version: numericVersion(runtime?.pin?.version),
      repairAvailable: !!runtime?.canRepair,
      includedCompiler:
        runtime?.pin?.id && runtime.defaultPin?.id
          ? runtime.pin.id === runtime.defaultPin.id
          : null,
      build: result?.status ?? 'not-built',
      buildMatchesSource: !!result && result.revision === project.revision,
      runtimeUnavailable: !!result?.runtimeUnavailable,
      durationMs: result?.durationMs ?? 0,
      errors: result?.diagnostics.filter((d) => d.severity === 'error').length ?? 0,
      warnings: result?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0,
      problem: result?.status === 'error' ? (buildHelp(result)?.kind ?? 'unknown') : 'none',
    },
    workspace: {
      saved: !!project.directory,
      unsavedSource: input.dirty,
      outsideChanges: input.needsDiskReview,
      sourceFiles: project.files.length,
      sourceBytes: project.files.reduce(
        (sum, file) => sum + new TextEncoder().encode(file.content).length,
        0,
      ),
      messages: workspace.messages.length,
      notes: workspace.annotations.length,
      versions: workspace.versions.length,
      appearance: input.appearance,
      autoCompile: input.autoCompile,
      autoSave: input.autoSave,
    },
    ai: {
      configured: connections.connections.length,
      activeKind: active?.kind ?? null,
      apiFormat: active?.format ?? null,
      imageCheck: active?.vision ?? 'unknown',
    },
  };
}
