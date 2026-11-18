// One open document or board: local edits, debounced saves, and recovery when
// someone else saved first. Pure apart from the store and timers it is given.
import { applyEdit, rebase, resolveConflict, ArtifactError, type ArtifactContent, type Conflict, type Edit, type Kept, type NodeOp } from "./artifacts";
import { isStale, type ArtifactStore, type Revision } from "./artifact-store";

export type EditorState = {
  phase: "loading" | "ready" | "missing" | "error";
  revision?: Revision;
  /** What the person sees: the head plus their unsaved edit. */
  content?: ArtifactContent;
  saving: boolean;
  unsaved: boolean;
  conflicts: readonly Conflict[];
  kept: readonly Kept[];
  error: string;
};

export function documentSession(store: ArtifactStore, channelId: string, artifactId: string, actor: () => string | undefined, options: { debounceMs?: number; now?: () => number } = {}) {
  const debounceMs = options.debounceMs ?? 400, now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let state: EditorState = { phase: "loading", saving: false, unsaved: false, conflicts: [], kept: [], error: "" };
  let pending: Edit | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false, saving: Promise<void> | undefined, retries = 0;
  const emit = (next: Partial<EditorState>) => { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); };
  const local = () => state.revision && pending ? applyEdit(state.revision.content, pending) : state.revision?.content;

  async function load() {
    try {
      const head = await store.head(channelId, artifactId);
      if (closed) return;
      if (!head) return emit({ phase: "missing" });
      emit({ phase: "ready", revision: head, content: local() ?? head.content });
    } catch (problem) { if (!closed) emit({ phase: "error", error: problem instanceof Error ? problem.message : "Couldn’t open this document." }); }
  }
  // Someone else saved: adopt their head when nothing local is waiting; otherwise the next save rebases.
  const unsubscribe = store.subscribe(() => { void store.head(channelId, artifactId).then(head => {
    if (closed || !head || head.id === state.revision?.id || pending || saving) return;
    emit({ revision: head, content: head.content });
  }); });

  /** Stage operations locally. Typing is debounced; structural changes (insert, move, remove) save at once. */
  function edit(ops: NodeOp[], immediate = false) {
    const who = actor();
    if (!state.revision || !who) return;
    pending ??= { opId: crypto.randomUUID(), base: state.revision.id, actor: who, at: now(), ops: [] };
    for (const op of ops) {
      const last = pending.ops.at(-1);
      // Consecutive keystrokes in one block collapse into one update.
      if (op.type === "update" && last?.type === "update" && last.id === op.id && Object.keys(op.fields).join() === Object.keys(last.fields).join()) pending.ops[pending.ops.length - 1] = op;
      else pending.ops.push(op);
    }
    pending.at = now();
    try { emit({ content: local(), unsaved: true, error: "" }); }
    catch (problem) { pending.ops.splice(pending.ops.length - ops.length, ops.length); emit({ error: problem instanceof Error ? problem.message : "That change couldn’t be made." }); return; }
    clearTimeout(timer);
    if (immediate) void save(); else timer = setTimeout(() => { void save(); }, debounceMs);
  }

  async function save(): Promise<void> {
    clearTimeout(timer);
    if (saving) { await saving; if (pending) return save(); return; }
    if (!pending || !state.revision) return;
    const run = (async () => {
      emit({ saving: true });
      let edit: Edit = pending!, base: Revision = state.revision!;
      pending = undefined;
      for (let attempt = 0; attempt < 4 && !closed; attempt++) {
        try {
          const content = applyEdit(base.content, edit);
          const revision = await store.publish(channelId, artifactId, content, base.id);
          if (closed) return;
          const later = pending as Edit | undefined;
          if (later) pending = { ...later, base: revision.id };
          retries = 0;
          emit({ revision, content: later ? applyEdit(revision.content, later) : revision.content, unsaved: !!later, error: "" });
          return;
        } catch (problem) {
          if (!isStale(problem)) {
            // Keep the unsaved edit so nothing is lost; the person can retry.
            const later = pending as Edit | undefined;
            pending = later ? { ...edit, ops: [...edit.ops, ...later.ops] } : edit;
            emit({ error: problem instanceof Error ? problem.message : "Couldn’t save. Your changes are kept.", unsaved: true });
            return;
          }
          const result = rebase(base.content, problem.head.content, problem.head.id, edit);
          base = problem.head; edit = result.edit;
          // Adopt the new head now, so a later failure leaves the edit based on a revision the session knows.
          const later = pending as Edit | undefined;
          const view = applyEdit(base.content, edit);
          emit({ revision: base, content: later ? applyEdit(view, { ...later, base: base.id }) : view, conflicts: [...state.conflicts, ...result.conflicts], kept: [...state.kept, ...result.kept] });
          if (!edit.ops.length) { if (!later) emit({ unsaved: false }); return; }
        }
      }
      const later = pending as Edit | undefined;
      pending = later ? { ...edit, ops: [...edit.ops, ...later.ops] } : edit;
      // Others keep saving first: back off and try again on our own.
      const wait = Math.min(8000, 1000 * 2 ** retries++);
      if (!closed) timer = setTimeout(() => { void save(); }, wait);
      emit({ error: `Others are saving quickly. Your changes are kept and will save again in ${Math.round(wait / 1000)} s.`, unsaved: true });
    })();
    saving = run;
    try { await run; } finally { saving = undefined; if (!closed) emit({ saving: false }); }
  }

  /** Keep mine re-applies the held value on top of the current head; Keep theirs drops it. */
  function resolve(conflict: Conflict, choice: "mine" | "theirs") {
    emit({ conflicts: state.conflicts.filter(item => item !== conflict) });
    if (choice === "theirs" || !state.revision) return;
    const who = actor(); if (!who) return;
    const keep = resolveConflict(conflict, "mine", { opId: crypto.randomUUID(), base: state.revision.id, actor: who, at: now() });
    if (keep) edit(keep.ops, true);
  }
  function dismissKept(nodeId: string) { emit({ kept: state.kept.filter(item => item.nodeId !== nodeId) }); }

  void load();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit, save, resolve, dismissKept, reload: load,
    /**
     * Flush unsaved typing, then stop. Resolves false (and stays open) when the
     * changes could not be saved, so the caller can keep them reachable.
     */
    async close() {
      clearTimeout(timer);
      if (pending || saving) await save();
      if (pending) return false;
      closed = true; unsubscribe(); listeners.clear();
      return true;
    },
  };
}
export type DocumentSession = ReturnType<typeof documentSession>;
export { ArtifactError };
