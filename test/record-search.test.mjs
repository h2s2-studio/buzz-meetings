import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { meetingFlow, general, identities, settle } from "./meeting-flow.mjs";
import { design } from "./workspace-host.mjs";
const built = await build({ entryPoints: ["src/record-search.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { registerRecordSearch, excerpts, searchTerms, cacheBudget, readBudget } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

// Two saved meetings: one in General Voice, one in Design. The agent (Riley's key) searches as Alex's agent.
async function twoMeetings() {
  const flow = meetingFlow();
  flow.join("RM_general", { channelId: general }); await flow.transcript.start();
  flow.speak(["riley-1", "Riley", "The braking marker sits behind the bridge shadow."], ["sam-1", "Sam", "Retest on Thursday."]);
  await flow.records.save(general, flow.transcript.snapshot(), flow.agents); flow.leave();
  flow.join("RM_design", { roomName: "Design", channelId: design }); await flow.transcript.start();
  flow.speak(["alex-1", "Alex", "The launch budget is forty thousand."]);
  await flow.records.save(design, flow.transcript.snapshot(), flow.agents); flow.leave();
  await settle();
  assert.equal(flow.records.snapshot().records.length, 2, flow.records.snapshot().error);
  registerRecordSearch({ agents: { addTool: tool => flow.tools.set(tool.name, tool) }, relay: { snapshot: flow.connection.current } }, flow.records);
  const search = (args, client = {}) => flow.tools.get("meetings_search_records").call({ key: flow.agent.key, pubkey: flow.agent.pubkey, owner: identities.Alex, ...client }, {}, args).then(JSON.parse);
  return { flow, search };
}

test("an agent finds what an earlier meeting said, with speaker, record and channel", async () => {
  const { flow, search } = await twoMeetings();
  const found = await search({ query: "braking marker" });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].channelId, general); assert.equal(found.results[0].channel, "General Voice"); assert.equal(found.results[0].callId, "RM_general");
  assert.equal(found.results[0].excerpts.length, 1); assert.match(found.results[0].excerpts[0], /Riley: The braking marker sits behind the bridge shadow\./);
  // Every word must be in the same entry; words from two different entries do not match.
  assert.equal((await search({ query: "braking thursday" })).results.length, 0);
  assert.equal((await search({ query: "THURSDAY" })).results[0].excerpts[0].includes("Sam: Retest on Thursday."), true);
  assert.equal((await search({ query: "budget", channel_id: general })).results.length, 0);
  assert.equal((await search({ query: "budget", channel_id: design })).results.length, 1);
  flow.close();
});

test("an agent never sees records from a channel it does not belong to", async () => {
  const { flow, search } = await twoMeetings();
  assert.equal((await search({ query: "budget" })).results.length, 1);
  flow.host.grant(design, flow.agent.pubkey, null); await settle();
  const hidden = await search({ query: "budget" });
  assert.deepEqual(hidden.results, []); assert.equal(hidden.searchedRecords, 1);
  assert.deepEqual((await search({ query: "budget", channel_id: design })).results, []);
  // The agent's other channel still works.
  assert.equal((await search({ query: "bridge" })).results.length, 1);
  flow.close();
});

test("only the connected owner's own agents may search, and bad input is refused", async () => {
  const { flow, search } = await twoMeetings();
  await assert.rejects(search({ query: "budget" }, { owner: identities.Sam }), /only available to your owner/);
  await assert.rejects(search({ query: "budget" }, { owner: undefined }), /only available to your owner/);
  await assert.rejects(search({ query: " " }), /at least two characters/);
  await assert.rejects(search({ query: "budget", channel_id: "not-a-channel" }), /not a channel ID/);
  flow.close();
});

test("a matching task result is returned with its message link", async () => {
  const flow = meetingFlow();
  flow.join("RM_tasks", { channelId: general }); await flow.addAgent();
  flow.speak(["alex-1", "Alex", "Studio, draft the playtest brief."]);
  await flow.task({ key: "brief", title: "Draft the playtest brief", status: "done", result: "Brief posted with three causes." });
  await flow.records.save(general, flow.transcript.snapshot(), flow.agents); flow.leave(); await settle();
  registerRecordSearch({ agents: { addTool: tool => flow.tools.set(tool.name, tool) }, relay: { snapshot: flow.connection.current } }, flow.records);
  const found = JSON.parse(await flow.tools.get("meetings_search_records").call({ key: flow.agent.key, pubkey: flow.agent.pubkey, owner: identities.Alex }, {}, { query: "three causes" }));
  assert.equal(found.results.length, 1); assert.deepEqual(found.results[0].excerpts, []);
  assert.equal(found.results[0].tasks[0].title, "Draft the playtest brief"); assert.match(found.results[0].tasks[0].messageId, /^[0-9a-f]{64}$/);
  flow.close();
});

test("excerpts are bounded and terms are deduplicated", () => {
  assert.deepEqual(searchTerms("  Bridge bridge  SHADOW "), ["bridge", "shadow"]);
  const text = Array.from({ length: 9 }, (_, index) => `[t] A: bridge ${index} ${"x".repeat(400)}`).join("\n\n");
  const found = excerpts(text, ["bridge"]);
  assert.equal(found.length, 5); assert.ok(found.every(entry => entry.length <= 301));
});

test("punctuation in a query does not prevent a match, and timestamps are not searched", async () => {
  const { flow, search } = await twoMeetings();
  assert.deepEqual(searchTerms("bridge shadow?"), ["bridge", "shadow"]);
  assert.equal((await search({ query: "bridge shadow?" })).results.length, 1);
  assert.equal((await search({ query: "“Thursday.”" })).results.length, 1);
  // The entry timestamps are in 2023; a year must not match every entry.
  assert.deepEqual((await search({ query: "2023" })).results, []);
  // The speaker is still searchable with what they said.
  assert.equal((await search({ query: "Riley bridge" })).results.length, 1);
  flow.close();
});

// A scripted records source: `count` records, each with `parts` saved parts and `size` characters of transcript.
function scripted(count, parts, size) {
  const flow = meetingFlow(), reads = [];
  const all = Array.from({ length: count }, (_, index) => ({ id: `record-${index}`, value: { channelId: general, title: `Meeting ${index}`, capturedAt: 1_700_000_000_000 - index, tasks: [], parts: Array.from({ length: parts }, () => ({})) } }));
  const records = { snapshot: () => ({ records: all }), async read(id) { reads.push(id); return `[t] Riley: needle ${id} ${"x".repeat(size)}`; } };
  registerRecordSearch({ agents: { addTool: tool => flow.tools.set(tool.name, tool) }, relay: { snapshot: flow.connection.current } }, records);
  const search = args => flow.tools.get("meetings_search_records").call({ key: flow.agent.key, pubkey: flow.agent.pubkey, owner: identities.Alex }, {}, args).then(JSON.parse);
  return { flow, reads, search };
}

test("one search reads a bounded number of saved parts and says what it left unread", async () => {
  const { flow, reads, search } = scripted(20, 16, 10);
  const first = await search({ query: "needle", limit: 10 });
  // 16 parts per record against a budget of 40: two records read, the rest deferred.
  assert.equal(reads.length, Math.floor(readBudget / 16)); assert.equal(first.results.length, reads.length);
  assert.equal(first.transcriptsNotReadThisSearch, 20 - reads.length); assert.match(first.note, /not read in this search/);
  // The next search reuses what was read and spends its budget on new records.
  const second = await search({ query: "needle", limit: 10 });
  assert.equal(reads.length, 2 * Math.floor(readBudget / 16)); assert.equal(second.results.length, reads.length);
  assert.equal(new Set(reads).size, reads.length);
  flow.close();
});

test("cached transcripts are bounded by total size, not by count", async () => {
  const size = Math.floor(cacheBudget / 2.5);
  // Two transcripts fit the budget: a repeat search reads nothing.
  const fits = scripted(2, 1, size);
  await fits.search({ query: "needle", limit: 10 }); await fits.search({ query: "needle", limit: 10 });
  assert.equal(fits.reads.length, 2); fits.flow.close();
  // Four do not: the cache keeps at most two, so a repeat search has to read again.
  const over = scripted(4, 1, size);
  await over.search({ query: "needle", limit: 10 });
  assert.equal(over.reads.length, 4);
  await over.search({ query: "needle", limit: 10 });
  assert.ok(over.reads.length >= 6, `expected evicted transcripts to be read again, saw ${over.reads.length} reads`);
  // A transcript larger than the whole budget is never kept.
  const huge = scripted(1, 1, cacheBudget + 1);
  await huge.search({ query: "needle" }); await huge.search({ query: "needle" });
  assert.equal(huge.reads.length, 2); huge.flow.close();
  over.flow.close();
});
