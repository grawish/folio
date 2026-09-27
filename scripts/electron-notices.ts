import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const names = ['LICENSE', 'LICENSES.chromium.html'];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Notice = {
  file: string;
  bytes: number;
  sha256: string;
  compressedFile: string;
  compressedBytes: number;
  compressedSha256: string;
  copy: string;
};
async function regular(file: string, max: number) {
  const state = await fs.lstat(file);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > max)
    throw new Error(`Linked, oversized or nonregular Electron notice: ${path.basename(file)}`);
  const bytes = await fs.readFile(file);
  if (bytes.length > max) throw new Error('Oversized Electron notice.');
  return bytes;
}
async function sources(root: string) {
  const source = path.join(root, 'resources/electron-notices');
  const indexBytes = await regular(path.join(source, 'SOURCES.json'), 32 * 1024);
  const index = JSON.parse(indexBytes.toString());
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const locked = lock.packages['node_modules/electron'];
  if (
    index.schemaVersion !== 1 ||
    index.platform !== 'darwin-arm64' ||
    index.completeBinarySbom !== false ||
    index.package?.location !== 'node_modules/electron' ||
    !locked ||
    index.electronVersion !== locked.version ||
    index.package.version !== locked.version ||
    pkg.devDependencies.electron !== locked.version ||
    index.package.integrity !== locked.integrity ||
    index.package.url !== locked.resolved ||
    !Array.isArray(index.noticeFiles) ||
    index.noticeFiles.length !== names.length
  )
    throw new Error('Electron notices do not match the pinned dependency.');
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const [i, notice] of (index.noticeFiles as Notice[]).entries()) {
    if (
      notice.file !== names[i] ||
      notice.compressedFile !== `${names[i]}.gz` ||
      notice.copy !== 'complete-original' ||
      !Number.isSafeInteger(notice.bytes) ||
      notice.bytes < 1 ||
      notice.bytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(notice.compressedBytes) ||
      notice.compressedBytes < 1 ||
      notice.compressedBytes > 4 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(notice.sha256) ||
      !/^[a-f0-9]{64}$/.test(notice.compressedSha256)
    )
      throw new Error('Invalid original Electron notice record.');
    expected.set(notice.file, notice);
  }
  const readme = await regular(path.join(source, 'README.md'), 32 * 1024);
  expected.set('SOURCES.json', { bytes: indexBytes.length, sha256: digest(indexBytes) });
  expected.set('README.md', { bytes: readme.length, sha256: digest(readme) });
  return { source, index, indexBytes, readme, expected };
}

export async function verifyElectronNotices(directory: string, root = repository) {
  const { index, indexBytes, expected } = await sources(root);
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error('Linked Electron notice directory.');
  const found = await fs.readdir(directory);
  if (found.length !== expected.size) throw new Error('Incomplete or unexpected Electron notices.');
  const records = [];
  for (const name of found.sort()) {
    const ref = expected.get(name);
    if (!ref) throw new Error('Unexpected Electron notice.');
    const bytes = await regular(path.join(directory, name), ref.bytes);
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256)
      throw new Error(`Changed Electron notice: ${name}`);
    records.push({ path: name, bytes: ref.bytes, sha256: ref.sha256 });
  }
  return {
    electronVersion: index.electronVersion,
    platform: index.platform,
    originalNoticeFiles: names.length,
    sourceIndexSha256: digest(indexBytes),
    upstreamArchiveSha256: index.upstream.archive.sha256,
    records,
    completeBinarySbom: false,
  };
}

export async function prepareElectronNotices(directory: string, root = repository) {
  const { source, index, indexBytes, readme } = await sources(root);
  const outputs = new Map<string, Uint8Array>([
    ['SOURCES.json', indexBytes],
    ['README.md', readme],
  ]);
  // Check all compressed and expanded bytes before replacing any output.
  for (const notice of index.noticeFiles as Notice[]) {
    const compressed = await regular(
      path.join(source, notice.compressedFile),
      notice.compressedBytes,
    );
    if (
      compressed.length !== notice.compressedBytes ||
      digest(compressed) !== notice.compressedSha256
    )
      throw new Error(`Changed compressed Electron notice: ${notice.file}`);
    const bytes = gunzipSync(compressed, { maxOutputLength: notice.bytes });
    if (bytes.length !== notice.bytes || digest(bytes) !== notice.sha256)
      throw new Error(`Changed expanded Electron notice: ${notice.file}`);
    outputs.set(notice.file, bytes);
  }
  await fs.mkdir(directory, { recursive: true });
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error('Linked Electron notice directory.');
  for (const name of await fs.readdir(directory)) {
    if (!outputs.has(name)) throw new Error('Unexpected Electron notice output.');
    const old = await fs.lstat(path.join(directory, name));
    if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1)
      throw new Error('Linked or nonregular Electron notice output.');
  }
  for (const [name, bytes] of outputs) {
    const target = path.join(directory, name),
      temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  return verifyElectronNotices(directory, root);
}
