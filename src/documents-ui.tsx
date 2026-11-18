import type * as ReactRuntime from "react";
import { createContent, type ArtifactContent, type Conflict, type DocumentNode } from "./artifacts";
import type { ArtifactStore, Revision } from "./artifact-store";
import { documentSession, type DocumentSession } from "./document-editor";

/** What to open in the editor: the current head, or one revision read-only ("As presented"). */
export type OpenTarget = { channelId: string; artifactId: string; revisionId?: string };
type Options = {
  store: ArtifactStore;
  actor(): string | undefined;
  /** Display name for a pubkey (person or agent). */
  name(pubkey: string): string;
  /** The call occurrence a new document belongs to, when created during this channel's call. */
  occurrence(channelId: string): string | undefined;
};

// Design screens 4 and 6: the Documents & boards list and the editor pane that
// sits beside the stage. Board editing comes later; boards list here already.
export function documentsUI(React: typeof ReactRuntime, options: Options) {
  const { useEffect, useMemo, useState, useSyncExternalStore, useId } = React;
  const ago = (time: number) => { const seconds = Math.max(0, Math.round((Date.now() - time) / 1000)); return seconds < 10 ? "just now" : seconds < 60 ? `${seconds} s ago` : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : new Date(time).toLocaleString(); };
  // Open sessions outlive their editor until unsaved typing is flushed. A session whose
  // flush failed stays here, listed as unsaved, so reopening it shows the text and Try again.
  const sessions = new Map<string, { session: DocumentSession; refs: number }>(), registry = new Set<() => void>();
  let unsavedList: readonly string[] = [];
  const notify = () => { unsavedList = [...sessions].filter(([, entry]) => entry.refs === 0 && entry.session.snapshot().unsaved).map(([key]) => key); for (const listener of [...registry]) listener(); };
  const subscribeRegistry = (listener: () => void) => { registry.add(listener); return () => { registry.delete(listener); }; };
  function acquire(channelId: string, artifactId: string) {
    const key = `${channelId}:${artifactId}`;
    let entry = sessions.get(key);
    if (!entry) { entry = { session: documentSession(options.store, channelId, artifactId, options.actor), refs: 0 }; sessions.set(key, entry); }
    entry.refs++; notify();
    return entry.session;
  }
  function release(channelId: string, artifactId: string) {
    const key = `${channelId}:${artifactId}`, entry = sessions.get(key);
    if (!entry) return;
    entry.refs--;
    void entry.session.save().finally(() => {
      if (entry.refs > 0 || sessions.get(key) !== entry) return notify();
      if (entry.session.snapshot().unsaved) return notify();
      void entry.session.close(); sessions.delete(key); notify();
    });
  }
  const Preview = () => options.store.durable ? null : <p className="meeting-documents-preview text-caption" role="note">Preview: documents aren’t saved to Buzz yet. They last until you close Buzz.</p>;

  function DocumentsList({ channelId, open }: { channelId: string; open(target: OpenTarget): void }) {
    const items = useSyncExternalStore(options.store.subscribe, () => options.store.list(channelId));
    const unsaved = useSyncExternalStore(subscribeRegistry, () => unsavedList);
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    async function create() {
      const actor = options.actor(); if (!actor || busy) return;
      setBusy(true); setError("");
      try {
        let content: ArtifactContent = createContent({ kind: "document", title: "Untitled document", createdBy: actor, occurrenceId: options.occurrence(channelId) });
        content = { ...content, nodes: [{ id: crypto.randomUUID(), type: "paragraph", text: "", author: actor, editedAt: Date.now() }] };
        const revision = await options.store.create(channelId, content);
        open({ channelId, artifactId: revision.artifactId });
      } catch (problem) { setError(problem instanceof Error ? problem.message : "Couldn’t create a document."); }
      finally { setBusy(false); }
    }
    return <section className="meeting-documents text-body-sm" aria-label="Documents and boards">
      <header className="meeting-documents-header"><h3 className="text-body-sm">Documents & boards</h3><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="prominent" disabled={busy} onClick={() => { void create(); }}>New document</button></header>
      <Preview />
      {items.filter(item => unsaved.includes(`${channelId}:${item.id}`)).map(item => <p key={item.id} role="alert" className="meeting-document-notice"><span>Your last change to “{item.title}” isn’t saved yet.</span><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => open({ channelId, artifactId: item.id })}>Open to try again</button></p>)}
      {!items.length && <p className="text-subtle">Ask an agent to draft something in the call, or start a document here. Everyone with access to this workspace can open and edit it.</p>}
      <ul className="meeting-document-cards">{items.map(item => <li key={item.id}><button type="button" className="meeting-document-card" onClick={() => open({ channelId, artifactId: item.id })}>
        <strong>{item.title}</strong><span className="text-caption text-subtle">{item.kind === "document" ? "Document" : "Whiteboard"} · revision {item.head.number} · {options.name(item.head.signer)} · {ago(item.head.createdAt)}</span>
      </button></li>)}</ul>
      {error && <p role="alert" className="text-danger">{error}</p>}
    </section>;
  }

  function Block({ node, index, session, conflict, keptBy, readOnly }: { node: DocumentNode; index: number; session: DocumentSession; conflict?: Conflict; keptBy?: string; readOnly: boolean }) {
    const [compare, setCompare] = useState(false), id = useId();
    const label = node.type === "heading" ? `Heading ${index + 1}` : `Paragraph ${index + 1}`;
    return <div className="meeting-document-block" data-type={node.type} data-conflict={conflict ? "" : undefined}>
      {readOnly ? <p className={node.type === "heading" ? "text-body-lg" : undefined}>{node.text}</p>
        : <textarea id={id} className="meeting-document-text" aria-label={label} data-type={node.type} rows={Math.max(1, Math.ceil(node.text.length / 70))} value={node.text} onChange={event => session.edit([{ type: "update", id: node.id, fields: { text: event.target.value } }])} />}
      <p className="meeting-document-author text-caption text-subtle"><span className="meeting-author-chip">{options.name(node.author)}</span> edited {ago(node.editedAt)}{!readOnly && <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => session.edit([{ type: "remove", id: node.id }], true)}>Remove</button>}</p>
      {keptBy && <div className="meeting-document-notice" role="status"><span>Kept — {keptBy} edited this while you were removing it.</span><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => session.dismissKept(node.id)}>OK</button></div>}
      {conflict && <div className="meeting-document-conflict" role="group" aria-label="Your version">
        <p><strong>{options.name(node.author)} changed this paragraph while you were typing.</strong></p>
        <p className="text-subtle">Theirs is shown above. Yours: “{String(conflict.mine)}”</p>
        {compare && <div className="meeting-document-compare"><div><h4 className="text-caption text-metadata">Yours</h4><p>{String(conflict.mine)}</p></div><div><h4 className="text-caption text-metadata">Theirs</h4><p>{String(conflict.theirs)}</p></div></div>}
        <div className="meeting-document-conflict-actions">
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="prominent" onClick={() => session.resolve(conflict, "mine")}>Keep mine</button>
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="subtle" onClick={() => session.resolve(conflict, "theirs")}>Keep theirs</button>
          <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" aria-pressed={compare} onClick={() => setCompare(!compare)}>Compare</button>
        </div>
      </div>}
    </div>;
  }

  function Editor({ target, close, openCurrent }: { target: OpenTarget; close(): void; openCurrent?(): void }) {
    const session = useMemo(() => acquire(target.channelId, target.artifactId), [target.channelId, target.artifactId]);
    // Closing, switching documents or leaving the tab flushes what was typed.
    useEffect(() => () => release(target.channelId, target.artifactId), [session]);
    const live = useSyncExternalStore(session.subscribe, session.snapshot);
    const [presented, setPresented] = useState<Revision | null>();
    useEffect(() => { setPresented(undefined); if (target.revisionId) void options.store.revision(target.channelId, target.artifactId, target.revisionId).then(value => setPresented(value ?? null)); }, [target.revisionId]);
    const readOnly = !!target.revisionId, content = readOnly ? presented?.content : live.content, revision = readOnly ? presented : live.revision;
    const authors = [...new Set(content?.nodes.map(node => node.author) ?? [])];
    const [title, setTitle] = useState(content?.title ?? "");
    useEffect(() => { setTitle(content?.title ?? ""); }, [content?.title]);
    if (readOnly ? presented === undefined : live.phase === "loading") return <section className="meeting-document-editor" aria-label="Document"><p role="status">Opening…</p></section>;
    if (!content || !revision) return <section className="meeting-document-editor" aria-label="Document"><p role="alert">This document is unavailable.</p><button type="button" className="buzz-button" data-buzz-ui="" onClick={close}>Close</button></section>;
    const nodes = content.nodes.filter((node): node is DocumentNode => content.kind === "document");
    return <section className="meeting-document-editor text-body-sm" aria-label={`Document: ${content.title}`} data-buzz-ui="">
      <header className="meeting-document-header">
        {readOnly ? <h3 className="text-body-sm">{content.title}</h3> : <input className="meeting-document-title" aria-label="Document title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} onBlur={() => { if (title.trim() && title.trim() !== content.title) live.revision && session.edit([{ type: "rename", title }], true); }} />}
        <span className="meeting-document-authors" aria-label={`Written by ${authors.map(options.name).join(", ")}`}>{authors.map(author => <span key={author} className="meeting-author-chip" title={options.name(author)}>{options.name(author).slice(0, 1).toLocaleUpperCase()}</span>)}</span>
        <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={close}>Close</button>
      </header>
      <Preview />
      {readOnly && <p className="meeting-document-notice" role="status"><span>As presented · revision {revision.number}</span>{openCurrent && <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={openCurrent}>Open current</button>}</p>}
      {content.kind !== "document" ? <p className="text-subtle">Whiteboards open here in a later update.</p> : <div className="meeting-document-body">
        {nodes.map((node, index) => <Block key={node.id} node={node} index={index} session={session} readOnly={readOnly}
          conflict={readOnly ? undefined : live.conflicts.find(item => item.nodeId === node.id && item.field === "text")}
          keptBy={readOnly || !live.kept.some(item => item.nodeId === node.id) ? undefined : options.name(node.author)} />)}
        {!readOnly && <div className="meeting-document-add">{(["heading", "paragraph"] as const).map(type => <button key={type} type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => session.edit([{ type: "insert", node: { id: crypto.randomUUID(), type, text: "", author: options.actor() ?? "", editedAt: Date.now() }, after: nodes.at(-1)?.id ?? null }], true)}>{type === "heading" ? "Add heading" : "Add paragraph"}</button>)}</div>}
      </div>}
      {!readOnly && <footer className="meeting-document-footer text-caption" role="status">
        <span className="meeting-status-dot" data-connected={!live.unsaved && !live.saving || undefined} />
        <span>{live.saving ? "Saving…" : live.unsaved ? "Unsaved changes" : `Saved · revision ${revision.number}${live.conflicts.length ? "" : " · nothing lost"}`}</span>
        {live.error && <span className="text-danger">{live.error}{live.unsaved && <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => { void session.save(); }}>Try again</button>}</span>}
      </footer>}
    </section>;
  }

  /** The tab: the list, or one open item. */
  function DocumentsTab({ channelId, target, setTarget }: { channelId: string; target?: OpenTarget; setTarget(target?: OpenTarget): void }) {
    return target && target.channelId === channelId
      ? <Editor key={`${target.artifactId}:${target.revisionId ?? "current"}`} target={target} close={() => setTarget()} openCurrent={target.revisionId ? () => setTarget({ channelId, artifactId: target.artifactId }) : undefined} />
      : <DocumentsList channelId={channelId} open={setTarget} />;
  }
  return { DocumentsTab, Editor, DocumentsList };
}
export type DocumentsUI = ReturnType<typeof documentsUI>;
