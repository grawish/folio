import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler } from '../../electron/core/compiler';
import { acquireEngineCache, engineCachePolicy } from '../../electron/core/engine-cache';

test(
  'a native writer exceeding the cache budget is stopped and its cache reclaimed',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-cache-writer-')));
    const lease = await acquireEngineCache(root, 'a'.repeat(64), {
      ...engineCachePolicy,
      bytes: 1024,
    });
    const compiler = new Compiler(root, path.join(root, 'unused'));
    try {
      const result = await compiler['run'](
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          'printf "PID=%s\\n" "$$"; printf "%04096d" 0 > "$1"; sleep 30',
          'cache-limit-fixture',
          path.join(lease.path, 'large'),
        ],
        root,
        root,
        lease.path,
        new AbortController().signal,
        root,
        () => lease.check(),
      );
      assert.equal(result.code, 1);
      assert.match(result.log, /compiler cache exceeded its storage limit/);
      const pid = Number(result.log.match(/PID=(\d+)/)?.[1]);
      assert.ok(pid > 1);
      assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
      await lease.release();
      await assert.rejects(fs.lstat(lease.path), { code: 'ENOENT' });
    } finally {
      await lease.release();
      await compiler.cancel();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
