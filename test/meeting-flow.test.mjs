import test from "node:test";
import assert from "node:assert/strict";
import { meetingFlow, general } from "./meeting-flow.mjs";

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
