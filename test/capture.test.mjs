import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untilCanceled, stopStream } from '../src/capture.ts';

test('canceling an unresolved device request retires the wait and stops a late stream', async () => {
  let resolve;
  const original = new Promise(done => { resolve = done; });
  const controller = new AbortController(); let stopped = 0;
  const pending = untilCanceled(original, controller.signal, stopStream);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  await original;
  assert.equal(stopped, 1);
});

test('a returned stream transfers ownership and is not stopped by later cancellation', async () => {
  const controller = new AbortController(); let stopped = 0;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  assert.equal(await untilCanceled(Promise.resolve(stream), controller.signal, stopStream), stream);
  controller.abort(); assert.equal(stopped, 0);
});
