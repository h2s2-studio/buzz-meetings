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

test("an insert anchored to a removed paragraph goes after its nearest surviving predecessor", () => {
  const { doc, saw, causes } = brief();
  const evidence = paragraph("Clip at 03:12 shows three players lifting.");
  // Nothing survives before the removed anchor: the insert goes to the start, not the end.
  const first = rebase(doc, applyEdit(doc, edit(agent, rev(2), [{ type: "remove", id: saw.id }])), rev(3), edit(riley, rev(2), [{ type: "insert", node: evidence, after: saw.id }]));
  assert.deepEqual(texts(first.content), [evidence.text, causes.text]);
  // The anchor's predecessor survives: the insert follows it.
  const third = paragraph("Next steps.");
  const longer = applyEdit(doc, edit(agent, rev(2), [{ type: "insert", node: third, after: causes.id }]));
  const second = rebase(longer, applyEdit(longer, edit(agent, rev(3), [{ type: "remove", id: causes.id }])), rev(4), edit(riley, rev(3), [{ type: "insert", node: evidence, after: causes.id }]));
  assert.deepEqual(texts(second.content), [saw.text, evidence.text, third.text]);
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

test("a connector or grouping to something the head removed restores it instead of failing", () => {
  let board = createContent({ kind: "board", title: "Ideas", createdBy: agent });
  const group = { id: id(), type: "group", text: "Visibility", x: 0, y: 0, w: 400, h: 300, author: agent, editedAt: 1 };
  const marker = card("Move the marker", 10, 10), kerb = card("Kerb paint", 200, 10);
  board = applyEdit(board, edit(agent, rev(1), [{ type: "insert", node: group }, { type: "insert", node: marker }, { type: "insert", node: kerb }]));
  const head = applyEdit(board, edit(agent, rev(2), [{ type: "remove", id: kerb.id }, { type: "remove", id: group.id }]));
  const connector = { id: id(), type: "connector", from: marker.id, to: kerb.id, author: riley, editedAt: 1 };
  const linked = rebase(board, head, rev(3), edit(riley, rev(2), [{ type: "insert", node: connector }, { type: "move", id: marker.id, groupId: group.id }]));
  assert.deepEqual(linked.restored.sort(), [group.id, kerb.id].sort());
  assert.ok(linked.content.nodes.some(node => node.id === connector.id));
  assert.equal(linked.content.nodes.find(node => node.id === marker.id).groupId, group.id);
});

test("a paragraph inserted and moved in the same edit is not a position conflict", () => {
  const { doc, saw, causes } = brief();
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: saw.id, fields: { text: "Changed." } }]));
  const fresh = paragraph("Next session: Thursday.");
  const result = rebase(doc, head, rev(3), edit(riley, rev(2), [{ type: "insert", node: fresh, after: causes.id }, { type: "move", id: fresh.id, after: null }]));
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(texts(result.content), ["Next session: Thursday.", "Changed.", causes.text]);
});

// Review items on PR #9, one test each.
test("later operations in one edit override earlier ones instead of conflicting with them", () => {
  const { doc, causes } = brief();
  const result = rebase(doc, doc, rev(3), edit(riley, rev(2), [{ type: "update", id: causes.id, fields: { text: "A" } }, { type: "update", id: causes.id, fields: { text: "B" } }]));
  assert.deepEqual(result.conflicts, []); assert.equal(result.content.nodes[1].text, "B");
  // A held conflict keeps the latest local value.
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: causes.id, fields: { text: "Head" } }]));
  const held = rebase(doc, head, rev(3), edit(riley, rev(2), [{ type: "update", id: causes.id, fields: { text: "A" } }, { type: "update", id: causes.id, fields: { text: "B" } }]));
  assert.deepEqual(held.conflicts.map(conflict => conflict.mine), ["B"]);
});

test("moving a paragraph is not a conflict when others only inserted or removed around it", () => {
  const { doc, saw, causes } = brief();
  const third = paragraph("Three.");
  const three = applyEdit(doc, edit(agent, rev(2), [{ type: "insert", node: third, after: causes.id }]));
  const head = applyEdit(three, edit(agent, rev(3), [{ type: "insert", node: paragraph("New above three."), after: causes.id }]));
  const result = rebase(three, head, rev(4), edit(riley, rev(3), [{ type: "move", id: third.id, after: null }]));
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(texts(result.content), ["Three.", saw.text, causes.text, "New above three."]);
  // Both sides moved it: the head's place stays and mine is held.
  const moved = applyEdit(three, edit(agent, rev(3), [{ type: "move", id: third.id, after: saw.id }]));
  const clash = rebase(three, moved, rev(4), edit(riley, rev(3), [{ type: "move", id: third.id, after: null }]));
  assert.deepEqual(clash.conflicts.map(conflict => [conflict.field, conflict.mine, conflict.theirs]), [["position", null, saw.id]]);
});

test("updates may change only the fields allowed for the node type, and stored nodes carry no other keys", () => {
  const { doc, causes } = brief();
  for (const fields of [{ junk: "x" }, { author: riley }, { editedAt: 5 }, { x: 4 }, {}])
    assert.throws(() => applyEdit(doc, edit(riley, rev(2), [{ type: "update", id: causes.id, fields }])), ArtifactError);
  let board = createContent({ kind: "board", title: "B", createdBy: agent });
  const marker = card("Marker", 0, 0);
  board = applyEdit(board, edit(agent, rev(1), [{ type: "insert", node: marker }]));
  assert.throws(() => applyEdit(board, edit(riley, rev(2), [{ type: "update", id: marker.id, fields: { x: 10 } }])), ArtifactError, "position is move-only");
  assert.throws(() => parseContent(JSON.stringify({ ...doc, nodes: [{ ...doc.nodes[0], junk: 1 }] })), ArtifactError);
});

test("a removal that loses to someone else's edit is reported as kept", () => {
  const { doc, causes } = brief();
  const head = applyEdit(doc, edit(agent, rev(2), [{ type: "update", id: causes.id, fields: { text: "Agent's addition." } }]));
  const result = rebase(doc, head, rev(3), edit(riley, rev(2), [{ type: "remove", id: causes.id }]));
  assert.deepEqual(result.kept, [{ nodeId: causes.id, reason: "edited" }]);
});

test("board references are type-checked: groups must be groups, connectors join two distinct cards or groups", () => {
  const base = createContent({ kind: "board", title: "B", createdBy: agent });
  const a = card("a", 0, 0), b = card("b", 10, 0), connector = { id: id(), type: "connector", from: a.id, to: b.id, author: agent, editedAt: 1 };
  const board = applyEdit(base, edit(agent, rev(1), [{ type: "insert", node: a }, { type: "insert", node: b }, { type: "insert", node: connector }]));
  const bad = [
    { ...card("c", 0, 0), groupId: a.id },
    { id: id(), type: "connector", from: a.id, to: a.id, author: agent, editedAt: 1 },
    { id: id(), type: "connector", from: a.id, to: connector.id, author: agent, editedAt: 1 },
  ];
  for (const node of bad) assert.throws(() => applyEdit(board, edit(agent, rev(2), [{ type: "insert", node }])), ArtifactError);
  const self = id();
  assert.throws(() => applyEdit(board, edit(agent, rev(2), [{ type: "insert", node: { id: self, type: "connector", from: self, to: a.id, author: agent, editedAt: 1 } }])), ArtifactError);
});

test("a restored node keeps its original author and time", () => {
  let board = createContent({ kind: "board", title: "B", createdBy: agent });
  const a = card("a", 0, 0), b = { ...card("b", 10, 0), author: sam, editedAt: 42 };
  board = applyEdit(board, edit(agent, rev(1), [{ type: "insert", node: a }]));
  board = applyEdit(board, edit(sam, rev(2), [{ type: "insert", node: b }]));
  const writtenBy = board.nodes.find(node => node.id === b.id);
  const head = applyEdit(board, edit(agent, rev(3), [{ type: "remove", id: b.id }]));
  const result = rebase(board, head, rev(4), edit(riley, rev(3), [{ type: "insert", node: { id: id(), type: "connector", from: a.id, to: b.id, author: riley, editedAt: 1 } }]));
  const back = result.content.nodes.find(node => node.id === b.id);
  assert.deepEqual([back.author, back.editedAt], [writtenBy.author, writtenBy.editedAt]);
});

test("renaming changes the title, and both sides renaming holds a conflict", () => {
  const { doc } = brief();
  const renamed = applyEdit(doc, edit(riley, rev(2), [{ type: "rename", title: "Thursday test brief" }]));
  assert.equal(renamed.title, "Thursday test brief");
  assert.throws(() => applyEdit(doc, edit(riley, rev(2), [{ type: "rename", title: " " }])), ArtifactError);
  const result = rebase(doc, renamed, rev(3), edit(sam, rev(2), [{ type: "rename", title: "Friday brief" }]));
  assert.deepEqual(result.conflicts.map(conflict => [conflict.nodeId, conflict.field, conflict.mine, conflict.theirs]), [["", "title", "Friday brief", "Thursday test brief"]]);
  const keep = resolveConflict(result.conflicts[0], "mine", { opId: id(), base: rev(3), actor: sam, at: 9 });
  assert.equal(applyEdit(result.content, keep).title, "Friday brief");
});
