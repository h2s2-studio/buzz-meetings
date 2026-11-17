import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSegments, wav16 } from '../src/speech.ts';

test('overlapping speakers retain independent identities and speech times', () => {
  const rows = [], one = new SpeechSegments(() => ({ id: 'source-one', name: 'Alex' }), row => rows.push(row)), two = new SpeechSegments(() => ({ id: 'source-two', name: 'Riley' }), row => rows.push(row));
  const speech = new Float32Array(1600).fill(0.1), silence = new Float32Array(1600);
  for (let i = 1; i <= 12; i++) { one.push(i <= 5 ? speech : silence, 10000 + i * 100); two.push(i <= 5 ? speech : silence, 10000 + i * 100); }
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.speakerId, row.speakerName, row.startedAt, row.endedAt]), [['source-one', 'Alex', 10000, 11200], ['source-two', 'Riley', 10000, 11200]]);
});

test('silent microphones produce no captions and long speech is bounded for the service', () => {
  const rows = [], source = new SpeechSegments(() => ({ id: 'one', name: 'Same name' }), row => rows.push(row));
  for (let i = 0; i < 100; i++) source.push(new Float32Array(1600), i * 100);
  assert.equal(rows.length, 0);
  for (let i = 0; i < 90; i++) source.push(new Float32Array(1600).fill(0.2), 10000 + i * 100);
  assert.equal(rows.length, 1); assert.ok(rows[0].samples.length <= 130000);
  const bytes = wav16(rows[0].samples), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), rows[0].samples.length * 2);
});
