import { CompilerMigration } from '../../electron/core/compiler-migration';
import { ProjectStore } from '../../electron/core/project';
import { WorkspaceStore } from '../../electron/core/workspace';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Project } from '../../src/shared/types';
const [root, boundary] = process.argv.slice(2);
const store = new ProjectStore(root),
  workspace = new WorkspaceStore(root);
const old = {
  engine: 'tectonic' as const,
  version: '0.16.0',
  bundle: 'old',
  id: 'a'.repeat(64),
  platform: `${process.platform}-${process.arch}`,
};
const next = { ...old, version: '0.17.0', bundle: 'new', id: 'b'.repeat(64) };
const project: Project = {
  id: 'crash-resume',
  name: 'Keep this resume',
  mainFile: 'main.tex',
  revision: 1,
  runtime: old,
  files: [{ path: 'main.tex', content: 'Preserve my draft' }],
};
await store.recover(project);
const manager = new CompilerMigration(path.join(root, 'backups'), {
  target: () => next,
  assets: async () => new Map(),
  checkDisk: async () => {},
  compile: async (p) => ({
    projectId: p.id,
    revision: p.revision,
    status: 'success',
    pdf: Buffer.from('%PDF-1.7\n' + p.runtime?.bundle),
    diagnostics: [],
    log: '',
    durationMs: 1,
  }),
  cancel: async () => {},
  recover: (p) => store.recover(p),
  workspace,
  checkpoint: async (phase) => {
    if (phase === boundary) {
      setInterval(() => {}, 1000);
      console.log('READY-TO-KILL');
      await new Promise(() => {});
    }
  },
});
const id = randomUUID();
await manager.prepare(id, project);
await manager.apply(id, project);
