import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const virtualOwners: Record<string, string[]> = {
  '\0rolldown/runtime.js': ['node_modules/rolldown'],
  '\0vite/modulepreload-polyfill.js': ['node_modules/vite', 'node_modules/rolldown'],
  '\0vite/preload-helper.js': ['node_modules/vite', 'node_modules/rolldown'],
};

export function relativeInput(root: string, input: string) {
  if (!input || input.includes('\0') || input.includes('\\'))
    throw new Error('Invalid module path.');
  const clean = input.split('?')[0];
  const relative = path.relative(root, path.resolve(root, clean)).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    throw new Error('Module path escapes the source checkout.');
  return relative;
}

export function packageLocation(file: string) {
  const parts = file.split('/');
  const start = parts.lastIndexOf('node_modules');
  if (start < 0) return undefined;
  const name = parts[start + 1];
  if (!name || name.startsWith('.')) throw new Error('Invalid npm module identity.');
  const end = start + (name.startsWith('@') ? 3 : 2);
  if (parts.length < end || parts.slice(start + 1, end).some((p) => !p))
    throw new Error('Incomplete scoped npm identity.');
  return parts.slice(0, end).join('/');
}

export function verifyCoverage(members: string[], outputs: string[]) {
  const relevant = (file: string) => /\.(?:cjs|mjs|js)(?:\.map)?$/.test(file);
  const actual = members
    .map((f) => f.replace(/^\//, ''))
    .filter(relevant)
    .sort();
  const reproduced = outputs.filter(relevant).sort();
  if (
    new Set(actual).size !== actual.length ||
    new Set(reproduced).size !== reproduced.length ||
    JSON.stringify(actual) !== JSON.stringify(reproduced)
  )
    throw new Error('Packaged JavaScript or source-map coverage differs from the replay.');
  return actual;
}

export async function inventoryJavaScriptReplay(options: {
  root: string;
  asarMembers: string[];
  readAsar: (file: string) => Uint8Array;
  electron: any[];
  renderer: any[];
}) {
  const { root, readAsar } = options;
  const lockBytes = await fs.readFile(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString());
  const packages = new Map<string, any>();
  const modules = new Map<string, any>();
  const outputs: any[] = [];
  const external = new Set<string>();
  const sources = new Map<string, Buffer>();
  const packageInfo = async (location: string, role: string) => {
    let item = packages.get(location);
    if (!item) {
      const pkgBytes = await fs.readFile(path.join(root, location, 'package.json'));
      const pkg = JSON.parse(pkgBytes.toString());
      const entry = lock.packages[location];
      if (!entry || entry.version !== pkg.version || !entry.integrity || !entry.resolved)
        throw new Error(`Package is not bound to the dependency lock: ${location}`);
      item = {
        location,
        name: pkg.name,
        version: pkg.version,
        declaredLicense: pkg.license ?? entry.license,
        markedDevInNpmLock: entry.dev === true,
        packageJsonSha256: sha256(pkgBytes),
        integrity: entry.integrity,
        url: entry.resolved,
        roles: [],
      };
      packages.set(location, item);
    }
    if (!item.roles.includes(role)) item.roles.push(role);
    return item;
  };
  const publishedMaps = new Map<string, { file: string; bytes: Buffer; map: any }[]>();
  const findPublishedSource = async (location: string, file: string, content: string) => {
    let maps = publishedMaps.get(location);
    if (!maps) {
      maps = [];
      let total = 0;
      const visit = async (relative: string) => {
        for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('Linked package source-map input.');
          const name = relative + '/' + entry.name;
          if (entry.isDirectory() && entry.name !== 'node_modules') await visit(name);
          else if (entry.isFile() && entry.name.endsWith('.map')) {
            const bytes = await fs.readFile(path.join(root, name));
            total += bytes.length;
            if (bytes.length > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 || maps!.length >= 2000)
              throw new Error('Package source-map budget exceeded.');
            maps!.push({ file: name, bytes, map: JSON.parse(bytes.toString()) });
          }
        }
      };
      await visit(location);
      publishedMaps.set(location, maps);
    }
    const candidates = [];
    for (const original of maps) {
      for (let i = 0; i < (original.map.sources?.length ?? 0); i++) {
        const name = original.map.sources[i];
        if (typeof name !== 'string' || /[a-z]+:\/\//i.test(name)) continue;
        const candidate = relativeInput(
          root,
          path.resolve(root, path.dirname(original.file), original.map.sourceRoot ?? '', name),
        );
        if (candidate === file && original.map.sourcesContent?.[i] === content) {
          sources.set(original.file, original.bytes);
          candidates.push({ file: original.file, sha256: sha256(original.bytes), sourceIndex: i });
        }
      }
    }
    if (!candidates.length) throw new Error(`No original package source map contains ${file}`);
    return candidates.sort((a, b) => a.file.localeCompare(b.file));
  };
  const moduleInfo = async (
    id: string,
    role: string,
    output: string,
    bytes?: number,
    renderedCode?: string | null,
    embeddedSource?: string,
  ) => {
    const key = id.startsWith('\0') ? id : relativeInput(root, id);
    let item = modules.get(key);
    if (!item) {
      if (id.startsWith('\0')) {
        const owners = virtualOwners[id];
        if (!owners) throw new Error(`Unreviewed generated module: ${JSON.stringify(id)}`);
        for (const owner of owners) await packageInfo(owner, 'generator');
        item = { id, kind: 'generated', generators: owners, contributions: [] };
      } else {
        const file = relativeInput(root, id);
        const full = path.join(root, file);
        const owner = packageLocation(file);
        let content: Buffer;
        let publishedSourceMaps:
          { file: string; sha256: string; sourceIndex: number }[] | undefined;
        try {
          if ((await fs.realpath(full)) !== full) throw new Error(`Linked build input: ${file}`);
          content = await fs.readFile(full);
          sources.set(file, content);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
            role !== 'distributed-source-map' ||
            !owner ||
            typeof embeddedSource !== 'string'
          )
            throw error;
          publishedSourceMaps = await findPublishedSource(owner, file, embeddedSource);
          content = Buffer.from(embeddedSource);
        }
        if (owner) await packageInfo(owner, role);
        item = {
          id: file,
          kind: publishedSourceMaps
            ? 'npm-source-map-content'
            : owner
              ? 'npm-source'
              : 'folio-source',
          ...(publishedSourceMaps ? { publishedSourceMaps } : {}),
          file,
          sourceBytes: content.length,
          sourceSha256: sha256(content),
          ...(owner ? { package: owner } : {}),
          contributions: [],
        };
      }
      modules.set(key, item);
    } else if (item.package) await packageInfo(item.package, role);
    const contribution = {
      output,
      role,
      ...(bytes === undefined ? {} : { reportedBytes: bytes }),
      ...(renderedCode == null ? {} : { renderedCodeSha256: sha256(renderedCode) }),
    };
    if (!item.contributions.some((c: any) => c.output === output && c.role === role))
      item.contributions.push(contribution);
    return item;
  };
  const addOutput = async (file: string, content: Uint8Array, kind: string) => {
    file = relativeInput(root, file);
    if (!file.startsWith('dist/') && !file.startsWith('dist-electron/'))
      throw new Error('Unexpected build output path.');
    if (outputs.some((o) => o.file === file)) throw new Error('Duplicate build output.');
    const packaged = readAsar(file);
    if (!Buffer.from(content).equals(packaged))
      throw new Error(`Replayed output differs from packaged bytes: ${file}`);
    const entry = { file, kind, bytes: content.length, sha256: sha256(content) };
    outputs.push(entry);
    return file;
  };
  await packageInfo('node_modules/esbuild', 'generator');
  for (const build of options.electron) {
    if (!build.metafile || !build.outputFiles) throw new Error('Missing esbuild replay metadata.');
    for (const output of build.outputFiles) {
      const file = await addOutput(
        output.path,
        output.contents,
        output.path.endsWith('.map') ? 'source-map' : 'javascript',
      );
      if (file.endsWith('.map')) {
        const map = JSON.parse(Buffer.from(output.contents).toString());
        if (!Array.isArray(map.sources) || map.sources.length !== map.sourcesContent?.length)
          throw new Error('Incomplete source-map contents.');
        for (let i = 0; i < map.sources.length; i++) {
          const source = relativeInput(
            root,
            path.resolve(root, path.dirname(file), map.sourceRoot ?? '', map.sources[i]),
          );
          const input = await moduleInfo(
            source,
            'distributed-source-map',
            file,
            undefined,
            undefined,
            map.sourcesContent[i],
          );
          if (
            typeof map.sourcesContent[i] !== 'string' ||
            sha256(map.sourcesContent[i]) !== input.sourceSha256
          )
            throw new Error(`Source-map content differs from original input: ${source}`);
        }
      } else {
        const metadata = build.metafile.outputs[file];
        if (!metadata) throw new Error(`Missing output metadata: ${file}`);
        for (const [id, details] of Object.entries(metadata.inputs) as [
          string,
          { bytesInOutput: number },
        ][]) {
          if (details.bytesInOutput > 0)
            await moduleInfo(id, 'runtime-code', file, details.bytesInOutput);
        }
        for (const dependency of metadata.imports ?? [])
          if (dependency.external) external.add(dependency.path);
      }
    }
  }
  for (const build of options.renderer)
    for (const output of build.output) {
      const content = Buffer.from(output.type === 'chunk' ? output.code : output.source);
      const file = await addOutput(
        'dist/' + output.fileName,
        content,
        output.type === 'chunk' || /\.(mjs|js)$/.test(output.fileName) ? 'javascript' : 'asset',
      );
      if (output.type === 'chunk') {
        for (const [id, details] of Object.entries(output.modules) as [
          string,
          { renderedLength: number; code: string | null },
        ][]) {
          if (details.renderedLength > 0)
            await moduleInfo(id, 'runtime-code', file, details.renderedLength, details.code);
        }
        for (const dependency of [...output.imports, ...output.dynamicImports]) {
          if (
            !outputs.some((o) => o.file === 'dist/' + dependency) &&
            !build.output.some((o: any) => o.fileName === dependency)
          )
            external.add(dependency);
        }
      } else if (/\.(mjs|js)$/.test(output.fileName)) {
        if (output.originalFileNames?.length !== 1)
          throw new Error('Worker asset has ambiguous source ownership.');
        const input = await moduleInfo(
          output.originalFileNames[0],
          'runtime-asset',
          file,
          content.length,
        );
        if (input.sourceSha256 !== sha256(content))
          throw new Error('JavaScript asset differs from its declared original.');
      }
    }
  const coverage = verifyCoverage(
    options.asarMembers,
    outputs.map((o) => o.file),
  );
  const permitted = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => 'node:' + m),
    'electron',
  ]);
  const unresolvedExternalImports = [...external].filter((e) => !permitted.has(e)).sort();
  if (unresolvedExternalImports.length)
    throw new Error(`Unmapped static external imports: ${unresolvedExternalImports.join(', ')}`);
  for (const [file, original] of sources)
    if (!original.equals(await fs.readFile(path.join(root, file))))
      throw new Error('Source changed during inventory.');
  if (!lockBytes.equals(await fs.readFile(path.join(root, 'package-lock.json'))))
    throw new Error('Dependency lock changed during inventory.');
  return {
    schemaVersion: 1,
    packageLockSha256: sha256(lockBytes),
    reproducedOutputs: outputs.sort((a, b) => a.file.localeCompare(b.file)),
    packagedJavaScriptAndMaps: coverage,
    modules: [...modules.values()].sort((a, b) => a.id.localeCompare(b.id)),
    packages: [...packages.values()].sort((a, b) => a.location.localeCompare(b.location)),
    staticExternalImports: [...external].sort(),
    unresolvedStaticExternalImports: unresolvedExternalImports,
    generatedModuleOwnership:
      'Reviewed internal Vite/Rolldown IDs identify the generator chain; output metadata does not assign every emitted helper byte to an original author.',
    completeBinarySbom: false,
    scope:
      'Byte-reproduced application JavaScript and distributed source maps inside app.asar. Records actual source contributions, copied worker code and generated helpers. Does not map Electron/Chromium internals, native/compiler/TeX resources, per-package vendored subcomponents, dynamic runtime discovery or every original license obligation.',
  };
}

export function javascriptBom(inventory: any, version: string, asarSha256: string) {
  const prop = (name: string, value: unknown) => ({
    name,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  });
  const purl = (p: any) =>
    `pkg:npm/${p.name.startsWith('@') ? '%40' + p.name.slice(1) : p.name}@${encodeURIComponent(p.version)}`;
  const component = (p: any) => ({
    type: p.roles.every((r: string) => r === 'generator') ? 'application' : 'library',
    'bom-ref': purl(p),
    name: p.name,
    version: p.version,
    purl: purl(p),
    ...(typeof p.declaredLicense === 'string'
      ? { licenses: [{ expression: p.declaredLicense }] }
      : {}),
    properties: [
      prop('folio:npm-location', p.location),
      prop('folio:npm-lock-dev', p.markedDevInNpmLock),
      prop('folio:bundle-roles', p.roles),
      prop(
        'folio:license-declaration-source',
        'Original npm package.json; nested component terms remain separately reviewable',
      ),
    ],
  });
  const runtime = inventory.packages.filter((p: any) =>
    p.roles.some((r: string) => r !== 'generator'),
  );
  const generators = inventory.packages.filter((p: any) => p.roles.includes('generator'));
  const packages = new Map(inventory.packages.map((p: any) => [p.location, p]));
  const files = inventory.reproducedOutputs.filter((o: any) =>
    inventory.packagedJavaScriptAndMaps.includes(o.file),
  );
  const dependencies = files.map((file: any) => ({
    ref: `folio:javascript-file:${file.file}`,
    dependsOn: [
      ...new Set(
        inventory.modules
          .filter((m: any) => m.package && m.contributions.some((c: any) => c.output === file.file))
          .map((m: any) => purl(packages.get(m.package))),
      ),
    ].sort(),
  }));
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': 'folio:application-javascript',
        name: 'Folio application JavaScript',
        version,
        properties: [
          prop('folio:app-asar-sha256', asarSha256),
          prop('folio:inventory-sha256', sha256(JSON.stringify(inventory, null, 2) + '\n')),
          prop('folio:scope', inventory.scope),
          prop('folio:complete-binary-sbom', false),
        ],
      },
      tools: { components: generators.map(component) },
    },
    components: [
      ...runtime.map(component),
      ...files.map((f: any) => ({
        type: 'file',
        'bom-ref': `folio:javascript-file:${f.file}`,
        name: f.file,
        hashes: [{ alg: 'SHA-256', content: f.sha256 }],
        properties: [prop('folio:bytes', f.bytes), prop('folio:kind', f.kind)],
      })),
    ],
    dependencies: [
      {
        ref: 'folio:application-javascript',
        dependsOn: files.map((f: any) => `folio:javascript-file:${f.file}`),
      },
      ...dependencies,
    ],
    compositions: [{ aggregate: 'incomplete', assemblies: ['folio:application-javascript'] }],
  };
}
