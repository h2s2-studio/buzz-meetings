// Board helpers on top of the artifact model: pure, so the board UI and agents share them.
import { applyEdit, createContent, type ArtifactContent, type BoardNode, type NodeOp } from "./artifacts";

export const cardSize = { w: 176, h: 96 }, groupPadding = 24;
const cards = (content: ArtifactContent) => content.nodes.filter((node): node is BoardNode => (node as BoardNode).type === "card");
const groups = (content: ArtifactContent) => content.nodes.filter((node): node is BoardNode => (node as BoardNode).type === "group");
const byPosition = (a: BoardNode, b: BoardNode) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0);

/** A new card at the next free spot in a simple grid, so cards never stack on each other. */
export function addCardOp(content: ArtifactContent, actor: string, text: string, at = Date.now()): NodeOp {
  const taken = cards(content).length, column = taken % 4, row = Math.floor(taken / 4);
  const free = (x: number, y: number) => !content.nodes.some(node => { const value = node as BoardNode; return value.type !== "connector" && Math.abs((value.x ?? 0) - x) < cardSize.w && Math.abs((value.y ?? 0) - y) < cardSize.h; });
  let x = 32 + column * (cardSize.w + 24), y = 32 + row * (cardSize.h + 24);
  for (let guard = 0; !free(x, y) && guard < 200; guard++) { x += cardSize.w + 24; if (x > 32 + 3 * (cardSize.w + 24)) { x = 32; y += cardSize.h + 24; } }
  return { type: "insert", node: { id: crypto.randomUUID(), type: "card", text: text.slice(0, 8000), x, y, w: cardSize.w, h: cardSize.h, author: actor, editedAt: at } };
}

/** Group the selected cards: a group framing them, and each card moved into it. */
export function groupOps(content: ArtifactContent, ids: readonly string[], actor: string, label: string, at = Date.now()): NodeOp[] {
  const chosen = cards(content).filter(card => ids.includes(card.id));
  if (chosen.length < 2) return [];
  const left = Math.min(...chosen.map(card => card.x ?? 0)) - groupPadding, top = Math.min(...chosen.map(card => card.y ?? 0)) - groupPadding - 16;
  const right = Math.max(...chosen.map(card => (card.x ?? 0) + (card.w ?? cardSize.w))) + groupPadding, bottom = Math.max(...chosen.map(card => (card.y ?? 0) + (card.h ?? cardSize.h))) + groupPadding;
  const id = crypto.randomUUID();
  // The group goes first so cards render above it.
  return [{ type: "insert", node: { id, type: "group", text: label.slice(0, 200) || "Group", x: left, y: top, w: right - left, h: bottom - top, author: actor, editedAt: at }, after: null }, ...chosen.map(card => ({ type: "move" as const, id: card.id, groupId: id }))];
}

export function connectOp(content: ArtifactContent, from: string, to: string, actor: string, at = Date.now()): NodeOp | undefined {
  const ends = content.nodes.filter(node => node.id === from || node.id === to);
  if (from === to || ends.length !== 2 || ends.some(node => !["card", "group"].includes((node as BoardNode).type))) return;
  if (content.nodes.some(node => { const value = node as BoardNode; return value.type === "connector" && ((value.from === from && value.to === to) || (value.from === to && value.to === from)); })) return;
  return { type: "insert", node: { id: crypto.randomUUID(), type: "connector", from, to, author: actor, editedAt: at } };
}

/** The board as a list for keyboard and screen-reader use: groups with their cards, then loose cards. */
export type OutlineItem = { id: string; kind: "group" | "card"; text: string; depth: 0 | 1; links: string[] };
export function outline(content: ArtifactContent): OutlineItem[] {
  const text = (id: string) => (content.nodes.find(node => node.id === id) as BoardNode | undefined)?.text || "Untitled";
  const links = (id: string) => content.nodes.flatMap(node => { const value = node as BoardNode; return value.type === "connector" && (value.from === id || value.to === id) ? [`${value.from === id ? "→" : "←"} ${text(value.from === id ? value.to! : value.from!)}`] : []; });
  const items: OutlineItem[] = [];
  for (const group of [...groups(content)].sort(byPosition)) {
    items.push({ id: group.id, kind: "group", text: group.text || "Group", depth: 0, links: links(group.id) });
    for (const card of cards(content).filter(card => card.groupId === group.id).sort(byPosition)) items.push({ id: card.id, kind: "card", text: card.text || "Untitled", depth: 1, links: links(card.id) });
  }
  for (const card of cards(content).filter(card => !card.groupId).sort(byPosition)) items.push({ id: card.id, kind: "card", text: card.text || "Untitled", depth: 0, links: links(card.id) });
  return items;
}

/** "Turn into a brief": a document from the chosen cards, linked to this board revision. */
export function briefFrom(board: ArtifactContent, boardId: string, revision: string, ids: readonly string[], actor: string, occurrenceId?: string, at = Date.now()): ArtifactContent {
  const chosen = cards(board).filter(card => ids.includes(card.id)).sort(byPosition);
  if (!chosen.length) throw new Error("Select at least one card.");
  const document = createContent({ kind: "document", title: `Brief: ${board.title}`.slice(0, 200), createdBy: actor, occurrenceId, source: { artifactId: boardId, revision, nodeIds: chosen.map(card => card.id) } });
  const ops: NodeOp[] = [];
  let last: string | null = null;
  const add = (type: "heading" | "paragraph", text: string) => { const id = crypto.randomUUID(); ops.push({ type: "insert", node: { id, type, text, author: actor, editedAt: at }, after: last }); last = id; };
  add("paragraph", `From the board “${board.title}”: ${chosen.length} ${chosen.length === 1 ? "card" : "cards"}.`);
  const named = new Map(groups(board).map(group => [group.id, group.text || "Group"]));
  for (const [groupId, label] of [...named, [undefined, ""] as const]) {
    const inGroup = chosen.filter(card => card.groupId === groupId || (groupId === undefined && (!card.groupId || !named.has(card.groupId))));
    if (!inGroup.length) continue;
    if (label) add("heading", label);
    for (const card of inGroup) add("paragraph", card.text || "Untitled");
  }
  return applyEdit(document, { opId: crypto.randomUUID(), base: "", actor, at, ops });
}
