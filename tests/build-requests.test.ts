import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuildRequests } from '../electron/core/build-requests';
import type { BuildResult, Project } from '../src/shared/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const project = (revision: number): Project => ({
  id: 'queue-test',
  name: 'Queue test',
  revision,
  mainFile: 'main.tex',
  files: [{ path: 'main.tex', content: `revision ${revision}` }],
});
const success = (p: Project): BuildResult => ({
  projectId: p.id,
  revision: p.revision,
  status: 'success',
  durationMs: 0,
  diagnostics: [],
  log: '',
  pdf: new Uint8Array([1, 2, 3]),
});

for (const stage of ['review', 'assets', 'compile', 'checkpoint'] as const) {
  test(`a held ${stage} keeps only the newest of 10,000 waiting builds`, async () => {
    const hold = gate(),
      entered = gate();
    const visits: Record<string, number[]> = {
      review: [],
      assets: [],
      compile: [],
      checkpoint: [],
    };
    let cancellations = 0;
    const stopped = gate();
    async function visit(name: string, p: Project) {
      visits[name].push(p.revision);
      if (name === stage && p.revision === 0) {
        entered.release();
        await hold.promise;
      }
    }
    const builds = new BuildRequests({
      review: (p) => visit('review', p),
      assets: async (p) => {
        await visit('assets', p);
        return new Map();
      },
      compile: async (p) => {
        await visit('compile', p);
        return success(p);
      },
      checkpoint: async (p) => {
        await visit('checkpoint', p);
        return `version-${p.revision}`;
      },
      cancelCompiler: async () => {
        cancellations++;
        await stopped.promise;
      },
    });
    const first = builds.compile(project(0));
    await entered.promise;
    let settled = 0;
    const pending = Array.from({ length: 10_000 }, (_, i) =>
      builds.compile(project(i + 1)).then((value) => {
        settled++;
        return value;
      }),
    );
    await turn();
    assert.equal(settled, 9999);
    assert.equal(cancellations, 1, 'superseding edits must share the pending compiler stop');
    assert.equal(builds.busy, true);
    for (const values of Object.values(visits)) assert.ok(values.every((n) => n === 0));
    hold.release();
    assert.equal((await first).status, 'cancelled');
    await turn();
    assert.deepEqual(visits.review, [0], 'the newest request waits for compiler cleanup');
    stopped.release();
    const results = await Promise.all(pending);
    results.slice(0, -1).forEach((r, i) => {
      assert.equal(r.status, 'cancelled');
      assert.equal(r.projectId, 'queue-test');
      assert.equal(r.revision, i + 1);
      assert.equal(r.pdf, undefined);
    });
    const latest = results.at(-1)!;
    assert.equal(latest.status, 'success');
    assert.equal(latest.revision, 10_000);
    assert.equal(latest.versionId, 'version-10000');
    for (const values of Object.values(visits))
      assert.ok(values.every((n) => n === 0 || n === 10_000));
    assert.equal(visits.checkpoint.filter((n) => n === 0).length, stage === 'checkpoint' ? 1 : 0);
    assert.equal(builds.busy, false);
  });
}

for (const stage of ['review', 'assets', 'checkpoint'] as const) {
  test(`Stop drops pending requests and waits for held ${stage} to finish`, async () => {
    const entered = gate(),
      hold = gate();
    let cancelled = false;
    const visits: string[] = [];
    async function visit(name: string) {
      visits.push(name);
      if (name === stage) {
        entered.release();
        await hold.promise;
      }
    }
    const builds = new BuildRequests({
      review: () => visit('review'),
      assets: async () => {
        await visit('assets');
        return new Map();
      },
      compile: async (p) => success(p),
      checkpoint: async () => {
        await visit('checkpoint');
        return 'old-version';
      },
      cancelCompiler: async () => {
        cancelled = true;
      },
    });
    const active = builds.compile(project(0));
    await entered.promise;
    const pending = builds.compile(project(1));
    let finished = false;
    const stopping = builds.cancel().then(() => {
      finished = true;
    });
    assert.equal(cancelled, true);
    assert.equal((await pending).status, 'cancelled');
    await turn();
    assert.equal(finished, false);
    assert.equal(builds.busy, true);
    hold.release();
    await stopping;
    assert.equal((await active).status, 'cancelled');
    assert.equal(builds.busy, false);
    assert.equal(visits.filter((v) => v === 'review').length, 1);
  });
}

test('a disk error is actionable for its request and later requests can still build', async () => {
  const builds = new BuildRequests({
    review: async (p) => {
      if (p.revision === 0) throw new Error('Review disk changes first.');
    },
    assets: async () => new Map(),
    compile: async (p) => success(p),
    checkpoint: async () => 'saved',
    cancelCompiler: async () => {},
  });
  await assert.rejects(builds.compile(project(0)), /Review disk changes/);
  assert.equal((await builds.compile(project(1))).status, 'success');
});

test('Stop waits for disk work even if compiler cleanup fails', async () => {
  const entered = gate(),
    hold = gate();
  const builds = new BuildRequests({
    review: async () => {
      entered.release();
      await hold.promise;
    },
    assets: async () => {
      assert.fail('cancelled request read assets');
    },
    compile: async () => {
      assert.fail('cancelled request compiled');
    },
    checkpoint: async () => {
      assert.fail('cancelled request wrote history');
    },
    cancelCompiler: async () => {
      throw new Error('cleanup failed');
    },
  });
  const active = builds.compile(project(0));
  await entered.promise;
  let finished = false;
  const stopping = assert.rejects(builds.cancel(), /cleanup failed/).then(() => {
    finished = true;
  });
  await turn();
  assert.equal(finished, false);
  hold.release();
  await stopping;
  assert.equal((await active).status, 'cancelled');
  assert.equal(builds.busy, false);
});
