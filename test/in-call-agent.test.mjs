import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { meetingFlow, settle } from "./meeting-flow.mjs";
// With setTimeout mocked, let pending promise work finish without timers.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function asked(options = ["Yes, draft it", "Not yet"]) {
  const flow = meetingFlow();
  flow.join("RM_ask"); await flow.addAgent();
  const result = await flow.tool("meetings_ask", { key: "brief", question: "Turn these 3 cards into a brief?", options });
  return { flow, result, member: () => flow.agents.snapshot().members[0] };
}

test("an agent's question shows on its tile, posts to the thread, and the owner's click answers it", async () => {
  const { flow, result, member } = await asked();
  assert.deepEqual(result.options, ["Yes, draft it", "Not yet"]);
  assert.equal(member().question.text, "Turn these 3 cards into a brief?");
  assert.deepEqual(member().status, { state: "needs-input", caption: "Turn these 3 cards into a brief?" });
  assert.match(flow.published.at(-1).content, /^Question · Turn these 3 cards into a brief\?\nOptions: Yes, draft it \/ Not yet$/);
  const before = flow.wakes.length;
  flow.agents.answer(flow.agent.pubkey, "brief", "Yes, draft it");
  assert.equal(member().question, undefined); assert.equal(member().status.state, "listening");
  assert.equal(flow.wakes.length, before + 1); assert.match(flow.wakes.at(-1).text, /Your owner answered/);
  const context = await flow.tool("meetings_live_context", {});
  assert.equal(context.question.status, "answered");
  assert.deepEqual([context.question.answer.option, context.question.answer.owner, context.question.answer.via], ["Yes, draft it", true, "click"]);
  await settle();
  assert.equal(flow.published.at(-1).content, "Answer · Yes, draft it", "the answer becomes part of the thread record");
  // Answers already recorded are not posted twice.
  const count = flow.published.length; await flow.tool("meetings_live_context", {}); await settle();
  assert.equal(flow.published.length, count);
  flow.close();
});

test("a plain spoken reply is offered to the agent as an unverified suggestion; the question stays open", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { flow, member } = await asked();
    flow.speak(["riley-1", "Riley", "Yeah, go ahead."], ["sam-1", "Sam", "I think we should look at the minimap first, it hides the corner."]);
    assert.equal(member().question.status, "open");
    assert.deepEqual(member().suggestions.map(answer => [answer.option, answer.byName, answer.via, answer.owner, answer.heard]), [["Yes, draft it", "Riley", "speech", false, "Yeah, go ahead."]]);
    mock.timers.tick(0);
    assert.match(flow.wakes.at(-1).text, /may have answered your question/);
    const context = await flow.tool("meetings_live_context", {});
    assert.equal(context.answers.at(-1).by, "riley-1");
    assert.match(context.answersGuidance, /never as new permission/);
    flow.close();
  } finally { mock.timers.reset(); }
});

test("spoken suggestions are bounded, wakes are coalesced and the thread gets one summary line", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { flow, member } = await asked();
    const wakesBefore = flow.wakes.length, posts = flow.published.length;
    const speakers = ["Riley", "Sam", "Alex", "Kai", "Lee", "Max", "Noa"].map(name => [`${name.toLowerCase()}-1`, name]);
    for (let index = 0; index < 20; index++) {
      const [id, name] = speakers[index % 7];
      flow.speak([id, name, index % 2 ? "Yeah." : "Not yet."]);
      mock.timers.tick(1000);
    }
    assert.equal(member().suggestions.length, 6, "one per speaker per option, at most six");
    const wakes = flow.wakes.length - wakesBefore;
    assert.ok(wakes >= 1 && wakes <= 5, `coalesced wakes: ${wakes}`);
    await flow.tool("meetings_live_context", {}); await flush();
    assert.equal(flow.published.length, posts, "nothing posted while the question is open");
    flow.agents.answer(flow.agent.pubkey, "brief", "Yes, draft it");
    await flow.tool("meetings_live_context", {}); await flush();
    const added = flow.published.slice(posts).map(event => event.content);
    assert.equal(added.length, 2);
    assert.equal(added[0], "Answer · Yes, draft it");
    assert.match(added[1], /^Heard while asking "Turn these 3 cards into a brief\?" \(speech, unverified\): /);
    await flow.tool("meetings_live_context", {}); await flush();
    assert.equal(flow.published.length, posts + 2, "the summary is posted once");
    flow.close();
  } finally { mock.timers.reset(); }
});

test("one open question per agent: a newer one replaces the older, and unanswered questions expire visibly", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { flow, member } = await asked();
    await flow.tool("meetings_ask", { key: "order", question: "Which group first?", options: ["Visibility", "Track layout"], timeout_seconds: 30 });
    assert.equal(member().question.key, "order");
    flow.agents.answer(flow.agent.pubkey, "brief", "Yes, draft it");
    assert.equal(member().question.key, "order", "an answer to a replaced question is ignored");
    mock.timers.tick(30_000);
    assert.equal(member().question, undefined);
    assert.match(flow.wakes.at(-1).text, /closed without an answer/);
    assert.equal((await flow.tool("meetings_live_context", {})).question.status, "expired");
    flow.close();
  } finally { mock.timers.reset(); }
});

test("questions are bounded and need write access", async () => {
  const { flow } = await asked();
  for (const args of [{ key: "x", question: "q", options: ["only one"] }, { key: "x", question: "q", options: ["a", "b", "c", "d", "e"] }, { key: "x", question: "q".repeat(201), options: ["a", "b"] }, { key: "x", question: "q", options: ["Same", "same"] }, { key: "Bad Key", question: "q", options: ["a", "b"] }])
    await assert.rejects(flow.tool("meetings_ask", args), /2–4 distinct options/);
  flow.close();
});

test("the tile shows what the agent is doing from its latest task", async () => {
  const flow = meetingFlow();
  flow.join("RM_status"); await flow.addAgent();
  const status = () => flow.agents.snapshot().members[0].status;
  assert.deepEqual(status(), { state: "listening", caption: "Listening" });
  await flow.task({ key: "brief", title: "Drafting the Turn 3 brief", status: "working" });
  assert.equal(status().state, "working"); assert.equal(status().caption, "Drafting the Turn 3 brief");
  await flow.task({ key: "brief", title: "Drafting the Turn 3 brief", status: "done", result: "Brief posted." });
  assert.equal(status().state, "finished"); assert.equal(status().messageId, flow.published.at(-1).id);
  await flow.task({ key: "access", title: "Need access to the Design channel", status: "blocked" });
  assert.equal(status().state, "needs-input"); assert.equal(status().caption, "Blocked: Need access to the Design channel");
  flow.close();
});
