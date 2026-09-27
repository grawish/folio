import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inventoryBundle, jsonBytes, sha256 } from './mac-app-inventory';

const execute = promisify(execFile);
const command = (file: string, args: string[]) =>
  execute(file, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
const developerRequirement = (team: string) => {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('Select the expected Apple Team ID.');
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
};

/** Actual Apple checks only; no test override can report production acceptance. */
export async function verifyDistributionApp(app: string, expectedTeamId: string) {
  await command('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--all-architectures',
    '-R',
    `=identifier "app.folio.resume" and ${developerRequirement(expectedTeamId)}`,
    app,
  ]);
  const details = await command('/usr/bin/codesign', ['--display', '--verbose=4', app]);
  assert.match(
    details.stderr,
    /^CodeDirectory .*flags=.*\bruntime\b/m,
    'Missing hardened runtime signature.',
  );
  assert.match(details.stderr, /^Timestamp=.+/m, 'Missing secure signing timestamp.');
  const staple = await command('/usr/bin/xcrun', ['stapler', 'validate', app]);
  const policy = await command('/usr/bin/syspolicy_check', ['distribution', app]);
  return {
    developerIdVerified: true,
    hardenedRuntimeVerified: true,
    secureTimestampVerified: true,
    notarizationTicketVerified: true,
    systemPolicyPassed: true,
    stapleLogSha256: sha256(staple.stdout + staple.stderr),
    policyLogSha256: sha256(policy.stdout + policy.stderr),
  };
}

/** A disk image uses Developer ID Application, not an installer certificate. */
export async function verifyDmgSignature(dmg: string, expectedTeamId: string) {
  await command('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '-R',
    `=${developerRequirement(expectedTeamId)}`,
    dmg,
  ]);
  const details = await command('/usr/bin/codesign', ['--display', '--verbose=4', dmg]);
  assert.match(details.stderr, /^Timestamp=.+/m, 'Missing secure disk-image signing timestamp.');
}

export async function verifyDistributionDmg(dmg: string, expectedTeamId: string) {
  await verifyDmgSignature(dmg, expectedTeamId);
  const staple = await command('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  const policy = await command('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--verbose=3',
    '--context',
    'context:primary-signature',
    dmg,
  ]);
  assert.match(
    policy.stderr,
    /^source=Notarized Developer ID$/m,
    'The disk image was not accepted as notarized Developer ID.',
  );
  return {
    developerIdVerified: true,
    secureTimestampVerified: true,
    notarizationTicketVerified: true,
    systemPolicyPassed: true,
    stapleLogSha256: sha256(staple.stdout + staple.stderr),
    policyLogSha256: sha256(policy.stdout + policy.stderr),
  };
}

export async function archiveDigest(file: string) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 2n * 1024n ** 3n)
      throw new Error('Choose a regular archive no larger than 2 GiB.');
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    for await (const block of stream) hash.update(block);
    const after = await handle.stat({ bigint: true });
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
      'The archive changed while being read.',
    );
    return { bytes: Number(before.size), sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Read-only DMG mount and private ZIP extraction. Never launches bundled code. */
export async function verifyMacArchives(
  app: string,
  dmg: string,
  zip: string,
  options: { distributionTeamId?: string } = {},
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Archive verification requires an Apple silicon Mac.');
  app = await fs.realpath(app);
  dmg = path.resolve(dmg);
  zip = path.resolve(zip);
  const team = options.distributionTeamId;
  if (team !== undefined) developerRequirement(team);
  const inventory = await inventoryBundle(app);
  const inventoryHash = sha256(jsonBytes(inventory));
  const before = { dmg: await archiveDigest(dmg), zip: await archiveDigest(zip) };
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-archives-')));
  const mount = path.join(work, 'mounted');
  await fs.mkdir(mount);
  const parentDevice = (await fs.stat(work)).dev;
  let cleanupAllowed = true;
  try {
    const inventoryPath = path.join(work, 'inventory.json');
    await fs.writeFile(inventoryPath, jsonBytes(inventory), { flag: 'wx', mode: 0o600 });
    // Validate and extract our private copy, so ordinary changes to the original
    // download cannot replace the archive between its inspection and extraction.
    const privateZip = path.join(work, 'input.zip');
    await fs.copyFile(zip, privateZip, constants.COPYFILE_EXCL);
    assert.deepEqual(await archiveDigest(privateZip), before.zip);
    const checked = await command(process.env.FOLIO_PYTHON || 'python3', [
      fileURLToPath(new URL('./check-mac-zip.py', import.meta.url)),
      privateZip,
      inventoryPath,
      path.basename(app),
    ]);
    const zipMembers = JSON.parse(checked.stdout);
    const expanded = path.join(work, 'expanded');
    await fs.mkdir(expanded);
    await command('/usr/bin/ditto', ['-x', '-k', privateZip, expanded]);
    const expandedApp = path.join(expanded, path.basename(app));
    const match = async (candidate: string) => {
      const actual = await inventoryBundle(candidate);
      assert.equal(
        sha256(jsonBytes(actual)),
        inventoryHash,
        'Archive app differs from the qualified app.',
      );
    };
    await match(expandedApp);
    const zipDistribution = team ? await verifyDistributionApp(expandedApp, team) : undefined;
    await command('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mount,
      dmg,
    ]);
    if ((await fs.stat(mount)).dev === parentDevice)
      throw new Error('The disk image did not mount.');
    const mountedApp = path.join(mount, path.basename(app));
    await match(mountedApp);
    const dmgAppDistribution = team ? await verifyDistributionApp(mountedApp, team) : undefined;
    let dmgDistribution;
    if (team) {
      dmgDistribution = await verifyDistributionDmg(dmg, team);
    }
    await match(app);
    assert.deepEqual(
      await archiveDigest(dmg),
      before.dmg,
      'The disk image changed during verification.',
    );
    assert.deepEqual(await archiveDigest(zip), before.zip, 'The ZIP changed during verification.');
    return {
      passed: true,
      bundleInventorySha256: inventoryHash,
      dmg: {
        ...before.dmg,
        appMatches: true,
        ...(dmgDistribution
          ? { distribution: dmgDistribution, appDistribution: dmgAppDistribution }
          : {}),
      },
      zip: {
        ...before.zip,
        appMatches: true,
        ...zipMembers,
        ...(zipDistribution ? { distribution: zipDistribution } : {}),
      },
      distributionVerified: !!team,
      scope:
        'Exact app bytes, modes and internal links inside both archives. Apple checks run only in distribution mode; fresh-machine quarantined download/launch and updater acceptance remain separate.',
    };
  } finally {
    // Never recurse into a mounted filesystem, including after a partial attach.
    if ((await fs.stat(mount)).dev !== parentDevice) {
      try {
        await command('/usr/bin/hdiutil', ['detach', mount]);
      } catch (error) {
        cleanupAllowed = false;
        throw new Error(
          `Could not detach the owned disk-image mount at ${mount}; temporary files were preserved.`,
          { cause: error },
        );
      }
    }
    if (cleanupAllowed) await fs.rm(work, { recursive: true, force: true });
  }
}
