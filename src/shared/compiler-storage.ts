import type { RuntimePin } from './runtime';

export type CompilerStorageEntry = {
  key: string;
  pin?: RuntimePin;
  bytes: number;
  copies: number;
  token: string;
  protectedReason?: string;
  unfinishedRemoval: boolean;
};
export type CompilerStorage = {
  bytes: number;
  installationBudgetBytes: number;
  entries: CompilerStorageEntry[];
};
