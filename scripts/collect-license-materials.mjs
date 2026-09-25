import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// This inventories installed npm production packages plus Electron notices.
// It is deliberately not a claim that TeX/Biber/native binary auditing is done.
const output = path.resolve('artifacts/license-materials');
await fs.mkdir(output, { recursive: true });
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const records = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev === true) continue;
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && entry.optional) {
      records.push({
        location,
        version: entry.version,
        declaredLicense: entry.license,
        state: 'optional-not-installed',
      });
      continue;
    }
    throw error;
  }
  if (pkg.version !== entry.version)
    throw new Error(`Installed version differs from lock: ${location}`);
  const names = (await fs.readdir(location))
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)([._-].*)?$/i.test(name))
    .sort();
  const files = [];
  const id = location.replaceAll('/', '__');
  for (const name of names) {
    const source = path.join(location, name);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const bytes = await fs.readFile(source);
    const destination = path.join(id, name);
    await fs.mkdir(path.dirname(path.join(output, destination)), { recursive: true });
    await fs.writeFile(path.join(output, destination), bytes);
    files.push({
      path: destination,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  records.push({
    name: pkg.name,
    version: pkg.version,
    location,
    declaredLicense: pkg.license ?? entry.license,
    state: files.length ? 'texts-collected' : 'license-text-review-needed',
    files,
  });
}
const electron = JSON.parse(await fs.readFile('node_modules/electron/package.json', 'utf8'));
const electronFiles = [];
for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
  const bytes = await fs.readFile(path.join('node_modules/electron/dist', name));
  await fs.mkdir(path.join(output, 'electron'), { recursive: true });
  await fs.writeFile(path.join(output, 'electron', name), bytes);
  electronFiles.push({
    path: `electron/${name}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
}
const sbom = execFileSync('npm', ['sbom', '--omit=dev', '--sbom-format=cyclonedx'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
JSON.parse(sbom);
await fs.writeFile(path.join(output, 'npm-production.cdx.json'), sbom);
await fs.writeFile(
  path.join(output, 'inventory.json'),
  JSON.stringify(
    {
      scope:
        'Installed npm production dependency license texts plus upstream Electron/Chromium notices. npm SBOM excludes development dependencies, including the separately recorded Electron runtime.',
      releaseAuditComplete: false,
      pending: [
        'Tectonic and its linked native components',
        'Biber and its embedded Perl/native dependencies',
        'TeX resources and fonts by component',
        'Corresponding-source/source-offer requirements where applicable',
        'Exact final signed-app inventory and binary SBOM',
      ],
      packageLockSha256: createHash('sha256')
        .update(await fs.readFile('package-lock.json'))
        .digest('hex'),
      npmPackages: records,
      electron: { version: electron.version, files: electronFiles },
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      output,
      installedPackages: records.filter((r) => r.name).length,
      missingText: records
        .filter((r) => r.state === 'license-text-review-needed')
        .map((r) => r.name),
      electronVersion: electron.version,
      completeBinaryAudit: false,
    },
    null,
    2,
  ),
);
