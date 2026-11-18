import { readable, writable, uuid, type Collection, type Entry, type Event, type Storage, type Template, type WorkspaceConnection } from "./workspaces";
import type { MeetingTranscriptState } from "./meeting-transcription";
import { formatTranscript, validEntry, type TranscriptEntry } from "./transcript-format";
type TaskSource = { tasksFor(channelId: string, occurrenceId?: string): readonly { title: string; status: string; result: string; messageId?: string; author?: { pubkey: string; name: string } }[] };
export const recordType = "studio.h2s2.meetings.record";
// Version 2 parts hold structured entries; version 1 parts hold preformatted text.
type Coverage = { lastEntryId: string; count: number; streamId?: string; through?: number };
type Covered = Pick<MeetingTranscriptState, "joinId" | "occurrenceId" | "segments" | "sharedStreamId" | "sharedCallId">;
const entryId = (transcript: Pick<MeetingTranscriptState, "joinId">, row: MeetingTranscriptState["segments"][number], index: number) => (row.id ?? `${transcript.joinId ?? "local"}:${row.seq ?? index}`).slice(0,160);
/** What a save covers: its last entry and, for a shared stream, the highest sequence. */
export function coverageOf(transcript: Covered): Coverage | undefined {
  const last = transcript.segments.at(-1); if (!last) return;
  return { lastEntryId: entryId(transcript, last, transcript.segments.length - 1), count: transcript.segments.length, ...(transcript.sharedStreamId ? { streamId: transcript.sharedStreamId, through: last.seq } : {}) };
}
/** A transcript counts as saved only when a record in its channel and call covers its last entry. */
export function covers(record: SavedRecord, channelId: string | undefined, transcript: Covered) {
  const need = coverageOf(transcript), have = record.covers;
  if (!need || !have || record.channelId !== channelId || record.callId !== (transcript.occurrenceId ?? transcript.sharedCallId)) return false;
  return have.lastEntryId === need.lastEntryId || (!!need.streamId && have.streamId === need.streamId && (have.through ?? 0) >= (need.through ?? Infinity));
}
type SavedRecord = { version: 1 | 2; covers?: Coverage; callId?: string; streamId?: string; title: string; channelId: string; capturedAt: number; warning: string; parts: { id: string; revision: string }[]; tasks: { title: string; status: string; result: string; messageId?: string; author?: { pubkey: string; name: string } }[] };
type Intent = { channelId: string; events: Event[]; recordId: string };
export type RecordsState = { busy: boolean; error: string; saved?: string; pending: boolean; records: { id: string; value: SavedRecord }[] };
const parse = (entry: Entry) => {
  try {
    const value = JSON.parse(entry.record.current?.content ?? "");
    return entry.record.availability.state === "available" && entry.record.type === recordType && (value.version === 1 || value.version === 2) && uuid(value.channelId) && Array.isArray(value.parts) && value.parts.every((part: { id?: unknown; revision?: unknown }) => uuid(part?.id) && typeof part?.revision === "string" && /^[0-9a-f]{64}$/.test(part.revision)) && value.parts.length <= 256 && typeof value.title === "string" && value.title.length <= 128 && Number.isSafeInteger(value.capturedAt) && value.capturedAt > 0 && value.capturedAt <= 8640000000000000 && typeof value.warning === "string" && value.warning.length <= 4000 && (value.covers === undefined || typeof value.covers?.lastEntryId === "string" && value.covers.lastEntryId.length <= 160 && Number.isSafeInteger(value.covers.count) && (value.covers.streamId === undefined || typeof value.covers.streamId === "string" && value.covers.streamId.length <= 128) && (value.covers.through === undefined || Number.isSafeInteger(value.covers.through))) && Array.isArray(value.tasks) && value.tasks.length <= 2048 && value.tasks.every((task: {title?:unknown;status?:unknown;result?:unknown;messageId?:unknown;author?:{pubkey?:unknown;name?:unknown}}) => task && (task.author === undefined || typeof task.author?.pubkey === "string" && /^[0-9a-f]{64}$/.test(task.author.pubkey) && typeof task.author.name === "string" && task.author.name.length <= 64) && typeof task.title === "string" && task.title.length <= 200 && typeof task.status === "string" && ["proposed","working","done","blocked"].includes(task.status) && typeof task.result === "string" && task.result.length <= 2000 && (task.messageId === undefined || typeof task.messageId === "string" && /^[a-f0-9]{64}$/.test(task.messageId))) ? value as SavedRecord : undefined;
  } catch { return undefined; }
};
export function meetingRecords(relay: { snapshot(): WorkspaceConnection; subscribe(listener: () => void): () => void }, storage: Storage) {
  let state: RecordsState = { busy: false, error: "", records: [], pending: false }, connection = relay.snapshot(), closed = false, generation = 0;
  // Bound lazily: Buzz's artifact storage needs an identity and a selected community.
  let collection: Collection | undefined;
  const listeners = new Set<() => void>();
  let abort = new AbortController(), stopCollection = () => {};
  const emit = (patch: Partial<RecordsState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  async function refresh() {
    const revision = ++generation, scope = connection, store = collection;
    if (!store) return;
    try {
      const entries: Entry[] = [];
      let after: { order: string; id: string } | undefined;
      do {
        const page = await store.page({ index: "records", value: "all", limit: 100, after }); entries.push(...page.entries); after = page.next;
        if (entries.length >= 4096) break;
      } while (after);
      const pending = await store.preferences.get("pending");
      if (!closed && revision === generation && connection === scope) emit({ records: entries.flatMap(entry => { const value = parse(entry); return value && readable(scope.session.channels?.list().channels.find(channel => channel.id === value.channelId),scope.viewer) ? [{ id: entry.record.id, value }] : []; }).sort((a,b) => b.value.capturedAt-a.value.capturedAt), pending: !!pending });
    } catch { if (!closed && connection === scope) emit({ error: "Meeting records couldn’t synchronize. Your saved work is retained." }); }
  }
  const bindable = (value: WorkspaceConnection) => !!value.viewer && !!value.origin && !!value.scope;
  // The connection whose storage failed to open; retried only when the connection changes.
  let failed: WorkspaceConnection | undefined;
  const same = (a: WorkspaceConnection, b: WorkspaceConnection) => a.session === b.session && a.scope === b.scope && a.viewer === b.viewer && a.origin === b.origin;
  function attach() {
    if (!bindable(connection)) return;
    try {
      collection = storage.open({ name: "meeting-records", type: recordType, version: 1, project(entry) { return parse(entry) ? [{ index: "records", value: "all", order: entry.record.id }] : []; } });
    } catch { collection = undefined; failed = connection; emit({ error: "Meeting records aren’t available on this connection yet. Reconnect to try again." }); return; }
    failed = undefined;
    stopCollection = collection.subscribe(() => { void refresh(); }); void refresh();
  }
  function detach() { stopCollection(); stopCollection = () => {}; collection?.close(); collection = undefined; }
  function requireAccess(scope: WorkspaceConnection, channelId: string, write: boolean) {
    const now = relay.snapshot(), channel = now.session.channels?.list().channels.find(channel => channel.id === channelId);
    if (now.session !== scope.session || now.scope !== scope.scope || now.viewer !== scope.viewer || now.status !== "ready" || !(write ? writable(channel,now.viewer) : readable(channel,now.viewer))) throw new Error("Reconnect and check channel access before saving this meeting.");
  }
  async function publish(intent: Intent, scope: WorkspaceConnection, signal: AbortSignal, store: Collection) {
    const writer = scope.session.configArtifactWriter;
    if (!writer || !scope.session.snapshotRead || intent.events.length > 257 || !uuid(intent.channelId)) throw new Error("This Buzz connection cannot save meeting records.");
    for (const event of intent.events) {
      requireAccess(scope,intent.channelId,true); signal.throwIfAborted();
      const id = event.tags.find(tag => tag[0] === "d")?.[1];
      if (event.pubkey !== scope.viewer || event.kind !== 45010 || !uuid(id) || !event.tags.some(tag => tag[0] === "h" && tag[1] === intent.channelId) || !event.tags.some(tag => tag[0] === "type" && [recordType,recordType+".part"].includes(tag[1]))) throw new Error("The saved meeting operation is invalid.");
      // Native receipt plus authoritative readback; a retry sends these exact bytes.
      try { await writer.publish(event,signal); } catch { /* An ambiguous write still gets read back. */ }
      const read = await scope.session.snapshotRead([{ artifact: "head", kinds: [45010], "#h": [intent.channelId], "#d": [id], limit: 1 }], { signal });
      if (!read.some(value => value.id === event.id && value.pubkey === scope.viewer)) throw new Error("Saving is unconfirmed. Check or retry the saved operation; no duplicate record will be created.");
    }
    requireAccess(scope,intent.channelId,true);
    await store.preferences.update("pending", () => null);
    emit({ saved: intent.recordId, pending: false }); await refresh();
  }
  async function run(work: (scope: WorkspaceConnection, signal: AbortSignal, store: Collection) => Promise<void>) {
    if (state.busy || closed) return;
    const scope = connection, signal = abort.signal, store = collection;
    if (!store) return emit({ error: "Connect to a community to save meeting records." });
    emit({ busy: true, error: "", saved: undefined });
    try { await work(scope,signal,store); }
    catch (error) { if (connection === scope) emit({ error: error instanceof Error ? error.message : "Couldn’t save this meeting." }); }
    finally { if (connection === scope) { emit({ busy: false }); await refresh(); } }
  }
  attach();
  const stopRelay = relay.subscribe(() => {
    const next = relay.snapshot();
    if (!same(next, connection) || (!collection && bindable(next) && !(failed && same(failed, next)))) {
      abort.abort(); detach(); connection = next; abort = new AbortController();
      emit({ busy: false, error: "", saved: undefined, pending: false, records: [] }); attach();
    } else void refresh();
  });
  return {
    snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: (channelId: string, transcript: MeetingTranscriptState, agents: TaskSource) => run(async (scope,signal,store) => {
      requireAccess(scope,channelId,true);
      if (await store.preferences.get("pending")) throw new Error("Finish the previous saved meeting operation first.");
      if (!transcript.segments.length || !scope.session.configArtifactWriter?.kinds?.includes(45010)) throw new Error("There is no transcript to save, or this Buzz version cannot save records.");
      const events: Event[] = [], parts: { id: string; revision: string }[] = [], rows: TranscriptEntry[] = [];
      let bytes = 0;
      const sign = async (id: string, type: string, content: string) => {
        const template: Template = { kind:45010, created_at: Math.floor(Date.now()/1000), tags:[["ar","1"],["d",id],["h",channelId],["type",type],["title",transcript.roomName ?? "Meeting"],["op","create"]], content };
        const signed = await scope.session.configArtifactWriter!.sign(template,signal);
        if (signed.pubkey !== scope.viewer || signed.content !== content || JSON.stringify(signed.tags) !== JSON.stringify(template.tags)) throw new Error("The meeting signer changed the record. Nothing was sent.");
        events.push(signed);
      };
      const flush = async () => { if (!rows.length) return; const id = crypto.randomUUID(); await sign(id,recordType+".part",JSON.stringify({ version:2, channelId, entries:rows })); parts.push({ id, revision:events.at(-1)!.id }); rows.length=0; bytes=0; };
      for (const [index,row] of transcript.segments.entries()) {
        const entry: TranscriptEntry = { id:entryId(transcript,row,index), speakerId:row.speakerId, speakerName:row.speakerName, startedAt:row.startedAt, endedAt:row.endedAt, text:row.text };
        if (!validEntry(entry)) throw new Error("A transcript entry is incomplete. Nothing was saved.");
        const size = new TextEncoder().encode(JSON.stringify(entry)).length;
        if (bytes+size > 40000) await flush(); rows.push(entry); bytes += size;
      }
      await flush();
      const recordId = crypto.randomUUID();
      const record: SavedRecord = { version:2, covers:coverageOf(transcript),callId:transcript.occurrenceId ?? transcript.sharedCallId,streamId:transcript.sharedStreamId, title:transcript.roomName ?? "Meeting", channelId, capturedAt:Date.now(), warning:[transcript.warning, transcript.base ? "Earlier entries passed the live retention window." : ""].filter(Boolean).join(" "), parts, tasks:agents.tasksFor(channelId, transcript.occurrenceId).map(task => ({ title:task.title, status:task.status, result:task.result, messageId:task.messageId, ...(task.author ? { author:{ pubkey:task.author.pubkey, name:task.author.name.slice(0,64) } } : {}) })) };
      await sign(recordId,recordType,JSON.stringify(record)); requireAccess(scope,channelId,true);
      const intent: Intent = { channelId,events,recordId };
      await store.preferences.update("pending", value => { if (value) throw new Error("Another save is awaiting confirmation."); return JSON.parse(JSON.stringify(intent)); });
      emit({ pending:true }); await publish(intent,scope,signal,store);
    }),
    retry: () => run(async (scope,signal,store) => { const intent = await store.preferences.get("pending") as unknown as Intent; if (intent) await publish(intent,scope,signal,store); }),
    async read(id: string) {
      const record = state.records.find(record => record.id === id); if (!record) throw new Error("This meeting record is unavailable.");
      const scope = connection, signal = abort.signal; requireAccess(scope,record.value.channelId,false);
      const text: string[] = [], entries: TranscriptEntry[] = [];
      for (const part of record.value.parts) {
        const events = await scope.session.snapshotRead!([{ artifact:"head", kinds:[45010], "#h":[record.value.channelId], "#d":[part.id],limit:1 }],{ signal });
        requireAccess(scope,record.value.channelId,false);
        const event = events[0];
        if (!event || event.id !== part.revision || !event.tags.some(tag => tag[0] === "type" && tag[1] === recordType+".part")) throw new Error("Part of this saved transcript is unavailable.");
        const value = JSON.parse(event.content); if (value.channelId !== record.value.channelId) throw new Error("Invalid saved transcript.");
        if (record.value.version === 2) { if (value.version !== 2 || !Array.isArray(value.entries) || event.content.length > 120000 || !value.entries.every(validEntry)) throw new Error("Invalid saved transcript."); entries.push(...value.entries); }
        else { if (typeof value.text !== "string" || value.text.length > 60000) throw new Error("Invalid saved transcript."); text.push(value.text); }
      }
      // Labels are computed across the whole record so same-name speakers stay distinct.
      return record.value.version === 2 ? formatTranscript(entries) : text.join("\n\n");
    },
    close() { closed=true; abort.abort(); stopRelay(); detach(); listeners.clear(); },
  };
}
export type MeetingRecords = ReturnType<typeof meetingRecords>;
