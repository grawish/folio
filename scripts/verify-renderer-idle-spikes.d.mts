export type RendererIdleSpikeSeed = {
  passed: boolean;
  longSession: boolean;
  cycles: number;
  errors?: unknown[];
  storage?: Array<{ label?: string }>;
  appAsarSha256?: string;
};

export type RendererIdleSpikeInput = {
  platform: string;
  arch: string;
  executableArg?: string;
  seedArg?: string;
  argvLength: number;
  cycles: number;
  seed?: RendererIdleSpikeSeed;
  appAsarSha256?: string;
};

export function rendererIdleSpikeInputs(input: RendererIdleSpikeInput): {
  mode: 'renderer-idle-spike-scan';
  cycles: number;
  appAsarSha256: string;
  seedAppAsarSha256: string;
  seedCycles: number;
};
