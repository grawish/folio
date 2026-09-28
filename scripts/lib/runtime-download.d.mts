export interface RuntimeDownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  retryDelayMs?: number;
  onRetry?: (retry: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }) => void;
}
export function downloadRuntimeArchive(
  url: string,
  digest: string,
  options?: RuntimeDownloadOptions,
): Promise<Buffer>;
