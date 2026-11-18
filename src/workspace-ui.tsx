import type { LiveAgents } from "./live-agents";
import type { makeRoomSession } from "./room";
import type { MeetingTranscription, RetainedTranscript } from "./meeting-transcription";
import { covers, type MeetingRecords } from "./meeting-records";
import type * as ReactRuntime from "react";
import { meetingAgents, type ConversationTarget } from "./agents-ui";
import { makeWorkspaces, readable, writable, uuid, type Channel, type Storage, type WorkspaceConnection, type Workspaces, type WorkspaceState } from "./workspaces";
import { meetingService, type MeetingService, type Presence } from "./workspace-voice";
import { communityBroker, pluginId } from "./protocol";

export type PageNavigation = { target: { route?: { params?: unknown }; params?: Readonly<Record<string, string>>; scope?: { viewer: string; communityOrigin: string } | null } };
export type ConversationProps = { id: string; session: WorkspaceConnection["session"]; scope: string; target: { channelId: string }; label: string; actions?: readonly { label: string; run(): void }[] };
export type PanelContribution = { id: string; pluginId: string; revision: string; component: ReactRuntime.ComponentType<{ target: string; close(): void; channelContext: { scope: string; channelId: string; channelName: string; viewer: string; relayUrl: string } }> };
export type WorkspaceContext = {
  react: typeof ReactRuntime; artifactStorage: Storage;
  relay: { snapshot(): WorkspaceConnection; subscribe(listener: () => void): () => void };
  effect(setup: () => () => void): void;
  navigation: { open(target: ConversationTarget | { version: 1; kind: "settings"; section: string } | { version: 1; kind: "page"; pluginId: string; pageId: string; scope: { viewer: string; communityOrigin: string }; route: { version: 1; params: { workspace: string } } }): Promise<unknown> };
  conversation: { ui: { Workspace?: ReactRuntime.ComponentType<ConversationProps> } };
  panels: { snapshot?(): readonly PanelContribution[]; subscribe?(listener: () => void): () => void };
  settingsCards: { register(card: { id: string; title: string; component: ReactRuntime.ComponentType }): void };
};
export const validWorkspaceRoute = (params: unknown) => !!params && typeof params === "object" && !Array.isArray(params) && Object.keys(params).length === 1 && uuid((params as { workspace?: unknown }).workspace);
const empty: WorkspaceState = { workspaces: [], busy: "", error: "", pending: [], loading: true };
const noPanels: readonly PanelContribution[] = [];

export function workspaceUI(ctx: WorkspaceContext, liveAgents?: LiveAgents, media?: ReturnType<typeof makeRoomSession>, voice?: { broker(): string; join(channel: Channel): Promise<void>; startTranscript(): void; Transcript: ReactRuntime.ComponentType<{ roomName: string; close(): void; review?: RetainedTranscript }>; Call: ReactRuntime.ComponentType; Roster: ReactRuntime.ComponentType; Records: ReactRuntime.ComponentType<{ channelId: string }>; transcript?: MeetingTranscription; records?: MeetingRecords;
  /** Temporary (name-based) meetings saved on this device; listed in the same Meetings list. */
  temporary?: { Rows: ReactRuntime.ComponentType; count(): number; add(name: string): string; manage(): void };
  /** Pre-join: who is in this workspace's call, read without joining. */
  presence?(channel: Channel, signal: AbortSignal): Promise<Presence>;
  AudioCheck?: ReactRuntime.ComponentType }) {
  const React = ctx.react;
  const Agents = meetingAgents(ctx, liveAgents, media);
  const { useEffect, useState, useSyncExternalStore } = React;
  let controller: Workspaces | undefined, connection = ctx.relay.snapshot(), stopController = () => {};
  let state = empty, problem = "", proposed = "";
  const listeners = new Set<() => void>();
  const emit = () => { state = controller?.snapshot() ?? { ...empty, loading: false, error: problem }; for (const listener of listeners) listener(); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const useStateSnapshot = () => useSyncExternalStore(subscribe, () => state);
  function rebind() {
    const next = ctx.relay.snapshot();
    if (controller && next.session === connection.session && next.viewer === connection.viewer && next.origin === connection.origin) { connection = next; void controller.refresh(); return; }
    stopController(); controller?.dispose(); controller = undefined; connection = next; problem = "";
    if (next.viewer && next.origin && next.scope) {
      try { controller = makeWorkspaces(next, ctx.artifactStorage, ctx.relay.snapshot); stopController = controller.subscribe(emit); }
      catch { problem = "Shared workspaces aren’t available on this connection. Reconnect to your community."; }
    } else problem = "Connect to a community to open shared workspaces.";
    emit();
  }
  ctx.effect(() => {
    rebind(); const stop = ctx.relay.subscribe(rebind);
    return () => { stop(); stopController(); controller?.dispose(); controller = undefined; };
  });
  function manage(id = "") {
    proposed = id;
    void ctx.navigation.open({ version: 1, kind: "settings", section: `${pluginId}/workspaces` });
  }
  let viewRequest: { id:string; view:"agents" | "transcript" | "call"; sequence:number } | undefined;
  function open(id: string, view?: "agents" | "transcript" | "call") {
    if (view) { viewRequest={id,view,sequence:(viewRequest?.sequence ?? 0)+1}; state={...state}; for (const listener of listeners) listener(); }
    const current = ctx.relay.snapshot();
    if (!current.viewer || !current.origin) return;
    controller?.select(id);
    void ctx.navigation.open({ version: 1, kind: "page", pluginId, pageId: "meeting", scope: { viewer: current.viewer, communityOrigin: current.origin }, route: { version: 1, params: { workspace: id } } });
  }
  function Action({ children, ...props }: ReactRuntime.ButtonHTMLAttributes<HTMLButtonElement>) {
    return <button {...props} type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" data-disabled={props.disabled || undefined}><span className="buzz-button-label">{children}</span></button>;
  }
  function CreateMeeting() {
    const saved=useStateSnapshot(), id=React.useId(), trigger=React.useRef<HTMLButtonElement>(null), dialog=React.useRef<HTMLDivElement>(null), nameInput=React.useRef<HTMLInputElement>(null);
    const [name,setName]=useState(""), [temporaryError,setTemporaryError]=useState("");
    function addTemporary() {
      const problem = voice?.temporary?.add(name) ?? "";
      setTemporaryError(problem);
      if (!problem) { dialog.current?.hidePopover(); setName(""); }
    }
    async function create(event: ReactRuntime.FormEvent) {
      event.preventDefault(); const owner=controller;
      if (!owner || saved.busy || !name.trim()) return;
      await owner.create(name,"private");
      if (controller !== owner) return;
      const result=owner.snapshot();
      if (!result.error && !result.creation && result.selected) { dialog.current?.hidePopover(); setName(""); open(result.selected); }
    }
    function position() {
      const anchor=trigger.current?.getBoundingClientRect(), element=dialog.current; if (!anchor || !element) return;
      element.style.left=`${Math.max(12,Math.min(innerWidth-352,anchor.left))}px`;
      element.style.top=`${Math.max(12,Math.min(innerHeight-280,anchor.bottom+8))}px`;
      element.style.maxHeight=`${innerHeight-36}px`;
    }
    function dismiss() { dialog.current?.hidePopover(); trigger.current?.focus(); }
    useEffect(() => {
      const element=dialog.current; if (!element) return;
      const focusName=()=>{if(element.matches(":popover-open")) nameInput.current?.focus();};
      element.addEventListener("toggle",focusName); return ()=>element.removeEventListener("toggle",focusName);
    },[]);
    useEffect(() => { setName(""); dialog.current?.hidePopover(); },[connection.scope]);
    return <><button ref={trigger} type="button" className="buzz-button" data-buzz-ui="" data-button-shape="icon" data-icon-size="sm" data-icon-shape="control" data-icon-variant="ghost" aria-label="Create meeting" title="Create meeting" popoverTarget={id} onClick={position}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
      <div ref={dialog} id={id} popover="auto" className="meeting-create-dialog text-body-sm" role="dialog" aria-label="Create meeting" data-buzz-ui="" onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();dismiss();}}}>
        <form onSubmit={event=>{void create(event);}}>
          <header><h3 className="text-body-sm">Create meeting</h3><button type="button" className="buzz-button" data-buzz-ui="" onClick={dismiss} aria-label="Close create meeting">×</button></header>
          <label>Meeting name<input ref={nameInput} className="buzz-input" value={name} maxLength={64} disabled={!!saved.busy} onChange={event=>{setName(event.target.value);setTemporaryError("");}} /></label>
          <p className="text-caption text-subtle">Private by default. Invite people through its channel when you’re ready.</p>
          <button type="submit" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="prominent" disabled={!!saved.busy || !!saved.creation || !name.trim()}>{saved.busy || "Create meeting"}</button>
          {voice?.temporary && <><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="subtle" disabled={!name.trim()} onClick={addTemporary}>Add temporary meeting</button><p className="text-caption text-subtle">A temporary meeting is voice only and saved on this device. Others join it by its name.</p></>}
          {temporaryError && <p role="alert" className="text-danger">{temporaryError}</p>}
          {saved.error && <p role="alert" className="text-danger">{saved.error}</p>}{saved.creation && <p className="text-caption text-subtle">A previous creation needs checking in meeting settings.</p>}
          <Action onClick={()=>{dialog.current?.hidePopover();manage();}}>Link an existing channel or change settings</Action>
          {voice?.temporary && <Action onClick={()=>{dialog.current?.hidePopover();voice.temporary!.manage();}}>Manage temporary meetings</Action>}
        </form>
      </div>
    </>;
  }
  function Sidebar() {
    const current = useStateSnapshot();
    const call = useSyncExternalStore(media?.subscribe ?? subscribe, media?.snapshot ?? (() => undefined));
    // One list: shared workspaces first, then this device's temporary meetings.
    return <nav className="navigation-section meeting-workspace-navigation" aria-label="Meetings">
      <header className="navigation-section-heading"><h2 className="navigation-section-heading-label text-caption text-metadata">Meetings</h2><span className="navigation-section-heading-actions"><Action aria-label="Manage workspaces" onClick={() => manage()}>⋯</Action><CreateMeeting /></span></header>
      {current.workspaces.map(channel => <React.Fragment key={channel.id}><button key={channel.id} className="navigation-item" data-buzz-ui="" data-variant="row" data-selected={current.selected === channel.id || undefined} aria-current={current.selected === channel.id ? "page" : undefined} type="button" onClick={() => open(channel.id)}><span className="navigation-item-label">{channel.name}</span></button>{voice && call?.workspaceChannelId === channel.id && call.phase !== "idle" && <voice.Roster />}</React.Fragment>)}
      {voice?.temporary && <voice.temporary.Rows />}
      {!current.workspaces.length && !voice?.temporary?.count() && <p className="meeting-workspace-hint text-caption text-metadata">{current.loading ? "Loading workspaces…" : "Create a meeting to keep voice, chat and notes together."}</p>}
      {current.pending.length > 0 && <Action onClick={() => manage()}>Review {current.pending.length} saved {current.pending.length === 1 ? "link" : "links"}</Action>}
      {(current.error || current.syncError) && <p className="meeting-workspace-hint text-caption text-danger" role="status">{current.error || current.syncError}</p>}
    </nav>;
  }
  function Management() {
    const saved = useStateSnapshot();
    const live = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const [draft, setDraft] = useState(""), [visibility, setVisibility] = useState<"private" | "open">("private");
    const [chosen, setChosen] = useState(proposed), [editing, setEditing] = useState<{ id: string; name: string }>();
    const [reviewedCreation, setReviewedCreation] = useState(false);
    const channels = live.session.channels?.list().channels.filter(channel => writable(channel, live.viewer) && !channel.ttlSeconds) ?? [];
    const selected = channels.find(channel => channel.id === chosen);
    const disabled = !!saved.busy || live.status !== "ready";
    useEffect(() => { setChosen(proposed); setEditing(undefined); setDraft(""); }, [live.scope, live.session]);
    return <div className="meeting-workspace-settings text-body-sm" data-buzz-ui="">
      <p className="text-subtle">A workspace keeps a permanent Buzz channel’s conversation, notes and files together. Everyone with channel access can reopen it in Meetings.</p>
      <div className="buzz-settings-group meeting-workspace-form"><h3 className="text-body-sm">Link an existing channel</h3><label>Channel<select className="buzz-input" aria-label="Workspace channel" value={chosen} disabled={disabled} onChange={event => setChosen(event.target.value)}><option value="">Choose a joined permanent channel…</option>{channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}{channel.visibility === "private" ? " · Private" : channel.visibility === "public" ? " · Open" : ""}</option>)}</select></label>
        {selected && <p className="text-caption text-metadata">{selected.visibility === "private" ? "This private channel stays private." : selected.visibility === "public" ? "This open channel is discoverable by your community." : "The channel keeps its current visibility and membership."} Linking preserves its messages, notes and members.</p>}
        <Action disabled={disabled || !selected} onClick={() => { if (selected) void controller?.link(selected.id); }}>Link workspace</Action>
      </div>
      <form className="buzz-settings-group meeting-workspace-form" onSubmit={event => { event.preventDefault(); if (!saved.creation) void controller?.create(draft, visibility); }}><h3 className="text-body-sm">Create a workspace</h3><label>Workspace name<input className="buzz-input" value={draft} maxLength={64} disabled={disabled || !!saved.creation} onChange={event => setDraft(event.target.value)} /></label><label>Visibility<select className="buzz-input" value={visibility} disabled={disabled || !!saved.creation} onChange={event => setVisibility(event.target.value as "private" | "open")}><option value="private">Private</option><option value="open">Open to the community</option></select></label>
        <p className="text-caption text-metadata">{visibility === "private" ? "Only channel members can open this workspace. Invite people through its native channel controls." : "Anyone in this community can discover the channel and join it."} The channel will not expire.</p><Action disabled={disabled || !!saved.creation || !draft.trim()} onClick={() => { void controller?.create(draft, visibility); }}>Create workspace</Action>
      </form>
      {saved.busy && <p role="status">{saved.busy}</p>}{saved.error && <p className="text-danger" role="alert">{saved.error}</p>}
      {saved.syncError && <p role="status">{saved.syncError}</p>}
      {saved.creation && <div className="buzz-settings-group meeting-workspace-form"><h3 className="text-body-sm">Finish creating {saved.creation.name}</h3><p>{saved.creation.channelId ? "The channel was created. Finish linking that same channel to Meetings." : "Channel creation was interrupted. Check Channels and Outbox before trying again. If the channel exists, choose it above and link it."}</p>{saved.creation.channelId ? <Action disabled={disabled} onClick={() => { void controller?.finishCreation(); }}>Finish workspace link</Action> : <><label><input type="checkbox" checked={reviewedCreation} onChange={event => setReviewedCreation(event.target.checked)} />I checked the existing channels and Outbox.</label><Action disabled={disabled || !reviewedCreation} onClick={() => { void controller?.dismissCreation(); setReviewedCreation(false); }}>Clear reviewed creation</Action></>}</div>}
      {!!saved.pending.length && <div className="buzz-settings-group meeting-workspace-form"><h3 className="text-body-sm">Unconfirmed links</h3><p>A saved link may have reached the relay. Checking only reads its status. Retrying sends the same signed operation.</p>{saved.pending.map(pending => <div key={pending.event.id} className="meeting-workspace-pending"><span>{live.session.channels?.list().channels.find(channel => channel.id === pending.channelId)?.name ?? "Unavailable channel"}</span><Action disabled={disabled} onClick={() => { void controller?.check(pending.channelId); }}>Check saved link</Action><Action disabled={disabled || !writable(live.session.channels?.list().channels.find(channel => channel.id === pending.channelId), live.viewer)} onClick={() => { void controller?.retry(pending.channelId); }}>Retry saved link</Action></div>)}</div>}
      <div className="buzz-settings-group meeting-workspace-form"><h3 className="text-body-sm">Saved workspaces</h3>{!saved.workspaces.length && <p className="text-subtle">Shared workspaces appear here as Buzz synchronizes. Your device’s voice shortcuts are preserved separately.</p>}{saved.workspaces.map(channel => <div key={channel.id} className="meeting-workspace-row">{editing?.id === channel.id ? <form onSubmit={event => { event.preventDefault(); void controller?.rename(channel.id, editing.name); }}><label>New workspace name<input className="buzz-input" value={editing.name} maxLength={64} disabled={disabled} onChange={event => setEditing({ id: channel.id, name: event.target.value })} /></label><div className="meeting-setting-actions"><Action disabled={disabled} onClick={() => setEditing(undefined)}>Close rename</Action><Action disabled={disabled} onClick={() => { void controller?.rename(channel.id, editing.name); }}>Save workspace name</Action></div></form> : <><Action onClick={() => open(channel.id)}>{channel.name}</Action>{["owner", "admin"].includes(channel.viewerRole ?? "") && <Action disabled={disabled} aria-label={`Rename workspace ${channel.name}`} onClick={() => setEditing({ id: channel.id, name: channel.name })}>Rename</Action>}</>}{live.session.channelDetails?.snapshot(channel.id)?.status === "unconfirmed" && <Action disabled={disabled} onClick={() => { void controller?.checkRename(channel.id); }}>Check name change</Action>}</div>)}</div>
    </div>;
  }
  function Content({ navigation, children }: { navigation?: PageNavigation; children?: ReactRuntime.ReactNode }) {
    const saved = useStateSnapshot();
    const live = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const panels = useSyncExternalStore(ctx.panels.subscribe ?? subscribe, ctx.panels.snapshot ?? (() => noPanels));
    const call = useSyncExternalStore(media?.subscribe ?? subscribe, media?.snapshot ?? (() => undefined));
    const [surface, setSurface] = useState<"overview" | "notes" | "chat" | "agents" | "call" | "transcript" | "review" | "records">("overview");
    const [presence, setPresence] = useState<{ value?: Presence; error?: string }>({}), [now, setNow] = useState(Date.now());
    const [service, setService] = useState<MeetingService>(), [voiceError, setVoiceError] = useState(""), [joining, setJoining] = useState(false);
    const params = navigation?.target.route?.params ?? navigation?.target.params;
    const route = validWorkspaceRoute(params) ? (params as { workspace: string }).workspace : undefined;
    const routeScope = navigation?.target.scope;
    const sameScope = !routeScope || (routeScope.viewer === live.viewer && routeScope.communityOrigin === live.origin);
    useEffect(() => { if (route && sameScope) controller?.select(route); }, [route, sameScope, live.session]);
    const id = route ?? saved.selected;
    const channel = live.session.channels?.list().channels.find(channel => channel.id === id);
    const workspace = saved.workspaces.find(channel => channel.id === id);
    const access = sameScope && live.status === "ready" && readable(channel, live.viewer) && !!workspace;
    const inCall = !!call && call.workspaceChannelId === id && call.phase !== "idle";
    // A transcript outlives its call until it is saved or discarded, bound to its original channel.
    const captured = useSyncExternalStore(voice?.transcript?.subscribe ?? subscribe, voice?.transcript?.snapshot ?? (() => undefined));
    const archived = useSyncExternalStore(voice?.records?.subscribe ?? subscribe, voice?.records?.snapshot ?? (() => undefined));
    // Transcripts awaiting Save or Discard: this channel's ended call, then earlier joins kept on rejoin.
    const currentEnded = !inCall && !!captured && captured.channelId === id && captured.segments.length > 0 && !["starting", "transcribing", "reconnecting"].includes(captured.phase);
    const pending: RetainedTranscript[] = captured ? [...(currentEnded ? [{ ...captured, phase: "ended", error: "", retained: [] } as RetainedTranscript] : []), ...captured.retained.filter(item => item.channelId === id)] : [];
    const item = pending[0];
    const itemIsCurrent = currentEnded && item?.joinId === captured?.joinId;
    const itemSaved = !!item && !!archived?.records.some(record => covers(record.value, id, item));
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    useEffect(() => setConfirmDiscard(false), [item?.joinId, itemSaved]);
    function discard() { if (itemSaved || confirmDiscard) { voice?.transcript?.discard(item?.joinId); if (surface === "review") setSurface(inCall ? "call" : "notes"); } else setConfirmDiscard(true); }
    const reviewing = (surface === "review" || (surface === "transcript" && !inCall)) && !!item;
    useEffect(() => {
      setService(undefined); setVoiceError("");
      const abort = new AbortController();
      if (voice && access && voice.broker() === communityBroker(live.origin)) void meetingService(voice.broker(), abort.signal).then(setService).catch(problem => { if (!abort.signal.aborted) setVoiceError(problem.message); });
      return () => abort.abort();
    }, [live.session, id, access]);
    useEffect(() => { if (inCall) setSurface("call"); }, [inCall]);
    useEffect(() => { if (viewRequest && viewRequest.id === id) setSurface(viewRequest.view); }, [id,viewRequest?.sequence]);
    // Overview polls presence while visible and out of the call; in the call the roster is live.
    useEffect(() => {
      setPresence({});
      if (surface !== "overview" || !access || inCall || !voice?.presence || !channel || !service?.workspaceVoice || service.community !== live.origin || !service.identity || !channel.members?.includes(service.identity)) return;
      const abort = new AbortController();
      // Each check signs an admission proof: only poll while this window is visible and focused.
      const shown = () => document.visibilityState === "visible" && document.hasFocus();
      const check = () => { if (shown()) poll(); };
      const poll = () => void voice.presence!(channel, abort.signal).then(value => { if (!abort.signal.aborted) setPresence({ value }); }).catch(problem => { if (!abort.signal.aborted) setPresence(previous => ({ ...previous, error: problem instanceof Error ? problem.message : "Couldn’t check who is in the call." })); });
      poll(); const timer = setInterval(check, 20000);
      addEventListener("focus", check); document.addEventListener("visibilitychange", check);
      return () => { abort.abort(); clearInterval(timer); removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
    }, [surface, access, inCall, channel?.id, service, live.session]);
    useEffect(() => { if (surface !== "overview") return; const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, [surface]);
    const enabled = !!service?.workspaceVoice && service.community === live.origin && !!service.identity && !!channel?.members?.includes(service.identity);
    const canEnable = !!live.session.memberAdditions && ["owner","admin"].includes(channel?.viewerRole ?? "");
    async function joinVoice() {
      if (!voice || !channel || joining) return;
      const previous=surface;
      setJoining(true); setVoiceError("");
      try {
        if (!enabled) {
          if (!service?.identity || service.community !== live.origin || !service.workspaceVoice || !live.session.memberAdditions) throw new Error("Workspace voice is unavailable on this service.");
          await live.session.memberAdditions.add(channel.id, service.identity, { role: "guest" });
        }
        if (ctx.relay.snapshot().session !== live.session) return;
        await voice.join(channel);
        const activeCall=media?.snapshot();
        setSurface(activeCall?.workspaceChannelId === channel.id && activeCall.phase !== "idle" ? "call" : previous);
      } catch (problem) { setSurface(previous); setVoiceError(problem instanceof Error ? problem.message : "Couldn’t join workspace voice."); }
      finally { setJoining(false); }
    }
    const Canvas = panels.find(panel => panel.id === "canvas" && panel.pluginId === "buzz.channels")?.component;
    const ago = (time: number) => { const seconds = Math.max(0, Math.round((now - time) / 1000)); return seconds < 10 ? "just now" : seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`; };
    // Screen 1: who is in the call (with freshness), agents and their role, the agenda, and the audio check.
    // Rendered by call (not as a component) so the embedded Canvas keeps its state across ticks.
    function overview() {
      const people = inCall ? call!.participants.map(person => ({ name: `${person.name}${person.local ? " (you)" : ""}`, sharing: call!.streams.some(stream => stream.presenterId === person.id) || (person.local && !!call!.sharing), transcribing: person.transcribing, agents: (person.listeners ?? []).map(agent => ({ name: agent.name, mode: undefined as "act" | "assist" | undefined })) })) : presence.value?.participants ?? [];
      const agents = [...new Map(people.flatMap(person => person.agents.map(agent => [agent.name, { ...agent, owner: person.name }] as const))).values()];
      const transcribing = people.some(person => person.transcribing) || (inCall && !!call!.transcriptActive);
      const started = !inCall && presence.value?.startedAt;
      const latest = archived?.records.filter(record => record.value.channelId === id)[0];
      return <div className="meeting-overview">
        <div className="meeting-overview-main">
          <h3 className="text-heading">{inCall ? "You’re in this call" : people.length ? "A call is in progress" : "No one is in the call"}</h3>
          <p className="text-subtle" role="status">{inCall ? `${people.length} in the call` : presence.value ? `${started ? `Started ${ago(started)} · ` : ""}updated ${ago(presence.value.checkedAt)}` : presence.error ? presence.error : enabled ? "Checking who is here…" : "Turn on voice for this workspace to see who is in the call."}</p>
          {people.length > 0 && <section aria-label="In the call"><h4 className="text-caption text-metadata">In the call</h4><ul className="meeting-overview-people">{people.map((person, index) => <li key={`${person.name}:${index}`}><span className="meeting-avatar" aria-hidden="true">{person.name.slice(0, 1).toLocaleUpperCase()}</span><div><strong>{person.name}</strong><span className="text-caption text-subtle">{person.sharing ? "Sharing their screen" : "In the call"}</span></div></li>)}
            {agents.map(agent => <li key={`agent:${agent.name}`} data-agent=""><span className="meeting-avatar" aria-hidden="true">✦</span><div><strong>{agent.name}</strong> <span className="meeting-agent-badge text-caption">Agent · {agent.owner.replace(" (you)", "")}’s</span><span className="text-caption text-subtle">Listening · {agent.mode === "act" ? "can create and carry out tasks" : "takes notes and proposes tasks"}</span></div></li>)}</ul></section>}
          <section aria-label="Agenda" className="meeting-overview-agenda"><h4 className="text-caption text-metadata">Agenda · from shared notes</h4>{Canvas && live.viewer && live.origin && live.scope ? <Canvas target="" close={() => setSurface("chat")} channelContext={{ scope: live.scope, channelId: channel!.id, channelName: channel!.name, viewer: live.viewer, relayUrl: live.origin }} /> : <p className="text-subtle">Turn on Channels to keep an agenda in shared notes.</p>}</section>
          {latest && <section aria-label="From the last meeting"><h4 className="text-caption text-metadata">From the last meeting</h4><Action onClick={() => setSurface("records")}>{latest.value.title} · {new Date(latest.value.capturedAt).toLocaleDateString()}</Action></section>}
        </div>
        {voice && !inCall && <aside className="meeting-overview-join" aria-label="Ready to join"><h4 className="text-body-sm">Ready to join?</h4>
          {voice.AudioCheck && <voice.AudioCheck />}
          <button type="button" className="buzz-button" data-buzz-ui="" data-variant="prominent" disabled={joining || !service?.workspaceVoice || service.community !== live.origin || (!enabled && !canEnable)} onClick={() => { void joinVoice(); }}>{joining ? "Joining…" : !service?.workspaceVoice ? "Voice unavailable" : enabled ? "Join voice" : "Enable voice & join"}</button>
          <p className="text-caption text-subtle">{transcribing ? "This call is being transcribed. The transcript is saved only if someone chooses to save it." : "Opening this workspace never turns on your microphone."}</p>
        </aside>}
      </div>;
    }
    const Conversation = ctx.conversation.ui.Workspace;
    return <section className="meeting-page meeting-workspace-page text-body" data-buzz-ui="" aria-label="Persistent workspace">
      <header className="panel-header"><div className="panel-header-title"><div className="panel-header-label"><h2>{access ? channel!.name : "Workspace"}</h2><span className="text-caption text-metadata">{access && !writable(channel, live.viewer) ? "Read only" : "Shared workspace"}</span></div></div><div className="panel-header-actions">{access && voice && !inCall && surface !== "overview" && <Action disabled={joining || !service?.workspaceVoice || service.community !== live.origin || (!enabled && !canEnable)} onClick={() => { void joinVoice(); }}>{joining ? "Joining…" : !service?.workspaceVoice ? "Voice unavailable" : enabled ? "Join voice" : "Enable voice & join"}</Action>}<Action onClick={() => manage(access ? id : "")}>Workspace settings</Action></div></header>
      {!access ? <div className="meeting-workspace-unavailable" role="status"><p>{live.status !== "ready" ? "Reconnect to load this workspace. Saved content cannot establish current channel access." : saved.loading ? "Loading the saved workspace…" : "This workspace is unavailable. It may still be synchronizing, archived, removed, or outside your current channel access."}</p><Action onClick={() => { void controller?.refresh(); }}>Check workspace</Action></div> : <>
        {voiceError && <p role="alert" className="meeting-transcript-notice text-danger">{voiceError}</p>}
        {service && !service.workspaceVoice && <p className="meeting-workspace-footnote text-caption text-metadata">Workspace voice needs to be enabled on your meeting service.</p>}
        {service?.workspaceVoice && !enabled && <p className="meeting-workspace-footnote text-caption text-metadata">{!canEnable && "A channel owner or admin needs to enable voice. "}Enabling voice adds the Meetings service to this channel as a guest. It can verify members and transcribe the call, with access to channel history and files.</p>}
        {inCall && call?.error && <p role="alert" className="text-danger">{call.error}</p>}
        {item && <div className="meeting-ended-call" role="group" aria-label="Ended call"><p role="status" className="text-body-sm">{!itemIsCurrent ? (itemSaved ? "An earlier call’s transcript is saved in Meeting records." : "An earlier call’s transcript isn’t saved yet.") : itemSaved ? "This call’s transcript is saved in Meeting records." : "The call ended. Its transcript isn’t saved yet."}{pending.length > 1 && ` ${pending.length - 1} more after this one.`}</p><div className="meeting-ended-call-actions">{!itemSaved && <Action onClick={() => setSurface("review")}>Review and save</Action>}<Action onClick={discard}>{itemSaved ? "Close transcript" : confirmDiscard ? "Confirm discard" : "Discard"}</Action></div></div>}
        <div className="meeting-workspace-tabs" role="group" aria-label="Workspace views">{inCall && <><Action aria-pressed={surface === "call"} onClick={() => setSurface("call")}>Voice</Action><Action aria-pressed={surface === "transcript"} onClick={() => { setSurface("transcript"); voice?.startTranscript(); }}>Transcript</Action></>}{item && <Action aria-pressed={reviewing} onClick={() => setSurface("review")}>{inCall ? "Earlier transcript" : "Transcript"}</Action>}<Action aria-pressed={surface === "overview"} onClick={() => setSurface("overview")}>Overview</Action><Action aria-pressed={surface === "notes"} onClick={() => setSurface("notes")}>Notes</Action><Action aria-pressed={surface === "chat"} onClick={() => setSurface("chat")}>Chat & files</Action><Action aria-pressed={surface === "agents"} onClick={() => setSurface("agents")}>Agents</Action>{voice && <Action aria-pressed={surface === "records"} onClick={() => setSurface("records")}>Meeting records</Action>}</div>
        <div className="meeting-workspace-surface" key={`${live.scope}:${id}`}>
          {surface === "records" && voice ? <voice.Records channelId={channel!.id} /> : surface === "call" && voice && inCall ? <voice.Call /> : reviewing && voice ? <voice.Transcript key={item.joinId} review={item} roomName={item.roomName ?? channel!.name} close={() => setSurface(inCall ? "call" : "notes")} /> : surface === "transcript" && voice && inCall ? <voice.Transcript roomName={call!.roomName!} close={() => setSurface("call")} /> : surface === "agents" ? <Agents channelId={channel!.id} roomName={inCall ? call!.roomName : undefined} /> : surface === "overview" ? overview() : surface === "notes" ? Canvas && live.viewer && live.origin && live.scope ? <Canvas target="" close={() => setSurface("chat")} channelContext={{ scope: live.scope, channelId: channel!.id, channelName: channel!.name, viewer: live.viewer, relayUrl: live.origin }} /> : <p>Turn on Channels to use shared Canvas notes here.</p>
            : Conversation && live.scope ? <Conversation id={`meetings-workspace-${channel!.id}`} session={live.session} scope={live.scope} target={{ channelId: channel!.id }} label={channel!.name} /> : <p>Turn on Channels to use this workspace’s conversation and files.</p>}
        </div><p className="meeting-workspace-footnote text-caption text-metadata">Chat, notes and task results stay with this channel after the call.</p>
      </>}{inCall && surface === "call" ? null : children}
    </section>;
  }
  ctx.settingsCards.register({ id: "workspaces", title: "Meeting workspaces", component: Management });
  return { Agents, Sidebar, Content, useState: useStateSnapshot, manage, open, clear: () => controller?.select(), validRoute: validWorkspaceRoute };
}
