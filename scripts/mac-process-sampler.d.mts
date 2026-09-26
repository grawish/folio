export interface ProcessReading {
  pid: number;
  parent: number;
  name: string;
  birthAbstime: string;
  userTicks: string;
  systemTicks: string;
  rssBytes: number;
  footprintBytes: number;
}

export interface ProcessSample {
  atMs: number;
  phase: string;
  collectionMs: number;
  atAbstime: string;
  timebase: { numer: number; denom: number };
  processes: ProcessReading[];
  vanished: number;
  samplerCpuSeconds: number;
  observedCpuSeconds: number;
  summedRssBytes: number;
  summedFootprintBytes: number;
}

export function buildProcessSampler(directory: string): Promise<string>;

export class ProcessSampler {
  constructor(executable: string, rootPid: number, intervalMs?: number);
  samples: ProcessSample[];
  take(): Promise<ProcessSample>;
  start(): Promise<void>;
  mark(phase: string): Promise<ProcessSample>;
  stop(): Promise<void>;
}
