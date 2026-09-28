import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
type RecordIdentity = { bytes: number; sha256: string };
const validRecord = (ref: RecordIdentity, max: number) =>
  Number.isSafeInteger(ref?.bytes) &&
  ref.bytes > 0 &&
  ref.bytes <= max &&
  hashPattern.test(ref.sha256);
type NoticeBundleSpec = {
  name: string;
  directory: string;
  pinFile: string;
  sourceLocks: string[];
  selectPin: (value: any) => { version: string; sourceCommit: string; binarySha256: string };
};

// Shared packaging rules for immutable original text bundles. The spec is a
// trusted build-time definition, never a project file or downloaded option.
export function originalNoticeBundle(spec: NoticeBundleSpec) {
  async function regular(file: string, max: number) {
    const state = await fs.lstat(file);
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > max)
      throw new Error(
        `Linked, oversized or nonregular ${spec.name} notice: ${path.basename(file)}`,
      );
    const bytes = await fs.readFile(file);
    if (bytes.length > max) throw new Error(`Oversized ${spec.name} notice.`);
    return bytes;
  }
  async function sources(root: string) {
    const source = path.join(root, 'resources', spec.directory);
    const indexBytes = await regular(path.join(source, 'SOURCES.json'), 2 * 1024 * 1024);
    const index = JSON.parse(indexBytes.toString());
    const pin = spec.selectPin(
      JSON.parse((await regular(path.join(root, spec.pinFile), 2 * 1024 * 1024)).toString()),
    );
    if (
      index.schemaVersion !== 1 ||
      index.compiler !== spec.name ||
      index.completeBinarySbom !== false ||
      index.compilerVersion !== pin.version ||
      index.compilerSourceCommit !== pin.sourceCommit ||
      index.originalCompilerSha256 !== pin.binarySha256 ||
      !Array.isArray(index.components) ||
      !index.components.length ||
      index.components.length > 1024 ||
      index.payload?.file !== 'ORIGINALS.json.gz' ||
      !validRecord(index.payload, 4 * 1024 * 1024) ||
      !Number.isSafeInteger(index.payload.expandedJsonBytes) ||
      index.payload.expandedJsonBytes < 1 ||
      index.payload.expandedJsonBytes > 16 * 1024 * 1024 ||
      !hashPattern.test(index.payload.expandedJsonSha256)
    )
      throw new Error(
        `${spec.name} notices do not match the pinned compiler or valid notice limits.`,
      );
    for (const file of spec.sourceLocks) {
      if (digest(await regular(path.join(root, file), 2 * 1024 * 1024)) !== index.inputs?.[file])
        throw new Error(
          `Pinned ${spec.name} notice source lock changed. Regenerate and review the originals.`,
        );
    }
    const expected = new Map<string, RecordIdentity>();
    const components = new Set<string>();
    let references = 0;
    for (const component of index.components) {
      if (
        typeof component.id !== 'string' ||
        !component.id ||
        components.has(component.id) ||
        !Array.isArray(component.notices) ||
        !component.notices.length
      )
        throw new Error(`Invalid ${spec.name} notice component.`);
      components.add(component.id);
      for (const notice of component.notices) {
        if (
          ++references > 4096 ||
          !validRecord(notice, 8 * 1024 * 1024) ||
          notice.file !== `${notice.sha256}.txt`
        )
          throw new Error(`Invalid ${spec.name} original notice record.`);
        const old = expected.get(notice.file);
        if (old && (old.bytes !== notice.bytes || old.sha256 !== notice.sha256))
          throw new Error(`Conflicting ${spec.name} original notice records.`);
        expected.set(notice.file, { bytes: notice.bytes, sha256: notice.sha256 });
      }
    }
    const expandedBytes = [...expected.values()].reduce((sum, ref) => sum + ref.bytes, 0);
    if (
      references !== index.originalNoticeReferences ||
      expected.size !== index.uniqueOriginalTexts ||
      expandedBytes !== index.expandedTextBytes ||
      expandedBytes > 8 * 1024 * 1024
    )
      throw new Error(`Incomplete ${spec.name} notice index.`);
    const readme = await regular(path.join(source, 'README.md'), 512 * 1024);
    expected.set('SOURCES.json', { bytes: indexBytes.length, sha256: digest(indexBytes) });
    expected.set('README.md', { bytes: readme.length, sha256: digest(readme) });
    return { source, index, indexBytes, readme, expected };
  }

  async function verifyNotices(directory: string, root = repository) {
    const { index, indexBytes, expected } = await sources(root);
    const state = await fs.lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error(`Linked ${spec.name} notice directory.`);
    const found = await fs.readdir(directory);
    if (found.length !== expected.size)
      throw new Error(`Incomplete or unexpected ${spec.name} notices.`);
    const records = [];
    for (const name of found.sort()) {
      const ref = expected.get(name);
      if (!ref) throw new Error(`Unexpected ${spec.name} notice.`);
      const bytes = await regular(path.join(directory, name), ref.bytes);
      if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256)
        throw new Error(`Changed ${spec.name} notice: ${name}`);
      records.push({ path: name, ...ref });
    }
    return {
      compilerVersion: index.compilerVersion,
      originalCompilerSha256: index.originalCompilerSha256,
      sourceIndexSha256: digest(indexBytes),
      components: index.components.length,
      originalNoticeReferences: index.originalNoticeReferences,
      uniqueOriginalTexts: index.uniqueOriginalTexts,
      expandedTextBytes: index.expandedTextBytes,
      records,
      completeBinarySbom: false,
    };
  }

  async function prepareNotices(directory: string, root = repository) {
    const { source, index, indexBytes, readme, expected } = await sources(root);
    const compressed = await regular(path.join(source, index.payload.file), index.payload.bytes);
    if (compressed.length !== index.payload.bytes || digest(compressed) !== index.payload.sha256)
      throw new Error(`Changed compressed ${spec.name} originals.`);
    const expanded = gunzipSync(compressed, { maxOutputLength: index.payload.expandedJsonBytes });
    if (
      expanded.length !== index.payload.expandedJsonBytes ||
      digest(expanded) !== index.payload.expandedJsonSha256
    )
      throw new Error(`Changed expanded ${spec.name} originals.`);
    const texts = JSON.parse(expanded.toString());
    if (
      !texts ||
      Array.isArray(texts) ||
      typeof texts !== 'object' ||
      Object.keys(texts).length !== index.uniqueOriginalTexts
    )
      throw new Error(`Incomplete ${spec.name} original text payload.`);
    const outputs = new Map<string, Uint8Array>([
      ['SOURCES.json', indexBytes],
      ['README.md', readme],
    ]);
    for (const [hash, encoded] of Object.entries(texts)) {
      const name = `${hash}.txt`,
        ref = expected.get(name);
      if (!hashPattern.test(hash) || !ref || typeof encoded !== 'string')
        throw new Error(`Unexpected ${spec.name} original text.`);
      const bytes = Buffer.from(encoded, 'base64');
      if (
        bytes.toString('base64') !== encoded ||
        bytes.length !== ref.bytes ||
        digest(bytes) !== hash
      )
        throw new Error(`Changed ${spec.name} original text.`);
      outputs.set(name, bytes);
    }
    // Validate the complete source set before changing any generated output.
    await fs.mkdir(directory, { recursive: true });
    const state = await fs.lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error(`Linked ${spec.name} notice directory.`);
    for (const name of await fs.readdir(directory)) {
      if (!outputs.has(name)) throw new Error(`Unexpected ${spec.name} notice output.`);
      const old = await fs.lstat(path.join(directory, name));
      if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1)
        throw new Error(`Linked or nonregular ${spec.name} notice output.`);
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
    return verifyNotices(directory, root);
  }

  return { prepare: prepareNotices, verify: verifyNotices };
}
