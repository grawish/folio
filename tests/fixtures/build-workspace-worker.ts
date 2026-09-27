import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BuildWorkspaces, cleanupBuildWorkspaces } from '../../electron/core/build-workspaces';

const [root, mode] = process.argv.slice(2);
const hold = async (phase: string) => {
  process.send?.({ phase });
  await new Promise(() => {});
};
setInterval(() => {}, 1000);
if (mode === 'create') {
  const lease = await new BuildWorkspaces(root).create();
  await fs.mkdir(path.join(lease.path, 'source'));
  await fs.writeFile(
    path.join(lease.path, 'source', 'main.tex'),
    'Synthetic staged source.\n'.repeat(8192),
  );
  process.send?.({ phase: 'created', payload: lease.path });
} else if (mode === 'compile') {
  const { Compiler } = await import('../../electron/core/compiler');
  Compiler.prototype['run'] = async (...args) => {
    process.send?.({ phase: 'compiled-snapshot', payload: args[3] });
    return new Promise(() => {});
  };
  const content = await fs.readFile(process.argv[4], 'utf8');
  const result = await new Compiler(process.argv[5], root).compile({
    id: 'build-recovery',
    name: 'Crash recovery fixture',
    revision: 0,
    mainFile: 'main.tex',
    files: [{ path: 'main.tex', content }],
  });
  process.send?.({ phase: 'unexpected-completion', status: result.status, log: result.log });
} else {
  const rm = fs.rm;
  const unlink = fs.unlink;
  fs.rm = async (...args: Parameters<typeof fs.rm>) => {
    if (path.basename(String(args[0])) === 'files' && mode === 'before-files') await hold(mode);
    await rm(...args);
    if (path.basename(String(args[0])) === 'files' && mode === 'after-files') await hold(mode);
  };
  fs.unlink = async (...args: Parameters<typeof fs.unlink>) => {
    await unlink(...args);
    if (path.basename(String(args[0])) === 'owner.json' && mode === 'after-owner') await hold(mode);
  };
  await cleanupBuildWorkspaces(root);
  process.send?.({ phase: 'unexpected-completion' });
}
