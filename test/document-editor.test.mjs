import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = async entry => { const built = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false }); return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`); };
const [{ memoryArtifactStore, StaleRevision, recordArtifacts }, { documentSession }, { createContent, applyEdit }] = await Promise.all(["src/artifact-store.ts", "src/document-editor.ts", "src/artifacts.ts"].map(bundle));

const agent = "a".repeat(64), riley = "b".repeat(64), sam = "c".repeat(64), channel = "10000000-0000-4000-8000-000000000001";
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const paragraph = (text, author = agent) => ({ id: crypto.randomUUID(), type: "paragraph", text, author, editedAt: 1 });
async function seeded() {
  let who = sam;
  const store = memoryArtifactStore(() => who);
  const [saw, causes] = [paragraph("Seven of nine players missed the apex."), paragraph("The braking marker sits behind the bridge shadow.")];
  let content = createContent({ kind: "document", title: "Turn 3 playtest brief", createdBy: agent, occurrenceId: "RM_call" });
  content = applyEdit(content, { opId: crypto.randomUUID(), base: "", actor: agent, at: 1, ops: [{ type: "insert", node: saw }, { type: "insert", node: causes, after: saw.id }] });
  who = agent; const first = await store.create(channel, content); who = sam;
  return { store, saw, causes, id: first.artifactId, as: value => { who = value; } };
}
const remoteText = (store, id, by, node, text) => store.remote(channel, id, by, content => applyEdit(content, { opId: crypto.randomUUID(), base: "", actor: by, at: 2, ops: [{ type: "update", id: node.id, fields: { text } }] }));

test("the memory store enforces prev like the relay and numbers revisions", async () => {
  const { store, id, causes } = await seeded();
  const head = await store.head(channel, id);
  assert.equal(head.number, 1); assert.equal(store.list(channel)[0].title, "Turn 3 playtest brief");
  const next = await store.publish(channel, id, applyEdit(head.content, { opId: crypto.randomUUID(), base: head.id, actor: sam, at: 3, ops: [{ type: "update", id: causes.id, fields: { text: "x" } }] }), head.id);
  assert.equal(next.number, 2); assert.equal(next.prev, head.id); assert.equal(next.signer, sam);
  await assert.rejects(store.publish(channel, id, head.content, head.id), error => error instanceof StaleRevision && error.head.id === next.id);
  assert.equal((await store.revision(channel, id, head.id)).number, 1, "an older revision stays readable for As presented");
});

test("typing is debounced into one revision; structural changes save at once", async () => {
  const { store, id, causes, saw } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 20 });
  await settle();
  for (const text of ["T", "Th", "Thursday"]) session.edit([{ type: "update", id: causes.id, fields: { text } }]);
  assert.equal(session.snapshot().content.nodes[1].text, "Thursday"); assert.equal(session.snapshot().unsaved, true);
  await settle(60);
  assert.equal(session.snapshot().revision.number, 2); assert.equal(session.snapshot().unsaved, false);
  session.edit([{ type: "insert", node: paragraph("Evidence: clip at 03:12.", sam), after: saw.id }], true);
  await settle(5);
  assert.equal(session.snapshot().revision.number, 3);
  session.close();
});

test("someone else's save lands in an idle editor", async () => {
  const { store, id, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam);
  await settle();
  await remoteText(store, id, riley, causes, "Riley: it is the bridge shadow.");
  await settle();
  assert.equal(session.snapshot().content.nodes[1].text, "Riley: it is the bridge shadow.");
  session.close();
});

test("a stale save rebases: a different paragraph saves, the same paragraph is held for Keep mine / Keep theirs", async () => {
  const { store, id, saw, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 1000 });
  await settle();
  session.edit([{ type: "update", id: saw.id, fields: { text: "Sam: seven of nine braked late." } }, { type: "update", id: causes.id, fields: { text: "Retest on Thursday." } }]);
  await remoteText(store, id, agent, causes, "Retest planned for Friday.");
  await session.save();
  const state = session.snapshot();
  assert.equal(state.revision.number, 3);
  assert.deepEqual(state.content.nodes.map(node => node.text), ["Sam: seven of nine braked late.", "Retest planned for Friday."]);
  assert.deepEqual(state.conflicts.map(conflict => [conflict.field, conflict.mine, conflict.theirs]), [["text", "Retest on Thursday.", "Retest planned for Friday."]]);
  session.resolve(state.conflicts[0], "mine");
  await settle(5);
  assert.equal(session.snapshot().content.nodes[1].text, "Retest on Thursday."); assert.equal(session.snapshot().revision.number, 4);
  assert.deepEqual(session.snapshot().conflicts, []);
  session.close();
});

test("a removal that loses to someone else's edit is reported, and nothing is lost when saving fails", async () => {
  const { store, id, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 1000 });
  await settle();
  session.edit([{ type: "remove", id: causes.id }]);
  await remoteText(store, id, riley, causes, "Riley edited this.");
  await session.save();
  assert.deepEqual(session.snapshot().kept, [{ nodeId: causes.id, reason: "edited" }]);
  assert.equal(session.snapshot().content.nodes[1].text, "Riley edited this.");
  session.dismissKept(causes.id); assert.deepEqual(session.snapshot().kept, []);
  // Saving with no identity keeps the edit and reports it.
  const offline = documentSession(store, channel, id, () => sam, { debounceMs: 1000 });
  await settle();
  const original = store.publish;
  store.publish = async () => { throw new Error("Connection lost"); };
  offline.edit([{ type: "update", id: causes.id, fields: { text: "Kept locally." } }]);
  await offline.save();
  assert.equal(offline.snapshot().content.nodes[1].text, "Kept locally."); assert.equal(offline.snapshot().unsaved, true); assert.match(offline.snapshot().error, /Connection lost/);
  store.publish = original;
  await offline.save();
  assert.equal(offline.snapshot().unsaved, false); assert.equal((await store.head(channel, id)).content.nodes[1].text, "Kept locally.");
  session.close(); offline.close();
});

test("an invalid change is refused without losing earlier edits", async () => {
  const { store, id, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 1000 });
  await settle();
  session.edit([{ type: "update", id: causes.id, fields: { text: "Good." } }]);
  session.edit([{ type: "update", id: causes.id, fields: { junk: 1 } }]);
  assert.match(session.snapshot().error, /isn’t allowed/);
  assert.equal(session.snapshot().content.nodes[1].text, "Good.");
  await session.save();
  assert.equal((await store.head(channel, id)).content.nodes[1].text, "Good.");
  session.close();
});

// PR #10 review items.
test("records never reference documents from a store that keeps nothing across restarts", async () => {
  const { store } = await seeded();
  assert.deepEqual(recordArtifacts(store, channel, "RM_call"), []);
  const durable = memoryArtifactStore(() => agent, { durable: true });
  const made = await durable.create(channel, createContent({ kind: "document", title: "Brief", createdBy: agent, occurrenceId: "RM_call" }));
  assert.deepEqual(recordArtifacts(durable, channel, "RM_call").map(item => [item.id, item.revision, item.number]), [[made.artifactId, made.id, 1]]);
  assert.deepEqual(recordArtifacts(durable, channel, "RM_other"), []);
});

test("closing flushes text typed within the debounce window", async () => {
  const { store, id, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 10_000 });
  await settle();
  session.edit([{ type: "update", id: causes.id, fields: { text: "Typed just before closing." } }]);
  assert.equal(await session.close(), true);
  assert.equal((await store.head(channel, id)).content.nodes[1].text, "Typed just before closing.");
  // A flush that fails keeps the session open with the text.
  const failing = documentSession(store, channel, id, () => sam, { debounceMs: 10_000 });
  await settle();
  const original = store.publish; store.publish = async () => { throw new Error("Connection lost"); };
  failing.edit([{ type: "update", id: causes.id, fields: { text: "Not saved yet." } }]);
  assert.equal(await failing.close(), false);
  assert.equal(failing.snapshot().content.nodes[1].text, "Not saved yet."); assert.equal(failing.snapshot().unsaved, true);
  store.publish = original;
  assert.equal(await failing.close(), true);
});

test("a stale save, then a network failure, then a retry gives one clean save and no duplicate conflicts", async () => {
  const { store, id, saw, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 10_000 });
  await settle();
  session.edit([{ type: "update", id: saw.id, fields: { text: "Sam's line." } }, { type: "update", id: causes.id, fields: { text: "Thursday." } }]);
  await remoteText(store, id, agent, causes, "Friday.");
  const original = store.publish; let calls = 0;
  store.publish = async (...args) => { if (++calls === 2) throw new Error("Connection lost"); return original(...args); };
  await session.save();
  assert.match(session.snapshot().error, /Connection lost/);
  const head = await store.head(channel, id);
  assert.equal(session.snapshot().revision.id, head.id, "the session adopted the head its edit was rebased onto");
  assert.equal(session.snapshot().conflicts.length, 1);
  await session.save();
  const saved = await store.head(channel, id);
  assert.equal(saved.number, head.number + 1);
  assert.deepEqual(saved.content.nodes.map(node => node.text), ["Sam's line.", "Friday."]);
  assert.equal(session.snapshot().conflicts.length, 1); assert.equal(session.snapshot().error, "");
  session.close();
});

test("when others keep saving first, the session schedules its own retry", async () => {
  const { store, id, saw, causes } = await seeded();
  const session = documentSession(store, channel, id, () => sam, { debounceMs: 10_000 });
  await settle();
  session.edit([{ type: "update", id: saw.id, fields: { text: "Mine." } }]);
  const original = store.publish; let busy = 4;
  store.publish = async (...args) => { if (busy-- > 0) await remoteText(store, id, riley, causes, `Riley ${busy}`); return original(...args); };
  await session.save();
  assert.match(session.snapshot().error, /will save again in 1 s/);
  await settle(1200);
  assert.equal(session.snapshot().unsaved, false); assert.equal(session.snapshot().error, "");
  assert.equal((await store.head(channel, id)).content.nodes[0].text, "Mine.");
  session.close();
});
