import type { ChildProcess } from 'node:child_process';
export interface SubprocessTimeline {
  startedAtMs: number;
  spawnedAtMs?: number;
  exitedAtMs?: number;
  closedAtMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  outputBytes: number;
  retainedBytes: number;
  truncated: boolean;
  chunks: { stream: string; atMs: number; base64: string }[];
}
export function observeSubprocess(
  child: ChildProcess,
  now?: () => number,
  limit?: number,
): SubprocessTimeline;
