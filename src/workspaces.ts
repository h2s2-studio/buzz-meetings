// Structural API-v1 contracts. Buzz owns verification, channel commands and sync.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Event = { id: string; pubkey: string; sig: string; kind: number; created_at: number; tags: string[][]; content: string };
export type Template = Omit<Event, "id" | "pubkey" | "sig">;
export type Channel = { id: string; name: string; channelType?: string; members?: readonly string[]; viewerRole?: string; visibility?: string; readOnly?: boolean; huddle?: boolean; parentChannelId?: string; archived?: boolean; cached?: boolean; metadataCached?: boolean; metadataPending?: boolean; pending?: boolean; ttlSeconds?: number };
export type Details = { channelId: string; version: string; name: string; description: string; visibility: "public" | "private"; canEdit: boolean; ttlSeconds?: number; labels?: readonly string[]; joinRole?: "member" | "guest" };
export type Entry = { record: { id: string; channelId?: string; type?: string; current?: { id: string; content: string; event?: Event }; availability: { state: string } }; preference?: Json };
export type Collection = {
  get(id: string): Promise<Entry | undefined>;
  page(input: { index: string; value: string; limit: number; after?: { order: string; id: string } }): Promise<{ entries: readonly Entry[]; next?: { order: string; id: string } }>;
  subscribe(listener: () => void): () => void;
  refreshError(): Promise<string | null>;
  preferences: { get(id: string): Promise<Json | undefined>; update(id: string, change: (value: Json | undefined) => Json): Promise<void> };
  close(): void;
};
export type Storage = { open(definition: { name: string; type: string; version: number; project(entry: Entry): readonly { index: string; value: string; order: string }[] }): Collection };
export type WorkspaceSession = {
  channels?: { list(): { channels: readonly Channel[] }; subscribeList(listener: () => void): () => void; ensureList?(): void };
  snapshotRead?(filters: readonly object[], options: { signal?: AbortSignal }): Promise<readonly Event[]>;
  configArtifactWriter?: { kinds?: readonly number[]; sign(template: Template, signal: AbortSignal): Promise<Event>; publish(event: Event, signal: AbortSignal): Promise<unknown> };
  channelCreation?: { available: boolean; create(input: { name: string; visibility: "open" | "private"; description?: string }): Promise<string> };
  channelDetails?: { available: boolean; load(id: string, signal?: AbortSignal): Promise<Details>; save(base: Details, draft: Omit<Details, "channelId" | "version" | "canEdit">, signal?: AbortSignal, active?: () => boolean): Promise<void>; check(id: string, signal?: AbortSignal): Promise<void>; snapshot(id: string): { status: string } | undefined };
};
export type WorkspaceConnection = { status?: string; viewer?: string; origin?: string; scope?: string; session: WorkspaceSession };
export const workspaceType = "studio.h2s2.meetings.workspace";
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000";
export const tag = (event: Event, key: string) => {
  const values = event.tags.filter(value => value[0] === key);
  return values.length === 1 && values[0]?.length === 2 ? values[0][1] : undefined;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function isEvent(value: unknown): value is Event {
  return record(value) && typeof value.content === "string" && Array.isArray(value.tags) && value.tags.length <= 256 && value.tags.every(tag => Array.isArray(tag) && tag.every(part => typeof part === "string")) && Number.isSafeInteger(value.kind) && Number.isSafeInteger(value.created_at) && typeof value.id === "string" && /^[0-9a-f]{64}$/.test(value.id) && typeof value.pubkey === "string" && /^[0-9a-f]{64}$/.test(value.pubkey) && typeof value.sig === "string" && /^[0-9a-f]{128}$/.test(value.sig);
}
async function correctHash(event: Event) {
  const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") === event.id;
}
// A type-specific UUID avoids consuming the channel's own UUID in the artifact namespace.
export async function workspaceId(channel: string) {
  if (!uuid(channel)) throw new Error("Invalid workspace channel.");
  const ns = Uint8Array.from(channel.replaceAll("-", "").match(/../g)!, pair => parseInt(pair, 16));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array([...ns, ...new TextEncoder().encode(workspaceType)])));
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Shared records describe presentation, never membership or live media. */
export function parseWorkspace(event: unknown) {
  if (!isEvent(event) || event.kind !== 45010 || tag(event, "ar") !== "1" || tag(event, "type") !== workspaceType || !uuid(tag(event, "d")) || !uuid(tag(event, "h")) || !["create", "update", "restore"].includes(tag(event, "op") ?? "") || event.content.length > 4096) return undefined;
  try {
    const value = JSON.parse(event.content);
    return value?.version === 1 && value.channelId === tag(event, "h") ? { channelId: value.channelId as string, revision: event.id } : undefined;
  } catch { return undefined; }
}
export function readable(channel: Channel | undefined, viewer: string | undefined) {
  return !!channel && uuid(channel.id) && channel.channelType === "stream" && !channel.huddle && !channel.parentChannelId && !channel.archived && !channel.cached && !channel.metadataCached && !channel.metadataPending && !channel.pending && !!viewer && !!channel.members?.includes(viewer);
}
export const writable = (channel: Channel | undefined, viewer: string | undefined) => readable(channel, viewer) && !channel?.readOnly && ["owner", "admin", "member", "bot"].includes(channel?.viewerRole ?? "");
export const cleanName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ");
export function validWorkspaceName(name: string) {
  if (!name || name.length > 64 || name.startsWith("#") || /[\p{Cc}]/u.test(name)) throw new Error("Enter a workspace name of 1–64 characters without a leading #.");
}
const object = (value: Json | undefined): { [key: string]: Json } => value && typeof value === "object" && !Array.isArray(value) ? value : {};
type Pending = { channelId: string; event: Event };
type Creation = { operation: string; name: string; visibility: "open" | "private"; channelId?: string };
function creation(value: Json | undefined): Creation | undefined {
  if (!record(value) || !uuid(value.operation) || typeof value.name !== "string" || !["open", "private"].includes(String(value.visibility)) || (value.channelId !== undefined && !uuid(value.channelId))) return undefined;
  return value as Creation;
}
export type WorkspaceState = { workspaces: Channel[]; selected?: string; busy: string; error: string; pending: Pending[]; creation?: Creation; loading: boolean; syncError?: string };

export function makeWorkspaces(connection: WorkspaceConnection, storage: Storage, current: () => WorkspaceConnection) {
  const session = connection.session, lifetime = new AbortController(), signal = lifetime.signal;
  const listeners = new Set<() => void>(), confirmed = new Map<string, Event>();
  let state: WorkspaceState = { workspaces: [], busy: "", error: "", pending: [], loading: true };
  let revision = 0, closed = false, selectionChanged = false;
  const collection = storage.open({ name: "workspaces", type: workspaceType, version: 1, project({ record }) {
    return record.type === workspaceType && record.current?.event && parseWorkspace(record.current.event)
      ? [{ index: "workspaces", value: "all", order: record.id }] : [];
  } });
  const active = () => !closed && current().session === session && current().viewer === connection.viewer && current().origin === connection.origin;
  function emit(patch: Partial<WorkspaceState>) {
    if (!active()) return;
    state = { ...state, ...patch }; for (const listener of listeners) listener();
  }
  function requireChannel(id: string, write = false) {
    signal.throwIfAborted();
    const channel = session.channels?.list().channels.find(value => value.id === id);
    if (!active() || current().status !== "ready" || !(write ? writable(channel, connection.viewer) : readable(channel, connection.viewer))) throw new Error("Workspace access is unavailable. Reconnect or check your channel membership.");
    return channel!;
  }
  async function details(id: string, write = false) {
    requireChannel(id, write);
    if (!session.channelDetails?.available) throw new Error("This Buzz version cannot verify workspace channel details.");
    const value = await session.channelDetails.load(id, signal);
    requireChannel(id, write);
    if (value.channelId !== id || value.ttlSeconds !== undefined) throw new Error("Choose a permanent channel. Temporary channels cannot hold a persistent workspace.");
    return value;
  }
  async function refresh() {
    const generation = ++revision;
    try {
      const rows: Entry[] = []; let after: { order: string; id: string } | undefined;
      do {
        const page = await collection.page({ index: "workspaces", value: "all", limit: 100, ...(after ? { after } : {}) });
        rows.push(...page.entries);
        if (page.next && (rows.length >= 4096 || JSON.stringify(page.next) === JSON.stringify(after))) throw new Error("Workspace discovery is incomplete. Refine your channel list before continuing.");
        after = page.next;
      } while (after);
      const ids = new Set<string>();
      for (const row of rows) {
        if (row.record.availability.state !== "available" || !row.record.current?.event) continue;
        const parsed = parseWorkspace(row.record.current.event);
        if (parsed && row.record.id === await workspaceId(parsed.channelId) && row.record.channelId === parsed.channelId && row.record.current.id === row.record.current.event.id) ids.add(parsed.channelId);
      }
      for (const [id, event] of confirmed) {
        const cached = await collection.get(await workspaceId(id));
        if (cached?.record.current || ["deleted", "unavailable"].includes(cached?.record.availability.state ?? "")) {
          // Once sync observes this identity it owns it, including removal and
          // unreadable/unknown versions. A receipt cannot keep a retired link alive.
          if (confirmed.get(id) === event) confirmed.delete(id);
        } else ids.add(id);
      }
      const saved = object(await collection.preferences.get("view"));
      const pending = object(await collection.preferences.get("pending"));
      const operations = Object.entries(pending).flatMap(([id, value]) => {
        const entry = value as unknown as Pending;
        return validPending(entry) && entry.channelId === id ? [entry] : [];
      });
      const creating = creation(await collection.preferences.get("creation"));
      const syncError = await collection.refreshError();
      if (!active() || generation !== revision) return;
      const channels = session.channels?.list().channels ?? [];
      const workspaces = channels.filter(channel => ids.has(channel.id) && readable(channel, connection.viewer)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      emit({ workspaces, pending: operations, creation: creating, syncError: syncError ? "Workspace synchronization is recovering. Saved links may be out of date." : undefined, loading: false, ...(!selectionChanged ? { selected: uuid(saved.selected) ? saved.selected : undefined } : {}) });
    } catch {
      if (active() && generation === revision) emit({ loading: false, error: "Couldn’t load saved workspaces. Your channels and saved operations are unchanged." });
    }
  }
  function validPending(value: Pending | undefined): value is Pending {
    const event = value?.event;
    return isEvent(event) && uuid(value?.channelId) && event.pubkey === connection.viewer && parseWorkspace(event)?.channelId === value.channelId && tag(event, "op") === "create";
  }
  async function head(id: string) {
    requireChannel(id);
    if (!session.snapshotRead) throw new Error("Workspace reads are unavailable on this Buzz version.");
    const d = await workspaceId(id);
    const events = await session.snapshotRead([{ artifact: "head", kinds: [45010], "#h": [id], "#d": [d], limit: 1 }], { signal });
    requireChannel(id);
    if (!events.length) { confirmed.delete(id); return undefined; }
    const event = events[0];
    if (events.length !== 1 || !isEvent(event) || tag(event, "d") !== d || tag(event, "h") !== id || parseWorkspace(event)?.channelId !== id) {
      confirmed.delete(id);
      throw new Error("The workspace record was removed or has an unsupported format. It has not been overwritten.");
    }
    return event;
  }
  async function clearPending(id: string, eventId: string) {
    await collection.preferences.update("pending", value => {
      const values = { ...object(value) }, existing = values[id] as unknown as Pending | undefined;
      if (existing?.event?.id === eventId) delete values[id];
      return values;
    });
  }
  async function reconcile(id: string) {
    const event = await head(id);
    if (!event) return false;
    const saved = object(await collection.preferences.get("pending"))[id] as unknown as Pending | undefined;
    if (validPending(saved)) await clearPending(id, saved.event.id);
    await collection.preferences.update("creation", value => creation(value)?.channelId === id ? null : value ?? null);
    confirmed.set(id, event); await refresh(); return true;
  }
  async function send(pending: Pending) {
    const writer = session.configArtifactWriter;
    if (!writer || !validPending(pending) || tag(pending.event, "d") !== await workspaceId(pending.channelId) || !await correctHash(pending.event)) throw new Error("The saved workspace operation is invalid. No event was sent.");
    await details(pending.channelId, true);
    if (await reconcile(pending.channelId)) return;
    requireChannel(pending.channelId, true);
    try { await writer.publish(pending.event, signal); } catch { /* Readback decides; a transport error is not a refusal. */ }
    try { if (await reconcile(pending.channelId)) return; } catch { /* Keep the exact signed operation for recovery. */ }
    throw new Error("The workspace link is unconfirmed. Check its status or retry the saved operation; no replacement will be created.");
  }
  async function link(id: string) {
    await details(id, true);
    if (await reconcile(id)) return;
    const previous = object(await collection.preferences.get("pending"))[id] as unknown as Pending | undefined;
    if (validPending(previous)) throw new Error("A link is already pending. Check or retry its saved operation below.");
    const writer = session.configArtifactWriter;
    if (!writer?.kinds?.includes(45010)) throw new Error("This Buzz version cannot save shared workspace records.");
    const template: Template = { kind: 45010, created_at: Math.floor(Date.now() / 1000), tags: [["ar", "1"], ["d", await workspaceId(id)], ["h", id], ["type", workspaceType], ["title", "Meetings workspace"], ["op", "create"]], content: JSON.stringify({ version: 1, channelId: id }) };
    const event = await writer.sign(template, signal);
    const pending = { channelId: id, event };
    if (!validPending(pending) || event.content !== template.content || event.kind !== template.kind || event.created_at !== template.created_at || JSON.stringify(event.tags) !== JSON.stringify(template.tags) || !await correctHash(event)) throw new Error("The signer changed the workspace record. Nothing was sent.");
    requireChannel(id, true);
    // A domain-specific, create-only intent; not a replacement for Buzz's outbox.
    // Persist signed bytes before publication. No publication happens on startup.
    await collection.preferences.update("pending", value => {
      const values = object(value);
      if (values[id]) throw new Error("A link is already pending in another window.");
      return { ...values, [id]: pending as unknown as Json };
    });
    await send(pending);
  }
  async function run(label: string, work: () => Promise<void>) {
    if (!active() || state.busy) return;
    emit({ busy: label, error: "" });
    try { await work(); } catch (error) { if (active()) emit({ error: error instanceof Error ? error.message : "The workspace change could not be confirmed." }); }
    finally { if (active()) { emit({ busy: "" }); await refresh(); } }
  }
  const stopCollection = collection.subscribe(() => { void refresh(); });
  const stopChannels = session.channels?.subscribeList(() => { void refresh(); });
  session.channels?.ensureList?.();
  void refresh().then(async () => {
    // Reconcile saved intent without issuing writes, including after a lost receipt.
    for (const pending of state.pending) {
      try { await reconcile(pending.channelId); } catch { /* Visible recovery stays pending. */ }
    }
    if (state.creation?.channelId) { try { await reconcile(state.creation.channelId); } catch { /* The creation remains recoverable. */ } }
  });
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    collection,
    select(id?: string) {
      if (!active()) return;
      selectionChanged = true; emit({ selected: id });
      void collection.preferences.update("view", value => ({ ...object(value), selected: uuid(id) ? id : null })).catch(() => emit({ error: "The workspace opened, but this device couldn’t save its last view." }));
    },
    link: (id: string) => run("Linking workspace…", async () => { await link(id); selectionChanged = true; emit({ selected: id }); await collection.preferences.update("view", () => ({ selected: id })); }),
    create: (name: string, visibility: "open" | "private") => run("Creating workspace…", async () => {
      name = cleanName(name); validWorkspaceName(name);
      if (!["open", "private"].includes(visibility)) throw new Error("Choose workspace visibility.");
      if (!session.channelCreation?.available || current().status !== "ready" || !active()) throw new Error("Reconnect before creating a workspace.");
      const attempt: Creation = { operation: crypto.randomUUID(), name, visibility };
      // Persist intent first. An ambiguous host channel create must be reconciled
      // through Channels/Outbox, never silently repeated after restart.
      await collection.preferences.update("creation", value => {
        if (value) throw new Error("Finish the previous channel creation before starting another workspace.");
        return attempt as unknown as Json;
      });
      if (!active()) return;
      const id = await session.channelCreation.create({ name, visibility });
      if (!active()) return;
      await collection.preferences.update("creation", value => creation(value)?.operation === attempt.operation ? { ...attempt, channelId: id } : value ?? null);
      await link(id); selectionChanged = true; emit({ selected: id });
      await collection.preferences.update("view", () => ({ selected: id }));
    }),
    finishCreation: () => run("Finishing workspace link…", async () => {
      const attempt = creation(await collection.preferences.get("creation"));
      if (!attempt?.channelId) throw new Error("Check the channel creation in Channels and Outbox, then link its existing channel above.");
      const pending = object(await collection.preferences.get("pending"))[attempt.channelId] as unknown as Pending | undefined;
      if (validPending(pending)) await send(pending); else await link(attempt.channelId);
      selectionChanged = true; emit({ selected: attempt.channelId });
      await collection.preferences.update("view", () => ({ selected: attempt.channelId! }));
    }),
    dismissCreation: () => run("Clearing reviewed creation…", async () => { await collection.preferences.update("creation", () => null); }),
    rename: (id: string, name: string) => run("Saving workspace name…", async () => {
      name = cleanName(name); validWorkspaceName(name);
      const base = await details(id, true);
      if (!base.canEdit) throw new Error("Only a channel owner or admin can rename this workspace.");
      const { channelId: _id, version: _version, canEdit: _canEdit, ...draft } = base;
      await session.channelDetails!.save(base, { ...draft, name }, signal, active);
      await session.channelDetails!.load(id, signal);
    }),
    checkRename: (id: string) => run("Checking name change…", () => session.channelDetails!.check(id, signal)),
    check: (id: string) => run("Checking saved link…", async () => { if (!await reconcile(id)) throw new Error("The link is still unconfirmed. You can retry the exact saved operation."); }),
    retry: (id: string) => run("Retrying saved link…", async () => {
      const pending = object(await collection.preferences.get("pending"))[id] as unknown as Pending;
      await send(pending);
    }),
    dispose() { if (closed) return; closed = true; lifetime.abort(); stopChannels?.(); stopCollection(); collection.close(); listeners.clear(); },
  };
}
export type Workspaces = ReturnType<typeof makeWorkspaces>;
