import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler } from '../electron/core/compiler';
import type { RuntimeSource } from '../electron/core/runtime-manager';
import type { Project, RuntimeStatus } from '../src/shared/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const unavailable: RuntimeStatus = {
  ready: false,
  engine: 'synthetic',
  bundle: 'none',
  platform: 'test',
  isolation: 'unavailable',
  message: 'Synthetic unavailable compiler.',
};
const project = (revision: number): Project => ({
  id: 'compiler-queue',
  name: 'Compiler queue',
  revision,
  mainFile: 'main.tex',
  files: [],
});

test('obsolete compiler requests settle without acquiring runtimes during a held build', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-compiler-queue-'));
  const entered = gate(),
    hold = gate();
  let acquired = 0,
    released = 0;
  const runtime: RuntimeSource = {
    acquire: async () => {
      acquired++;
      if (acquired === 1) {
        entered.release();
        await hold.promise;
      }
      return {
        root,
        status: unavailable,
        release: async () => {
          released++;
        },
      };
    },
  };
  const compiler = new Compiler(runtime, root);
  try {
    const active = compiler.compile(project(0));
    await entered.promise;
    let settled = 0;
    const pending = Array.from({ length: 10_000 }, (_, i) =>
      compiler.compile(project(i + 1)).then((r) => {
        settled++;
        return r;
      }),
    );
    await turn();
    assert.equal(settled, 9999);
    assert.equal(acquired, 1);
    assert.equal(released, 0);
    assert.equal(compiler.busy, true);
    hold.release();
    assert.equal((await active).status, 'cancelled');
    const results = await Promise.all(pending);
    results.slice(0, -1).forEach((r, i) => {
      assert.equal(r.status, 'cancelled');
      assert.equal(r.revision, i + 1);
      assert.equal(r.projectId, 'compiler-queue');
    });
    assert.equal(results.at(-1)!.status, 'error');
    assert.equal(results.at(-1)!.revision, 10_000);
    assert.match(results.at(-1)!.log, /Synthetic unavailable/);
    assert.equal(acquired, 2);
    assert.equal(released, 2);
    assert.equal(compiler.busy, false);
  } finally {
    hold.release();
    await compiler.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('compiler Stop waits for lease release and discards a pending runtime acquisition', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-compiler-stop-'));
  const entered = gate(),
    hold = gate();
  let acquired = 0;
  const compiler = new Compiler(
    {
      acquire: async () => {
        acquired++;
        return {
          root,
          status: unavailable,
          release: async () => {
            entered.release();
            await hold.promise;
          },
        };
      },
    },
    root,
  );
  try {
    const active = compiler.compile(project(0));
    await entered.promise;
    const pending = compiler.compile(project(1));
    let stopped = false;
    const stopping = compiler.cancel().then(() => {
      stopped = true;
    });
    assert.equal((await pending).status, 'cancelled');
    await turn();
    assert.equal(stopped, false);
    assert.equal(compiler.busy, true);
    hold.release();
    await stopping;
    assert.equal((await active).status, 'cancelled');
    assert.equal(acquired, 1);
    assert.equal(compiler.busy, false);
  } finally {
    hold.release();
    await compiler.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('lease cleanup failure does not poison a newer compiler request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-compiler-cleanup-'));
  const entered = gate(),
    hold = gate();
  let acquired = 0;
  const compiler = new Compiler(
    {
      acquire: async () => {
        const number = ++acquired;
        return {
          root,
          status: unavailable,
          release: async () => {
            if (number === 1) {
              entered.release();
              await hold.promise;
              throw new Error('lease cleanup');
            }
          },
        };
      },
    },
    root,
  );
  try {
    const active = assert.rejects(compiler.compile(project(0)), /lease cleanup/);
    await entered.promise;
    const pending = compiler.compile(project(1));
    hold.release();
    await active;
    const result = await pending;
    assert.equal(result.revision, 1);
    assert.match(result.log, /Synthetic unavailable/);
    assert.equal(acquired, 2);
    assert.equal(compiler.busy, false);
  } finally {
    hold.release();
    await compiler.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});
