import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  NativeUpdateStaging,
  UpdateRestartRequired,
  UPDATE_STAGE_TIMEOUT_MS,
} from '../electron/core/update-staging';

function fixture(check: (events: EventEmitter) => void = () => {}) {
  const events = new EventEmitter();
  // The pinned MacUpdater retains its own error and downloaded listeners.
  events.on('error', () => {});
  events.on('update-downloaded', () => {});
  let checks = 0;
  const native = Object.assign(events, {
    checkForUpdates() {
      checks++;
      check(events);
    },
  });
  const stage = new NativeUpdateStaging(native);
  const clean = () => {
    assert.equal(events.listenerCount('error'), 1);
    assert.equal(events.listenerCount('update-downloaded'), 1);
    assert.equal(events.listenerCount('update-not-available'), 0);
  };
  return { stage, events, clean, checks: () => checks };
}

test('native staging deadline releases the caller and ignores late ready/error events', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stage, events, clean, checks } = fixture();
  let quits = 0;
  let settled = false;
  const pending = stage.install(() => quits++);
  void pending.catch(() => {
    settled = true;
  });
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof UpdateRestartRequired);
    assert.equal(error.name, 'Error');
    assert.match(error.message, /longer than two minutes/);
    return true;
  });
  t.mock.timers.tick(UPDATE_STAGE_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(quits, 0);
  t.mock.timers.tick(1);
  await rejected;
  clean();
  events.emit('update-downloaded');
  events.emit('error', new Error('late native failure'));
  assert.equal(quits, 0);
  assert.throws(() => stage.assertAvailable(), UpdateRestartRequired);
  await assert.rejects(
    stage.install(() => quits++),
    UpdateRestartRequired,
  );
  assert.equal(checks(), 1);
});

test('native staging handles synchronous failure, native error and no-update without waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const fail of [
    () => {
      throw new Error('check failed');
    },
    (events: EventEmitter) => events.emit('error', new Error('signature rejected')),
    (events: EventEmitter) => events.emit('update-not-available'),
  ]) {
    const { stage, events, clean, checks } = fixture(fail);
    let quits = 0;
    await assert.rejects(
      stage.install(() => quits++),
      UpdateRestartRequired,
    );
    clean();
    events.emit('update-downloaded');
    t.mock.timers.tick(UPDATE_STAGE_TIMEOUT_MS);
    assert.equal(quits, 0);
    await assert.rejects(
      stage.install(() => quits++),
      UpdateRestartRequired,
    );
    assert.equal(checks(), 1);
  }
});

test('only a ready event hands off once; successful handoff clears the deadline and listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stage, events, clean, checks } = fixture();
  let quits = 0;
  const pending = stage.install(() => {
    quits++;
    events.emit('update-downloaded');
  });
  events.emit('update-available');
  assert.equal(quits, 0);
  await assert.rejects(
    stage.install(() => quits++),
    UpdateRestartRequired,
  );
  events.emit('update-downloaded');
  await pending;
  clean();
  t.mock.timers.tick(UPDATE_STAGE_TIMEOUT_MS);
  events.emit('update-downloaded');
  assert.equal(quits, 1);
  assert.equal(checks(), 1);
});

test('quit handoff errors reject and do not leave a later quit callback behind', async () => {
  for (const emitError of [false, true]) {
    const { stage, events, clean } = fixture();
    let quits = 0;
    const pending = stage.install(() => {
      quits++;
      if (emitError) events.emit('error', new Error('quit rejected'));
      else throw new Error('quit threw');
    });
    const rejected = assert.rejects(pending, UpdateRestartRequired);
    events.emit('update-downloaded');
    await rejected;
    clean();
    events.emit('update-downloaded');
    assert.equal(quits, 1);
  }
});
