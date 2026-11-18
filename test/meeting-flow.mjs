// Composes the real transcript, live-agent and record controllers against the
// workspace contract fixture and a scripted call. No production code imports it.
import { build } from "esbuild";
import { WorkspaceHost, client, identities, general } from "./workspace-host.mjs";
const bundle = async entry => { const built = await build({ entryPoints:[entry],bundle:true,format:"esm",platform:"node",write:false }); return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`); };
const [{ makeMeetingTranscription }, { makeLiveAgents }, { meetingRecords, covers }] = await Promise.all(["src/meeting-transcription.ts","src/live-agents.ts","src/meeting-records.ts"].map(bundle));
export { general, identities, covers };
const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,"0")).join("");
export const settle = () => new Promise(resolve => setTimeout(resolve, 0));
export function meetingFlow({ host = new WorkspaceHost(), viewer = identities.Alex } = {}) {
  const connection = client(host, viewer);
  const agent = { key: "e".repeat(64), pubkey: identities.Riley, name: "Studio", owner: viewer, place: "here" };
  const observers = new Set(), sent = [], published = [], tools = new Map(), cleanups = [], mediaListeners = new Set(), announcements = [];
  const flow = { failSend: false, running: true };
  Object.assign(connection.session, {
    agentChoices: { snapshot: () => ({ selectable: [{ pubkey: agent.pubkey, name: agent.name }] }), subscribe: () => () => {} },
    agentActivity: { snapshot: () => ({ local: [] }), subscribe: () => () => {}, activate: () => () => {} },
    outbox: { observeSend(fn) { observers.add(fn); return () => observers.delete(fn); } },
    messages: { async send(channel, content, mentions) {
      if (flow.failSend) throw new Error("Relay offline");
      const event = { id: hex(), kind: 9, pubkey: viewer, content, tags: [["h", channel], ...mentions.map(key => ["p", key])] };
      sent.push(event); for (const observe of [...observers]) observe(event)?.(); return event.id;
    } },
  });
  const wakes = [];
  const runtime = { snapshot: () => ({ agents: [agent], running: flow.running ? [agent] : [] }), subscribe: () => () => {}, wake(key, input) { wakes.push({ key, ...input }); }, addInstructions() {}, addTool(tool) { tools.set(tool.name, tool); } };
  let call = { phase: "idle", transcription: true, sharedTranscription: true, participants: [] }, receive;
  const media = {
    snapshot: () => call, subscribe(fn) { mediaListeners.add(fn); return () => mediaListeners.delete(fn); },
    async setListener() {}, async setTranscribing(id, value) { announcements.push({ id, value }); },
    async captions(signal, next) { receive = next; return { close() {} }; },
  };
  const relay = { snapshot: connection.current, subscribe: connection.session.channels.subscribeList };
  const transcript = makeMeetingTranscription(media);
  const agents = makeLiveAgents({ agents: runtime, relay, effect: setup => cleanups.push(setup()) }, media, transcript);
  const records = meetingRecords(relay, connection.storage);
  let seq = 0, stream = "stream-" + hex().slice(0, 8);
  Object.assign(flow, { host, connection, agent, sent, published, tools, wakes, transcript, agents, records, media, announcements,
    join(occurrenceId, { roomName = "General Voice", channelId, keepStream = false } = {}) { call = { ...call, phase: "connected", joinId: crypto.randomUUID(), occurrenceId, roomName, workspaceChannelId: channelId }; if (!keepStream) { seq = 0; stream = "stream-" + hex().slice(0, 8); } for (const fn of [...mediaListeners]) fn(); },
    setOccurrence(occurrenceId) { call = { ...call, occurrenceId }; for (const fn of [...mediaListeners]) fn(); },
    leave() { call = { ...call, phase: "idle", joinId: undefined, occurrenceId: undefined, roomName: undefined, workspaceChannelId: undefined }; for (const fn of [...mediaListeners]) fn(); },
    speak(...lines) { receive?.({ streamId: stream, callId: call.occurrenceId, phase: "active", gap: false, dropped: 0, error: "", metrics: { subscribers: 1, sources: 1, queued: 0, jobs: 0, delayMs: 0 },
      segments: lines.map(([speakerId, speakerName, text]) => ({ seq: ++seq, speakerId, speakerName, text, startedAt: 1_700_000_000_000 + seq * 1000, endedAt: 1_700_000_000_500 + seq * 1000 })) }); },
    addAgent(mode = "act") { return agents.start({ channelId: general, roomName: call.roomName, pubkey: agent.pubkey, mode, mission: "Help the meeting." }); },
    // Call any agent tool as the fixture agent in its assignment thread.
    async tool(name, args) {
      const state = agents.snapshot();
      const agentClient = { key: agent.key, pubkey: agent.pubkey, owner: viewer, async publish(event) { const id = hex(); published.push({ ...event, id }); return { id }; } };
      return JSON.parse(await tools.get(name).call(agentClient, { channel: general, root: sent.at(-1)?.id }, { session_id: state.sessionId, ...args }));
    },
    async task(args) {
      const state = agents.snapshot();
      const agentClient = { key: agent.key, pubkey: agent.pubkey, owner: viewer, async publish(event) { const id = hex(); published.push({ ...event, id }); return { id }; } };
      return JSON.parse(await tools.get("meetings_task_record").call(agentClient, { channel: general, root: sent.at(-1)?.id }, { session_id: state.sessionId, ...args }));
    },
    async savedRecords() { await settle(); return records.snapshot().records.map(record => record.value); },
    close() { records.close(); for (const cleanup of cleanups.splice(0)) cleanup(); transcript.close(); connection.close(); },
  });
  return flow;
}
