import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packDirectory, packFile, savePackFile } from '../electron/core/pack-io';
import {
  archiveDigest,
  verifyDistributionApp,
  verifyDmgSignature,
  verifyMacArchives,
} from './verify-mac-archives';

const execute = promisify(execFile);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
type Digest = Awaited<ReturnType<typeof archiveDigest>>;
export type DmgFinalizationOperations = {
  run: (args: string[], timeout: number) => Promise<string>;
  verifyApp: (app: string, team: string) => Promise<unknown>;
  verifySignature: (dmg: string, team: string) => Promise<unknown>;
  verifyArchives: (
    app: string,
    dmg: string,
    zip: string,
    options?: { distributionTeamId?: string },
  ) => Promise<{
    bundleInventorySha256: string;
    distributionVerified: boolean;
    dmg: Digest;
    zip: Digest;
  }>;
};
type State = {
  schemaVersion: 1;
  teamId: string;
  dmgName: string;
  zip: Digest;
  bundleInventorySha256: string;
  submitted: Digest;
  submissionId?: string;
  phase: 'uploading' | 'submitted' | 'accepted' | 'complete';
  final?: Digest;
};
const production = {
  run: async (args: string[], timeout: number) =>
    (await execute('/usr/bin/xcrun', args, { timeout, maxBuffer: 2 * 1024 ** 2 })).stdout,
  verifyApp: verifyDistributionApp,
  verifySignature: verifyDmgSignature,
  verifyArchives: verifyMacArchives,
};

/** Durable submission identity prevents retrying a timeout as another upload.
 * Tests inject Apple responses; the CLI always uses these real production tools. */
export async function finalizeDmg(
  release: string,
  options: { teamId: string; profile: string; keychain?: string; submissionId?: string },
  operations: DmgFinalizationOperations = production,
) {
  if (!/^[A-Z0-9]{10}$/.test(options.teamId)) throw new Error('Set the expected Apple Team ID.');
  if (!options.profile || options.profile.length > 200 || /[\r\n\0]/.test(options.profile))
    throw new Error('Use a saved Apple notarization keychain profile.');
  if (options.submissionId && !uuid.test(options.submissionId))
    throw new Error('Use a valid Apple submission UUID.');
  await packDirectory(release);
  const lock = path.join(release, 'dmg-notarization.lock');
  const handle = await fs.open(lock, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error(
        'A DMG finalizer is active or was interrupted. Check the PID in dmg-notarization.lock before removing that lock.',
      );
    throw error;
  });
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await handle.sync();
    await savePackFile(
      release,
      'verification.json',
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        passed: false,
        distributionVerified: false,
        phase: 'finalizing-dmg',
      }) + '\n',
    );
    const names = await fs.readdir(release);
    const dmgs = names.filter((name) => /^Folio-[a-zA-Z0-9.-]+-mac-arm64\.dmg$/.test(name));
    if (dmgs.length !== 1)
      throw new Error('Use a release directory with exactly one Folio arm64 DMG.');
    const dmgName = dmgs[0],
      dmg = path.join(release, dmgName);
    const zip = path.join(release, dmgName.replace(/\.dmg$/, '.zip'));
    const app = path.join(release, 'mac-arm64/Folio.app');
    const requireOwnedDmg = async () => {
      const stat = await fs.lstat(dmg);
      if (!stat.isFile() || stat.nlink !== 1 || (await fs.realpath(dmg)) !== dmg)
        throw new Error('The DMG to staple must be a regular file without links.');
    };
    await requireOwnedDmg();
    const stateName = 'dmg-notarization-state.json';
    const bytes = await packFile(release, stateName, 32768);
    let state: State | undefined = bytes ? JSON.parse(bytes.toString()) : undefined;
    if (bytes && (!state || typeof state !== 'object' || Array.isArray(state)))
      throw new Error(
        'The saved notarization state is damaged. Preserve it and inspect Apple history.',
      );
    const save = () => savePackFile(release, stateName, JSON.stringify(state, null, 2) + '\n');
    // No Apple upload or staple before actual publisher, timestamp and app checks.
    await operations.verifyApp(app, options.teamId);
    await operations.verifySignature(dmg, options.teamId);
    const before = await operations.verifyArchives(app, dmg, zip);
    const current = await archiveDigest(dmg);
    const zipDigest = await archiveDigest(zip);
    if (state) {
      assert.equal(state.schemaVersion, 1, 'Unknown DMG notarization state.');
      assert.equal(state.teamId, options.teamId, 'Notarization publisher changed.');
      assert.equal(state.dmgName, dmgName, 'Notarization target changed.');
      assert.deepEqual(state.zip, zipDigest, 'The application ZIP changed.');
      assert.equal(state.bundleInventorySha256, before.bundleInventorySha256, 'The app changed.');
      assert.ok(['uploading', 'submitted', 'accepted', 'complete'].includes(state.phase));
      assert.ok(/^[a-f\d]{64}$/.test(state.submitted.sha256));
      if (state.phase === 'uploading' || state.phase === 'submitted')
        assert.deepEqual(current, state.submitted, 'The submitted DMG changed.');
      if (state.phase === 'complete')
        assert.deepEqual(current, state.final, 'The finalized DMG changed.');
    } else {
      if (options.submissionId)
        throw new Error('Cannot adopt a submission without its saved input record.');
      state = {
        schemaVersion: 1,
        teamId: options.teamId,
        dmgName,
        zip: zipDigest,
        bundleInventorySha256: before.bundleInventorySha256,
        submitted: current,
        phase: 'uploading',
      };
      // Save before submit. A crash or an ambiguous submit error must never
      // automatically send another copy to Apple on the next invocation.
      await save();
      const result = JSON.parse(
        await operations.run(
          ['notarytool', 'submit', dmg, ...auth(options), '--no-wait', '--output-format', 'json'],
          5 * 60_000,
        ),
      );
      if (!uuid.test(result.id ?? ''))
        throw new Error(
          'Apple did not return a submission ID. Check notarization history before retrying.',
        );
      state.submissionId = result.id;
      state.phase = 'submitted';
      await save();
    }
    if (options.submissionId) {
      if (state.submissionId && state.submissionId !== options.submissionId)
        throw new Error('Use the already recorded submission ID.');
      if (!state.submissionId) {
        state.submissionId = options.submissionId;
        state.phase = 'submitted';
        await save();
      }
    }
    const id = state.submissionId;
    if (!id || !uuid.test(id))
      throw new Error(
        'The previous upload has no recorded ID. Inspect Apple notarization history, then rerun with --submission-id. Do not resubmit.',
      );
    const info = async () => {
      const value = JSON.parse(
        await operations.run(
          ['notarytool', 'info', id, ...auth(options), '--output-format', 'json'],
          60_000,
        ),
      );
      assert.equal(value.id, id, 'Apple returned a different submission.');
      return value.status as string;
    };
    let status = await info();
    if (status === 'In Progress') {
      // Observation timeout leaves this exact submission active at Apple.
      await operations
        .run(
          [
            'notarytool',
            'wait',
            id,
            ...auth(options),
            '--timeout',
            '60s',
            '--output-format',
            'json',
          ],
          75_000,
        )
        .catch(() => {});
      status = await info();
    }
    if (status === 'In Progress') return { passed: false, pending: true, submissionId: id };
    if (status !== 'Accepted')
      throw new Error(
        `Apple submission ${id} is ${status}. Inspect its notarytool log; the DMG was not stapled.`,
      );
    const log = JSON.parse(
      await operations.run(['notarytool', 'log', id, ...auth(options)], 60_000),
    );
    assert.equal(log.jobId, id, 'Apple log belongs to another submission.');
    assert.equal(log.status, 'Accepted', 'Apple log is not accepted.');
    assert.equal(
      log.sha256?.toLowerCase(),
      state.submitted.sha256,
      'Apple accepted different DMG bytes.',
    );
    if (state.phase !== 'complete') {
      if (state.phase !== 'accepted')
        assert.deepEqual(
          await archiveDigest(dmg),
          state.submitted,
          'The DMG changed before stapling.',
        );
      state.phase = 'accepted';
      await save();
      await requireOwnedDmg();
      await operations.run(['stapler', 'staple', dmg], 120_000);
    }
    // Independently re-check actual tickets, policy, signatures and both app
    // copies. The service's JSON response is not release verification.
    const final = await operations.verifyArchives(app, dmg, zip, {
      distributionTeamId: options.teamId,
    });
    assert.equal(final.distributionVerified, true);
    assert.equal(final.bundleInventorySha256, state.bundleInventorySha256);
    assert.deepEqual(await archiveDigest(zip), state.zip, 'The application ZIP changed.');
    state.final = await archiveDigest(dmg);
    assert.deepEqual(
      state.final,
      { bytes: final.dmg.bytes, sha256: final.dmg.sha256 },
      'The DMG changed after verification.',
    );
    state.phase = 'complete';
    await save();
    return { passed: true, pending: false, submissionId: id, dmg: state.final, archives: final };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

function auth(options: { profile: string; keychain?: string }) {
  return [
    '--keychain-profile',
    options.profile,
    ...(options.keychain ? ['--keychain', options.keychain] : []),
  ];
}
