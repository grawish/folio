export type LocalAiTimingExecution = {
  id: string;
  createdAt: string;
  status: 'complete' | 'error' | 'cancelled' | null;
  workspaceIds: string[];
  models: string[];
  escalated: boolean;
  validation?: 'compiled' | 'visual';
  timings: Record<string, number>;
  knownStageMs: number;
  uninstrumentedMs: number;
};

export type LocalAiTimingSummary = {
  schemaVersion: 1;
  evidenceKind: 'local-scripted-provider-fixture';
  sourceDirectory: string;
  executionCount: number;
  executions: LocalAiTimingExecution[];
  workspaceRelationships: Array<{
    workspaces: string[];
    sharedMessages: number;
    relation: 'identical' | 'subset' | 'partial-overlap';
  }>;
  stageTotals: Record<string, { count: number; sumMs: number }>;
  totals: { sumTotalMs: number; sumKnownStageMs: number; sumUninstrumentedMs: number };
};

export function verifyLocalAiTiming(directory: string): Promise<LocalAiTimingSummary>;
