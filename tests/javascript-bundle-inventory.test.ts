import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  inventoryJavaScriptReplay,
  javascriptBom,
  packageLocation,
  relativeInput,
  verifyCoverage,
} from '../scripts/javascript-bundle-inventory';
import { validateBundleBom } from '../scripts/mac-app-inventory';

async function fixture(embedded = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-js-inventory-')));
  const write = async (name: string, value: unknown) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(
      path.join(root, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  for (const name of ['alpha', 'esbuild'])
    await write(`node_modules/${name}/package.json`, { name, version: '1.0.0', license: 'MIT' });
  await write('package-lock.json', {
    packages: Object.fromEntries(
      ['alpha', 'esbuild'].map((name) => [
        'node_modules/' + name,
        {
          version: '1.0.0',
          dev: true,
          integrity: 'sha512-fixture',
          resolved: 'https://registry.npmjs.org/' + name,
        },
      ]),
    ),
  });
  const source = 'export const value: number = 42;\n';
  await write('node_modules/alpha/out/main.js', 'exports.value = 42;\n');
  if (!embedded) await write('node_modules/alpha/src/main.ts', source);
  await write('node_modules/alpha/out/main.js.map', {
    version: 3,
    sources: ['../src/main.ts'],
    sourcesContent: [source],
    names: [],
    mappings: '',
  });
  const file = 'dist-electron/main.cjs';
  const content = Buffer.from('var alpha = {}; alpha.value = 42;\n');
  const map = Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ['../node_modules/alpha/src/main.ts'],
      sourcesContent: [source],
      names: [],
      mappings: '',
    }),
  );
  const stored = new Map([
    [file, content],
    [file + '.map', map],
  ]);
  const options = {
    root,
    asarMembers: [...stored.keys()],
    readAsar: (name: string) => {
      const bytes = stored.get(name);
      if (!bytes) throw Error('Missing fixture file');
      return bytes;
    },
    electron: [
      {
        outputFiles: [
          { path: path.join(root, file), contents: content },
          { path: path.join(root, file + '.map'), contents: map },
        ],
        metafile: {
          outputs: {
            [file]: {
              inputs: { 'node_modules/alpha/out/main.js': { bytesInOutput: 20 } },
              imports: [{ path: 'node:fs', external: true }],
            },
          },
        },
      },
    ],
    renderer: [] as any[],
  };
  return {
    root,
    write,
    stored,
    options,
    remove: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('module paths stay in the checkout and nested scoped package ownership is preserved', () => {
  const root = '/workspace';
  assert.equal(relativeInput(root, '/workspace/src/app.ts?query'), 'src/app.ts');
  assert.equal(
    packageLocation('node_modules/a/node_modules/@scope/b/lib/index.js'),
    'node_modules/a/node_modules/@scope/b',
  );
  for (const input of ['../escape.js', '/elsewhere/a.js', '\0unreviewed', 'a\\b'])
    assert.throws(() => relativeInput(root, input));
  assert.throws(() => packageLocation('node_modules/@scope'));
});

test('coverage rejects omitted packaged JavaScript, omitted source maps and duplicate outputs', () => {
  assert.deepEqual(
    verifyCoverage(
      ['/dist/a.js', '/dist/a.js.map', '/dist/style.css'],
      ['dist/a.js', 'dist/a.js.map'],
    ),
    ['dist/a.js', 'dist/a.js.map'],
  );
  assert.throws(() => verifyCoverage(['dist/a.js', 'dist/hidden.js'], ['dist/a.js']));
  assert.throws(() => verifyCoverage(['dist/a.js.map'], []));
  assert.throws(() => verifyCoverage(['dist/a.js'], ['dist/a.js', 'dist/a.js']));
});

test('actual contributors remain in the inventory even when npm marks them dev-only', async () => {
  const f = await fixture();
  try {
    const result = await inventoryJavaScriptReplay(f.options);
    const alpha = result.packages.find((p) => p.name === 'alpha');
    assert.equal(alpha.markedDevInNpmLock, true);
    assert.deepEqual(alpha.roles, ['runtime-code', 'distributed-source-map']);
    assert.equal(result.packagedJavaScriptAndMaps.length, 2);
    const bom = javascriptBom(result, '1.0.0', 'a'.repeat(64));
    await validateBundleBom(bom);
    assert.equal(
      bom.metadata.component.properties.find((p) => p.name === 'folio:inventory-sha256')?.value,
      createHash('sha256')
        .update(JSON.stringify(result, null, 2) + '\n')
        .digest('hex'),
    );
  } finally {
    await f.remove();
  }
});

test('missing source files require exact original publisher source-map contents', async () => {
  const f = await fixture(true);
  try {
    const result = await inventoryJavaScriptReplay(f.options);
    const input = result.modules.find((m) => m.kind === 'npm-source-map-content');
    assert.equal(input.publishedSourceMaps[0].file, 'node_modules/alpha/out/main.js.map');
    await f.write('node_modules/alpha/out/main.js.map', {
      version: 3,
      sources: ['../src/main.ts'],
      sourcesContent: ['another source'],
      names: [],
      mappings: '',
    });
    await assert.rejects(inventoryJavaScriptReplay(f.options), /No original package source map/);
  } finally {
    await f.remove();
  }
});

test('changed packaged code, changed original source and mismatched package versions fail closed', async () => {
  for (const kind of ['package', 'source', 'version']) {
    const f = await fixture();
    try {
      if (kind === 'package') f.stored.set('dist-electron/main.cjs', Buffer.from('different code'));
      if (kind === 'source') await f.write('node_modules/alpha/src/main.ts', 'different source');
      if (kind === 'version')
        await f.write('node_modules/alpha/package.json', {
          name: 'alpha',
          version: '2.0.0',
          license: 'MIT',
        });
      await assert.rejects(inventoryJavaScriptReplay(f.options));
    } finally {
      await f.remove();
    }
  }
});

test('unknown virtual helper ownership and unresolved static external imports are rejected', async () => {
  const f = await fixture();
  try {
    f.options.renderer.push({
      output: [
        {
          type: 'chunk',
          fileName: 'helper.js',
          code: '1;',
          modules: { '\0unknown-helper': { renderedLength: 2, code: '1;' } },
          imports: [],
          dynamicImports: [],
        },
      ],
    });
    f.stored.set('dist/helper.js', Buffer.from('1;'));
    f.options.asarMembers.push('dist/helper.js');
    await assert.rejects(inventoryJavaScriptReplay(f.options), /Unreviewed generated module/);
    f.options.renderer.length = 0;
    f.options.asarMembers.pop();
    f.options.electron[0].metafile.outputs['dist-electron/main.cjs'].imports.push({
      path: 'unmapped-library',
      external: true,
    });
    await assert.rejects(inventoryJavaScriptReplay(f.options), /Unmapped static external imports/);
  } finally {
    await f.remove();
  }
});
