import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/artifacts.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { createContent, applyEdit, rebase, resolveConflict, serialize, parseContent, ArtifactError, opHistory } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

const agent = "a".repeat(64), riley = "b".repeat(64), sam = "c".repeat(64);
const rev = n => String(n).padStart(64, "0");
let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const edit = (actor, base, ops) => ({ opId: id(), base, actor, at: 1_700_000_000_000 + counter, ops });
const paragraph = (text, nodeId = id()) => ({ id: nodeId, type: "paragraph", text, author: agent, editedAt: 1 });
const card = (text, x, y, extra = {}) => ({ id: id(), type: "card", text, x, y, w: 160, h: 90, author: agent, editedAt: 1, ...extra });
const texts = content => content.nodes.map(node => node.text);

function brief() {
  const doc = createContent({ kind: "document", title: "Turn 3 playtest brief", createdBy: agent, occurrenceId: "RM_call" });
  const [saw, causes] = [paragraph("Seven of nine players missed the apex."), paragraph("The braking marker sits behind the bridge shadow.")];
  return { doc: applyEdit(doc, edit(agent, rev(1), [{ type: "insert", node: saw }, { type: "insert", node: causes, after: saw.id }])), saw, causes };
}

test("an edit applies once, records its author and survives a serialize round trip", () => {
  const { doc, causes } = brief();
  const change = edit(riley, rev(2), [{ type: "update", id: causes.id, fields: { text: "The marker is hidden until 40 m out." } }]);
  const next = applyEdit(doc, change);
  assert.equal(next.nodes[1].text, "The marker is hidden until 40 m out.");
  assert.equal(next.nodes[1].author, riley);
  assert.equal(applyEdit(next, change), next, "a replayed opId is a no-op");
  assert.deepEqual(parseContent(serialize(next)), next);
});

test("concurrent edits to different paragraphs both apply", () => {
  const { doc, saw, causes } = brief();
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: saw.id, fields: { text: "Seven of nine players braked late." } }]));
  const mine = edit(riley, rev(2), [{ type: "update", id: causes.id, fields: { text: "Riley: it is the bridge shadow." } }]);
  const result = rebase(doc, head, rev(3), mine);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.edit.base, rev(3));
  assert.deepEqual(texts(result.content), ["Seven of nine players braked late.", "Riley: it is the bridge shadow."]);
});

test("the same paragraph changed on both sides keeps the head and holds mine for Keep mine / Keep theirs", () => {
  const { doc, causes } = brief();
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: causes.id, fields: { text: "Retest planned for Friday." } }]));
  const mine = edit(sam, rev(2), [{ type: "update", id: causes.id, fields: { text: "We should test again on Thursday." } }]);
  const { content, conflicts } = rebase(doc, head, rev(3), mine);
  assert.equal(content.nodes[1].text, "Retest planned for Friday.");
  assert.deepEqual(conflicts.map(({ nodeId, field, mine, theirs }) => ({ nodeId, field, mine, theirs })), [{ nodeId: causes.id, field: "text", mine: "We should test again on Thursday.", theirs: "Retest planned for Friday." }]);
  assert.equal(resolveConflict(conflicts[0], "theirs", { opId: id(), base: rev(3), actor: sam, at: 2 }), undefined);
  const keep = resolveConflict(conflicts[0], "mine", { opId: id(), base: rev(3), actor: sam, at: 2 });
  assert.equal(applyEdit(content, keep).nodes[1].text, "We should test again on Thursday.");
});

test("an identical change on both sides is not a conflict", () => {
  const { doc, causes } = brief();
  const fields = { text: "Same words." };
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: causes.id, fields }]));
  const result = rebase(doc, head, rev(3), edit(sam, rev(2), [{ type: "update", id: causes.id, fields }]));
  assert.deepEqual(result.conflicts, []); assert.deepEqual(result.edit.ops, []);
});

test("remove versus update: the update wins in both directions and no text is lost", () => {
  const { doc, causes } = brief();
  // The agent removed the paragraph while Riley edited it: Riley's edit restores it.
  const removed = applyEdit(doc, edit(agent, rev(2), [{ type: "remove", id: causes.id }]));
  const edited = rebase(doc, removed, rev(3), edit(riley, rev(2), [{ type: "update", id: causes.id, fields: { text: "Riley's correction." } }]));
  assert.deepEqual(edited.restored, [causes.id]);
  assert.deepEqual(texts(edited.content), ["Seven of nine players missed the apex.", "Riley's correction."]);
  // Riley removed it while the agent edited it: the agent's update stays.
  const updated = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: causes.id, fields: { text: "Agent's addition." } }]));
  const removal = rebase(doc, updated, rev(3), edit(riley, rev(2), [{ type: "remove", id: causes.id }]));
  assert.deepEqual(removal.edit.ops, []);
  assert.deepEqual(texts(removal.content), ["Seven of nine players missed the apex.", "Agent's addition."]);
});

test("an insert anchored to a paragraph someone removed still lands, at the end", () => {
  const { doc, saw, causes } = brief();
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "remove", id: saw.id }]));
  const evidence = paragraph("Clip at 03:12 shows three players lifting.");
  const result = rebase(doc, head, rev(3), edit(riley, rev(2), [{ type: "insert", node: evidence, after: saw.id }]));
  assert.deepEqual(texts(result.content), [causes.text, evidence.text]);
});

test("on a board, moving a card and editing its text merge; grouping survives; removing a group keeps its cards", () => {
  let board = createContent({ kind: "board", title: "Turn 3 ideas", createdBy: agent });
  const group = { id: id(), type: "group", text: "Visibility", x: 0, y: 0, w: 400, h: 300, author: agent, editedAt: 1 };
  const marker = card("Move the braking marker", 10, 10), kerb = card("Brighter kerb paint", 200, 10);
  board = applyEdit(board, edit(agent, rev(1), [{ type: "insert", node: group }, { type: "insert", node: marker }, { type: "insert", node: kerb },
    { type: "insert", node: { id: id(), type: "connector", from: marker.id, to: kerb.id, author: agent, editedAt: 1 } }]));
  const head = applyEdit(board, edit(riley, rev(2), [{ type: "move", id: marker.id, x: 40, y: 60, groupId: group.id }]));
  const result = rebase(board, head, rev(3), edit(agent, rev(2), [{ type: "update", id: marker.id, fields: { text: "Move the marker out of the shadow" } }]));
  const moved = result.content.nodes.find(node => node.id === marker.id);
  assert.deepEqual([moved.x, moved.y, moved.groupId, moved.text], [40, 60, group.id, "Move the marker out of the shadow"]);
  // Both people dragged the same card: the head position stays and mine is held.
  const dragged = rebase(board, head, rev(3), edit(sam, rev(2), [{ type: "move", id: marker.id, x: 300, y: 200 }]));
  assert.deepEqual(dragged.conflicts.map(conflict => [conflict.field, conflict.mine, conflict.theirs]), [["x", 300, 40], ["y", 200, 60]]);
  const ungrouped = applyEdit(result.content, edit(sam, rev(4), [{ type: "remove", id: group.id }]));
  assert.equal(ungrouped.nodes.find(node => node.id === marker.id).groupId, undefined);
  const noCard = applyEdit(ungrouped, edit(sam, rev(5), [{ type: "remove", id: kerb.id }]));
  assert.equal(noCard.nodes.some(node => node.type === "connector"), false, "connectors to a removed card go with it");
});

test("a rebased edit that was already accepted becomes a no-op", () => {
  const { doc, causes } = brief();
  const change = edit(riley, rev(2), [{ type: "update", id: causes.id, fields: { text: "Accepted." } }]);
  const head = applyEdit(doc, change);
  const result = rebase(doc, head, rev(3), change);
  assert.equal(result.content, head); assert.deepEqual(result.edit.ops, []);
});

test("revisions stay within the 48 KiB budget and keep only the last operations", () => {
  let doc = createContent({ kind: "document", title: "Long", createdBy: agent });
  for (let index = 0; index < opHistory + 6; index++) doc = applyEdit(doc, edit(agent, rev(index + 1), [{ type: "insert", node: paragraph(`Line ${index}`) }]));
  assert.equal(doc.ops.length, opHistory);
  const big = applyEdit(doc, edit(agent, rev(99), Array.from({ length: 8 }, () => ({ type: "insert", node: paragraph("x".repeat(7000)) }))));
  assert.throws(() => serialize(big), ArtifactError);
});

test("invalid content and operations are refused", () => {
  assert.throws(() => parseContent("{"), ArtifactError);
  assert.throws(() => parseContent(JSON.stringify({ version: 1, kind: "board", title: "x", createdBy: agent, nodes: [{ id: id(), type: "paragraph", text: "", author: agent, editedAt: 1 }], ops: [] })), ArtifactError);
  const { doc } = brief();
  assert.throws(() => applyEdit(doc, edit(riley, rev(2), [{ type: "update", id: id(), fields: { text: "gone" } }])), ArtifactError);
  assert.throws(() => applyEdit(doc, edit(riley, rev(2), [{ type: "insert", node: { ...paragraph("x"), href: "javascript:alert(1)", type: "link" } }])), ArtifactError);
});
