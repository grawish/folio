import { promises as fs } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { zipSync } from 'fflate';
import path from 'node:path';
import { buildResourcePack, ResourcePackVerifier } from '../../electron/core/resource-pack';
import { runtimePin, type RuntimeManifest } from '../../electron/core/runtime';

export const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
export async function packFixture(root: string) {
  const baseRoot = path.join(root, 'bundled');
  await fs.mkdir(baseRoot);
  const files = new Map([
    ['tectonic', Buffer.from('Synthetic engine; never execute.')],
    [
      'bundle.zip',
      Buffer.from(
        zipSync({
          'article.cls': Buffer.from('Synthetic class.'),
          SHA256SUM: Buffer.from('a'.repeat(64)),
        }),
      ),
    ],
  ]);
  for (const [name, bytes] of files)
    await fs.writeFile(path.join(baseRoot, name), bytes, {
      mode: name === 'tectonic' ? 0o700 : 0o600,
    });
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    version: '0.17.0',
    bundle: 'folio-core-v1',
    platform: 'darwin-arm64',
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])),
  };
  await fs.writeFile(path.join(baseRoot, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(baseRoot, 'THIRD_PARTY_NOTICES.md'), 'Synthetic base notices.');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const verifier = new ResourcePackVerifier({ fixture: pem });
  const options = {
    baseRoot,
    id: 'folio-check-v1',
    title: 'Example resources',
    description: 'Synthetic fixture.',
    bundle: 'folio-check-v1',
    packages: ['folio-check.sty'],
    resources: new Map([['folio-check.sty', Buffer.from('Synthetic package.')]]),
    notices: 'Original synthetic test material.',
    probe: '\\documentclass{article}\\begin{document}Check.\\end{document}',
    keyId: 'fixture',
    privateKey,
  };
  const built = await buildResourcePack(options);
  return {
    root,
    baseRoot,
    manifest,
    base: runtimePin(manifest),
    pem,
    privateKey,
    verifier,
    options,
    built,
    pack: verifier.read(built.archive),
  };
}
