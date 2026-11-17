import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorkspaces, workspaceId, workspaceType, parseWorkspace, readable } from "../src/workspaces.ts";
import { WorkspaceHost, client, identities, general } from "./workspace-host.mjs";
function until(store, predicate) {
  if (predicate(store.snapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stop = store.subscribe(() => { if (predicate(store.snapshot())) { clearTimeout(timeout); stop(); resolve(); } });
    const timeout = setTimeout(() => { stop(); reject(new Error("Workspace state did not settle")); }, 2000);
  });
}
async function setup(host = new WorkspaceHost(), viewer = identities.Alex) {
  const connection = client(host, viewer), store = makeWorkspaces(connection.current(), connection.storage, connection.current);
  await until(store, state => !state.loading); return { host, connection, store, close() { store.dispose(); connection.close(); } };
}
test("a workspace is shared by channel ID; rename and restart preserve identity and content", async () => {
  const first = await setup(), second = await setup(first.host, identities.Riley);
  try {
    await first.store.link(general); await second.store.refresh();
    assert.equal(first.host.events.size, 1); assert.equal(second.store.snapshot().workspaces[0].id, general);
    first.host.saveCanvas(identities.Alex, general, "Agenda and decisions", undefined);
    first.host.send(identities.Riley, general, "https://example.com/design.pdf");
    await first.store.rename(general, "Planning"); await second.store.refresh();
    assert.equal(second.store.snapshot().workspaces[0].name, "Planning");
    assert.equal(second.host.events.size, 1); assert.equal(first.host.canvases.get(general).content, "Agenda and decisions");
    const restarted = await setup(first.host); assert.equal(restarted.store.snapshot().selected, general);
    assert.equal(restarted.store.snapshot().workspaces[0].name, "Planning"); assert.equal(first.host.publications.length, 1);
    restarted.close();
  } finally { first.close(); second.close(); }
});
test("new workspace creation explicitly preserves privacy and creates an ongoing channel", async () => {
  const { host, store, close } = await setup();
  try { await store.create("  Release  planning  ", "private"); assert.equal(store.snapshot().error, ""); const id = store.snapshot().selected; assert.ok(id); assert.equal(host.channels.get(id).visibility, "private"); assert.equal(host.creations[0].ttlSeconds, undefined); assert.equal(host.creations[0].name, "Release planning"); assert.deepEqual(host.state(identities.Riley).events, []); }
  finally { close(); }
});
test("an interrupted link is journaled before publish and retries identical signed bytes after restart", async () => {
  const first = await setup(); first.host.failPublish = "before";
  await first.store.link(general); assert.match(first.store.snapshot().error, /unconfirmed/);
  const event = first.store.snapshot().pending[0].event;
  assert.equal(first.host.preferences.get(identities.Alex).get("pending")[general].event.id, event.id);
  first.close(); first.host.failPublish = "";
  const restarted = await setup(first.host);
  try {
    assert.equal(first.host.publications.length, 1, "startup must never publish");
    await restarted.store.check(general); assert.equal(first.host.publications.length, 1, "checking only reads");
    await restarted.store.retry(general);
    assert.deepEqual(first.host.publications[1], event); assert.equal(first.host.events.size, 1); assert.equal(restarted.store.snapshot().pending.length, 0);
  } finally { restarted.close(); }
});
test("an accepted link with a lost receipt reconciles after restart without another publication", async () => {
  const first = await setup(); first.host.failPublish = "after";
  await first.store.link(general); assert.match(first.store.snapshot().error, /unconfirmed/); assert.equal(first.host.events.size, 1);
  first.close(); first.host.failRead = false; first.host.failPublish = "";
  const restarted = await setup(first.host);
  try { await until(restarted.store, state => state.pending.length === 0); assert.equal(restarted.store.snapshot().pending.length, 0); assert.equal(restarted.store.snapshot().workspaces[0].id, general); assert.equal(first.host.publications.length, 1); }
  finally { restarted.close(); }
});
test("disk failure prevents publication; failed reads never become a create", async () => {
  const { host, store, close } = await setup();
  try {
    host.storageFailure = true; await store.link(general); assert.equal(host.publications.length, 0); assert.equal(host.events.size, 0);
    host.storageFailure = false; host.failRead = true; await store.link(general); assert.equal(host.publications.length, 0);
  } finally { close(); }
});
test("concurrent linking converges on one workspace without replacing another writer's revision", async () => {
  const first = await setup(), second = await setup(first.host, identities.Riley);
  try { await Promise.all([first.store.link(general), second.store.link(general)]); assert.equal(first.host.events.size, 1); assert.equal(first.store.snapshot().error, ""); assert.equal(second.store.snapshot().error, ""); }
  finally { first.close(); second.close(); }
});
test("guests, revocation, stale metadata and offline state cannot write workspace records", async () => {
  const { host, connection, store, close } = await setup();
  try {
    host.grant(general, identities.Alex, "guest"); await store.link(general); assert.equal(host.publications.length, 0);
    host.grant(general, identities.Alex, "owner"); await store.link(general); assert.equal(host.publications.length, 1);
    host.grant(general, identities.Alex, null); await store.refresh(); assert.deepEqual(store.snapshot().workspaces, []);
    await store.retry(general); assert.equal(host.publications.length, 1);
    host.grant(general, identities.Alex, "owner"); connection.setStatus("offline"); await store.rename(general, "No"); assert.notEqual(host.channels.get(general).name, "No");
    assert.equal(readable({ ...host.list(identities.Alex)[0], metadataCached: true }, identities.Alex), false);
  } finally { close(); }
});
test("unknown schemas, deleted heads and temporary channels are preserved instead of overwritten", async () => {
  const { host, connection, store, close } = await setup();
  try {
    const id = await workspaceId(general), event = host.sign(identities.Alex, { kind: 45010, created_at: 1, tags: [["ar", "1"], ["d", id], ["h", general], ["type", workspaceType], ["op", "create"]], content: JSON.stringify({ version: 2, channelId: general }) });
    host.events.set(id, event); await store.link(general); assert.equal(host.publications.length, 0); assert.match(store.snapshot().error, /unsupported/);
    event.tags[event.tags.length - 1][1] = "delete"; event.content = "";
    await store.link(general); assert.equal(host.publications.length, 0);
    host.events.clear(); host.channels.get(general).ttlSeconds = 60; host.emit(); await store.link(general); assert.equal(host.publications.length, 0);
    const original = connection.session.configArtifactWriter.sign;
    delete host.channels.get(general).ttlSeconds; host.emit(); connection.session.configArtifactWriter.sign = async template => ({ ...await original(template), pubkey: identities.Riley });
    await store.link(general); assert.equal(host.publications.length, 0);
  } finally { close(); }
});
test("closing during signing prevents late publication or state restoration", async () => {
  const { host, connection, store, close } = await setup(); let release, entered;
  const signing = new Promise(resolve => { entered = resolve; });
  connection.session.configArtifactWriter.sign = template => new Promise(resolve => { release = () => resolve(host.sign(identities.Alex, template)); entered(); });
  const linking = store.link(general); await signing; close(); release(); await linking;
  assert.equal(host.publications.length, 0);
});

test("created channel is reused when its workspace link fails and the app restarts", async () => {
  const first = await setup(); first.host.failPublish = "before";
  await first.store.create("Planning", "private");
  assert.equal(first.host.creations.length, 1);
  const id = first.store.snapshot().creation.channelId;
  assert.ok(id); first.close(); first.host.failPublish = "";
  const second = await setup(first.host);
  try {
    await second.store.create("Planning", "private"); assert.equal(first.host.creations.length, 1);
    await second.store.finishCreation(); assert.equal(first.host.creations.length, 1); assert.equal(second.store.snapshot().selected, id); assert.equal(second.store.snapshot().creation, undefined);
  } finally { second.close(); }
});
test("ambiguous channel creation never starts another channel after restart", async () => {
  const first = await setup();
  first.connection.session.channelCreation.create = async input => { first.host.create(identities.Alex, input); throw new Error("Connection lost"); };
  await first.store.create("Unconfirmed", "private"); assert.ok(first.store.snapshot().creation); first.close();
  const second = await setup(first.host);
  try { await second.store.create("Unconfirmed", "private"); assert.equal(first.host.creations.length, 1); assert.match(second.store.snapshot().error, /previous channel creation/); }
  finally { second.close(); }
});
test("an authoritative deletion removes a previously confirmed workspace without reload", async () => {
  const { host, store, close } = await setup();
  try {
    await store.link(general); const d = await workspaceId(general), previous = host.events.get(d);
    host.events.set(d, { ...previous, content: "", tags: previous.tags.map(tag => tag[0] === "op" ? ["op", "delete"] : tag) }); host.emit();
    await store.refresh(); assert.deepEqual(store.snapshot().workspaces, []);
    await store.link(general); assert.equal(host.publications.length, 1); assert.match(store.snapshot().error, /removed/);
  } finally { close(); }
});
test("malformed saved operations cannot crash discovery or publish altered signed bytes", async () => {
  const { host, store, close } = await setup();
  try {
    host.preferences.get(identities.Alex).set("pending", { [general]: { channelId: general, event: { tags: [null], content: 5 } } });
    await store.refresh(); assert.equal(store.snapshot().error, ""); assert.equal(store.snapshot().pending.length, 0);
    await store.retry(general); assert.equal(host.publications.length, 0); assert.match(store.snapshot().error, /invalid/);
    host.preferences.get(identities.Alex).set("pending", {}); host.failPublish = "before"; await store.link(general);
    const pending = host.preferences.get(identities.Alex).get("pending"); pending[general].event.created_at += 1;
    host.failPublish = ""; await store.retry(general); assert.equal(host.publications.length, 1); assert.equal(host.events.size, 0);
  } finally { close(); }
});
