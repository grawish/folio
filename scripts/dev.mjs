import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { buildElectron } from './build-electron.mjs';

await buildElectron();
const server = await createServer();
await server.listen();
const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ['.'], { stdio: 'inherit', env });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => app.kill());
process.on('SIGTERM', () => app.kill());
