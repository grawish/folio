import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';

export default defineConfig(({ command }) => {
  // Fast Refresh injects a small inline bootstrap in development. Give it a
  // per-server nonce while keeping the packaged app's script policy strict.
  const nonce = randomBytes(18).toString('base64');
  return {
    plugins: [
      react(),
      {
        name: 'folio-development-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`);
        },
      },
    ],
    html: command === 'serve' ? { cspNonce: nonce } : undefined,
    base: './',
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { chunkSizeWarningLimit: 1500 },
  };
});
