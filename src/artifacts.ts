// Meeting documents and boards: a pure model with no host calls.
//
// An artifact revision is a full snapshot (the content of one kind-45010 event).
// People and agents change it with edits: a stable opId, the revision the edit
// was made against (base) and operations. When the relay reports that the head
// moved on (`conflict:`), the editor re-reads the head and rebases its pending
// edits onto it with `rebase`. Rules:
// - Edits to different nodes, or different fields of one node, all apply.
// - The same field changed on both sides keeps the head and returns the local
//   value as a conflict ("Your version") for Keep mine / Keep theirs. Within one
//   edit, a later operation overrides an earlier one.
// - Remove versus update: the update wins. A removed node is restored with its
//   original author and time; a removal that lost is reported in `kept`.
// - An insert or restore whose anchor is gone goes after the nearest surviving
//   predecessor from the base order.
// - Text is never silently dropped.
// Pointers, selection and viewport are transient and never stored here.
//
// Per-node `author` and `editedAt` are advisory: every revision is a full
// snapshot signed by one identity, so only the revision's signer is verifiable.

export const artifactLimit = 48 * 1024;
export const opHistory = 64;
export const documentType = "studio.h2s2.meetings.document";
export const boardType = "studio.h2s2.meetings.board";

export type ArtifactKind = "document" | "board";
export type DocumentNode = { id: string; type: "heading" | "paragraph" | "list" | "link"; text: string; href?: string; author: string; editedAt: number };
export type BoardNode = { id: string; type: "card" | "group" | "connector"; text?: string; x?: number; y?: number; w?: number; h?: number; groupId?: string; from?: string; to?: string; author: string; editedAt: number };
export type ArtifactNode = DocumentNode | BoardNode;
/** What a document was made from: a board revision and the cards chosen ("Turn into a brief"). */
export type ArtifactSource = { artifactId: string; revision: string; nodeIds: string[] };
export type ArtifactContent = { version: 1; kind: ArtifactKind; title: string; createdBy: string; occurrenceId?: string; source?: ArtifactSource; nodes: ArtifactNode[]; ops: string[] };

/** Fields an update may change; which apply depends on the node type (see `updatable`). */
export type NodeFields = { text?: string; href?: string | null; type?: string; w?: number; h?: number; from?: string; to?: string };
export type NodeOp =
  | { type: "insert"; node: ArtifactNode; after?: string | null; /** Re-inserting a removed node keeps its author and time. */ restore?: true }
  | { type: "update"; id: string; fields: NodeFields }
  | { type: "move"; id: string; after?: string | null; x?: number; y?: number; groupId?: string | null }
  | { type: "remove"; id: string }
  | { type: "rename"; title: string };
export type Edit = { opId: string; base: string; actor: string; at: number; ops: NodeOp[] };
/** A local value the head overrode; shown as "Your version" until resolved. `nodeId` is "" for the title. */
export type Conflict = { opId: string; nodeId: string; field: string; mine: unknown; theirs: unknown };
/** A local removal that lost because someone else edited the node meanwhile. */
export type Kept = { nodeId: string; reason: "edited" };
export type Rebased = { content: ArtifactContent; edit: Edit; conflicts: Conflict[]; restored: string[]; kept: Kept[] };

export class ArtifactError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const documentTypes = ["heading", "paragraph", "list", "link"];
const boardTypes = ["card", "group", "connector"];
const textLimit = 8000, titleLimit = 200, nodeLimit = 400;
const position = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message = "This document or board is not valid."): never => { throw new ArtifactError(message); };

// Stored keys per node type; anything else is rejected, so content cannot carry stray data.
const stored: Record<string, readonly string[]> = {
  document: ["id", "type", "text", "href", "author", "editedAt"],
  card: ["id", "type", "text", "x", "y", "w", "h", "groupId", "author", "editedAt"],
  group: ["id", "type", "text", "x", "y", "w", "h", "author", "editedAt"],
  connector: ["id", "type", "text", "from", "to", "author", "editedAt"],
};
// Fields an update may change. Position (x, y, groupId, order) is move-only.
const updatable: Record<string, readonly string[]> = { document: ["text", "href", "type"], card: ["text", "w", "h"], group: ["text", "w", "h"], connector: ["from", "to"] };
const shapeOf = (kind: ArtifactKind, node: ArtifactNode) => kind === "document" ? "document" : node.type;

export function createContent(input: { kind: ArtifactKind; title: string; createdBy: string; occurrenceId?: string; source?: ArtifactSource }): ArtifactContent {
  const content: ArtifactContent = { version: 1, kind: input.kind, title: input.title.trim().slice(0, titleLimit), createdBy: input.createdBy, ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}), ...(input.source ? { source: input.source } : {}), nodes: [], ops: [] };
  return validateContent(content);
}

function validNode(kind: ArtifactKind, node: ArtifactNode, nodes: Map<string, ArtifactNode>) {
  if (!node || typeof node !== "object" || !uuid.test(node.id) || !hex.test(node.author) || !Number.isSafeInteger(node.editedAt)) return false;
  const keys = stored[shapeOf(kind, node)];
  if (!keys || !Object.keys(node).every(key => keys.includes(key))) return false;
  if (kind === "document") {
    const value = node as DocumentNode;
    return documentTypes.includes(value.type) && typeof value.text === "string" && value.text.length <= textLimit && (value.href === undefined || (typeof value.href === "string" && /^https:\/\//.test(value.href) && value.href.length <= 2048));
  }
  const value = node as BoardNode;
  if (!boardTypes.includes(value.type) || (value.text !== undefined && (typeof value.text !== "string" || value.text.length > textLimit))) return false;
  // Connectors join two distinct cards or groups; a card's group must be a group.
  const linkable = (ref: unknown) => typeof ref === "string" && ref !== value.id && ["card", "group"].includes(nodes.get(ref)?.type ?? "");
  if (value.type === "connector") return linkable(value.from) && linkable(value.to) && value.from !== value.to;
  return [value.x, value.y, value.w ?? 0, value.h ?? 0].every(position) && (value.groupId === undefined || nodes.get(value.groupId)?.type === "group");
}

export function validateContent(content: ArtifactContent): ArtifactContent {
  const nodes = new Map((Array.isArray(content?.nodes) ? content.nodes : []).map(node => [node?.id, node] as const));
  if (!content || content.version !== 1 || !["document", "board"].includes(content.kind) || typeof content.title !== "string" || content.title.length > titleLimit
    || !hex.test(content.createdBy) || (content.occurrenceId !== undefined && typeof content.occurrenceId !== "string")
    || (content.source !== undefined && !(content.kind === "document" && uuid.test(content.source?.artifactId) && hex.test(content.source.revision) && Array.isArray(content.source.nodeIds) && content.source.nodeIds.length <= nodeLimit && content.source.nodeIds.every(id => uuid.test(id)) && Object.keys(content.source).length === 3)) || !Array.isArray(content.nodes) || content.nodes.length > nodeLimit
    || nodes.size !== content.nodes.length || !content.nodes.every(node => validNode(content.kind, node, nodes)) || !Array.isArray(content.ops) || content.ops.length > opHistory || !content.ops.every(op => typeof op === "string" && uuid.test(op)))
    fail();
  return content;
}

export function parseContent(raw: string): ArtifactContent {
  let value: ArtifactContent;
  try { value = JSON.parse(raw); } catch { return fail(); }
  return validateContent(value);
}

/** Serialized revision content; refuses anything over the 48 KiB event budget. */
export function serialize(content: ArtifactContent): string {
  const raw = JSON.stringify(validateContent(content));
  if (new TextEncoder().encode(raw).length > artifactLimit) fail("This is too large to save as one revision. Split it into another document or board.");
  return raw;
}

/** The kind-45010 `title` tag must always equal the content title, including after a rename. */
export const titleTag = (content: ArtifactContent) => ["title", content.title] as const;

const indexOf = (content: ArtifactContent, id: string) => content.nodes.findIndex(node => node.id === id);
function place(content: ArtifactContent, node: ArtifactNode, after: string | null | undefined) {
  const anchor = after ? indexOf(content, after) : -1;
  content.nodes.splice(after === null ? 0 : anchor >= 0 ? anchor + 1 : content.nodes.length, 0, node);
}
function setFields(kind: ArtifactKind, node: ArtifactNode, fields: NodeFields) {
  const allowed = updatable[shapeOf(kind, node)];
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length || !Object.keys(fields).every(key => allowed.includes(key))) fail("That change isn’t allowed for this item.");
  const target = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) if (value === null) delete target[key]; else target[key] = value;
}
function detach(content: ArtifactContent, id: string) {
  // Removing a group keeps its cards (ungrouped); removing a card drops connectors to it.
  content.nodes = content.nodes.filter(node => node.id !== id && !((node as BoardNode).type === "connector" && ((node as BoardNode).from === id || (node as BoardNode).to === id)));
  for (const node of content.nodes) if ((node as BoardNode).groupId === id) delete (node as BoardNode).groupId;
}

/** Apply an edit made against this content's revision. A replayed opId is a no-op. */
export function applyEdit(content: ArtifactContent, edit: Edit): ArtifactContent {
  if (!uuid.test(edit.opId) || !hex.test(edit.actor) || !Number.isSafeInteger(edit.at) || !Array.isArray(edit.ops)) fail("The edit is not valid.");
  if (content.ops.includes(edit.opId)) return content;
  const next = clone(content);
  for (const op of edit.ops) {
    if (op.type === "rename") {
      if (typeof op.title !== "string" || !op.title.trim() || op.title.length > titleLimit) fail("Enter a title of 1–200 characters.");
      next.title = op.title.trim();
    } else if (op.type === "insert") {
      if (!op.node || indexOf(next, op.node.id) >= 0) fail("That item already exists.");
      place(next, op.restore ? clone(op.node) : { ...op.node, author: edit.actor, editedAt: edit.at }, op.after);
    } else {
      const at = indexOf(next, op.id);
      if (at < 0) fail("That item no longer exists.");
      if (op.type === "remove") detach(next, op.id);
      else if (op.type === "update") { setFields(next.kind, next.nodes[at], op.fields); Object.assign(next.nodes[at], { author: edit.actor, editedAt: edit.at }); }
      else if (op.type === "move") {
        const node = next.nodes[at] as BoardNode;
        if (op.x !== undefined) node.x = op.x;
        if (op.y !== undefined) node.y = op.y;
        if (op.groupId === null) delete node.groupId; else if (op.groupId !== undefined) node.groupId = op.groupId;
        if (op.after !== undefined) { next.nodes.splice(at, 1); place(next, node, op.after); }
      } else fail("The edit is not valid.");
    }
  }
  next.ops = [...next.ops, edit.opId].slice(-opHistory);
  return validateContent(next);
}

const fieldsOf = (node: ArtifactNode | undefined): Record<string, unknown> => node ? Object.fromEntries(Object.entries(node).filter(([key]) => !["id", "author", "editedAt"].includes(key))) : {};
/** Base nodes that come before `id`, limited to those still present in `content`. */
function before(base: ArtifactContent, content: ArtifactContent, id: string) {
  const present = new Set(content.nodes.map(node => node.id)), at = indexOf(base, id);
  return base.nodes.slice(0, Math.max(0, at)).map(node => node.id).filter(other => present.has(other));
}
/** True when the head moved this node relative to the base nodes around it (not when others were added or removed). */
function movedInHead(base: ArtifactContent, head: ArtifactContent, id: string) {
  if (indexOf(base, id) < 0 || indexOf(head, id) < 0) return false;
  const shared = new Set(base.nodes.map(node => node.id)), headBefore = new Set(head.nodes.slice(0, indexOf(head, id)).map(node => node.id).filter(other => shared.has(other)));
  const baseBefore = before(base, head, id);
  return baseBefore.length !== headBefore.size || baseBefore.some(other => !headBefore.has(other));
}
/** Where to put something that was meant to follow `anchor`: after it, else after its nearest surviving base predecessor. */
function survivingAnchor(base: ArtifactContent, working: ArtifactContent, anchor: string | null | undefined): string | null | undefined {
  if (anchor === null || anchor === undefined || indexOf(working, anchor) >= 0) return anchor;
  if (indexOf(base, anchor) < 0) return undefined;
  return before(base, working, anchor).at(-1) ?? null;
}

/**
 * Rebase an edit made against `base` onto `head` (revision `headRevision`).
 * Decisions compare against the head, so an edit never conflicts with itself, and a
 * later operation on the same field overrides an earlier one. Returns the content
 * after the rebased edit, the rebased edit to sign, conflicts held for the person
 * to resolve, nodes restored, and removals that were kept because of an update.
 */
export function rebase(base: ArtifactContent, head: ArtifactContent, headRevision: string, edit: Edit): Rebased {
  if (head.ops.includes(edit.opId)) return { content: head, edit: { ...edit, base: headRevision, ops: [] }, conflicts: [], restored: [], kept: [] };
  const conflicts: Conflict[] = [], restored: string[] = [], kept: Kept[] = [], ops: NodeOp[] = [];
  const working = clone(head);
  const decided = new Map<string, "mine" | "theirs">();
  const nodeIn = (content: ArtifactContent, id: string) => content.nodes.find(node => node.id === id);
  // Field-level three-way decision against the head; later ops in this edit override earlier ones.
  function decide(nodeId: string, field: string, mine: unknown, theirs: unknown, was: unknown, fresh: boolean) {
    const key = `${nodeId}\u0000${field}`, earlier = decided.get(key);
    if (earlier === "theirs") { const held = conflicts.find(item => item.nodeId === nodeId && item.field === field); if (held) held.mine = mine; return false; }
    if (earlier === "mine" || fresh || same(theirs, was)) { decided.set(key, "mine"); return true; }
    if (same(mine, theirs)) return false;
    decided.set(key, "theirs"); conflicts.push({ opId: edit.opId, nodeId, field, mine, theirs });
    return false;
  }
  function restore(id: string) {
    if (indexOf(working, id) >= 0) return true;
    const original = nodeIn(base, id);
    if (!original) return false;
    for (const ref of [(original as BoardNode).from, (original as BoardNode).to, (original as BoardNode).groupId]) if (ref && !restore(ref)) return false;
    const after = survivingAnchor(base, working, before(base, base, id).at(-1) ?? null);
    const op: NodeOp = { type: "insert", node: clone(original), after, restore: true };
    ops.push(op); place(working, clone(original), after); restored.push(id);
    return true;
  }
  for (const op of edit.ops) {
    if (op.type === "rename") {
      if (decide("", "title", op.title, head.title, base.title, false)) { ops.push(op); working.title = op.title; }
      continue;
    }
    if (op.type === "insert") {
      if (indexOf(working, op.node.id) >= 0) continue;
      // A new connector or grouped card keeps what it refers to: restore it if the head removed it.
      const refs = [(op.node as BoardNode).from, (op.node as BoardNode).to, (op.node as BoardNode).groupId].filter((ref): ref is string => !!ref);
      if (!refs.every(ref => indexOf(working, ref) >= 0 || restore(ref))) continue;
      const after = survivingAnchor(base, working, op.after);
      ops.push({ ...op, after }); place(working, op.node, after);
      continue;
    }
    const original = nodeIn(base, op.id), current = nodeIn(working, op.id), theirs = nodeIn(head, op.id);
    const fresh = !original; // inserted earlier in this same edit
    if (op.type === "remove") {
      if (!current) continue;
      // Someone else's update to the same node wins over this removal; say so.
      if (original && theirs && !same(fieldsOf(original), fieldsOf(theirs))) { kept.push({ nodeId: op.id, reason: "edited" }); continue; }
      ops.push(op); detach(working, op.id);
      continue;
    }
    // An update or move to a node the head removed restores it.
    if (!current && !restore(op.id)) continue;
    const headFields = fieldsOf(theirs ?? original), baseFields = fieldsOf(original);
    if (op.type === "update") {
      const fields: NodeFields = {};
      for (const [field, mine] of Object.entries(op.fields ?? {})) if (decide(op.id, field, mine ?? undefined, headFields[field], baseFields[field], fresh || !theirs)) (fields as Record<string, unknown>)[field] = mine;
      if (Object.keys(fields).length) { const update: NodeOp = { type: "update", id: op.id, fields }; ops.push(update); setFields(working.kind, working.nodes[indexOf(working, op.id)], fields); }
      continue;
    }
    const move: { type: "move"; id: string; after?: string | null; x?: number; y?: number; groupId?: string | null } = { type: "move", id: op.id };
    for (const field of ["x", "y", "groupId"] as const) {
      if (op[field] === undefined) continue;
      if (field === "groupId" && op.groupId && indexOf(working, op.groupId) < 0 && !restore(op.groupId)) continue;
      if (decide(op.id, field, op[field] ?? undefined, headFields[field], baseFields[field], fresh || !theirs)) (move as Record<string, unknown>)[field] = op[field];
    }
    if (op.after !== undefined) {
      // Only a head-side move of this node conflicts; others' inserts or removals around it do not.
      const headMoved = !fresh && !!theirs && movedInHead(base, head, op.id), unmoved = "\u0000base-position";
      const headPlace = headMoved ? (head.nodes[indexOf(head, op.id) - 1]?.id ?? null) : unmoved;
      if (decide(op.id, "position", op.after, headPlace, unmoved, fresh || !theirs)) move.after = survivingAnchor(base, working, op.after);
    }
    if (Object.keys(move).length > 2) {
      ops.push(move);
      const node = working.nodes[indexOf(working, op.id)] as BoardNode;
      if (move.x !== undefined) node.x = move.x;
      if (move.y !== undefined) node.y = move.y;
      if (move.groupId === null) delete node.groupId; else if (move.groupId !== undefined) node.groupId = move.groupId;
      if (move.after !== undefined) { working.nodes.splice(indexOf(working, op.id), 1); place(working, node, move.after); }
    }
  }
  const rebased: Edit = { ...edit, base: headRevision, ops };
  return { content: ops.length ? applyEdit(head, rebased) : head, edit: rebased, conflicts, restored, kept };
}

/** Keep mine turns a held conflict into a new edit against the current head; Keep theirs needs none. */
export function resolveConflict(conflict: Conflict, choice: "mine" | "theirs", input: { opId: string; base: string; actor: string; at: number }): Edit | undefined {
  if (choice === "theirs") return undefined;
  const ops: NodeOp[] = conflict.field === "title" && !conflict.nodeId ? [{ type: "rename", title: conflict.mine as string }]
    : conflict.field === "position" ? [{ type: "move", id: conflict.nodeId, after: conflict.mine as string | null }]
    : ["x", "y", "groupId"].includes(conflict.field) ? [{ type: "move", id: conflict.nodeId, [conflict.field]: conflict.mine } as NodeOp]
    : [{ type: "update", id: conflict.nodeId, fields: { [conflict.field]: conflict.mine } as NodeFields }];
  return { ...input, ops };
}
