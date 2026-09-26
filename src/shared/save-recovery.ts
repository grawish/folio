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
