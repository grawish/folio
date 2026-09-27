import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const [root, mode] = process.argv.slice(2);
const spawn = cp.spawn;
cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
  const child = spawn(...args);
  if (args[0] === '/bin/bash' && Array.isArray(args[1]) && args[1][4] === 'folio-compiler-limits') {
    child.once('spawn', () => process.send?.({ type: 'spawned', pid: child.pid }));
    let output = '';
    let ready = false;
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      if (!ready && output.includes('folio-parent-ready')) {
        ready = true;
        process.send?.({ type: 'ready' });
      }
    });
  }
  return child;
}) as typeof cp.spawn;
syncBuiltinESMExports();
const { Compiler } = await import('../../electron/core/compiler');
const controller = new AbortController();
process.on('message', (message) => {
  if (message === 'cancel') controller.abort();
});
process.on('SIGTERM', () => controller.abort());
const compiler = new Compiler(root, root, mode === 'timeout' ? 2000 : 15_000);
// A descendant intentionally retains the log pipes. Its parent can exit cleanly
// while the descendant keeps running; checking only the leader would miss it.
const program = `
const cp = require('node:child_process'), fs = require('node:fs');
const helper = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
helper.once('spawn', () => {
  fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid, helperPid:helper.pid}));
  console.log('folio-parent-ready');
  if (process.argv[2] === 'success') setInterval(() => { if (fs.existsSync(process.argv[1] + '.finish')) process.exit(0); }, 25);
});
setInterval(()=>{},1000);
`;
const result = await compiler['run'](
  process.execPath,
  ['-e', program, path.join(root, 'native.json'), mode],
  root,
  root,
  root,
  controller.signal,
  path.dirname(process.execPath),
);
process.send?.({ type: 'result', ...result }, () => process.disconnect?.());
