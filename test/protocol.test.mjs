import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketUrl, communityBroker, roomServiceError } from '../src/protocol.ts';
test('community meeting services use secure WebSockets and a fixed admission endpoint', () => {
  assert.equal(communityBroker('https://buzz.example.org'), 'wss://buzz.example.org/rooms');
  assert.equal(communityBroker('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/rooms');
  assert.equal(communityBroker('http://public.example.org'), undefined);
  for (const value of ['ws://public.example.org/rooms', 'wss://user:pass@example.org/rooms', 'wss://example.org/rooms?token=secret', 'wss://example.org/elsewhere', 'file:///rooms']) {
    assert.throws(() => socketUrl(value));
  }
});

test('a legacy broker rejection explains the server upgrade while access errors stay specific', () => {
  assert.match(roomServiceError('meeting', 'Invalid room request.'), /deploy the Buzz Meetings server/);
  assert.equal(roomServiceError('meeting', 'The meeting access key was rejected.'), 'The meeting access key was rejected.');
  assert.equal(roomServiceError('create', 'Invalid room request.'), 'Invalid room request.');
});
