import type { RuntimePin } from './runtime';
import type { BuildResult, Project } from './types';

export type CompilerBackup = {
  id: string;
  createdAt: string;
  from: RuntimePin;
  to: RuntimePin;
};
export type CompilerComparison = CompilerBackup & {
  before: Uint8Array;
  after: Uint8Array;
  baseline: 'rebuilt' | 'saved-pdf';
};
export type CompilerMigrationResult = {
  project: Project;
  build: BuildResult;
  backup: CompilerBackup;
  warning?: string;
};
