import test from "node:test";
import assert from "node:assert/strict";
import { recentParticipants } from "../src/presence.ts";

const parent = "10000000-0000-4000-8000-000000000001";
const room = "20000000-0000-4000-8000-000000000001";
const otherRoom = "20000000-0000-4000-8000-000000000002";
const first = "a".repeat(64);
const second = "b".repeat(64);
const authority = "c".repeat(64);
const now = 10000;
const event = (kind, time, {
  author = authority, person = first, channel = parent, call = room, admission, revision,
} = {}) => ({
  id: `${kind}-${time}-${person}-${revision}`, kind, pubkey: author, created_at: time,
  tags: [["h", channel], ["p", person]],
  content: JSON.stringify({ ephemeral_channel_id: call, admission_id: admission, roster_revision: revision }),
});
const start = event(48100, now - 60, { author: first });

test("shows recent relay-confirmed participants only for the requested room", () => {
  assert.deepEqual(recentParticipants([
    start,
    event(48101, now - 30),
    event(48101, now - 25, { person: second, author: second }),
    event(48101, now - 24, { person: second, call: otherRoom }),
    event(48101, now - 24, { person: second, channel: otherRoom }),
    event(48101, now + 20, { person: second }),
  ], parent, authority, now), [first]);
});

test("expires ended and stale calls", () => {
  const joined = event(48101, now - 30);
  assert.deepEqual(recentParticipants([start, joined, event(48103, now - 10)], parent, authority, now), []);
  assert.deepEqual(recentParticipants([start, joined], parent, authority, now + 3600), []);
});

test("keeps a member present until all their admissions leave", () => {
  const admission1 = "30000000-0000-4000-8000-000000000001";
  const admission2 = "30000000-0000-4000-8000-000000000002";
  const activities = [
    start,
    event(48102, now - 30, { admission: admission1, revision: 3 }),
    event(48101, now - 30, { admission: admission1, revision: 1 }),
    event(48101, now - 30, { admission: admission2, revision: 2 }),
  ];
  assert.deepEqual(recentParticipants(activities, parent, authority, now), [first]);
  assert.deepEqual(recentParticipants([
    ...activities, event(48102, now - 20, { admission: admission2, revision: 4 }),
  ], parent, authority, now), []);
});
