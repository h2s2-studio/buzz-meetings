import type { LiveAgents, LiveAgentState } from "./live-agents";
import type { makeRoomSession, RoomSnapshot } from "./room";
import type * as ReactRuntime from "react";
import { readable, writable, type WorkspaceConnection } from "./workspaces";

// Public session-owned capabilities. Identity choices are not execution or access proof.
type Choice = { pubkey: string; name: string; managed?: boolean; deleting?: boolean };
type Work = { scope: string; agent: string; channelId: string; messageId: string; state: string; startedAt: number; error?: string; step?: { tool: string; target?: string }; stoppable?: boolean; evidence?: object | null };
type Activity = { status: string; local?: readonly Work[]; turns: readonly { agent: string; channelId: string | null; turnId: string; state: string; timestamp: number }[] };
export type OwnerEvent = { id: string; kind: number; pubkey: string; content: string; tags: readonly (readonly string[])[] };
export type AgentSession = {
  memberAdditions?: { add(channelId: string, pubkey: string, options?: { role?: "guest"; retry?: true }): Promise<void> };
  outbox?: { observeSend(listener: (event: OwnerEvent, signal: AbortSignal) => ((pending: readonly OwnerEvent[]) => void) | undefined): () => void };
  agentChoices?: { snapshot(): { selectable: readonly Choice[]; pending?: boolean }; subscribe(listener: () => void): () => void; ensure?(includeLegacy?: boolean, archives?: boolean): void };
  agentActivity?: { snapshot(): Activity; subscribe(listener: () => void): () => void; activate?(): () => void; interrupt?(agent: string, channel: string, message: string): Promise<unknown> };
  messages?: { send(channelId: string, text: string, mentions: readonly string[]): string | Promise<string> };
};
export type ConversationTarget = { version: 1; kind: "conversation"; scope: { viewer: string; communityOrigin: string }; channelId: string; messageId?: string; panel?: "members" };
const emptyChoices: { selectable: readonly Choice[]; pending?: boolean } = { selectable: [] };
const emptyChannels = { channels: [] };
const emptyLive: LiveAgentState = { phase: "idle", error: "", transcripts: [], tasks: [], channelId: undefined, agentName: undefined, consumed: 0, notified: 0 };
const emptyCall: Pick<RoomSnapshot, "phase" | "roomName" | "transcription"> = { phase: "idle", roomName: undefined, transcription: false };
const emptyActivity: Activity = { status: "unavailable", turns: [] };
const idle = () => () => {};
const templates = {
  agenda: { label: "Plan an agenda", text: "Propose an agenda for this meeting using the channel discussion and shared notes. Call out decisions we need to make and questions that need an owner." },
  research: { label: "Research a question", text: "Research the following question and post your findings with sources in this conversation:\n\n" },
  summary: { label: "Summarize the discussion", text: "Summarize the written discussion and shared notes in this channel. Separate decisions, open questions, and action items. Do not infer anything from live meeting audio." },
  actions: { label: "Extract action items", text: "Extract action items from this channel’s discussion and shared notes. Include an owner and due date only when they are stated; mark missing details as unassigned." },
} as const;

export function meetingAgents(ctx: { react: typeof ReactRuntime; relay: { snapshot(): WorkspaceConnection; subscribe(listener: () => void): () => void }; navigation: { open(target: ConversationTarget): Promise<unknown> } }, liveAgents?: LiveAgents, media?: ReturnType<typeof makeRoomSession>) {
  const React = ctx.react;
  const { useEffect, useState, useSyncExternalStore } = React;
  const drafts = new WeakMap<object, Map<string, { selected: string; draft: string; kind: keyof typeof templates; liveMode: "act" | "assist"; mission: string }>>();
  function Action(props: ReactRuntime.ButtonHTMLAttributes<HTMLButtonElement>) {
    return <button {...props} type={props.type ?? "button"} className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="subtle" data-disabled={props.disabled || undefined}><span className="buzz-button-label">{props.children}</span></button>;
  }
  return function MeetingAgents({ channelId, roomName }: { channelId: string; roomName?: string }) {
    const live = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot), session = live.session;
    const channels = useSyncExternalStore(session.channels?.subscribeList ?? idle, session.channels?.list ?? (() => emptyChannels));
    const choices = useSyncExternalStore(session.agentChoices?.subscribe ?? idle, session.agentChoices?.snapshot ?? (() => emptyChoices));
    const activity = useSyncExternalStore(session.agentActivity?.subscribe ?? idle, session.agentActivity?.snapshot ?? (() => emptyActivity));
    const listening = useSyncExternalStore(liveAgents?.subscribe ?? idle, liveAgents?.snapshot ?? (() => emptyLive));
    const call = useSyncExternalStore<Pick<RoomSnapshot, "phase" | "roomName" | "transcription">>(media?.subscribe ?? idle, media?.snapshot ?? (() => emptyCall));
    const savedDraft = drafts.get(session)?.get(channelId);
    const [liveMode, setLiveMode] = useState<"act" | "assist">(savedDraft?.liveMode ?? "act");
    const [mission, setMission] = useState(savedDraft?.mission ?? "Follow this meeting, identify agreed action items, create and carry out tasks using your available tools, and report progress and results in this channel. Ask when requirements or authorization are missing.");
    const [selected, setSelected] = useState(savedDraft?.selected ?? ""), [draft, setDraft] = useState<string>(savedDraft?.draft ?? templates.agenda.text);
    const [kind, setKind] = useState<keyof typeof templates>(savedDraft?.kind ?? "agenda"), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
    const channel = channels.channels.find(item => item.id === channelId);
    const access = live.status === "ready" && readable(channel, live.viewer);
    const candidates = choices.selectable.filter(agent => !agent.deleting && /^[0-9a-f]{64}$/.test(agent.pubkey));
    const agent = candidates.find(item => item.pubkey === selected);
    const member = !!agent && !!channel?.members?.includes(agent.pubkey);
    const local = activity.local?.filter(work => work.scope === live.scope && work.channelId === channelId) ?? [];
    const remote = activity.turns.filter(turn => turn.channelId === channelId && !local.some(work => work.agent === turn.agent));
    useEffect(() => { session.agentChoices?.ensure?.(true, true); return session.agentActivity?.activate?.(); }, [session]);
    useEffect(() => { let saved = drafts.get(session); if (!saved) drafts.set(session, saved = new Map()); saved.set(channelId, { selected, draft, kind, liveMode, mission }); }, [channelId, session, selected, draft, kind, liveMode, mission]);
    async function add(item: Choice) {
      if (busy || !roomName || !liveAgents) return;
      setError(""); setNotice(""); setBusy(true);
      try {
        const current = ctx.relay.snapshot(), channel = current.session.channels?.list().channels.find(channel => channel.id === channelId);
        if (current.session !== session || !writable(channel, current.viewer) || !liveAgents.eligible(item.pubkey)) throw new Error("Check current channel access and that this agent is running here.");
        if (!channel?.members?.includes(item.pubkey)) {
          if (!session.memberAdditions) throw new Error("Use Manage access to add this agent to the channel first.");
          await session.memberAdditions.add(channelId, item.pubkey);
        }
        if (ctx.relay.snapshot().session !== session) return;
        await liveAgents.start({ channelId, roomName, pubkey: item.pubkey, mode: liveMode, mission });
      } catch (problem) { setError(problem instanceof Error ? problem.message : "Couldn’t add this agent. Check Buzz’s Outbox before trying again."); }
      finally { setBusy(false); }
    }
    function open(panel?: "members", messageId?: string) {
      if (!live.viewer || !live.origin || ctx.relay.snapshot().session !== session || !access) return;
      void ctx.navigation.open({ version: 1, kind: "conversation", scope: { viewer: live.viewer, communityOrigin: live.origin }, channelId, ...(panel ? { panel } : {}), ...(messageId ? { messageId } : {}) });
    }
    async function send(event: ReactRuntime.FormEvent) {
      event.preventDefault(); if (busy) return;
      setNotice(""); setError("");
      const current = ctx.relay.snapshot(), freshChannel = current.session.channels?.list().channels.find(item => item.id === channelId);
      const freshAgent = current.session.agentChoices?.snapshot().selectable.find(item => item.pubkey === selected && !item.deleting);
      if (current.session !== session || current.scope !== live.scope || current.status !== "ready" || !writable(freshChannel, current.viewer) || !freshAgent || !freshChannel?.members?.includes(freshAgent.pubkey) || !session.messages || !draft.trim()) {
        setError("Check the channel’s current access and choose an agent who is a member before sending."); return;
      }
      setBusy(true);
      try {
        await session.messages.send(channelId, `@${freshAgent.name}\n\n${draft.trim()}`, [freshAgent.pubkey]);
        if (ctx.relay.snapshot().session === session) { setNotice("Task queued in Buzz. Check chat for delivery and the agent’s reply."); setDraft(""); }
      } catch (problem) { if (ctx.relay.snapshot().session === session) setError(problem instanceof Error ? problem.message : "Couldn’t queue this task. Check Buzz’s Outbox before sending it again."); }
      finally { setBusy(false); }
    }
    async function stop(work: Work) {
      if (busy || !access || ctx.relay.snapshot().session !== session || !session.agentActivity?.interrupt) return;
      setBusy(true); setError("");
      try { await session.agentActivity.interrupt(work.agent, channelId, work.messageId); setNotice("Stop requested. The activity below updates when the runner stops."); }
      catch (problem) { setError(problem instanceof Error ? problem.message : "Couldn’t stop this task. Open the conversation’s Activity controls."); }
      finally { setBusy(false); }
    }
    const name = (pubkey: string) => candidates.find(item => item.pubkey === pubkey)?.name ?? "Agent";
    return <section className="meeting-agents text-body-sm" aria-label="Meeting agents" data-buzz-ui="">
      <header><h3 className="text-body-sm">Agents in this call</h3><Action disabled={!access} onClick={() => open("members")}>Manage access</Action></header>
      {!access ? <p role="status">Reconnect and choose a channel you belong to to work with its agents.</p> : <>
        {(listening.members ?? []).filter(item => item.channelId === channelId).map(item => <div className="meeting-agent-member" key={item.pubkey}>
          <span className="meeting-agent-symbol" aria-hidden="true">✦</span><div><strong>{item.name}</strong><p className="text-caption text-subtle" role="status">{item.phase === "starting" ? "Joining…" : "Listening · ready for spoken tasks"}</p></div>
          <Action aria-label={`Remove ${item.name} from call`} onClick={() => liveAgents?.stop("", item.pubkey)}>Remove</Action>
        </div>)}
        {listening.error && <p role="alert" className="text-danger">{listening.error}</p>}
        <div className="meeting-agent-chooser" aria-label="Add agent to call">
          {!roomName || call.phase !== "connected" ? <p className="text-caption text-subtle">Join voice to add a listening agent. You can send a written task below.</p> : !call.transcription ? <p className="text-caption text-subtle">Transcription needs to be available before an agent can listen.</p> : <p className="text-caption text-subtle">Add an agent, then speak naturally to give it work.</p>}
          {candidates.filter(item => !listening.members?.some(member => member.pubkey === item.pubkey && member.channelId === channelId)).map(item => {
            const member = !!channel?.members?.includes(item.pubkey), ready = !!liveAgents?.eligible(item.pubkey);
            return <div className="meeting-agent-choice" key={item.pubkey}><div><strong>{item.name}</strong><p className="text-caption text-metadata">{!ready ? "Needs to be one of your agents running on this device" : !member ? "Adding also gives access to this channel’s history, notes and files" : "Ready to listen and carry out tasks"}</p></div><Action aria-label={`Add ${item.name} to call`} disabled={busy || !ready || !roomName || call.phase !== "connected" || call.roomName !== roomName || !call.transcription || !writable(channel, live.viewer) || (!member && !session.memberAdditions) || !mission.trim()} onClick={() => { void add(item); }}>Add</Action></div>;
          })}
          {!candidates.length && <p className="text-caption text-metadata">{choices.pending ? "Loading agents…" : "No agents are available. Create and start an agent in Buzz to bring it here."}</p>}
        </div>
        <details className="meeting-agent-preferences"><summary>Agent settings</summary><label>Live role<select className="buzz-input" aria-label="Live role" value={liveMode} onChange={event => setLiveMode(event.target.value as "act" | "assist")}><option value="act">Create and carry out tasks</option><option value="assist">Take notes and propose tasks</option></select></label><label>Agent mission<textarea className="buzz-input" aria-label="Agent mission" rows={3} value={mission} maxLength={4000} onChange={event => setMission(event.target.value)} /></label><p className="text-caption text-metadata">Applies when you add an agent. Removing an agent stops new speech input; use Stop task for work already running.</p></details>
        {listening.channelId === channelId && listening.tasks.length > 0 && <div className="meeting-agent-tasks"><h4 className="text-caption text-metadata">Meeting tasks</h4>{listening.tasks.map(task => <div key={task.messageId ?? task.key}><strong>{task.title}</strong><span className="text-caption text-subtle">{task.status === "done" ? "Done" : task.status === "working" ? "Working" : task.status === "blocked" ? "Needs attention" : "Proposed"} · {task.delivery === "published" ? "Saved in chat" : task.delivery === "publishing" ? "Saving…" : "Check delivery"}</span>{task.result && <p>{task.result}</p>}{task.messageId && <Action onClick={() => open(undefined, task.messageId)}>View result</Action>}</div>)}</div>}
        <details className="meeting-written-task"><summary>Send a written task</summary><label>Agent<select aria-label="Agent" className="buzz-input" value={selected} disabled={busy || !session.agentChoices} onChange={event => { setSelected(event.target.value); setNotice(""); }}><option value="">Choose an agent…</option>{candidates.map(item => <option key={item.pubkey} value={item.pubkey}>{item.name}{channel?.members?.includes(item.pubkey) ? "" : " · Needs channel access"}</option>)}</select></label>{agent && !member && <p className="text-caption text-subtle">Add {agent.name} through Manage access before sending a written task.</p>}<form onSubmit={event => { void send(event); }}>
          <label>Task<select aria-label="Task" className="buzz-input" value={kind} disabled={busy} onChange={event => { const next = event.target.value as keyof typeof templates; setKind(next); setDraft(templates[next].text); setNotice(""); }}>{Object.entries(templates).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
          <label>Request<textarea aria-label="Request" className="buzz-input" rows={6} value={draft} maxLength={12000} disabled={busy} onChange={event => { setDraft(event.target.value); setNotice(""); }} /></label>
          <div className="meeting-agent-actions"><Action onClick={() => open()}>Open conversation</Action><Action type="submit" disabled={busy || !member || !writable(channel, live.viewer) || !session.messages || !draft.trim()}>Send task</Action></div>
        </form></details>
        {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="text-danger">{error}</p>}
        <div className="meeting-agent-activity"><h4 className="text-caption text-metadata">Activity in this channel</h4>
          {!local.length && !remote.length && <p className="text-caption text-subtle">{activity.status === "unavailable" ? "Activity isn’t available here. Delivery and results stay in native chat." : "No agent activity has been reported here yet."}</p>}
          {local.slice(-8).reverse().map(work => <div className="meeting-agent-work" key={`${work.agent}:${work.messageId}`}><div><strong>{name(work.agent)}</strong><span className="text-caption text-subtle">{work.state === "working" ? work.evidence === null ? "Starting…" : "Working" : work.state === "done" ? "Turn finished · see chat for results" : work.state === "waiting" ? "Waiting in runner" : work.state === "stopped" ? "Stopped" : work.state === "error" ? "Task failed" : "Superseded"}</span>{work.step && <span className="text-caption text-metadata">{work.step.tool}</span>}{work.error && <span className="text-caption text-danger">{work.error}</span>}</div><Action onClick={() => open(undefined, work.messageId)}>View task</Action>{work.stoppable && ["waiting", "working"].includes(work.state) && <Action disabled={busy || !session.agentActivity?.interrupt} onClick={() => { void stop(work); }}>Stop task</Action>}</div>)}
          {remote.slice(-8).reverse().map(turn => <p key={`${turn.agent}:${turn.turnId}`} className="text-caption text-subtle">{name(turn.agent)} · {turn.state === "working" ? "Working (reported)" : turn.state === "ended" ? "Turn ended · see chat" : "Status unknown"}</p>)}
        </div>
      </>}
    </section>;
  };
}
