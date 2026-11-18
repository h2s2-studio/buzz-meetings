import type * as ReactRuntime from "react";
import type { ArtifactContent, BoardNode, Conflict } from "./artifacts";
import type { Revision } from "./artifact-store";
import type { DocumentSession } from "./document-editor";
import { addCardOp, briefFrom, cardSize, connectOp, groupOps, outline } from "./board";

type Props = {
  session: DocumentSession; content: ArtifactContent; revision: Revision; readOnly: boolean;
  actor(): string | undefined; name(pubkey: string): string;
  /** Create the brief document and open it. */
  brief(content: ArtifactContent): Promise<void>;
  occurrence?: string;
};

// Design screen 5 in the quiet style: cards, groups and connectors on a plain
// surface, one small toolbar, and an Outline view that does everything by keyboard.
export function boardUI(React: typeof ReactRuntime) {
  const { useRef, useState } = React;

  // Outside Board, so a re-render while typing keeps the draft.
  function Text({ node, label, commit, cancel }: { node: BoardNode; label: string; commit(id: string, text: string): void; cancel(): void }) {
    const [value, setValue] = useState(node.text ?? ""), done = useRef(false);
    const finish = (save: boolean) => { if (done.current) return; done.current = true; if (save) commit(node.id, value); else cancel(); };
    return <textarea className="meeting-board-input" aria-label={label} autoFocus value={value} maxLength={8000}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onChange={event => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); finish(false); } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); finish(true); } }} />;
  }
  function Board({ session, content, revision, readOnly, actor, name, brief, occurrence }: Props) {
    const [view, setView] = useState<"board" | "outline">("board");
    const [selected, setSelected] = useState<string[]>([]);
    const [editing, setEditing] = useState<string>();
    const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean }>();
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const live = React.useSyncExternalStore(session.subscribe, session.snapshot);
    const nodes = content.nodes as BoardNode[], byId = new Map(nodes.map(node => [node.id, node]));
    const cards = nodes.filter(node => node.type === "card"), groups = nodes.filter(node => node.type === "group"), connectors = nodes.filter(node => node.type === "connector");
    const chosen = selected.filter(id => byId.get(id)?.type === "card");
    const who = actor();
    const toggle = (id: string, extend: boolean) => setSelected(current => extend ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : current.length === 1 && current[0] === id ? [] : [id]);

    function addCard() { if (!who) return; const op = addCardOp(content, who, ""); session.edit([op], true); if (op.type === "insert") { setSelected([op.node.id]); setEditing(op.node.id); } }
    function group() { if (!who) return; const ops = groupOps(content, chosen, who, "Group"); if (ops.length) { session.edit(ops, true); const id = ops[0].type === "insert" ? ops[0].node.id : undefined; if (id) { setSelected([id]); setEditing(id); } } }
    function connect() { if (!who || selected.length !== 2) return; const op = connectOp(content, selected[0], selected[1], who); if (op) session.edit([op], true); }
    function remove() { if (!selected.length) return; session.edit(selected.filter(id => byId.has(id)).map(id => ({ type: "remove" as const, id })), true); setSelected([]); }
    async function turnIntoBrief() {
      if (!who || !chosen.length || busy) return;
      setBusy(true); setError("");
      try { await brief(briefFrom(content, revision.artifactId, revision.id, chosen, who, occurrence)); }
      catch (problem) { setError(problem instanceof Error ? problem.message : "Couldn’t make a brief."); }
      finally { setBusy(false); }
    }
    function commitText(id: string, text: string) { setEditing(undefined); if ((byId.get(id)?.text ?? "") !== text) session.edit([{ type: "update", id, fields: { text } }], true); }

    // Dragging: the card follows the pointer locally; one move is saved on release.
    function down(event: ReactRuntime.PointerEvent, node: BoardNode) {
      if (readOnly || editing === node.id || event.button !== 0) return;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      setDrag({ id: node.id, dx: 0, dy: 0, startX: event.clientX, startY: event.clientY, moved: false });
    }
    function move(event: ReactRuntime.PointerEvent) { if (drag) { const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY; setDrag({ ...drag, dx, dy, moved: drag.moved || Math.abs(dx) + Math.abs(dy) > 3 }); } }
    function up(event: ReactRuntime.PointerEvent, node: BoardNode) {
      if (!drag || drag.id !== node.id) return;
      setDrag(undefined);
      if (!drag.moved) { toggle(node.id, event.shiftKey || event.metaKey); return; }
      const x = Math.round((node.x ?? 0) + drag.dx), y = Math.round((node.y ?? 0) + drag.dy);
      // Dropping a card inside a group puts it in that group; dropping it outside takes it out.
      const target = node.type === "card" ? groups.find(group => x + (node.w ?? cardSize.w) / 2 > (group.x ?? 0) && x + (node.w ?? cardSize.w) / 2 < (group.x ?? 0) + (group.w ?? 0) && y + (node.h ?? cardSize.h) / 2 > (group.y ?? 0) && y + (node.h ?? cardSize.h) / 2 < (group.y ?? 0) + (group.h ?? 0)) : undefined;
      const groupId = node.type !== "card" ? undefined : target ? (target.id === node.groupId ? undefined : target.id) : node.groupId ? null : undefined;
      session.edit([{ type: "move", id: node.id, x, y, ...(groupId !== undefined ? { groupId } : {}) }], true);
    }
    // Keyboard on the board: arrows nudge the selected card, Enter edits, Delete removes.
    function key(event: ReactRuntime.KeyboardEvent, node: BoardNode) {
      if (readOnly || editing) return;
      const step = event.shiftKey ? 48 : 12, delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (delta) { event.preventDefault(); session.edit([{ type: "move", id: node.id, x: (node.x ?? 0) + delta[0], y: (node.y ?? 0) + delta[1] }], true); }
      else if (event.key === "Enter") { event.preventDefault(); setEditing(node.id); }
      else if (event.key === " ") { event.preventDefault(); toggle(node.id, true); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); session.edit([{ type: "remove", id: node.id }], true); setSelected(current => current.filter(id => id !== node.id)); }
    }
    const at = (node: BoardNode) => drag?.id === node.id ? { x: (node.x ?? 0) + drag.dx, y: (node.y ?? 0) + drag.dy } : { x: node.x ?? 0, y: node.y ?? 0 };
    const centre = (id?: string) => { const node = id ? byId.get(id) : undefined; if (!node) return; const point = at(node); return { x: point.x + (node.w ?? cardSize.w) / 2, y: point.y + (node.h ?? cardSize.h) / 2 }; };
    const width = Math.max(720, ...nodes.map(node => (node.x ?? 0) + (node.w ?? cardSize.w) + 48)), height = Math.max(420, ...nodes.map(node => (node.y ?? 0) + (node.h ?? cardSize.h) + 48));
    const conflictFor = (id: string): Conflict | undefined => live.conflicts.find(item => item.nodeId === id && item.field === "text");

    const item = (node: BoardNode) => {
      const point = at(node), isSelected = selected.includes(node.id), label = node.type === "group" ? `Group: ${node.text || "Group"}` : `Card: ${node.text || "Untitled"}`;
      const conflict = conflictFor(node.id);
      return <div key={node.id} className={`meeting-board-${node.type}`} role="button" tabIndex={0} aria-pressed={isSelected} aria-label={label}
        data-selected={isSelected || undefined} data-dragging={drag?.id === node.id || undefined}
        style={{ left: point.x, top: point.y, width: node.w ?? cardSize.w, height: node.h ?? cardSize.h }}
        onPointerDown={event => down(event, node)} onPointerMove={move} onPointerUp={event => up(event, node)} onDoubleClick={() => !readOnly && setEditing(node.id)} onKeyDown={event => key(event, node)}>
        {editing === node.id ? <Text node={node} label={node.type === "group" ? "Group name" : "Card text"} commit={commitText} cancel={() => setEditing(undefined)} /> : <span className="meeting-board-text">{node.text || (node.type === "group" ? "Group" : "Untitled")}</span>}
        {node.type === "card" && <span className="meeting-board-author text-caption">{name(node.author)}</span>}
        {conflict && <span className="meeting-board-conflict text-caption" role="group" aria-label="Your version">Yours: “{String(conflict.mine)}” <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onPointerDown={event => event.stopPropagation()} onClick={() => session.resolve(conflict, "mine")}>Keep mine</button><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onPointerDown={event => event.stopPropagation()} onClick={() => session.resolve(conflict, "theirs")}>Keep theirs</button></span>}
      </div>;
    };

    // Outline: a listbox. Arrows move, Space selects, Enter edits, Delete removes.
    const rows = outline(content), list = useRef<HTMLUListElement>(null);
    const [focus, setFocus] = useState(0);
    function listKey(event: ReactRuntime.KeyboardEvent) {
      if (editing) return;
      const row = rows[focus];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setFocus(index => Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); setFocus(event.key === "Home" ? 0 : rows.length - 1); }
      else if (row && event.key === " ") { event.preventDefault(); toggle(row.id, true); }
      else if (row && event.key === "Enter" && !readOnly) { event.preventDefault(); setEditing(row.id); }
      else if (row && (event.key === "Delete" || event.key === "Backspace") && !readOnly) { event.preventDefault(); session.edit([{ type: "remove", id: row.id }], true); }
    }

    return <div className="meeting-board" data-buzz-ui="">
      <div className="meeting-board-toolbar" role="toolbar" aria-label="Board">
        <div className="meeting-board-views" role="group" aria-label="View">{(["board", "outline"] as const).map(value => <button key={value} type="button" className="meeting-library-option" aria-pressed={view === value} onClick={() => setView(value)}>{value === "board" ? "Board" : "Outline"}</button>)}</div>
        {!readOnly && <>
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={addCard}>Add card</button>
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" disabled={chosen.length < 2} onClick={group}>Group</button>
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" disabled={selected.length !== 2} onClick={connect}>Connect</button>
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" disabled={!selected.length} onClick={remove}>Remove</button>
        </>}
      </div>
      {view === "board"
        ? <div className="meeting-board-surface" aria-label="Board surface" onPointerDown={event => { if (event.target === event.currentTarget) setSelected([]); }}>
          <div className="meeting-board-plane" style={{ width, height }}>
            <svg className="meeting-board-links" width={width} height={height} aria-hidden="true">{connectors.map(link => { const a = centre(link.from), b = centre(link.to); return a && b ? <line key={link.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null; })}</svg>
            {groups.map(item)}{cards.map(item)}
          </div>
          {!nodes.length && <p className="meeting-board-empty text-subtle">Add a card, or ask an agent in the call to put ideas on this board.</p>}
        </div>
        : <ul ref={list} className="meeting-board-outline" role="listbox" aria-label="Board outline" aria-multiselectable="true" tabIndex={0} aria-activedescendant={rows[focus] ? `outline-${rows[focus].id}` : undefined} onKeyDown={listKey}>
          {rows.map((row, index) => <li key={row.id} id={`outline-${row.id}`} role="option" aria-selected={selected.includes(row.id)} data-focused={index === focus || undefined} data-depth={row.depth} onClick={() => { setFocus(index); toggle(row.id, true); }}>
            {editing === row.id ? <Text node={byId.get(row.id)!} label={row.kind === "group" ? "Group name" : "Card text"} commit={commitText} cancel={() => setEditing(undefined)} /> : <span>{row.kind === "group" ? <strong>{row.text}</strong> : row.text}</span>}
            {row.links.length > 0 && <span className="text-caption text-metadata"> {row.links.join(" · ")}</span>}
          </li>)}
          {!rows.length && <li className="text-subtle">Nothing on this board yet.</li>}
        </ul>}
      {chosen.length > 0 && !readOnly && <div className="meeting-board-selection" role="status"><span>{chosen.length} {chosen.length === 1 ? "card" : "cards"} selected</span>
        <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="prominent" disabled={busy} onClick={() => { void turnIntoBrief(); }}>{busy ? "Making a brief…" : "Turn into a brief"}</button></div>}
      {live.kept.length > 0 && <p className="meeting-document-notice" role="status"><span>{live.kept.length === 1 ? "An item you removed was kept" : "Items you removed were kept"} — someone edited {live.kept.length === 1 ? "it" : "them"} meanwhile.</span><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => live.kept.forEach(kept => session.dismissKept(kept.nodeId))}>OK</button></p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>;
  }
  return { Board };
}
