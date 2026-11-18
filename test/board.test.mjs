import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const load = async entry => { const built = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false }); return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`); };
const [{ addCardOp, groupOps, connectOp, outline, briefFrom }, { createContent, applyEdit, parseContent, serialize, ArtifactError }] = await Promise.all([load("src/board.ts"), load("src/artifacts.ts")]);
const agent = "a".repeat(64), riley = "b".repeat(64), rev = "c".repeat(64);
const edit = (actor, ops) => ({ opId: crypto.randomUUID(), base: "", actor, at: 1, ops });
function board() {
  let content = createContent({ kind: "board", title: "Turn 3 ideas", createdBy: agent, occurrenceId: "RM_call" });
  for (const text of ["Move the braking marker", "Brighter kerb paint", "Show the radius on the minimap"]) content = applyEdit(content, edit(agent, [addCardOp(content, agent, text)]));
  return content;
}
const cardId = (content, text) => content.nodes.find(node => node.text === text).id;

test("new cards land on free spots instead of stacking", () => {
  const content = board();
  const spots = content.nodes.map(node => `${node.x},${node.y}`);
  assert.equal(new Set(spots).size, 3);
});

test("grouping frames the chosen cards and moves them in; one card alone is not a group", () => {
  let content = board();
  const [a, b] = [cardId(content, "Move the braking marker"), cardId(content, "Brighter kerb paint")];
  assert.deepEqual(groupOps(content, [a], agent, "Visibility"), []);
  content = applyEdit(content, edit(riley, groupOps(content, [a, b], riley, "Visibility")));
  const group = content.nodes.find(node => node.type === "group");
  assert.equal(group.text, "Visibility"); assert.equal(content.nodes[0].id, group.id, "groups render beneath cards");
  for (const id of [a, b]) { const card = content.nodes.find(node => node.id === id); assert.equal(card.groupId, group.id); assert.ok(card.x >= group.x && card.x + card.w <= group.x + group.w); }
});

test("connectors join two different cards once", () => {
  let content = board();
  const [a, b] = [cardId(content, "Move the braking marker"), cardId(content, "Show the radius on the minimap")];
  assert.equal(connectOp(content, a, a, agent), undefined);
  content = applyEdit(content, edit(agent, [connectOp(content, a, b, agent)]));
  assert.equal(connectOp(content, b, a, agent), undefined, "no duplicate in either direction");
});

test("the outline lists groups with their cards, loose cards, and connections", () => {
  let content = board();
  const [a, b, c] = ["Move the braking marker", "Brighter kerb paint", "Show the radius on the minimap"].map(text => cardId(content, text));
  content = applyEdit(content, edit(agent, groupOps(content, [a, b], agent, "Visibility")));
  content = applyEdit(content, edit(agent, [connectOp(content, a, c, agent)]));
  assert.deepEqual(outline(content).map(item => [item.kind, item.depth, item.text, item.links]), [
    ["group", 0, "Visibility", []],
    ["card", 1, "Move the braking marker", ["→ Show the radius on the minimap"]],
    ["card", 1, "Brighter kerb paint", []],
    ["card", 0, "Show the radius on the minimap", ["← Move the braking marker"]],
  ]);
});

test("a brief from selected cards is a linked document, grouped by the board's groups", () => {
  let content = board();
  const [a, b, c] = ["Move the braking marker", "Brighter kerb paint", "Show the radius on the minimap"].map(text => cardId(content, text));
  content = applyEdit(content, edit(agent, groupOps(content, [a, b], agent, "Visibility")));
  const boardId = crypto.randomUUID();
  const brief = briefFrom(content, boardId, rev, [c, a], riley, "RM_call");
  assert.equal(brief.kind, "document"); assert.equal(brief.title, "Brief: Turn 3 ideas"); assert.equal(brief.occurrenceId, "RM_call");
  assert.deepEqual(brief.source, { artifactId: boardId, revision: rev, nodeIds: [a, c] });
  assert.deepEqual(brief.nodes.map(node => [node.type, node.text]), [["paragraph", "From the board “Turn 3 ideas”: 2 cards."], ["heading", "Visibility"], ["paragraph", "Move the braking marker"], ["paragraph", "Show the radius on the minimap"]]);
  assert.deepEqual(parseContent(serialize(brief)).source, brief.source);
  assert.throws(() => briefFrom(content, boardId, rev, [], riley), /at least one card/);
});

test("a source link is only valid on a document and must be well formed", () => {
  const good = { artifactId: crypto.randomUUID(), revision: rev, nodeIds: [] };
  assert.throws(() => createContent({ kind: "board", title: "x", createdBy: agent, source: good }), ArtifactError);
  assert.throws(() => createContent({ kind: "document", title: "x", createdBy: agent, source: { ...good, revision: "nope" } }), ArtifactError);
  assert.throws(() => createContent({ kind: "document", title: "x", createdBy: agent, source: { ...good, extra: 1 } }), ArtifactError);
});
