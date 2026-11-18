// Storage for meeting documents and boards, behind one interface so the editor
// does not depend on how revisions are signed and stored. Until the native
// adapter lands (after Gate 0: agent-signed kind-45010 on the host), the plugin
// uses the in-memory store below, which keeps nothing across restarts.
import { ArtifactError, parseContent, serialize, type ArtifactContent, type ArtifactKind } from "./artifacts";

export type Revision = { id: string; artifactId: string; channelId: string; signer: string; createdAt: number; number: number; prev?: string; content: ArtifactContent };
export type ArtifactSummary = { id: string; channelId: string; kind: ArtifactKind; title: string; head: Revision };

/** The head moved on: the relay's `conflict:`. Rebase onto `head` and publish again. */
export class StaleRevision extends Error {
  override readonly name = "StaleRevision";
  constructor(readonly head: Revision) { super("Someone else saved a newer version."); }
}
/** Matches across bundle copies, where `instanceof` would not. */
export const isStale = (problem: unknown): problem is StaleRevision => !!problem && (problem as { name?: unknown }).name === "StaleRevision" && !!(problem as StaleRevision).head;


export interface ArtifactStore {
  /** False for the in-memory preview store: nothing survives a restart. */
  readonly durable: boolean;
  list(channelId: string): readonly ArtifactSummary[];
  subscribe(listener: () => void): () => void;
  create(channelId: string, content: ArtifactContent): Promise<Revision>;
  head(channelId: string, artifactId: string): Promise<Revision | undefined>;
  revision(channelId: string, artifactId: string, revisionId: string): Promise<Revision | undefined>;
  /** Publish a new full snapshot whose `prev` must be the current head, or throw StaleRevision. */
  publish(channelId: string, artifactId: string, content: ArtifactContent, prev: string): Promise<Revision>;
}

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function digest(value: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }

/**
 * In-memory store with the same atomic rule as the relay: an update must name the
 * current head as `prev`. `signer()` returns who signs the next revision; tests use
 * `remote` to land a concurrent revision as someone else.
 */
export function memoryArtifactStore(signer: () => string | undefined, options: { durable?: boolean } = {}) {
  const revisions = new Map<string, Revision[]>(), listeners = new Set<() => void>();
  let summaries = new Map<string, readonly ArtifactSummary[]>();
  const key = (channelId: string, artifactId: string) => `${channelId}\u0000${artifactId}`;
  function emit() { summaries = new Map(); for (const listener of [...listeners]) listener(); }
  async function append(channelId: string, artifactId: string, content: ArtifactContent, prev: string | undefined, by: string | undefined) {
    if (!by) throw new ArtifactError("Connect to your community before saving.");
    const raw = serialize(content), history = revisions.get(key(channelId, artifactId)) ?? [];
    const head = history.at(-1);
    if (prev === undefined ? !!head : head?.id !== prev) { if (head) throw new StaleRevision(head); throw new ArtifactError("This document no longer exists."); }
    const createdAt = Date.now(), id = await digest(JSON.stringify([by, createdAt, artifactId, prev ?? null, raw, history.length]));
    const revision: Revision = { id, artifactId, channelId, signer: by, createdAt, number: history.length + 1, ...(prev ? { prev } : {}), content: parseContent(raw) };
    revisions.set(key(channelId, artifactId), [...history, revision]);
    emit();
    return revision;
  }
  const store = {
    durable: options.durable === true,
    list(channelId: string) {
      let value = summaries.get(channelId);
      if (!value) {
        value = [...revisions.values()].map(history => history.at(-1)!).filter(head => head.channelId === channelId)
          .map(head => ({ id: head.artifactId, channelId, kind: head.content.kind, title: head.content.title, head })).sort((a, b) => b.head.createdAt - a.head.createdAt);
        summaries.set(channelId, value);
      }
      return value;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    create(channelId: string, content: ArtifactContent) { return append(channelId, crypto.randomUUID(), content, undefined, signer()); },
    async head(channelId: string, artifactId: string) { return revisions.get(key(channelId, artifactId))?.at(-1); },
    async revision(channelId: string, artifactId: string, revisionId: string) { return revisions.get(key(channelId, artifactId))?.find(revision => revision.id === revisionId); },
    publish(channelId: string, artifactId: string, content: ArtifactContent, prev: string) { return append(channelId, artifactId, content, prev, signer()); },
    /** Test and demo hook: land a revision as someone else, as a concurrent editor would. */
    async remote(channelId: string, artifactId: string, by: string, change: (content: ArtifactContent) => ArtifactContent) {
      const head = revisions.get(key(channelId, artifactId))?.at(-1);
      if (!head) throw new ArtifactError("No such document.");
      return append(channelId, artifactId, change(head.content), head.id, by);
    },
    clear() { revisions.clear(); emit(); },
  };
  return store satisfies ArtifactStore & Record<string, unknown>;
}
export type MemoryArtifactStore = ReturnType<typeof memoryArtifactStore>;

/**
 * Documents and boards a meeting record should reference: those made in this call,
 * with their current revision. Records are permanent, so a store that keeps nothing
 * across restarts contributes nothing (its references would dangle).
 */
export function recordArtifacts(store: ArtifactStore, channelId: string, occurrenceId?: string) {
  if (!store.durable || !occurrenceId) return [];
  return store.list(channelId).filter(item => item.head.content.occurrenceId === occurrenceId).map(item => ({ id: item.id, kind: item.kind, title: item.title, revision: item.head.id, number: item.head.number }));
}
