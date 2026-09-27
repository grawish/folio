import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const require = createRequire(import.meta.url);
const addInternationalFormats = require('ajv-formats-draft2019') as (ajv: Ajv) => void;
export const sha256 = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex');
export const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export type BundleEntry = {
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  mode: number;
  bytes?: number;
  sha256?: string;
  target?: string;
  resolvedTarget?: string;
};
export type BundleInventory = {
  schemaVersion: 1;
  entries: BundleEntry[];
  regularFiles: number;
  symlinks: number;
  directories: number;
  logicalFileBytes: number;
};
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);

export async function inventoryBundle(root: string): Promise<BundleInventory> {
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw new Error('Choose an ordinary app directory without symbolic-link parents.');
  async function scan(hashFiles: boolean) {
    const entries: BundleEntry[] = [];
    const identities: string[] = [];
    const buffer = Buffer.alloc(hashFiles ? 1024 * 1024 : 0);
    let bytes = 0;
    async function visit(relative: string) {
      if (entries.length >= 20_000) throw new Error('App inventory exceeds 20,000 entries.');
      const file = path.join(root, relative);
      const stat = await fs.lstat(file, { bigint: true });
      const identity = (s: typeof stat) =>
        [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':');
      const row: BundleEntry = {
        path: relative || '.',
        mode: Number(stat.mode & 0o7777n),
        kind: 'file',
      };
      if (stat.isSymbolicLink()) {
        row.kind = 'symlink';
        row.target = await fs.readlink(file);
        if (path.isAbsolute(row.target)) throw new Error('App contains an absolute symbolic link.');
        const resolved = await fs.realpath(file);
        if (!inside(root, resolved)) throw new Error('App symbolic link escapes its bundle.');
        row.resolvedTarget = path.relative(root, resolved) || '.';
      } else if (stat.isDirectory()) row.kind = 'directory';
      else if (stat.isFile()) {
        row.bytes = Number(stat.size);
        bytes += row.bytes;
        if (row.bytes > 2 * 1024 ** 3 || bytes > 4 * 1024 ** 3)
          throw new Error('App inventory exceeds its file or total byte limit.');
        if (hashFiles) {
          const handle = await fs.open(
            file,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (identity(await handle.stat({ bigint: true })) !== identity(stat))
              throw new Error('App changed while opening a file.');
            const hash = createHash('sha256');
            let readBytes = 0;
            for (;;) {
              const read = await handle.read(buffer, 0, buffer.length, null);
              if (!read.bytesRead) break;
              readBytes += read.bytesRead;
              if (readBytes > row.bytes) throw new Error('App file grew while being read.');
              hash.update(buffer.subarray(0, read.bytesRead));
            }
            if (
              readBytes !== row.bytes ||
              identity(await handle.stat({ bigint: true })) !== identity(stat)
            )
              throw new Error('App file changed while being read.');
            row.sha256 = hash.digest('hex');
          } finally {
            await handle.close();
          }
        }
      } else throw new Error('App contains a special file that cannot be inventoried.');
      entries.push(row);
      identities.push(
        `${relative}:${identity(stat)}:${row.target ?? ''}:${row.resolvedTarget ?? ''}`,
      );
      if (row.kind === 'directory')
        for (const name of (await fs.readdir(file)).sort())
          await visit(relative ? `${relative}/${name}` : name);
    }
    await visit('');
    return { entries, identities, bytes };
  }
  const first = await scan(true);
  const second = await scan(false);
  if (JSON.stringify(first.identities) !== JSON.stringify(second.identities))
    throw new Error('App tree changed during inventory. Try again with an idle artifact.');
  return {
    schemaVersion: 1,
    entries: first.entries,
    regularFiles: first.entries.filter((row) => row.kind === 'file').length,
    symlinks: first.entries.filter((row) => row.kind === 'symlink').length,
    directories: first.entries.filter((row) => row.kind === 'directory').length,
    logicalFileBytes: first.bytes,
  };
}

export function bundleBom(inventory: BundleInventory, name: string, version: string) {
  const property = (name: string, value: unknown) => ({ name, value: String(value) });
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': 'folio:application',
        name,
        version,
        properties: [
          property('folio:inventory:sha256', sha256(jsonBytes(inventory))),
          property('folio:inventory:scope', 'Physical bundle files and internal symbolic links'),
          property('folio:release-audit-complete', false),
        ],
        components: inventory.entries
          .filter((row) => row.kind !== 'directory')
          .map((row) => ({
            type: 'file',
            'bom-ref': `folio:file:${encodeURIComponent(row.path)}`,
            name: row.path,
            ...(row.sha256 ? { hashes: [{ alg: 'SHA-256', content: row.sha256 }] } : {}),
            properties: [
              property('folio:file:kind', row.kind),
              property('folio:file:mode', row.mode.toString(8)),
              ...(row.bytes === undefined ? [] : [property('folio:file:bytes', row.bytes)]),
              ...(row.target === undefined
                ? []
                : [
                    property('folio:file:link-target', row.target),
                    property('folio:file:resolved-target', row.resolvedTarget),
                  ]),
            ],
          })),
      },
    },
    compositions: [{ aggregate: 'incomplete', assemblies: ['folio:application'] }],
    properties: [
      property(
        'folio:remaining',
        'Map embedded ASAR/ZIP/PAR members and linked components to their sources and licenses; finish redistribution review and inventory the final signed app.',
      ),
      property(
        'folio:filesystem-scope',
        'Regular-file bytes, directories, POSIX modes and internal link targets. Excludes extended attributes, ACLs, resource forks, signing/notarization validation and disk-image contents.',
      ),
    ],
  };
}

export async function validateBundleBom(bom: unknown) {
  const folder = new URL('../resources/sbom-schema/', import.meta.url);
  const provenance = JSON.parse(await fs.readFile(new URL('source.json', folder), 'utf8'));
  const schemas: Record<string, object> = {};
  for (const row of provenance.files) {
    const raw = await fs.readFile(new URL(row.path, folder));
    const bytes = row.path.endsWith('.gz')
      ? gunzipSync(raw, { maxOutputLength: 1024 * 1024 })
      : raw;
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256)
      throw new Error('The retained CycloneDX schema or license changed.');
    if (row.path.endsWith('.gz')) schemas[row.path.slice(0, -3)] = JSON.parse(bytes.toString());
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  addInternationalFormats(ajv);
  ajv.addSchema(schemas['spdx.schema.json'], 'http://cyclonedx.org/schema/spdx.schema.json');
  ajv.addSchema(
    schemas['jsf-0.82.schema.json'],
    'http://cyclonedx.org/schema/jsf-0.82.schema.json',
  );
  const validate = ajv.compile(schemas['bom-1.6.schema.json']);
  if (!validate(bom))
    throw new Error(`Invalid CycloneDX record: ${ajv.errorsText(validate.errors)}`);
}
