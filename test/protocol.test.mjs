import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketUrl, communityBroker } from '../src/protocol.ts';
test('community meeting services use secure WebSockets and a fixed admission endpoint', () => {
  assert.equal(communityBroker('https://buzz.example.org'), 'wss://buzz.example.org/rooms');
  assert.equal(communityBroker('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/rooms');
  assert.equal(communityBroker('http://public.example.org'), undefined);
  for (const value of ['ws://public.example.org/rooms', 'wss://user:pass@example.org/rooms', 'wss://example.org/rooms?token=secret', 'wss://example.org/elsewhere', 'file:///rooms']) {
    assert.throws(() => socketUrl(value));
  }
});
