import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { version, biber } from './runtime-config.mjs';

const offline = process.argv.includes('--offline');
const cache = path.resolve('.cache/license-sources');
const output = path.resolve('artifacts/license-materials/compiler-sources');
const lock = JSON.parse(await fs.readFile('resources/runtime-license-sources.lock.json', 'utf8'));
if (
  lock.schemaVersion !== 1 ||
  lock.compilerVersion !== version ||
  lock.biberVersion !== biber.version
)
  throw new Error('Compiler versions changed; review and update the source-material lock.');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(output, { recursive: true });
const sources = [];
for (const source of lock.sources) {
  if (
    !/^[a-z0-9-]+$/.test(source.id) ||
    !/^[a-z0-9-]+\.tar\.gz$/.test(source.archive) ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes <= 0 ||
    source.bytes > 64 * 1024 * 1024 ||
    source.url !== `https://codeload.github.com/${source.repository}/tar.gz/${source.commit}`
  )
    throw new Error('Invalid source-material lock entry.');
  const cached = path.join(cache, source.archive);
  let bytes;
  try {
    const stat = await fs.lstat(cached);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.bytes)
      throw new Error(`${source.id}: cached archive type or size differs from its lock`);
    bytes = await fs.readFile(cached);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (offline) throw new Error(`Offline source archive is missing: ${source.id}`);
    const response = await fetch(source.url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
    const parts = [];
    let length = 0;
    for await (const part of response.body) {
      length += part.length;
      if (length > source.bytes) {
        await response.body.cancel().catch(() => {});
        throw new Error(`${source.id}: archive exceeds its locked size`);
      }
      parts.push(part);
    }
    bytes = Buffer.concat(parts);
  }
  if (bytes.length !== source.bytes || hash(bytes) !== source.sha256)
    throw new Error(`${source.id}: archive differs from its reviewed source-material lock`);
  await fs.writeFile(cached, bytes);
  const directory = path.join(output, source.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, source.archive), bytes);
  const materials = [];
  for (const member of source.materials) {
    if (
      member.startsWith('/') ||
      member.startsWith('-') ||
      member.includes('\\') ||
      member.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error(`${source.id}: invalid material path`);
    // Read only named members to stdout. Never extract an archive's links or
    // paths into the workspace, and never execute downloaded build scripts.
    const text = execFileSync('tar', ['-xOf', cached, member], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    const relative = member.split('/').slice(1).join('/');
    if (!relative) throw new Error('Expected a source file inside an archive root.');
    const target = path.join(directory, 'materials', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
    materials.push({ path: relative, bytes: text.length, sha256: hash(text) });
  }
  sources.push({ ...source, materials });
}
const inventory = {
  scope: lock.scope,
  releaseAuditComplete: false,
  sources,
  pending: [
    'Match all Rust and native linked dependencies to the exact Tectonic binary.',
    'Inventory and obtain sources/notices for Biber embedded Perl/native dependencies.',
    'Map all 516 locked TeX resources and fonts to component licenses and source requirements.',
    'Determine complete corresponding-source materials, build instructions and redistribution terms.',
    'Generate and verify the full final signed-app SBOM and shipped notices.',
  ],
};
await fs.writeFile(path.join(output, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      output,
      archives: sources.length,
      materialFiles: sources.reduce((n, s) => n + s.materials.length, 0),
      completeBinaryAudit: false,
    },
    null,
    2,
  ),
);
