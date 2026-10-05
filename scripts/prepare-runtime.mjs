import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipSync, strToU8 } from 'fflate';
import {
  version,
  releases,
  bundleUrl,
  upstreamBundleDigest,
  biberArchives,
} from './runtime-config.mjs';
import { templateInputs } from './template-inputs.mjs';
import { createRuntimeBundle } from './lib/runtime-bundle.mjs';
import { downloadRuntimeArchive } from './lib/runtime-download.mjs';

const platform = `${process.platform}-${process.arch}`;
const spec = releases[platform];
if (!spec) throw new Error(`No pinned compiler archive for ${platform}.`);
const root = path.resolve('resources/runtime', `${spec.os}-${process.arch}`);
const cache = path.resolve('.cache/tectonic-cache');
const output = path.resolve('.cache/template-build');
const executable = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';
const biber = biberArchives[platform];
const biberExecutable = process.platform === 'win32' ? 'biber.exe' : 'biber';
if (biber && !biber.hash)
  throw new Error(
    `Biber ${biber.version} for ${platform} has no reviewed digest. Run node scripts/pin-biber.mjs first.`,
  );
const hash = (data) => createHash('sha256').update(data).digest('hex');
const downloadOptions = {
  onRetry: ({ attempt, maxAttempts, delayMs, reason }) =>
    console.log(
      `Runtime download: ${reason} Retrying ${attempt}/${maxAttempts} in ${delayMs / 1000}s…`,
    ),
};

async function run(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let log = '';
    const timeout = setTimeout(
      () => {
        child.kill('SIGKILL');
        reject(new Error('Runtime preparation timed out. Retry to resume cached downloads.'));
      },
      15 * 60 * 1000,
    );
    child.stdout.on('data', (chunk) => {
      log += chunk;
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    child.once('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(log));
    });
  });
}

await Promise.all(
  [root, cache, output, '.cache/downloads'].map((p) => fs.mkdir(p, { recursive: true })),
);
const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
const name = `tectonic-${version}-${spec.triple}.${extension}`;
const archive = path.resolve('.cache/downloads', name);
let data;
try {
  data = await fs.readFile(archive);
} catch {
  /* Download below. */
}
if (!data || hash(data) !== spec.hash) {
  console.log(`Downloading official Tectonic ${version} for ${platform}…`);
  data = await downloadRuntimeArchive(
    `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${version}/${name}`,
    spec.hash,
    downloadOptions,
  );
  await fs.writeFile(archive, data);
}
if (extension === 'zip') {
  const files = unzipSync(data);
  for (const [name, contents] of Object.entries(files)) {
    if (name.endsWith('.exe') || name.endsWith('.dll'))
      await fs.writeFile(path.join(root, path.basename(name)), contents);
  }
} else await run('tar', ['-xzf', archive, '-C', root]);
await fs.chmod(path.join(root, executable), 0o755);
const env = {
  TECTONIC_CACHE_DIR: cache,
  XDG_CONFIG_HOME: path.resolve('.cache/tectonic-config'),
};
if (biber) {
  const biberArchive = path.resolve('.cache/downloads', biber.archive);
  let bytes;
  try {
    bytes = await fs.readFile(biberArchive);
  } catch {
    /* Download below. */
  }
  if (!bytes || hash(bytes) !== biber.hash) {
    console.log(`Downloading official Biber ${biber.version} for ${platform}…`);
    bytes = await downloadRuntimeArchive(biber.url, biber.hash, downloadOptions);
    await fs.writeFile(biberArchive, bytes);
  }
  if (process.platform === 'darwin') {
    const unpack = await fs.mkdtemp(path.resolve('.cache/biber-unpack-'));
    try {
      await run('tar', ['-xzf', biberArchive, '-C', unpack]);
      // Select the native slice during packaging; end users do not need lipo/Xcode.
      await run('/usr/bin/lipo', [
        path.join(unpack, 'biber'),
        '-thin',
        process.arch === 'arm64' ? 'arm64' : 'x86_64',
        '-output',
        path.join(root, 'biber'),
      ]);
    } finally {
      await fs.rm(unpack, { recursive: true, force: true });
    }
  } else if (biber.archive.endsWith('.zip')) {
    const files = unzipSync(bytes);
    const entry = Object.keys(files).find((n) => path.basename(n).toLowerCase() === 'biber.exe');
    if (!entry) throw new Error('The Biber archive does not contain biber.exe.');
    await fs.writeFile(path.join(root, biberExecutable), files[entry]);
  } else {
    const unpack = await fs.mkdtemp(path.resolve('.cache/biber-unpack-'));
    try {
      await run('tar', ['-xzf', biberArchive, '-C', unpack]);
      await fs.copyFile(path.join(unpack, 'biber'), path.join(root, biberExecutable));
    } finally {
      await fs.rm(unpack, { recursive: true, force: true });
    }
  }
  await fs.chmod(path.join(root, biberExecutable), 0o755);
  env.PATH = `${root}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`;
  // macOS pre-expands Perl dependencies so the compiler sandbox can keep the
  // runtime read-only. Other platforms expand into a per-user cache at run time.
  env.PAR_GLOBAL_TEMP =
    process.platform === 'darwin'
      ? path.join(root, 'biber-cache')
      : path.resolve('.cache/biber-par');
  await run(path.join(root, biberExecutable), ['--version'], env);
}
const sources = await templateInputs(path.join(output, 'templates'));
for (const directory of [...(biber ? ['resources/runtime-checks'] : [])]) {
  for (const name of (await fs.readdir(directory)).filter((n) => n.endsWith('.tex')).sort())
    sources.push(path.resolve(directory, name));
}
for (const source of sources) {
  console.log(`Collecting and compiling resources for ${source}…`);
  await run(
    path.join(root, executable),
    ['-X', 'compile', source, '--bundle', bundleUrl, '--untrusted', '--outdir', output],
    env,
  );
}
const bundleData = path.join(cache, 'bundles/data', upstreamBundleDigest);
const entries = (await fs.readdir(bundleData)).sort();
const content = {};
const files = {};
for (const name of entries) {
  const value = await fs.readFile(path.join(bundleData, name));
  content[name] = value;
  files[name] = hash(value);
}
const lockedPath = 'resources/bundle.lock.json';
let locked;
try {
  locked = JSON.parse(await fs.readFile(lockedPath, 'utf8'));
} catch {
  /* Explicit initial creation below. */
}
if (process.argv.includes('--update-lock')) {
  locked = {
    schemaVersion: 1,
    compilerVersion: version,
    sourceUrl: bundleUrl,
    upstreamBundleDigest,
    files,
  };
  await fs.writeFile(lockedPath, JSON.stringify(locked, null, 2) + '\n');
} else {
  if (!locked)
    throw new Error(
      'Missing resource lock. Maintainers must initialize it with --update-lock after reviewing the inputs.',
    );
  // Package exactly the locked set, including any previously collected template resources.
  for (const [name, digest] of Object.entries(locked.files)) {
    if (!content[name] || files[name] !== digest)
      throw new Error(
        `Locked resource missing or changed: ${name}. Do not silently replace the bundle.`,
      );
  }
  for (const name of Object.keys(content)) if (!locked.files[name]) delete content[name];
}
const bundleDigest = hash(JSON.stringify(locked.files));
content.SHA256SUM = strToU8(bundleDigest);
const zip = createRuntimeBundle(content);
await fs.writeFile(path.join(root, 'bundle.zip'), zip);
const manifest = {
  schemaVersion: 1,
  version,
  bundle: 'folio-core-v1',
  platform,
  upstreamBundleDigest,
  resourceCount: Object.keys(locked.files).length,
  ...(biber ? { biberVersion: biber.version } : {}),
  files: {
    [executable]: hash(await fs.readFile(path.join(root, executable))),
    'bundle.zip': hash(zip),
  },
};
if (biber)
  manifest.files[biberExecutable] = hash(await fs.readFile(path.join(root, biberExecutable)));
if (process.platform === 'darwin') {
  const visit = async (relative) => {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        manifest.files[name] = hash(await fs.readFile(path.join(root, name)));
      else throw new Error(`Unexpected Biber runtime entry: ${name}`);
    }
  };
  await visit('biber-cache');
}
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
// Pack v1 combines these historical core notices into its signed target. Keep
// their bytes stable; the app separately ships the current root-level notices.
const coreNotices = await fs.readFile('resources/runtime-core-v1-notices.md');
if (hash(coreNotices) !== 'f73320bb1070df34893eaa1ab58345daf693f7e141938f1e2959a1299dbf717b')
  throw new Error('The published core notices changed. Preserve their exact pack-v1 bytes.');
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), coreNotices);
await fs.copyFile(lockedPath, path.join(root, 'bundle.lock.json'));
console.log(
  `Prepared ${manifest.resourceCount} locked resources. Bundle: ${(zip.length / 1024 / 1024).toFixed(1)} MB.`,
);
// Rebuild every shipped template using a fresh cache and ONLY the local ZIP.
await import('./verify-runtime.mjs');
