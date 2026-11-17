// A contract fixture, not a replacement Buzz relay. No production code imports it.
import { createHash, randomUUID } from "node:crypto";
export const identities = { Alex: "a".repeat(64), Riley: "b".repeat(64), Sam: "c".repeat(64) };
export const general = "10000000-0000-4000-8000-000000000001", design = "10000000-0000-4000-8000-000000000002";
const tag = (event, key) => event.tags.find(value => value[0] === key)?.[1];
export class WorkspaceHost {
  channels = new Map([general, design].map((id, index) => [id, { id, name: index ? "Design" : "General Voice", description: "", visibility: "public", channelType: "stream", version: randomUUID(), roles: Object.fromEntries(Object.values(identities).map(viewer => [viewer, viewer === identities.Alex ? "owner" : "member"])) }]));
  events = new Map(); canvases = new Map(); messages = new Map(); preferences = new Map(); listeners = new Set(); publications = []; creations = [];
  failPublish = ""; failRead = false; storageFailure = false;
  emit() { for (const listener of this.listeners) listener(); }
  list(viewer) { return [...this.channels.values()].filter(channel => channel.roles[viewer]).map(({ roles, version, description, ...channel }) => ({ ...channel, members: Object.keys(roles), viewerRole: roles[viewer], ...(roles[viewer] === "guest" ? { readOnly: true } : {}) })); }
  access(id, viewer, write = false) { const role = this.channels.get(id)?.roles[viewer]; if (!role || (write && role === "guest")) throw new Error("restricted: channel access denied"); return this.channels.get(id); }
  state(viewer) { return { channels: this.list(viewer), events: [...this.events.values()].filter(event => this.channels.get(tag(event, "h"))?.roles[viewer] && tag(event, "op") !== "delete") }; }
  read(viewer, filters) {
    if (this.failRead) throw new Error("Connection lost");
    return filters.flatMap(filter => {
      for (const id of filter["#h"] ?? []) this.access(id, viewer);
      return [...this.events.values()].filter(event => this.channels.get(tag(event, "h"))?.roles[viewer] && (!filter["#h"] || filter["#h"].includes(tag(event, "h"))) && (!filter["#d"] || filter["#d"].includes(tag(event, "d"))) && (!filter["#type"] || filter["#type"].includes(tag(event, "type"))) && (filter.artifact !== "current" || tag(event, "op") !== "delete")).slice(0, filter.limit ?? 100);
    });
  }
  sign(viewer, template) { const id = createHash("sha256").update(JSON.stringify([0, viewer, template.created_at, template.kind, template.tags, template.content])).digest("hex"); return { ...template, pubkey: viewer, id, sig: "0".repeat(128) }; }
  publish(viewer, event) {
    this.publications.push(structuredClone(event)); this.access(tag(event, "h"), viewer, true);
    if (event.pubkey !== viewer || event.kind !== 45010) throw new Error("invalid: signer or kind");
    if (this.failPublish === "before") throw new Error("Connection lost before delivery");
    const previous = this.events.get(tag(event, "d"));
    if (previous?.id === event.id) return;
    if (previous && tag(event, "prev") !== previous.id) throw new Error("conflict: wrong previous revision");
    if (!previous && tag(event, "op") !== "create") throw new Error("invalid: missing create");
    this.events.set(tag(event, "d"), structuredClone(event)); this.emit();
    if (this.failPublish === "after") { this.failRead = true; throw new Error("Connection lost after delivery"); }
  }
  details(viewer, id) { const channel = this.access(id, viewer); const { roles, id: channelId, ...details } = channel; return { ...details, channelId, canEdit: ["owner", "admin"].includes(roles[viewer]) }; }
  rename(viewer, base, draft) {
    const channel = this.access(base.channelId, viewer, true);
    if (!["owner", "admin"].includes(channel.roles[viewer])) throw new Error("restricted: admin required");
    if (base.version !== channel.version) throw new Error("conflict: channel details changed");
    if (draft.visibility !== channel.visibility) throw new Error("The fixture expects visibility to be preserved");
    channel.name = draft.name; channel.version = randomUUID(); this.emit();
  }
  create(viewer, input) {
    if (input.ttlSeconds !== undefined) throw new Error("Temporary lifetime was supplied");
    const id = randomUUID(); this.creations.push({ ...input, id });
    this.channels.set(id, { id, name: input.name, description: "", visibility: input.visibility === "open" ? "public" : "private", channelType: "stream", version: randomUUID(), roles: { [viewer]: "owner" } }); this.emit(); return id;
  }
  grant(id, viewer, role = "member") { const channel = this.channels.get(id); if (role) channel.roles[viewer] = role; else delete channel.roles[viewer]; this.emit(); }
  canvas(viewer, id) { this.access(id, viewer); return this.canvases.get(id); }
  saveCanvas(viewer, id, content, expected) { this.access(id, viewer, true); if (this.canvases.get(id)?.id !== expected) throw new Error("Canvas changed. Your draft is kept; load the current notes before saving."); const event = { id: randomUUID(), content }; this.canvases.set(id, event); this.emit(); return event; }
  chat(viewer, id) { this.access(id, viewer); return this.messages.get(id) ?? []; }
  send(viewer, id, text) { this.access(id, viewer, true); this.messages.set(id, [...this.chat(viewer, id), { id: randomUUID(), text, viewer }]); this.emit(); }
}

export function client(host, viewer = identities.Alex) {
  const callbacks = new Set(), channels = { channels: host.list(viewer) };
  let status = "ready", closed = false;
  const handles = new Set();
  const update = () => { channels.channels = host.list(viewer); for (const fn of callbacks) fn(); for (const handle of handles) handle.notify(); };
  host.listeners.add(update);
  const session = {
    channels: { list: () => channels, subscribeList(fn) { callbacks.add(fn); return () => callbacks.delete(fn); }, ensureList() {} },
    snapshotRead: async filters => host.read(viewer, filters),
    configArtifactWriter: { kinds: [45010], sign: async template => host.sign(viewer, template), publish: async event => host.publish(viewer, event) },
    channelDetails: { available: true, load: async id => host.details(viewer, id), save: async (base, draft) => host.rename(viewer, base, draft), check: async () => {}, snapshot: () => undefined },
    channelCreation: { available: true, create: async input => host.create(viewer, input) },
  };
  const current = () => ({ session, viewer, status, origin: "https://relay.example", scope: `relay:${viewer}` });
  const storage = { open(definition) {
    const values = host.preferences.get(viewer) ?? new Map(); host.preferences.set(viewer, values);
    const listeners = new Set(); const handle = { notify() { for (const fn of listeners) fn(); } }; handles.add(handle);
    return {
      async get(id) {
        const event = host.events.get(id);
        if (!event || !host.channels.get(tag(event, "h"))?.roles[viewer]) return undefined;
        return { record: { id, channelId: tag(event, "h"), type: tag(event, "type"), current: { id: event.id, content: event.content, event }, availability: { state: tag(event, "op") === "delete" ? "deleted" : "available" } } };
      },
      async page({ index, value }) {
        const entries = host.state(viewer).events.map(event => ({ record: { id: tag(event, "d"), channelId: tag(event, "h"), type: tag(event, "type"), availability: { state: "available" }, current: { id: event.id, content: event.content, event } } }));
        return { entries: entries.filter(entry => definition.project(entry).some(row => row.index === index && row.value === value)) };
      },
      async refreshError() { return null; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      preferences: { async get(id) { return structuredClone(values.get(id)); }, async update(id, change) { if (host.storageFailure) throw new Error("Disk full"); const next = change(structuredClone(values.get(id))); values.set(id, structuredClone(next)); handle.notify(); } },
      close() { handles.delete(handle); listeners.clear(); },
    };
  } };
  return { current, storage, session, setStatus(value) { status = value; update(); }, close() { if (!closed) { closed = true; host.listeners.delete(update); } } };
}
