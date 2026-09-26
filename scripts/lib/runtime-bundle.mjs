import { zipSync } from 'fflate';

/** @param {Record<string, Uint8Array>} content */
export function createRuntimeBundle(content) {
  return zipSync(
    Object.fromEntries(
      Object.entries(content).map(([name, bytes]) => [
        name,
        // ZIP stores local clock fields, without a timezone. Preserve the first
        // published bundle's 2024-01-01 05:30 fields on every build machine.
        [bytes, { mtime: new Date(2024, 0, 1, 5, 30, 0) }],
      ]),
    ),
    { level: 6 },
  );
}
