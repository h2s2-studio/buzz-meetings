import test from "node:test";
import assert from "node:assert/strict";
import { meetingFlow, general, covers } from "./meeting-flow.mjs";

test("a later call in the same workspace never inherits an earlier call's tasks", async () => {
  const flow = meetingFlow();
  flow.join("RM_first"); await flow.addAgent();
  assert.equal(flow.agents.snapshot().phase, "listening");
  flow.speak(["alex-1", "Alex", "Studio, draft the playtest brief."]);
  await flow.task({ key: "brief", title: "Draft the playtest brief", status: "done", result: "Brief posted." });
  await flow.records.save(general, flow.transcript.snapshot(), flow.agents);
  flow.leave();
  // A second meeting in the same channel with no agent.
  flow.join("RM_second"); await flow.transcript.start();
  flow.speak(["alex-1", "Alex", "Quick sync, no agent today."]);
  assert.deepEqual(flow.agents.snapshot().tasks, []);
  await flow.records.save(general, flow.transcript.snapshot(), flow.agents);
  const [second, first] = await flow.savedRecords();
  assert.equal(first.callId, "RM_first"); assert.deepEqual(first.tasks.map(task => task.title), ["Draft the playtest brief"]);
  assert.equal(second.callId, "RM_second"); assert.deepEqual(second.tasks, []);
  flow.close();
});

test("a failed Add agent releases only the capture it requested", async () => {
  const flow = meetingFlow();
  flow.join("RM_empty"); flow.failSend = true;
  await flow.addAgent();
  assert.match(flow.agents.snapshot().error, /did not confirm/);
  assert.equal(flow.transcript.snapshot().phase, "paused");
  assert.deepEqual(flow.announcements.at(-1), { id: flow.media.snapshot().joinId, value: false });
  // Transcription the person started themselves survives a failed agent attempt.
  await flow.transcript.start();
  await flow.addAgent();
  assert.equal(flow.transcript.snapshot().phase, "transcribing");
  assert.deepEqual(flow.transcript.holders(), ["user"]);
  // A successful agent shares capture; removing it leaves the person's transcript running.
  flow.failSend = false; await flow.addAgent();
  assert.equal(flow.agents.snapshot().phase, "listening");
  flow.agents.stop("", flow.agent.pubkey);
  assert.equal(flow.transcript.snapshot().phase, "transcribing");
  // Capture that only an agent requested ends when that agent is removed.
  flow.transcript.stop(); await flow.addAgent();
  assert.deepEqual(flow.transcript.holders(), [`agent:${flow.agent.pubkey}`]);
  flow.agents.stop("", flow.agent.pubkey);
  assert.equal(flow.transcript.snapshot().phase, "paused");
  flow.close();
});

test("a task finished after listening stops updates the meeting and keeps its thread link", async () => {
  const flow = meetingFlow();
  flow.join("RM_results"); await flow.addAgent();
  await flow.task({ key: "brief", title: "Draft the brief", status: "working" });
  flow.agents.stop("", flow.agent.pubkey);
  flow.leave();
  await flow.task({ key: "brief", title: "Draft the brief", status: "done", result: "Brief posted." });
  const [task] = flow.agents.snapshot().tasks;
  assert.equal(task.status, "done");
  assert.equal(task.messageId, flow.published.at(-1).id);
  assert.deepEqual(task.author, { pubkey: flow.agent.pubkey, name: "Studio" });
  flow.close();
});

test("a save covers only the entries it contains, so later speech stays unsaved", async () => {
  const flow = meetingFlow();
  flow.join("RM_cover", { channelId: general }); await flow.transcript.start();
  flow.speak(["alex-1", "Alex", "First point."], ["riley-1", "Riley", "Second point."]);
  await flow.records.save(general, flow.transcript.snapshot(), flow.agents);
  const saved = () => flow.records.snapshot().records.map(record => record.value);
  assert.ok(saved().some(record => covers(record, general, flow.transcript.snapshot())));
  flow.speak(["alex-1", "Alex", "Said after saving."]);
  flow.leave();
  assert.equal(saved().some(record => covers(record, general, flow.transcript.snapshot())), false);
  // A record for another channel or another call never counts.
  assert.equal(saved().some(record => covers(record, "10000000-0000-4000-8000-000000000002", flow.transcript.snapshot())), false);
  await flow.records.save(general, flow.transcript.snapshot(), flow.agents);
  assert.ok(saved().some(record => covers(record, general, flow.transcript.snapshot())));
  flow.close();
});

test("rejoining keeps the earlier unsaved transcript reviewable and savable under its occurrence", async () => {
  const flow = meetingFlow();
  flow.join("RM_first", { channelId: general }); await flow.transcript.start();
  flow.speak(["alex-1", "Alex", "Before the drop."]);
  flow.leave();
  flow.join("RM_first", { channelId: general, keepStream: true }); await flow.transcript.start();
  flow.speak(["alex-1", "Alex", "After rejoining."]);
  const [earlier] = flow.transcript.snapshot().retained;
  assert.deepEqual(earlier.segments.map(row => row.text), ["Before the drop."]);
  assert.equal(earlier.occurrenceId, "RM_first"); assert.equal(earlier.channelId, general); assert.equal(earlier.phase, "ended");
  assert.deepEqual(flow.transcript.snapshot().segments.map(row => row.text), ["After rejoining."]);
  await flow.records.save(general, earlier, flow.agents);
  const [record] = flow.records.snapshot().records;
  assert.equal(record.value.callId, "RM_first"); assert.ok(covers(record.value, general, earlier));
  flow.transcript.discard(earlier.joinId);
  assert.deepEqual(flow.transcript.snapshot().retained, []);
  assert.equal(flow.transcript.snapshot().segments.length, 1);
  // Changing identity or community clears everything.
  flow.leave(); flow.join("RM_second", { channelId: general }); await flow.transcript.start(); flow.speak(["alex-1", "Alex", "x"]);
  flow.leave(); flow.join("RM_third"); assert.equal(flow.transcript.snapshot().retained.length, 2);
  flow.transcript.reset(); assert.deepEqual(flow.transcript.snapshot().retained, []);
  flow.close();
});

test("an agent added before the call's occurrence is known files tasks under it, and a restarted call ends the session", async () => {
  const flow = meetingFlow();
  flow.join(undefined); await flow.addAgent();
  await flow.task({ key: "early", title: "Early task", status: "working" });
  flow.setOccurrence("RM_late");
  assert.deepEqual(flow.agents.tasksFor(general, "RM_late").map(task => task.title), ["Early task"]);
  assert.deepEqual(flow.agents.snapshot().tasks.map(task => task.title), ["Early task"]);
  flow.setOccurrence("RM_restarted");
  assert.equal(flow.agents.snapshot().phase, "idle");
  assert.match(flow.agents.snapshot().error, /call restarted/);
  assert.deepEqual(flow.agents.tasksFor(general, "RM_restarted"), []);
  assert.deepEqual(flow.agents.tasksFor(general, "RM_late").map(task => task.title), ["Early task"]);
  flow.close();
});

test("Remove says when it also stops transcription, with and without an independent transcript viewer", async () => {
  const flow = meetingFlow();
  flow.join("RM_remove"); await flow.addAgent();
  assert.equal(flow.agents.stopsCapture(flow.agent.pubkey), true);
  // The person opens Transcript while the agent is capturing: their own interest now counts.
  await flow.transcript.start();
  assert.equal(flow.agents.stopsCapture(flow.agent.pubkey), false);
  flow.agents.stop("", flow.agent.pubkey);
  assert.equal(flow.transcript.snapshot().phase, "transcribing");
  // Without an independent viewer, removing the agent ends capture.
  flow.transcript.stop(); await flow.addAgent();
  assert.equal(flow.agents.stopsCapture(flow.agent.pubkey), true);
  flow.agents.stop("", flow.agent.pubkey);
  assert.equal(flow.transcript.snapshot().phase, "paused");
  assert.deepEqual(flow.announcements.at(-1).value, false);
  flow.close();
});
