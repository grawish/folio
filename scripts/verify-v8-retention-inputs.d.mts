export type ProjectSwitchRetentionSeed = {
  passed: boolean;
  longSession: boolean;
  cycles: number;
  errors?: unknown[];
  storage?: Array<{ label?: string }>;
  appAsarSha256: string;
};

export type ProjectSwitchRetentionInput = {
  diagnosticArg?: string;
  cycles: number;
  argvLength: number;
  platform: string;
  arch: string;
  executableArg?: string;
  seedArg?: string;
  seed?: ProjectSwitchRetentionSeed;
  appAsarSha256?: string;
};

export function projectSwitchRetentionInputs(input: ProjectSwitchRetentionInput): null | {
  mode: 'mounted-editor-project-switch';
  requiresUnchangedApp: true;
  appAsarSha256: string;
  seedAppAsarSha256: string;
  forcesGarbageCollection: false;
};
