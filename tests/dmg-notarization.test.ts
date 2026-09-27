import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeDmg, type DmgFinalizationOperations } from '../scripts/dmg-notarization';
import { archiveDigest } from '../scripts/verify-mac-archives';

const id = '12345678-1234-1234-1234-123456789abc';
const config = { teamId: 'ABCDEFGHIJ', profile: 'Folio test profile' };
async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-notary-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dmg = path.join(root, 'Folio-1.0.0-mac-arm64.dmg');
  const zip = path.join(root, 'Folio-1.0.0-mac-arm64.zip');
  await fs.writeFile(dmg, 'synthetic signed image');
  await fs.writeFile(zip, 'synthetic app zip');
  const submitted = await archiveDigest(dmg);
  const calls: string[] = [];
  let status = 'Accepted';
  const operations: DmgFinalizationOperations = {
    verifyApp: async () => {
      calls.push('app');
    },
    verifySignature: async () => {
      calls.push('signature');
    },
    verifyArchives: async (_app, _dmg, _zip, options) => {
      calls.push(options ? 'distribution' : 'contents');
      return {
        bundleInventorySha256: 'a'.repeat(64),
        distributionVerified: !!options,
        dmg: await archiveDigest(dmg),
        zip: await archiveDigest(zip),
      };
    },
    run: async (args) => {
      const action = args.slice(0, 2).join(' ');
      calls.push(action);
      if (args[0] === 'notarytool') {
        assert.ok(args.includes('--keychain-profile'));
        assert.ok(args.includes(config.profile));
      }
      if (action === 'notarytool submit') return JSON.stringify({ id });
      if (action === 'notarytool info') return JSON.stringify({ id, status });
      if (action === 'notarytool wait') throw new Error('Observation timed out');
      if (action === 'notarytool log')
        return JSON.stringify({ jobId: id, status, sha256: submitted.sha256 });
      if (action === 'stapler staple') {
        await fs.writeFile(dmg, 'synthetic signed image + ticket');
        return 'Stapled';
      }
      throw new Error(`Unexpected command ${action}`);
    },
  };
  return {
    root,
    dmg,
    zip,
    calls,
    operations,
    setStatus: (value: string) => {
      status = value;
    },
  };
}

test('finalization checks actual inputs before submission and final archives after staple', async (t) => {
  const f = await fixture(t);
  const result = await finalizeDmg(f.root, config, f.operations);
  assert.equal(result.passed, true);
  assert.deepEqual(f.calls, [
    'app',
    'signature',
    'contents',
    'notarytool submit',
    'notarytool info',
    'notarytool log',
    'stapler staple',
    'distribution',
  ]);
  const state = JSON.parse(
    await fs.readFile(path.join(f.root, 'dmg-notarization-state.json'), 'utf8'),
  );
  assert.equal(state.phase, 'complete');
  assert.notEqual(state.submitted.sha256, state.final.sha256);
  assert.equal(await fs.readFile(f.zip, 'utf8'), 'synthetic app zip');
  assert.equal((await fs.readdir(f.root)).includes('SHA256SUMS'), false);
  await finalizeDmg(f.root, config, f.operations);
  assert.equal(f.calls.filter((x) => x === 'notarytool submit').length, 1);
  assert.equal(f.calls.filter((x) => x === 'stapler staple').length, 1);
  assert.equal(f.calls.filter((x) => x === 'distribution').length, 2);
});

test('a wait timeout resumes the same Apple job and never submits another copy', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'verification.json'), JSON.stringify({ passed: true }));
  f.setStatus('In Progress');
  assert.deepEqual(await finalizeDmg(f.root, config, f.operations), {
    passed: false,
    pending: true,
    submissionId: id,
  });
  assert.equal(f.calls.includes('stapler staple'), false);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, 'verification.json'), 'utf8')).passed,
    false,
  );
  f.setStatus('Accepted');
  assert.equal((await finalizeDmg(f.root, config, f.operations)).passed, true);
  assert.equal(f.calls.filter((x) => x === 'notarytool submit').length, 1);
});

test('damaged journal values cannot be treated as a fresh submission', async (t) => {
  for (const value of ['null', 'false', '[]', '{}']) {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'dmg-notarization-state.json'), value);
    await assert.rejects(finalizeDmg(f.root, config, f.operations));
    assert.equal(
      f.calls.some((x) => x.startsWith('notarytool')),
      false,
    );
  }
});

test('linked disk images are refused before upload or mutation', async (t) => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = await fixture(t),
      target = path.join(f.root, 'keep.dmg');
    await fs.rename(f.dmg, target);
    if (kind === 'symlink') await fs.symlink(target, f.dmg);
    else await fs.link(target, f.dmg);
    await assert.rejects(finalizeDmg(f.root, config, f.operations), /without links/);
    assert.deepEqual(f.calls, []);
    assert.equal(await fs.readFile(target, 'utf8'), 'synthetic signed image');
  }
});

test('an ambiguous upload is not automatically repeated; an adopted job must bind the saved digest', async (t) => {
  const f = await fixture(t),
    original = f.operations.run;
  f.operations.run = async (args, timeout) => {
    if (args[1] === 'submit') {
      f.calls.push('notarytool submit');
      throw new Error('Connection lost after upload');
    }
    return original(args, timeout);
  };
  await assert.rejects(finalizeDmg(f.root, config, f.operations), /Connection lost/);
  f.operations.run = original;
  await assert.rejects(finalizeDmg(f.root, config, f.operations), /no recorded ID/);
  assert.equal(f.calls.filter((x) => x === 'notarytool submit').length, 1);
  assert.equal(
    (await finalizeDmg(f.root, { ...config, submissionId: id }, f.operations)).passed,
    true,
  );
  assert.equal(f.calls.filter((x) => x === 'notarytool submit').length, 1);
});

test('rejected service results, mismatched jobs or checksums cannot authorize stapling', async (t) => {
  for (const variation of ['rejected', 'job', 'digest']) {
    const f = await fixture(t),
      original = f.operations.run;
    if (variation === 'rejected') f.setStatus('Invalid');
    f.operations.run = async (args, timeout) => {
      if (args[1] === 'log')
        return JSON.stringify({
          jobId: variation === 'job' ? 'wrong' : id,
          status: 'Accepted',
          sha256: '0'.repeat(64),
        });
      return original(args, timeout);
    };
    await assert.rejects(finalizeDmg(f.root, config, f.operations));
    assert.equal(f.calls.includes('stapler staple'), false);
    assert.equal(await fs.readFile(f.dmg, 'utf8'), 'synthetic signed image');
  }
});

test('signature or archive failure prevents upload, and final policy failure never records completion', async (t) => {
  for (const step of ['verifyApp', 'verifySignature', 'verifyArchives'] as const) {
    const f = await fixture(t);
    f.operations[step] = async () => {
      throw new Error('Gate failed');
    };
    await assert.rejects(finalizeDmg(f.root, config, f.operations), /Gate failed/);
    assert.equal(
      f.calls.some((x) => x.startsWith('notarytool')),
      false,
    );
  }
  const f = await fixture(t),
    original = f.operations.verifyArchives;
  f.operations.verifyArchives = async (...args) => {
    if (args[3]) throw new Error('Apple policy rejected');
    return original(...args);
  };
  await assert.rejects(finalizeDmg(f.root, config, f.operations), /policy rejected/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, 'dmg-notarization-state.json'), 'utf8')).phase,
    'accepted',
  );
  f.operations.verifyArchives = original;
  assert.equal((await finalizeDmg(f.root, config, f.operations)).passed, true);
  assert.equal(f.calls.filter((x) => x === 'notarytool submit').length, 1);
});

test('changed files or publisher cannot reuse a pending submission, and locks exclude concurrent runs', async (t) => {
  for (const variation of ['dmg', 'zip', 'publisher']) {
    const f = await fixture(t);
    f.setStatus('In Progress');
    await finalizeDmg(f.root, config, f.operations);
    if (variation !== 'publisher') await fs.appendFile(f[variation as 'dmg' | 'zip'], 'changed');
    await assert.rejects(
      finalizeDmg(
        f.root,
        variation === 'publisher' ? { ...config, teamId: 'ZYXWVUTSRQ' } : config,
        f.operations,
      ),
    );
    assert.equal(f.calls.filter((x) => x === 'notarytool submit').length, 1);
  }
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'dmg-notarization.lock'), JSON.stringify({ pid: 123 }));
  await assert.rejects(finalizeDmg(f.root, config, f.operations), /active or was interrupted/);
  assert.deepEqual(f.calls, []);
});
