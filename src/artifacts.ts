// Meeting documents and boards: a pure model with no host calls.
//
// An artifact revision is a full snapshot (the content of one kind-45010 event).
// People and agents change it with edits: a stable opId, the revision the edit
// was made against (base) and node operations. When the relay reports that the
// head moved on (`conflict:`), the editor re-reads the head and rebases its
// pending edits onto it with `rebase`. Rules:
// - Edits to different nodes, or different fields of one node, all apply.
// - The same field changed on both sides keeps the head and returns the local
//   value as a conflict ("Your version") for Keep mine / Keep theirs.
// - Remove versus update: the update wins and a removed node is restored.
// - Text is never silently dropped.
// Pointers, selection and viewport are transient and never stored here.

export const artifactLimit = 48 * 1024;
export const opHistory = 64;
export const documentType = "studio.h2s2.meetings.document";
export const boardType = "studio.h2s2.meetings.board";

export type ArtifactKind = "document" | "board";
export type DocumentNode = { id: string; type: "heading" | "paragraph" | "list" | "link"; text: string; href?: string; author: string; editedAt: number };
export type BoardNode = { id: string; type: "card" | "group" | "connector"; text?: string; x?: number; y?: number; w?: number; h?: number; groupId?: string; from?: string; to?: string; author: string; editedAt: number };
export type ArtifactNode = DocumentNode | BoardNode;
export type ArtifactContent = { version: 1; kind: ArtifactKind; title: string; createdBy: string; occurrenceId?: string; nodes: ArtifactNode[]; ops: string[] };

/** Fields a person or agent can change on an existing node. */
export type NodeFields = { text?: string; href?: string; type?: string; w?: number; h?: number; groupId?: string | null; from?: string; to?: string };
export type NodeOp =
  | { type: "insert"; node: ArtifactNode; after?: string | null }
  | { type: "update"; id: string; fields: NodeFields }
  | { type: "move"; id: string; after?: string | null; x?: number; y?: number; groupId?: string | null }
  | { type: "remove"; id: string };
export type Edit = { opId: string; base: string; actor: string; at: number; ops: NodeOp[] };
/** A local value the head overrode; shown as "Your version" until resolved. */
export type Conflict = { opId: string; nodeId: string; field: string; mine: unknown; theirs: unknown };
export type Rebased = { content: ArtifactContent; edit: Edit; conflicts: Conflict[]; restored: string[] };

export class ArtifactError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const documentTypes = ["heading", "paragraph", "list", "link"];
const boardTypes = ["card", "group", "connector"];
const textLimit = 8000, titleLimit = 200, nodeLimit = 400;
const position = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createContent(input: { kind: ArtifactKind; title: string; createdBy: string; occurrenceId?: string }): ArtifactContent {
  const content: ArtifactContent = { version: 1, kind: input.kind, title: input.title.trim().slice(0, titleLimit), createdBy: input.createdBy, ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}), nodes: [], ops: [] };
  validateContent(content);
  return content;
}

function validNode(kind: ArtifactKind, node: ArtifactNode, ids: Set<string>) {
  if (!node || typeof node !== "object" || !uuid.test(node.id) || !hex.test(node.author) || !Number.isSafeInteger(node.editedAt)) return false;
  if (kind === "document") {
    const value = node as DocumentNode;
    return documentTypes.includes(value.type) && typeof value.text === "string" && value.text.length <= textLimit && (value.href === undefined || (typeof value.href === "string" && /^https:\/\//.test(value.href) && value.href.length <= 2048));
  }
  const value = node as BoardNode;
  if (!boardTypes.includes(value.type) || (value.text !== undefined && (typeof value.text !== "string" || value.text.length > textLimit))) return false;
  if (value.type === "connector") return typeof value.from === "string" && typeof value.to === "string" && ids.has(value.from) && ids.has(value.to);
  return [value.x, value.y, value.w ?? 0, value.h ?? 0].every(position) && (value.groupId === undefined || ids.has(value.groupId));
}

export function validateContent(content: ArtifactContent): ArtifactContent {
  const ids = new Set(content?.nodes?.map(node => node?.id));
  if (!content || content.version !== 1 || !["document", "board"].includes(content.kind) || typeof content.title !== "string" || content.title.length > titleLimit
    || !hex.test(content.createdBy) || (content.occurrenceId !== undefined && typeof content.occurrenceId !== "string") || !Array.isArray(content.nodes) || content.nodes.length > nodeLimit
    || ids.size !== content.nodes.length || !content.nodes.every(node => validNode(content.kind, node, ids)) || !Array.isArray(content.ops) || content.ops.length > opHistory || !content.ops.every(op => typeof op === "string" && uuid.test(op)))
    throw new ArtifactError("This document or board is not valid.");
  return content;
}

export function parseContent(raw: string): ArtifactContent {
  let value: ArtifactContent;
  try { value = JSON.parse(raw); } catch { throw new ArtifactError("This document or board is not valid."); }
  return validateContent(value);
}

/** Serialized revision content; refuses anything over the 48 KiB event budget. */
export function serialize(content: ArtifactContent): string {
  const raw = JSON.stringify(validateContent(content));
  if (new TextEncoder().encode(raw).length > artifactLimit) throw new ArtifactError("This is too large to save as one revision. Split it into another document or board.");
  return raw;
}

function indexOf(content: ArtifactContent, id: string) { return content.nodes.findIndex(node => node.id === id); }
function place(content: ArtifactContent, node: ArtifactNode, after: string | null | undefined) {
  const anchor = after ? indexOf(content, after) : -1;
  content.nodes.splice(after === null ? 0 : anchor >= 0 ? anchor + 1 : content.nodes.length, 0, node);
}
function setFields(node: ArtifactNode, fields: NodeFields) {
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
  if (!uuid.test(edit.opId) || !hex.test(edit.actor)) throw new ArtifactError("The edit is not valid.");
  if (content.ops.includes(edit.opId)) return content;
  const next = clone(content);
  for (const op of edit.ops) {
    if (op.type === "insert") {
      if (indexOf(next, op.node.id) >= 0) throw new ArtifactError("That item already exists.");
      place(next, { ...op.node, author: edit.actor, editedAt: edit.at }, op.after);
    } else {
      const at = indexOf(next, op.id);
      if (at < 0) throw new ArtifactError("That item no longer exists.");
      if (op.type === "remove") detach(next, op.id);
      else if (op.type === "update") { setFields(next.nodes[at], op.fields); Object.assign(next.nodes[at], { author: edit.actor, editedAt: edit.at }); }
      else {
        const node = next.nodes[at] as BoardNode;
        if (op.x !== undefined) node.x = op.x;
        if (op.y !== undefined) node.y = op.y;
        if (op.groupId === null) delete node.groupId; else if (op.groupId !== undefined) node.groupId = op.groupId;
        if (op.after !== undefined) { next.nodes.splice(at, 1); place(next, node, op.after); }
      }
    }
  }
  next.ops = [...next.ops, edit.opId].slice(-opHistory);
  return validateContent(next);
}

const fieldsOf = (node: ArtifactNode | undefined): Record<string, unknown> => node ? Object.fromEntries(Object.entries(node).filter(([key]) => !["id", "author", "editedAt"].includes(key))) : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const predecessor = (content: ArtifactContent, id: string) => { const at = indexOf(content, id); return at > 0 ? content.nodes[at - 1].id : null; };

/**
 * Rebase an edit made against `base` onto `head` (revision `headRevision`).
 * Returns the content after applying the rebased edit, the rebased edit to sign,
 * conflicts held for the person to resolve, and any removed nodes restored.
 */
export function rebase(base: ArtifactContent, head: ArtifactContent, headRevision: string, edit: Edit): Rebased {
  if (head.ops.includes(edit.opId)) return { content: head, edit: { ...edit, base: headRevision, ops: [] }, conflicts: [], restored: [] };
  const conflicts: Conflict[] = [], restored: string[] = [], ops: NodeOp[] = [];
  const working = clone(head);
  const restore = (id: string) => {
    if (indexOf(working, id) >= 0) return true;
    const original = base.nodes.find(node => node.id === id);
    if (!original) return false;
    place(working, clone(original), predecessor(base, id) ?? null);
    ops.push({ type: "insert", node: clone(original), after: predecessor(base, id) ?? null });
    restored.push(id);
    return true;
  };
  for (const op of edit.ops) {
    if (op.type === "insert") {
      if (indexOf(working, op.node.id) >= 0) continue;
      // A new connector or grouped card keeps what it refers to: restore it if the head removed it.
      const refs = [(op.node as BoardNode).from, (op.node as BoardNode).to, (op.node as BoardNode).groupId].filter((ref): ref is string => !!ref);
      if (!refs.every(ref => indexOf(working, ref) >= 0 || restore(ref))) continue;
      const after = op.after && indexOf(working, op.after) < 0 ? undefined : op.after;
      ops.push({ ...op, after }); place(working, op.node, after);
      continue;
    }
    const before = base.nodes.find(node => node.id === op.id), now = working.nodes.find(node => node.id === op.id);
    if (op.type === "remove") {
      // Someone else's update to the same node wins over this removal.
      if (!now || (before && !same(fieldsOf(before), fieldsOf(now)))) continue;
      ops.push(op); detach(working, op.id);
      continue;
    }
    // An update or move to a node the head removed restores it.
    if (!now && !restore(op.id)) continue;
    if (op.type === "move" && op.groupId && indexOf(working, op.groupId) < 0 && !restore(op.groupId)) continue;
    const current = fieldsOf(working.nodes.find(node => node.id === op.id)), original = fieldsOf(before);
    if (op.type === "update") {
      const fields: NodeFields = {};
      for (const [field, mine] of Object.entries(op.fields)) {
        const theirs = current[field], was = original[field];
        if (same(mine ?? undefined, theirs)) continue;
        if (same(theirs, was) || !before) (fields as Record<string, unknown>)[field] = mine;
        else conflicts.push({ opId: edit.opId, nodeId: op.id, field, mine, theirs });
      }
      if (Object.keys(fields).length) { ops.push({ type: "update", id: op.id, fields }); setFields(working.nodes[indexOf(working, op.id)], fields); }
      continue;
    }
    const move: NodeOp = { type: "move", id: op.id };
    for (const field of ["x", "y", "groupId"] as const) {
      if (op[field] === undefined) continue;
      const theirs = current[field], was = original[field], mine = op[field] ?? undefined;
      if (same(mine, theirs)) continue;
      if (same(theirs, was)) (move as Record<string, unknown>)[field] = op[field];
      else conflicts.push({ opId: edit.opId, nodeId: op.id, field, mine, theirs });
    }
    if (op.after !== undefined) {
      // A node this edit inserted has no base position to conflict with.
      if (!before || predecessor(head, op.id) === predecessor(base, op.id)) (move as { after?: string | null }).after = op.after && indexOf(working, op.after) < 0 ? undefined : op.after;
      else conflicts.push({ opId: edit.opId, nodeId: op.id, field: "position", mine: op.after, theirs: predecessor(head, op.id) });
    }
    if (Object.keys(move).length > 2) ops.push(move);
  }
  const rebased: Edit = { ...edit, base: headRevision, ops };
  return { content: ops.length ? applyEdit(head, rebased) : head, edit: rebased, conflicts, restored };
}

/** Keep mine turns a held conflict into a new edit against the current head; Keep theirs needs none. */
export function resolveConflict(conflict: Conflict, choice: "mine" | "theirs", input: { opId: string; base: string; actor: string; at: number }): Edit | undefined {
  if (choice === "theirs") return undefined;
  const ops: NodeOp[] = conflict.field === "position" ? [{ type: "move", id: conflict.nodeId, after: conflict.mine as string | null }]
    : ["x", "y", "groupId"].includes(conflict.field) ? [{ type: "move", id: conflict.nodeId, [conflict.field]: conflict.mine } as NodeOp]
    : [{ type: "update", id: conflict.nodeId, fields: { [conflict.field]: conflict.mine } as NodeFields }];
  return { ...input, ops };
}
