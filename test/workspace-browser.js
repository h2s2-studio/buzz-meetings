// Test-only browser adapter for the Buzz contracts supplied to the plugin.
export async function fixtureWorkspaceHost({ viewer, realm }) {
  const suffix = `?${new URLSearchParams({ viewer, realm })}`;
  const subscribers = new Set(), collections = new Set();
  let snapshot = { channels: [], events: [], records: [], canvases: {}, messages: {} };
  let channelSnapshot = { channels: [] };
  function install(value) {
    if (!value) return;
    const channelsChanged = JSON.stringify(snapshot.channels) !== JSON.stringify(value.channels);
    snapshot = value;
    if (channelsChanged) channelSnapshot = { channels: value.channels };
    for (const fn of subscribers) fn();
    for (const collection of collections) collection.notify();
  }
  async function request(action, value = {}, signal) {
    const response = await fetch(`/__workspace/${action}${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal });
    const data = await response.json(); install(data.state);
    if (!response.ok) throw new Error(data.error);
    return data.result;
  }
  await request("state");
  const events = new EventSource(`/__workspace/events${suffix}`);
  events.onmessage = event => install(JSON.parse(event.data));
  const subscribe = listener => { subscribers.add(listener); return () => subscribers.delete(listener); };
  const tag = (event, name) => event.tags.find(value => value[0] === name)?.[1];
  const entry = event => ({ record: { id: tag(event, "d"), channelId: tag(event, "h"), type: tag(event, "type"), availability: { state: tag(event, "op") === "delete" ? "deleted" : "available" }, current: { id: event.id, content: event.content, event } } });
  const storage = { open(definition) {
    const listeners = new Set(); const handle = { notify() { for (const listener of listeners) listener(); } }; collections.add(handle);
    const key = id => `meetings-fixture:${realm}:${viewer}:${definition.name}:${id}`;
    const get = id => { const saved = localStorage.getItem(key(id)); return saved === null ? undefined : JSON.parse(saved); };
    const storageChanged = event => { if (event.key?.startsWith(`meetings-fixture:${realm}:${viewer}:${definition.name}:`)) handle.notify(); };
    addEventListener("storage", storageChanged);
    return {
      async get(id) { const event = snapshot.records.find(event => tag(event, "d") === id); return event ? entry(event) : undefined; },
      async page({ index, value, limit = 100, after }) {
        const projected = snapshot.records.map(entry).flatMap(entry => definition.project(entry).filter(row => row.index === index && row.value === value).map(row => ({ entry, row }))).sort((a, b) => a.row.order.localeCompare(b.row.order) || a.entry.record.id.localeCompare(b.entry.record.id));
        const eligible = after ? projected.filter(({ row, entry }) => row.order > after.order || row.order === after.order && entry.record.id > after.id) : projected;
        const chosen = eligible.slice(0, limit); const last = chosen.at(-1);
        return { entries: chosen.map(({ entry }) => entry), ...(eligible.length > limit && last ? { next: { order: last.row.order, id: last.entry.record.id } } : {}) };
      },
      async refreshError() { return null; },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      preferences: { async get(id) { return get(id); }, async update(id, change) {
        const mutate = () => { localStorage.setItem(key(id), JSON.stringify(change(get(id)))); handle.notify(); };
        if (navigator.locks) await navigator.locks.request(key(id), mutate); else mutate();
      } },
      close() { collections.delete(handle); listeners.clear(); removeEventListener("storage", storageChanged); },
    };
  } };
  return {
    storage, request, snapshot: () => snapshot, subscribe,
    session: {
      channels: { list: () => channelSnapshot, subscribeList: subscribe, ensureList() {} },
      snapshotRead: (filters, { signal } = {}) => request("read", { filters }, signal),
      configArtifactWriter: { kinds: [45010], sign: (template, signal) => request("sign", { template }, signal), publish: (event, signal) => request("publish", { event }, signal) },
      channelDetails: { available: true, load: (id, signal) => request("details", { id }, signal), save: (base, draft, signal, active) => active && !active() ? Promise.reject(new Error("Scope changed")) : request("rename", { base, draft }, signal), check: async () => {}, snapshot: () => undefined },
      channelCreation: { available: true, create: input => request("create", input) },
    },
    close() { events.close(); subscribers.clear(); },
  };
}
