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
