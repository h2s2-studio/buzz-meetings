import type { LiveAgents } from "./live-agents";
import type { makeRoomSession } from "./room";
import type { MeetingTranscription, RetainedTranscript } from "./meeting-transcription";
import { covers, type MeetingRecords } from "./meeting-records";
import type * as ReactRuntime from "react";
import { meetingAgents, type ConversationTarget } from "./agents-ui";
import { makeWorkspaces, readable, writable, uuid, type Channel, type Storage, type WorkspaceConnection, type Workspaces, type WorkspaceState } from "./workspaces";
import { meetingService, type MeetingService } from "./workspace-voice";
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
  temporary?: { Rows: ReactRuntime.ComponentType; count(): number; add(name: string): string; manage(): void } }) {
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
    const [surface, setSurface] = useState<"notes" | "chat" | "agents" | "call" | "transcript" | "review" | "records">("notes");
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
    const Conversation = ctx.conversation.ui.Workspace;
    return <section className="meeting-page meeting-workspace-page text-body" data-buzz-ui="" aria-label="Persistent workspace">
      <header className="panel-header"><div className="panel-header-title"><div className="panel-header-label"><h2>{access ? channel!.name : "Workspace"}</h2><span className="text-caption text-metadata">{access && !writable(channel, live.viewer) ? "Read only" : "Shared workspace"}</span></div></div><div className="panel-header-actions">{access && voice && !inCall && <Action disabled={joining || !service?.workspaceVoice || service.community !== live.origin || (!enabled && !canEnable)} onClick={() => { void joinVoice(); }}>{joining ? "Joining…" : !service?.workspaceVoice ? "Voice unavailable" : enabled ? "Join voice" : "Enable voice & join"}</Action>}<Action onClick={() => manage(access ? id : "")}>Workspace settings</Action></div></header>
      {!access ? <div className="meeting-workspace-unavailable" role="status"><p>{live.status !== "ready" ? "Reconnect to load this workspace. Saved content cannot establish current channel access." : saved.loading ? "Loading the saved workspace…" : "This workspace is unavailable. It may still be synchronizing, archived, removed, or outside your current channel access."}</p><Action onClick={() => { void controller?.refresh(); }}>Check workspace</Action></div> : <>
        {voiceError && <p role="alert" className="meeting-transcript-notice text-danger">{voiceError}</p>}
        {service && !service.workspaceVoice && <p className="meeting-workspace-footnote text-caption text-metadata">Workspace voice needs to be enabled on your meeting service.</p>}
        {service?.workspaceVoice && !enabled && <p className="meeting-workspace-footnote text-caption text-metadata">{!canEnable && "A channel owner or admin needs to enable voice. "}Enabling voice adds the Meetings service to this channel as a guest. It can verify members and transcribe the call, with access to channel history and files.</p>}
        {inCall && call?.error && <p role="alert" className="text-danger">{call.error}</p>}
        {item && <div className="meeting-ended-call" role="group" aria-label="Ended call"><p role="status" className="text-body-sm">{!itemIsCurrent ? (itemSaved ? "An earlier call’s transcript is saved in Meeting records." : "An earlier call’s transcript isn’t saved yet.") : itemSaved ? "This call’s transcript is saved in Meeting records." : "The call ended. Its transcript isn’t saved yet."}{pending.length > 1 && ` ${pending.length - 1} more after this one.`}</p><div className="meeting-ended-call-actions">{!itemSaved && <Action onClick={() => setSurface("review")}>Review and save</Action>}<Action onClick={discard}>{itemSaved ? "Close transcript" : confirmDiscard ? "Confirm discard" : "Discard"}</Action></div></div>}
        <div className="meeting-workspace-tabs" role="group" aria-label="Workspace views">{inCall && <><Action aria-pressed={surface === "call"} onClick={() => setSurface("call")}>Voice</Action><Action aria-pressed={surface === "transcript"} onClick={() => { setSurface("transcript"); voice?.startTranscript(); }}>Transcript</Action></>}{item && <Action aria-pressed={reviewing} onClick={() => setSurface("review")}>{inCall ? "Earlier transcript" : "Transcript"}</Action>}<Action aria-pressed={surface === "notes"} onClick={() => setSurface("notes")}>Notes</Action><Action aria-pressed={surface === "chat"} onClick={() => setSurface("chat")}>Chat & files</Action><Action aria-pressed={surface === "agents"} onClick={() => setSurface("agents")}>Agents</Action>{voice && <Action aria-pressed={surface === "records"} onClick={() => setSurface("records")}>Meeting records</Action>}</div>
        <div className="meeting-workspace-surface" key={`${live.scope}:${id}`}>
          {surface === "records" && voice ? <voice.Records channelId={channel!.id} /> : surface === "call" && voice && inCall ? <voice.Call /> : reviewing && voice ? <voice.Transcript key={item.joinId} review={item} roomName={item.roomName ?? channel!.name} close={() => setSurface(inCall ? "call" : "notes")} /> : surface === "transcript" && voice && inCall ? <voice.Transcript roomName={call!.roomName!} close={() => setSurface("call")} /> : surface === "agents" ? <Agents channelId={channel!.id} roomName={inCall ? call!.roomName : undefined} /> : surface === "notes" ? Canvas && live.viewer && live.origin && live.scope ? <Canvas target="" close={() => setSurface("chat")} channelContext={{ scope: live.scope, channelId: channel!.id, channelName: channel!.name, viewer: live.viewer, relayUrl: live.origin }} /> : <p>Turn on Channels to use shared Canvas notes here.</p>
            : Conversation && live.scope ? <Conversation id={`meetings-workspace-${channel!.id}`} session={live.session} scope={live.scope} target={{ channelId: channel!.id }} label={channel!.name} /> : <p>Turn on Channels to use this workspace’s conversation and files.</p>}
        </div><p className="meeting-workspace-footnote text-caption text-metadata">Chat, notes and task results stay with this channel after the call.</p>
      </>}{inCall && surface === "call" ? null : children}
    </section>;
  }
  ctx.settingsCards.register({ id: "workspaces", title: "Meeting workspaces", component: Management });
  return { Agents, Sidebar, Content, useState: useStateSnapshot, manage, open, clear: () => controller?.select(), validRoute: validWorkspaceRoute };
}
