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
    const [liveMode, setLiveMode] = useState<"act" | "assist">("act");
    const [mission, setMission] = useState("Follow this meeting, identify agreed action items, create and carry out tasks using your available tools, and report progress and results in this channel. Ask when requirements or authorization are missing.");
    const [selected, setSelected] = useState(""), [draft, setDraft] = useState<string>(templates.agenda.text);
    const [kind, setKind] = useState<keyof typeof templates>("agenda"), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
    const channel = channels.channels.find(item => item.id === channelId);
    const access = live.status === "ready" && readable(channel, live.viewer);
    const candidates = choices.selectable.filter(agent => !agent.deleting && /^[0-9a-f]{64}$/.test(agent.pubkey));
    const agent = candidates.find(item => item.pubkey === selected);
    const member = !!agent && !!channel?.members?.includes(agent.pubkey);
    const local = activity.local?.filter(work => work.scope === live.scope && work.channelId === channelId) ?? [];
    const remote = activity.turns.filter(turn => turn.channelId === channelId && !local.some(work => work.agent === turn.agent));
    useEffect(() => { session.agentChoices?.ensure?.(true, true); return session.agentActivity?.activate?.(); }, [session]);
    useEffect(() => { setSelected(""); setNotice(""); setError(""); setDraft(templates.agenda.text); setKind("agenda"); }, [channelId, session]);
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
      <header><h3 className="text-body-sm">Work with agents</h3><Action disabled={!access} onClick={() => open("members")}>Add or manage agents</Action></header>
      {!access ? <p role="status">Reconnect and open a channel you belong to to work with its agents.</p> : <>
        <p className="text-caption text-subtle">Assign a written task, or enable a live agent for the linked voice call.</p>

          <label>Agent<select aria-label="Agent" className="buzz-input" value={selected} disabled={busy || !session.agentChoices} onChange={event => { setSelected(event.target.value); setNotice(""); }}><option value="">Choose an agent…</option>{candidates.map(item => <option key={item.pubkey} value={item.pubkey}>{item.name}{channel?.members?.includes(item.pubkey) ? "" : " · Needs channel access"}</option>)}</select></label>
          {!candidates.length && <p className="text-caption text-metadata">{choices.pending ? "Loading agents…" : "No agents are available yet. Add an existing agent through Buzz’s channel controls."}</p>}
          {agent && !member && <p className="text-caption text-subtle">Add {agent.name} using the channel’s access controls, then return here. Channel access includes its history, shared notes, and files.</p>}

        <div className="meeting-live-agent"><h4 className="text-body-sm">Live meeting agent</h4>
          {listening.phase !== "idle" && listening.channelId === channelId ? <><p role="status">{listening.phase === "starting" ? "Starting live listening…" : `${listening.agentName} is receiving speaker-attributed live speech`}</p><Action onClick={() => liveAgents?.stop()}>Stop listening</Action><p className="text-caption text-metadata">Stopping listening ends new audio input. Use Stop task below to stop work already running.</p></> : <><label>Live role<select className="buzz-input" aria-label="Live role" value={liveMode} onChange={event => setLiveMode(event.target.value as "act" | "assist")}><option value="act">Create and carry out tasks</option><option value="assist">Take notes and propose tasks</option></select></label><label>Agent mission<textarea className="buzz-input" aria-label="Agent mission" rows={4} value={mission} maxLength={4000} onChange={event => setMission(event.target.value)} /></label><Action disabled={!member || !writable(channel, live.viewer) || !liveAgents || !roomName || !call.transcription || !liveAgents.eligible(selected) || call.phase !== "connected" || call.roomName !== roomName || !mission.trim()} onClick={() => { if (agent && roomName) void liveAgents?.start({ channelId, roomName, pubkey: agent.pubkey, mode: liveMode, mission }); }}>Start live agent</Action><p className="text-caption text-metadata">{!roomName || call.phase !== "connected" ? "Join this channel’s voice room to enable live listening." : !call.transcription ? "Speech support needs to be enabled on your meeting service." : "Live listening uses one of your agents running here. Starting sends each participant’s microphone audio to your meeting service for transcription and agent context."}</p></>}
          {listening.error && <p role="alert" className="text-danger">{listening.error}</p>}
          {listening.channelId === channelId && listening.transcripts.length > 0 && <details><summary>Live transcript · {listening.transcripts.length} segments</summary><div className="meeting-transcript">{listening.transcripts.slice(-20).map((segment, index) => <p key={index}><strong>{segment.speakerName}</strong> <time className="text-caption text-metadata">{new Date(segment.startedAt).toLocaleTimeString()}</time> <span>{segment.text}</span></p>)}</div></details>}
          {listening.channelId === channelId && listening.tasks.length > 0 && <div className="meeting-agent-tasks"><h4 className="text-caption text-metadata">Meeting tasks</h4>{listening.tasks.map(task => <div key={task.key}><strong>{task.title}</strong><span className="text-caption text-subtle">{task.status} · {task.delivery}</span>{task.result && <p>{task.result}</p>}</div>)}</div>}
        </div>
        <details className="meeting-written-task"><summary>Send a written task</summary><form onSubmit={event => { void send(event); }}>
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
