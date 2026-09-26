export type RecoveryVersion = 'before' | 'after' | 'current';
export type RecoveryFileVersion = {
  available: boolean;
  exists: boolean;
  bytes: number | null;
  sha256: string | null;
};
export type SaveRecoveryReview = {
  token: string;
  directory: string;
  files: {
    path: string;
    changedAfterward: boolean;
    versions: Record<RecoveryVersion, RecoveryFileVersion>;
  }[];
};
export type SaveRecoveryChoice = { path: string; version: RecoveryVersion };
export type SaveRecoveryText = { text: string | null; truncated: boolean };
export type InterruptedSave = {
  id: string;
  name: string;
  directory: string | null;
  issue?: string;
  copyId?: string;
};
export type SaveRecoveryResult = {
  project: import('./types').Project | null;
  copyId: string;
  warning?: string;
  workspace?: import('./ai').WorkspaceState;
};
