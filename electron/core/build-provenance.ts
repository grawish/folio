import { createHash } from 'node:crypto';
import type { Project } from '../../src/shared/types';
import { fingerprint } from './project';

// Source fingerprint deliberately excludes assets. Never use it alone to reuse a PDF.
export function buildFingerprint(
  project: Project,
  assets: Map<string, Buffer>,
  runtime = project.runtime,
): string | undefined {
  if (!runtime?.id || !runtime.platform) return undefined;
  const hash = createHash('sha256').update(fingerprint({ ...project, runtime }));
  for (const [name, bytes] of [...assets].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
  return hash.digest('hex');
}
