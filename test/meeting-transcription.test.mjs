import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/meeting-transcription.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { makeMeetingTranscription } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const segment = { seq: 1, speakerId: 'one', speakerName: 'Alex', startedAt: 1000, endedAt: 2000, text: 'Discuss the design.' };
function fixture({ pending = false } = {}) {
  let call = { phase: 'connected', sessionId: 'first', roomName: 'General Voice', transcription: true, participants: [] };
  const subscribers = new Set(), announcements = [], contexts = [];
  let receive, failed, release, sockets = 0, closed = 0, signal;
  const media = {
    snapshot: () => call,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async setTranscribing(id, enabled) { announcements.push({ id, enabled }); },
    async transcribe(abort, next, error) {
      sockets++; signal = abort; receive = next; failed = error;
      if (pending) await new Promise(resolve => { release = resolve; });
      return { send() {}, close() { closed++; } };
    },
  };
  const transcript = makeMeetingTranscription(media, () => {
    const context = { state: 'running', currentTime: 0, async resume() {}, async close() { this.state = 'closed'; } };
    contexts.push(context); return context;
  });
  return { transcript, announcements, contexts, deliver: rows => receive(rows), fail: message => failed(message), release: () => release(),
    get sockets() { return sockets; }, get closed() { return closed; }, get signal() { return signal; },
    update(next) { call = { ...call, ...next }; for (const fn of subscribers) fn(); },
  };
}

test('transcription works without agents, reuses its stream, and preserves text through pause/resume', async () => {
  const f = fixture();
  await Promise.all([f.transcript.start(), f.transcript.start()]);
  assert.equal(f.sockets, 1); assert.equal(f.transcript.snapshot().phase, 'transcribing');
  f.deliver([segment]); f.transcript.stop();
  assert.equal(f.signal.aborted, true); assert.equal(f.contexts[0].state, 'closed');
  assert.deepEqual(f.transcript.snapshot().segments, [segment]);
  f.deliver([{ ...segment, text: 'Late response' }]);
  assert.deepEqual(f.transcript.snapshot().segments, [segment]);
  await f.transcript.start();
  assert.equal(f.sockets, 2); assert.deepEqual(f.transcript.snapshot().segments, [segment]);
  assert.deepEqual(f.announcements.slice(0, 3), [{ id: 'first', enabled: true }, { id: 'first', enabled: false }, { id: 'first', enabled: true }]);
  f.transcript.close();
});

test('canceling startup retires late sockets without resuming capture or announcing it', async () => {
  const f = fixture({ pending: true });
  const starting = f.transcript.start();
  f.transcript.stop(); f.release(); await starting;
  assert.equal(f.transcript.snapshot().phase, 'paused');
  assert.equal(f.closed, 1); assert.equal(f.contexts[0].state, 'closed');
  assert.ok(!f.announcements.some(item => item.enabled));
  f.transcript.close();
});

test('errors and disconnects preserve the transcript, while new calls and identity resets clear it', async () => {
  const f = fixture(); await f.transcript.start(); f.deliver([segment]);
  f.update({ phase: 'reconnecting' }); assert.equal(f.transcript.snapshot().phase, 'reconnecting');
  f.update({ phase: 'connected' }); assert.equal(f.transcript.snapshot().phase, 'transcribing');
  f.fail('Speech service unavailable');
  assert.equal(f.transcript.snapshot().phase, 'error'); assert.match(f.transcript.snapshot().error, /unavailable/);
  assert.deepEqual(f.transcript.snapshot().segments, [segment]);
  await f.transcript.start(); f.update({ phase: 'idle', sessionId: undefined });
  assert.equal(f.transcript.snapshot().phase, 'ended'); assert.deepEqual(f.transcript.snapshot().segments, [segment]);
  f.update({ phase: 'connecting', sessionId: 'second', roomName: 'Design' });
  assert.deepEqual(f.transcript.snapshot().segments, []);
  f.transcript.reset(); assert.equal(f.transcript.snapshot().roomName, undefined);
  f.transcript.close();
});

test('joining a call does not transcribe automatically and unsupported speech never opens a socket', async () => {
  const f = fixture();
  f.update({ transcription: false }); await f.transcript.start();
  assert.equal(f.sockets, 0); assert.match(f.transcript.snapshot().error, /isn’t available/);
  f.update({ phase: 'idle', sessionId: undefined }); await f.transcript.start();
  assert.equal(f.sockets, 0); assert.match(f.transcript.snapshot().error, /Join a voice room/);
  f.transcript.close();
});
