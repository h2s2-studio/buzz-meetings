// Test-only plugin for Buzz Meetings W2 Gate 0. Plain JS, no build step.
// 1. A local agent signs op=create and op=update of one kind-45010 artifact with
//    its own key (client.publish), through meetings_gate0_write.
// 2. The owner opens the "Gate 0" page, reads both back with snapshotRead and
//    signs revision 3 with configArtifactWriter.
// It refuses any channel whose name does not start with "meetings-gate0".
export const inject = ["react", "pages", "agents", "relay"];

const TYPE = "studio.h2s2.meetings.gate0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;

export function apply(ctx) {
  const React = ctx.react;
  const state = { channelId: "", d: "", writes: [], listeners: new Set() };
  const emit = () => { for (const fn of state.listeners) fn(); };
  const tag = (event, key) => event.tags.find(value => value[0] === key)?.[1];

  function testChannel(channelId) {
    const channel = ctx.relay.snapshot().session.channels?.list().channels.find(item => item.id === channelId);
    if (!channel || !/^meetings-gate0/.test(channel.name ?? "")) throw new Error("Gate 0 only writes to a channel named meetings-gate0-*.");
    return channel;
  }
  async function readHead(channelId, d) {
    const read = ctx.relay.snapshot().session.snapshotRead;
    if (!read) throw new Error("This Buzz connection has no snapshotRead.");
    const events = await read([{ artifact: "head", kinds: [45010], "#h": [channelId], "#d": [d], limit: 1 }], {});
    return events.map(event => ({ id: event.id, pubkey: event.pubkey, op: tag(event, "op"), prev: tag(event, "prev") ?? null, type: tag(event, "type"), content: event.content }));
  }
  const template = (channelId, d, op, prev, revision, author) => ({
    kind: 45010, created_at: Math.floor(Date.now() / 1000),
    tags: [["ar", "1"], ["d", d], ["h", channelId], ["type", TYPE], ["title", "Gate 0 test document"], ["op", op], ...(prev ? [["prev", prev]] : [])],
    content: JSON.stringify({ version: 1, kind: "document", title: "Gate 0 test document", revision, author, nodes: [{ id: "intro", type: "paragraph", text: `Revision ${revision} written by ${author}.` }] }),
  });

  ctx.agents.addTool({
    name: "meetings_gate0_write",
    description: "TEST ONLY (Buzz Meetings Gate 0). Sign a kind-45010 test artifact with your own key in a channel named meetings-gate0-*. step=create needs a new UUID d; step=update needs the current head revision as prev.",
    inputSchema: { type: "object", properties: { channel_id: { type: "string" }, d: { type: "string" }, step: { enum: ["create", "update"] }, prev: { type: "string" } }, required: ["channel_id", "d", "step"], additionalProperties: false },
    async call(client, context, args) {
      const { channel_id: channelId, d, step, prev } = args;
      if (!UUID.test(d) || (step === "update" && !HEX.test(prev ?? ""))) throw new Error("Supply a UUID d, and the current head id as prev for an update.");
      testChannel(channelId);
      if (state.writes.filter(write => write.by === "agent").length >= 2) throw new Error("Gate 0 allows exactly two agent revisions.");
      const event = template(channelId, d, step, step === "update" ? prev : undefined, step === "create" ? 1 : 2, "agent");
      const posted = await client.publish(event);
      state.channelId = channelId; state.d = d;
      state.writes.push({ by: "agent", pubkey: client.pubkey, step, id: posted.id, prev: prev ?? null }); emit();
      return JSON.stringify({ published: posted.id, signer: client.pubkey, step, prev: prev ?? null });
    },
  });
  ctx.agents.addTool({
    name: "meetings_gate0_read",
    description: "TEST ONLY (Buzz Meetings Gate 0). Read back the head revision of the Gate 0 test artifact and the revisions recorded in this app session.",
    inputSchema: { type: "object", properties: { channel_id: { type: "string" }, d: { type: "string" } }, required: ["channel_id", "d"], additionalProperties: false },
    async call(client, context, args) {
      testChannel(args.channel_id);
      return JSON.stringify({ head: await readHead(args.channel_id, args.d), recorded: state.writes });
    },
  });

  function Gate0() {
    const [, setTick] = React.useState(0);
    const [busy, setBusy] = React.useState(false), [result, setResult] = React.useState(""), [error, setError] = React.useState("");
    React.useEffect(() => { const fn = () => setTick(value => value + 1); state.listeners.add(fn); return () => state.listeners.delete(fn); }, []);
    const owner = state.writes.some(write => write.by === "owner");
    async function readAndWrite() {
      setBusy(true); setError("");
      try {
        testChannel(state.channelId);
        const before = await readHead(state.channelId, state.d);
        const head = before[0];
        const agentUpdate = state.writes.find(write => write.by === "agent" && write.step === "update");
        if (!head || !agentUpdate || head.id !== agentUpdate.id) throw new Error("The head is not the agent's update yet.");
        const session = ctx.relay.snapshot().session, writer = session.configArtifactWriter;
        if (!writer?.kinds?.includes(45010)) throw new Error("This Buzz version cannot sign artifacts from a plugin.");
        const signed = await writer.sign(template(state.channelId, state.d, "update", head.id, 3, "owner"));
        try { await writer.publish(signed); } catch (problem) { /* Read back decides. */ setError(`publish: ${problem?.message ?? problem}`); }
        const after = await readHead(state.channelId, state.d);
        state.writes.push({ by: "owner", pubkey: signed.pubkey, step: "update", id: signed.id, prev: head.id, accepted: after[0]?.id === signed.id }); emit();
        setResult(JSON.stringify({ readBeforeWrite: before, readAfterWrite: after }, null, 2));
      } catch (problem) { setError(problem?.message ?? String(problem)); }
      finally { setBusy(false); }
    }
    return React.createElement("section", { style: { padding: "var(--space-panel-inset)", display: "grid", gap: "var(--space-4)", alignContent: "start" } },
      React.createElement("h2", null, "Meetings Gate 0 (test)"),
      React.createElement("p", null, state.channelId ? `Test channel ${state.channelId} · artifact ${state.d}` : "Waiting for the agent to write revisions 1 and 2."),
      React.createElement("ol", null, ...state.writes.map(write => React.createElement("li", { key: write.id }, `${write.by} · ${write.step} · ${write.id}${write.prev ? ` (prev ${write.prev.slice(0, 12)}…)` : ""}${write.accepted === false ? " · NOT accepted" : ""}`))),
      React.createElement("button", { type: "button", className: "buzz-button", "data-buzz-ui": "", "data-variant": "prominent", disabled: busy || owner || !state.writes.some(write => write.step === "update"), onClick: () => { void readAndWrite(); } }, owner ? "Revision 3 written" : "Read back and write revision 3 as me"),
      error && React.createElement("p", { role: "alert" }, error),
      result && React.createElement("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, result));
  }
  ctx.pages.register({ id: "gate0", title: "Gate 0", primary: true, component: Gate0 });
}
