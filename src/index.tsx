import { makeLiveAgents, type AgentRuntime } from "./live-agents";
import { makeMeetingTranscription } from "./meeting-transcription";
import { transcriptUI } from "./transcript-ui";
import type * as ReactRuntime from "react";
import { makeRoomSession, type RoomSnapshot } from "./room";
import { communityBroker, pluginId, socketUrl } from "./protocol";
import { presets, type Preset } from "./capture";
import { cameraPermissions } from "./permissions";
import css from "./meeting.css";
import { workspaceUI, type PageNavigation, type WorkspaceContext } from "./workspace-ui";
import type { Storage, WorkspaceSession } from "./workspaces";

type Profile = { name?: string; picture?: string };
type ChatChannel = { id: string; name: string; channelType?: string; members?: readonly string[]; huddle?: boolean; parentChannelId?: string; archived?: boolean; cached?: boolean; metadataPending?: boolean };
const emptyChannels: { channels: readonly ChatChannel[] } = { channels: [] };
type Connection = { status?: string; origin?: string; viewer?: string; scope?: string;
  session: WorkspaceSession & { profiles: { snapshot(): ReadonlyMap<string, Profile>; subscribe(listener: () => void): () => void };
    channels?: { list(): { channels: readonly ChatChannel[] }; subscribeList(listener: () => void): () => void; ensureList?(): void };
    channelCreation?: { available: boolean; create(input: { name: string; visibility: "open" }): Promise<string> };
    media?(url: string, size: "small"): string | undefined } };
type Context = {
  react: typeof ReactRuntime;
  agents?: AgentRuntime;
  host: { runCommand(id: string): Promise<string | null> };
  artifactStorage: Storage;
  relay: { snapshot(): Connection; subscribe(listener: () => void): () => void };
  effect(setup: () => () => void): void;
  navigation: { open(target: { version: 1; kind: "plugin"; pluginId: string; pageId: string } | Parameters<WorkspaceContext["navigation"]["open"]>[0]): Promise<unknown> };
  settingsCards: { register(card: { id: string; title: string; component: ReactRuntime.ComponentType }): void };
  conversation: WorkspaceContext["conversation"];
  pages: { register(page: { id: string; title: string; primary: boolean; placement: "dock"; layout: "workspace";
    icon: string; route?: { version: number; validate(params: unknown): boolean }; component: ReactRuntime.ComponentType<{ navigation?: PageNavigation }>; sidebar: ReactRuntime.ComponentType<{ children?: ReactRuntime.ReactNode }> }): void };
  panels: WorkspaceContext["panels"] & { register(panel: { id: string; title: string; matches(target: string): boolean;
    toolbar: ReactRuntime.ComponentType; component: ReactRuntime.ComponentType }): void };
};
export const inject = ["react", "relay", "pages", "panels", "navigation", "settingsCards", "conversation", "artifactStorage", "host", "agents"];
const glyphs = {
  stop: "M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10",
  close: "M18 6l-12 12 M6 6l12 12",
  cameraOff: "M3 3l18 18 M15 11v-1l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -.675 .946 M10 6h3a2 2 0 0 1 2 2v3m0 4v1a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2h1",
  headphonesOff: "M3 3l18 18 M4 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2l0 -3 M17 13h1a2 2 0 0 1 2 2v1m-.589 3.417c-.361 .36 -.86 .583 -1.411 .583h-1a2 2 0 0 1 -2 -2v-3 M4 15v-3c0 -2.21 .896 -4.21 2.344 -5.658m2.369 -1.638a8 8 0 0 1 11.287 7.296v3",
  microphoneOff: "M3 3l18 18 M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -.13 .874m-2 2a3 3 0 0 1 -3.87 -2.872v-1 M5 10a7 7 0 0 0 10.846 5.85m2 -2a6.967 6.967 0 0 0 1.152 -3.85 M8 21l8 0 M12 17l0 4",
  headphones: "M3 13v-1a9 9 0 0 1 18 0v1M3 13h3v7H3zm18 0h-3v7h3z",
  microphone: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8",
  screen: "M3 4h18v13H3zM8 21h8m-4-4v4",
  camera: "M3 5h12v14H3zm12 5 6-4v12l-6-4z",
  leave: "M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2c-8.072 -.49 -14.51 -6.928 -15 -15a2 2 0 0 1 2 -2 M17 3l4 4 M21 3l-4 4",
  plus: "M12 5v14M5 12h14", expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  chat: "M4 4h16v12H9l-5 4z",
  transcript: "M4 5h16v14H4z M7 9h4 M7 13h4 M14 9h3 M14 13h3",
  agent: "M7 7h10a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3H7a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3 M12 3v4 M9 12v1 M15 12v1 M9 17h6",
  remove: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6",
  meetings: "M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 2-2ZM8 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5.5 15a2.5 2.5 0 0 1 5 0m3 0a2.5 2.5 0 0 1 5 0",
} as const;
const validName = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
const roomKey = (value: string) => validName(value).toLocaleLowerCase("en-US");
function readRooms(key: string) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return ["General Voice"];
    const saved: unknown = JSON.parse(raw);
    if (Array.isArray(saved)) {
      const names = saved.filter((x): x is string => typeof x === "string" && !!validName(x) && x.length <= 64 && !/[\p{Cc}]/u.test(x)).map(validName);
      return names.filter((name, index) => names.findIndex(other => roomKey(other) === roomKey(name)) === index).slice(0, 32);
    }
  } catch { /* Start with the default room. */ }
  return ["General Voice"];
}
export function apply(ctx: Context) {
  const React = ctx.react;
  const { useEffect, useId, useRef, useState, useSyncExternalStore } = React;
  const media = makeRoomSession();
  const transcript = makeMeetingTranscription(media);
  const Transcript = transcriptUI(React, transcript, media);
  const liveAgents = makeLiveAgents(ctx, media, transcript);
  ctx.effect(() => () => transcript.close());
  const workspaces = workspaceUI(ctx, liveAgents, media);
  const listeners = new Set<() => void>();
  let connection = ctx.relay.snapshot();
  const storageKey = () => `studio.h2s2.meeting:${connection.scope || connection.origin}:${connection.viewer}:rooms`;
  let rooms = readRooms(storageKey());
  let selected = rooms[0] || "";
  let broker = communityBroker(connection.origin) || "";
  let accessKey = "";
  let visible = 0;
  let stageChoice = "participants";
  let chatOpen = true;
  let shareSound = false;
  type RoomPanel = "chat" | "agents" | "transcript";
  let roomPanel: RoomPanel = "chat";
  let preset: Preset = "balanced";
  let ui = { rooms, selected, broker, accessKey, visible, stageChoice, chatOpen, shareSound, roomPanel: roomPanel as RoomPanel, preset: preset as Preset, error: "" };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function publish(error = "") {
    ui = { rooms, selected, broker, accessKey, visible, stageChoice, chatOpen, shareSound, roomPanel, preset, error };
    for (const listener of listeners) listener();
  }
  function chooseStage(choice: string) {
    const call = media.snapshot();
    stageChoice = stageChoice === choice ? "participants" : choice;
    publish();
    if (stageChoice === "all-screens") media.watchAll();
    else if (stageChoice.startsWith("screen:")) {
      const id = stageChoice.slice(7);
      if (call.watching !== id || call.screens.length) media.changeWatch(id);
    } else media.changeWatch();
  }
  function showPanel(panel: RoomPanel) { roomPanel = panel; chatOpen = true; publish(); }
  function setChatOpen(value: boolean) { chatOpen = value; publish(); }
  function setShareSound(value: boolean) { shareSound = value; publish(); }
  function setPreset(value: Preset) { preset = value; publish(); }
  function useUI() { return useSyncExternalStore(subscribe, () => ui); }
  function useCall() { return useSyncExternalStore(media.subscribe, media.snapshot); }
  const open = () => { void ctx.navigation.open({ version: 1, kind: "plugin", pluginId, pageId: "meeting" }); };
  const openSettings = () => { void ctx.navigation.open({ version: 1, kind: "settings", section: `${pluginId}/connection` }); };
  const openManagement = () => { void ctx.navigation.open({ version: 1, kind: "settings", section: `${pluginId}/rooms` }); };
  function saveRooms(next: string[]) {
    rooms = next;
    if (!rooms.includes(selected)) selected = rooms[0] || "";
    try { localStorage.setItem(storageKey(), JSON.stringify(rooms)); } catch { /* Keep this visit usable. */ }
    publish();
  }
  function nameError(value: string, original?: string) {
    if (!value || value.length > 64 || /[\p{Cc}]/u.test(value)) return "Enter a channel name of 1–64 characters.";
    if (rooms.some(room => room !== original && roomKey(room) === roomKey(value))) return "A voice channel with this name is already in your list.";
    return "";
  }
  function join(name: string) {
    const current = ctx.relay.snapshot();
    if (!current.viewer || !current.origin || (current.status && current.status !== "ready")) {
      publish("Connect to your community before joining a room."); return;
    }
    if (media.snapshot().roomName === name && media.snapshot().phase !== "idle") { workspaces.clear(); open(); return; }
    let service: string;
    try { service = socketUrl(broker); } catch { publish("Set your meeting service address in Connection settings."); return; }
    workspaces.clear();
    media.leave();
    selected = name; stageChoice = "participants";
    publish();
    const profile = current.session.profiles.snapshot().get(current.viewer);
    void media.connect(service, { type: "meeting", room: name, community: new URL(current.origin).origin,
      name: (profile?.name || "Participant").slice(0, 48), picture: profile?.picture,
      ...(accessKey ? { key: accessKey } : {}) });
    open();
  }
  ctx.effect(() => {
    const style = document.createElement("style"); style.textContent = css; document.head.append(style);
    const stop = ctx.relay.subscribe(() => {
      const next = ctx.relay.snapshot();
      if (next.scope !== connection.scope || next.viewer !== connection.viewer || next.origin !== connection.origin || next.session !== connection.session) {
        media.leave(); transcript.reset(); connection = next; rooms = readRooms(storageKey()); selected = rooms[0] || "";
        broker = communityBroker(next.origin) || ""; accessKey = ""; stageChoice = "participants"; chatOpen = true; preset = "balanced"; roomPanel = "chat"; shareSound = false; publish();
      } else connection = next;
    });
    return () => { stop(); media.leave(); style.remove(); };
  });
  function Icon({ name }: { name: keyof typeof glyphs }) {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name]} /></svg>;
  }
  function Button({ label, icon, active, danger, iconOnly = false, variant = "subtle", ...props }: ReactRuntime.ComponentProps<"button"> & {
    label: string; icon?: keyof typeof glyphs; active?: boolean; danger?: boolean; iconOnly?: boolean; variant?: "ghost" | "subtle" | "prominent";
  }) {
    return <button {...props} type="button" className="buzz-button meeting-control" data-buzz-ui="" data-size="sm"
      aria-label={label} title={label} aria-pressed={active} data-disabled={props.disabled || undefined}
      data-button-shape={iconOnly ? "icon" : "capsule"} data-icon-variant={iconOnly ? danger ? "destructive" : active ? "prominent" : variant : undefined}
      data-icon-size={iconOnly ? "sm" : undefined} data-icon-shape={iconOnly ? "control" : undefined}
      data-variant={danger ? "destructive" : active ? "prominent" : variant}>
      <span className="buzz-button-label">{icon && <Icon name={icon} />}{!iconOnly && label}</span>
    </button>;
  }
  function Avatar({ person, large = false }: { person: RoomSnapshot["participants"][number]; large?: boolean }) {
    const [failed, setFailed] = useState<string>();
    let source: string | undefined;
    const picture = person.picture;
    if (typeof picture === "string" && picture.length <= 2048) {
      try { const url = new URL(picture); if (url.protocol === "https:" && !url.username && !url.password)
        source = connection.session.media?.(url.href, "small"); } catch { /* Use initials. */ }
    }
    return <span className="meeting-avatar" data-large={large || undefined} data-speaking={person.speaking || undefined} aria-hidden="true">
      {source && source !== failed ? <img src={source} alt="" onError={() => setFailed(source)} /> : person.name.slice(0, 1).toLocaleUpperCase()}
    </span>;
  }
  function Roster({ call, tiles = false }: { call: RoomSnapshot; tiles?: boolean }) {
    const state = useUI();
    return <ul className={tiles ? "meeting-tiles" : "meeting-roster"} aria-label={tiles ? "Meeting participants" : "Connected participants"}>
      {call.participants.map(person => <li key={person.id} data-speaking={person.speaking || undefined}>
        <button type="button" className="meeting-person-pick buzz-button" data-buzz-ui="" data-variant={state.stageChoice === `person:${person.id}` ? "prominent" : "ghost"} aria-label={`Show ${person.name}${person.local ? " (you)" : ""} on stage`} aria-pressed={state.stageChoice === `person:${person.id}`} onClick={() => chooseStage(`person:${person.id}`)}>
        {tiles && person.video ? <Video stream={person.video} label={`${person.name}’s camera`} /> : <Avatar person={person} large={tiles} />}
        <span className="meeting-person-name">{person.name}{person.local ? " (you)" : ""}</span></button>
        {person.muted && <span className="meeting-muted" title="Muted"><Icon name="microphone" /><span className="sr-only">Muted</span></span>}
        {call.streams.some(stream => stream.presenterId === person.id) && <span className="meeting-live">Live</span>}
      </li>)}
    </ul>;
  }
  function SharingControl({ call }: { call: RoomSnapshot }) {
    const state = useUI();
    const id = useId(); const drawer = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    useEffect(() => {
      const element = drawer.current;
      if (!element) return;
      const toggled = () => setExpanded(element.matches(":popover-open"));
      element.addEventListener("toggle", toggled);
      return () => { element.removeEventListener("toggle", toggled); };
    }, []);
    function position() {
      const element = drawer.current, anchor = trigger.current?.getBoundingClientRect();
      if (!element || !anchor) return;
      const inset = 12, width = Math.min(26 * parseFloat(getComputedStyle(document.documentElement).fontSize), innerWidth - inset * 2);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(inset, Math.min(innerWidth - width - inset, anchor.left + anchor.width / 2 - width / 2))}px`;
      element.style.bottom = `${innerHeight - anchor.top + inset}px`;
      element.style.maxHeight = `${Math.max(80, anchor.top - inset * 2)}px`;
    }
    const pending = call.capturePhase === "preparing" ? "Preparing screen…" : call.capturePhase === "publishing" ? "Starting share…" : "Choosing screen…";
    return <>
      <div ref={trigger} className="meeting-sharing-trigger"><Button label={call.picking ? pending : call.sharing ? "Sharing options" : "Share screen"} icon="screen" iconOnly active={!!call.sharing} disabled={call.phase !== "connected" || call.stopping} popoverTarget={id} aria-expanded={expanded} aria-controls={id} onClick={position} /></div>
      <div ref={drawer} id={id} popover="auto" className="meeting-sharing-drawer text-body-sm" role="dialog" aria-label="Screen sharing" data-buzz-ui="">
        <header className="meeting-sharing-heading"><h3 className="text-body-sm">Screen sharing</h3><Button label="Close sharing options" icon="close" iconOnly variant="ghost" popoverTarget={id} popoverTargetAction="hide" /></header>
        {call.sharing && <div className="meeting-drawer-preview"><Video stream={call.sharing.preview} label="Selected screen preview" /><p className="text-caption text-subtle">{call.sharing.label}</p></div>}
        <label className="meeting-sharing-field">Share quality<select className="buzz-input" value={state.preset} disabled={call.picking} onChange={event => setPreset(event.target.value as Preset)}>{Object.entries(presets).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
        <p className="text-caption text-subtle">Choose a screen or window in the system picker. Your microphone is controlled separately.</p>
        {call.screenAudio ? <><label className="meeting-sharing-sound"><input type="checkbox" checked={state.shareSound} disabled={call.picking} onChange={event => setShareSound(event.target.checked)} />Share sound when available</label><p className="text-caption text-metadata">Sound support depends on your system and the source you choose. This applies to your next source selection.</p></> : <p className="text-caption text-metadata">Sound sharing requires an updated meeting service.</p>}
        {call.sharing?.sound && <p className="text-caption" role="status">Sharing screen sound</p>}
        {call.sharing?.soundError && <p className="text-caption text-subtle" role="status">{call.sharing.soundError}</p>}
        {call.picking ? <div className="meeting-sharing-actions"><span role="status">{pending}</span>{call.capturePhase !== "publishing" && <Button label="Cancel screen share" variant="ghost" onClick={() => media.cancelScreen()} />}</div>
          : <div className="meeting-sharing-actions"><Button label={call.sharing ? "Change source" : "Choose screen or window"} icon="screen" disabled={call.stopping || call.phase !== "connected"} onClick={() => { void media.share(state.preset, state.shareSound); }} /></div>}
      </div>
      {call.sharing && <Button label="Stop sharing" icon="stop" iconOnly active disabled={call.stopping} onClick={() => { void media.stopSharing(); }} />}
      {call.picking && !expanded && call.capturePhase !== "publishing" && <Button label="Cancel screen share" icon="close" iconOnly onClick={() => media.cancelScreen()} />}
    </>;
  }
  function Controls({ call, compact = false }: { call: RoomSnapshot; compact?: boolean }) {
    const listening = useSyncExternalStore(liveAgents.subscribe, liveAgents.snapshot);
    const captions = useSyncExternalStore(transcript.subscribe, transcript.snapshot);
    const [busy, setBusy] = useState(false);
    async function change(action: () => Promise<void>) { setBusy(true); try { await action(); } finally { setBusy(false); } }
    if (call.phase === "idle") return null;
    return <div className="meeting-callbar" role="group" aria-label="Meeting controls" data-compact={compact || undefined}>
      <span className="sr-only" role="status">{call.phase === "connected" ? "Voice connected" : call.phase === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
      <Button label={call.muted ? "Unmute" : "Mute"} icon={call.muted ? "microphoneOff" : "microphone"} iconOnly active={call.muted} disabled={busy || call.phase !== "connected" || call.deafened} onClick={() => { void change(() => media.setMuted(!call.muted)); }} />
      <Button label={call.deafened ? "Undeafen" : "Deafen"} icon={call.deafened ? "headphonesOff" : "headphones"} iconOnly active={call.deafened} disabled={busy || call.phase !== "connected"} onClick={() => { void change(() => media.setDeafened(!call.deafened)); }} />
      <Button label={call.cameraPhase === "choosing" ? "Cancel camera" : call.cameraPhase === "publishing" ? "Starting camera…" : call.camera ? "Camera off" : "Camera on"} icon={call.camera ? "camera" : "cameraOff"} iconOnly active={call.camera} disabled={busy || call.phase !== "connected" || call.cameraPhase === "publishing"} onClick={() => { if (call.cameraPhase) media.cancelCamera(); else void media.setCamera(!call.camera); }} />
      {listening.phase !== "idle" && <Button label="Stop live listening" icon="agent" iconOnly active onClick={() => liveAgents.stop()} />}
      {["starting", "transcribing", "reconnecting"].includes(captions.phase) && <Button label="Pause transcription" icon="transcript" iconOnly active onClick={() => transcript.stop()} />}
      <SharingControl call={call} /><span className="meeting-control-divider" />
      <Button label="Leave room" icon="leave" iconOnly danger onClick={() => media.leave()} />
    </div>;
  }
  function Sidebar({ children }: { children?: ReactRuntime.ReactNode }) {
    const state = useUI(); const call = useCall();
    const [adding, setAdding] = useState(false); const [name, setName] = useState("");
    function add(event: ReactRuntime.FormEvent) {
      event.preventDefault(); const value = validName(name);
      if (!value || value.length > 64 || /[\p{Cc}]/u.test(value)) return;
      if (!rooms.some(room => roomKey(room) === roomKey(value)) && rooms.length < 32) {
        saveRooms([...rooms, value]);
      }
      setName(""); setAdding(false);
    }
    return <div className="shell-sidebar-default meeting-sidebar" data-buzz-ui="">
      <div className="meeting-sidebar-pages">{children}</div><nav className="navigation-section" aria-label="Meeting rooms"><header className="navigation-section-heading"><h2 className="navigation-section-heading-label text-caption text-metadata">Voice Channels</h2><span className="navigation-section-heading-actions"><Button label="Manage voice channels" icon="settings" iconOnly variant="ghost" onClick={openManagement} /><Button label="Add voice channel" icon="plus" iconOnly variant="ghost" disabled={state.rooms.length >= 32} onClick={() => setAdding(!adding)} /></span></header>
        {adding && <form onSubmit={add}><label>Room name<input className="buzz-input" value={name} maxLength={64} autoFocus onChange={event => setName(event.target.value)} /></label><Button label="Add room" onClick={add} /></form>}
        {state.rooms.map(name => <div className="meeting-room" key={name}>
          <button type="button" className="navigation-item" data-buzz-ui="" data-variant="row" data-selected={call.roomName === name || undefined} aria-label={`Join ${name}`} aria-current={call.roomName === name ? "true" : undefined}
            onClick={() => join(name)}><Icon name="headphones" /><span className="navigation-item-label">{name}</span>{call.roomName === name && <span className="buzz-count-badge">{call.participants.length || "…"}</span>}</button>
          {call.roomName === name && <Roster call={call} />}
        </div>)}
      </nav><workspaces.Sidebar />{call.phase !== "idle" && <div className="meeting-sidebar-status"><span className="meeting-status-dot" /><div><span>{call.phase === "connected" ? "Voice connected" : "Connecting…"}</span><small>{call.roomName}</small></div></div>}
    </div>;
  }
  function Video({ stream, label }: { stream: MediaStream; label: string }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => { const element = ref.current; if (!element) return; element.srcObject = stream;
      return () => { element.srcObject = null; }; }, [stream]);
    return <video ref={ref} aria-label={label} autoPlay muted playsInline />;
  }
  function CameraAccess() {
    const help = cameraPermissions(navigator.platform);
    const [opening, setOpening] = useState(false);
    const [failed, setFailed] = useState(false);
    async function settings() {
      if (!help.command || opening) return;
      setOpening(true); setFailed(false);
      try { setFailed(await ctx.host.runCommand(help.command) === null); }
      catch { setFailed(true); }
      finally { setOpening(false); }
    }
    return <div className="meeting-recovery text-body-sm" role="group" aria-label="Camera permissions" style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
      <p style={{ flexBasis: "100%" }}>{help.instructions}</p>
      {help.command && <Button label="Open camera settings" variant="ghost" disabled={opening} onClick={() => { void settings(); }} />}
      <Button label="Try camera again" disabled={opening} onClick={() => { void media.setCamera(true); }} />
      {failed && <p role="alert">Couldn’t open camera settings. Follow the steps above to open them manually.</p>}
    </div>;
  }
  function RoomManagement() {
    const state = useUI(); const call = useCall();
    const [draft, setDraft] = useState("");
    const [editing, setEditing] = useState<{ original: string; name: string }>();
    const [removing, setRemoving] = useState<string>();
    const [error, setError] = useState("");
    const scope = connection.scope;
    useEffect(() => { setDraft(""); setEditing(undefined); setRemoving(undefined); setError(""); }, [scope, connection.viewer, connection.origin]);
    function add(event: ReactRuntime.FormEvent) {
      event.preventDefault(); const value = validName(draft);
      const problem = nameError(value) || (rooms.length >= 32 ? "You can save up to 32 voice channels on this device." : "");
      if (problem) { setError(problem); return; }
      saveRooms([...rooms, value]); setDraft(""); setError("");
    }
    function rename(event: ReactRuntime.FormEvent) {
      event.preventDefault(); if (!editing || !rooms.includes(editing.original)) return;
      const value = validName(editing.name); const problem = nameError(value, editing.original);
      if (problem) { setError(problem); return; }
      const original = editing.original;
      if (call.roomName === original && roomKey(original) !== roomKey(value)) media.leave();
      try {
        const prefix = `studio.h2s2.meetings:chat:${connection.scope}:`;
        const matching = connection.session.channels?.list().channels.filter(channel => roomKey(channel.name) === roomKey(original) && connection.viewer && channel.members?.includes(connection.viewer)) ?? [];
        const chat = localStorage.getItem(prefix + roomKey(original)) ?? (matching.length === 1 ? matching[0].id : undefined);
        if (chat) localStorage.setItem(prefix + roomKey(value), chat);
      } catch { /* Channel linking remains available in the room. */ }
      if (selected === original) selected = value;
      saveRooms(rooms.map(room => room === original ? value : room)); setEditing(undefined); setError("");
    }
    function remove(name: string) {
      if (call.roomName === name) media.leave();
      saveRooms(rooms.filter(room => room !== name)); setRemoving(undefined); setError("");
    }
    return <div className="meeting-room-settings text-body-sm" data-buzz-ui="">
      <p className="text-subtle">Manage the voice-channel shortcuts saved on this device. Other people join the same room by using its name.</p>
      <form className="meeting-room-create" onSubmit={add}><label>Channel name<input className="buzz-input" value={draft} maxLength={64} onChange={event => setDraft(event.target.value)} /></label><Button label="Create voice channel" icon="plus" disabled={state.rooms.length >= 32} onClick={add} /></form>
      {error && <p role="alert" className="text-danger">{error}</p>}
      <div className="buzz-settings-group meeting-room-list">
        {state.rooms.length === 0 && <p className="text-subtle">No voice channels saved. Create one above to get started.</p>}
        {state.rooms.map(name => <div className="meeting-room-setting" key={name}>
          {editing?.original === name ? <form onSubmit={rename}><label>New channel name<input className="buzz-input" autoFocus value={editing.name} maxLength={64} onChange={event => setEditing({ original: name, name: event.target.value })} /></label><p className="text-caption text-metadata">The new name selects a different voice room. Your linked text conversation stays the same.{call.roomName === name ? " Your current call will end." : ""}</p><div className="meeting-setting-actions"><Button label="Cancel rename" variant="ghost" onClick={() => { setEditing(undefined); setError(""); }} /><Button label="Save channel name" onClick={rename} /></div></form>
            : <div className="meeting-room-setting-row"><Icon name="headphones" /><span>{name}</span><Button label={`Rename ${name}`} icon="settings" iconOnly variant="ghost" onClick={() => { setEditing({ original: name, name }); setRemoving(undefined); setError(""); }} /><Button label={`Remove ${name}`} icon="remove" iconOnly variant="ghost" onClick={() => { setRemoving(name); setEditing(undefined); setError(""); }} /></div>}
          {removing === name && <div className="meeting-room-removal" role="group" aria-label={`Remove ${name} shortcut`}><p>Remove this shortcut? Its text conversation and other participants are unaffected.{call.roomName === name ? " You will leave the current call." : ""}</p><div className="meeting-setting-actions"><Button label="Cancel removal" variant="ghost" onClick={() => setRemoving(undefined)} /><Button label="Remove channel shortcut" danger onClick={() => remove(name)} /></div></div>}
        </div>)}
      </div>
    </div>;
  }
  function Settings() {
    const state = useUI();
    return <div className="meeting-settings text-body-sm" data-buzz-ui="">
      <p className="text-subtle">Connect Meetings to the service running beside your community relay.</p>
      <div className="buzz-settings-group" data-layout="form">
        <label>Meeting service<input className="buzz-input" value={state.broker} placeholder="wss://meet.example.org/rooms" onChange={event => { broker = event.target.value; publish(); }} /></label>
        <label>Access key<input className="buzz-input" type="password" autoComplete="off" value={state.accessKey} onChange={event => { accessKey = event.target.value; publish(); }} /></label>
        <p className="text-caption text-metadata">Access keys stay in memory and clear when you change community or identity.</p>
      </div>
    </div>;
  }
  function RoomChat({ room }: { room: string }) {
    const savedWorkspaces = workspaces.useState();
    const { roomPanel } = useUI();
    const current = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const session = current.session;
    const list = useSyncExternalStore(session.channels?.subscribeList ?? subscribe, session.channels?.list ?? (() => emptyChannels));
    const [linked, setLinked] = useState<{ key: string; id: string }>();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const key = `studio.h2s2.meetings:chat:${current.scope}:${roomKey(room)}`;
    useEffect(() => { session.channels?.ensureList?.(); }, [session]);
    const channels = list.channels.filter(channel => channel.channelType === "stream" && !channel.huddle && !channel.parentChannelId && !channel.archived && !channel.cached && !channel.metadataPending && !!current.viewer && channel.members?.includes(current.viewer));
    let saved: string | null = null;
    try { saved = localStorage.getItem(key); } catch { /* Use a matching joined channel. */ }
    const matches = channels.filter(channel => roomKey(channel.name) === roomKey(room));
    const chosen = channels.find(channel => channel.id === (linked?.key === key ? linked.id : saved)) ?? (matches.length === 1 ? matches[0] : undefined);
    const Workspace = ctx.conversation.ui.Workspace;
    function link(id: string) {
      if (!channels.some(channel => channel.id === id)) return;
      try { localStorage.setItem(key, id); } catch { /* Keep this visit usable. */ }
      setLinked({ key, id });
    }
    async function create() {
      if (!session.channelCreation?.available || pending) return;
      setPending(true); setError("");
      try {
        const id = await session.channelCreation.create({ name: room, visibility: "open" });
        if (ctx.relay.snapshot().session !== session) return;
        try { localStorage.setItem(key, id); } catch { /* Keep this visit usable. */ }
        setLinked({ key, id });
      } catch { setError("Couldn’t create the room conversation. Try again from Messages."); }
      finally { setPending(false); }
    }
    return <aside className="meeting-chat" aria-label="Room chat">
      {chosen && roomPanel === "agents" ? <workspaces.Agents key={`${current.scope}:${chosen.id}`} channelId={chosen.id} roomName={room} /> : chosen && Workspace && current.scope ? <div className="meeting-chat-workspace"><Workspace key={`${current.scope}:${chosen.id}`} id="meetings-room-chat" session={session} scope={current.scope} target={{ channelId: chosen.id }} label={`${room} chat`} actions={[savedWorkspaces.workspaces.some(item => item.id === chosen.id) ? { label: "Open workspace", run: () => workspaces.open(chosen.id) } : { label: "Save as shared workspace", run: () => workspaces.manage(chosen.id) }]} /></div>
        : <><header className="panel-header"><div className="panel-header-label"><Icon name="chat" /><h2>Room chat</h2></div></header><div className="meeting-chat-setup text-body-sm">
          {!Workspace ? <p>Turn on Channels to use Buzz’s room conversation here.</p> : <><p className="text-subtle">Keep the conversation going alongside {room}.</p>
            <label>Room conversation<select className="buzz-input" disabled={pending} value="" onChange={event => link(event.target.value)}><option value="">Choose a joined channel…</option>{channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
            {session.channelCreation?.available && <><Button label={pending ? "Creating…" : "Create open channel"} disabled={pending} onClick={() => { void create(); }} /><p className="text-caption text-metadata">Everyone in this community can discover an open channel.</p></>}
          </>}{error && <p role="alert" className="text-danger">{error}</p>}
        </div></>}
    </aside>;
  }
  function Page({ navigation }: { navigation?: PageNavigation }) {
    const state = useUI(); const call = useCall(); const video = useRef<HTMLDivElement>(null);
    const transcriptTrigger = useRef<HTMLButtonElement>(null);
    const workspace = workspaces.useState();
    const [fullscreenError, setFullscreenError] = useState("");
    const { preset, chatOpen } = state;
    const stageChoice = state.stageChoice;
    useEffect(() => { visible++; publish(); return () => { visible--; publish(); }; }, []);
    const connected = call.phase === "connected";
    const watching = call.streams.find(stream => stream.id === call.watching);
    const person = call.participants.find(person => stageChoice === `person:${person.id}`);
    const localScreen = stageChoice === "your-screen" && call.sharing;
    const remoteScreen = stageChoice.startsWith("screen:") && call.video;
    const allScreens = stageChoice === "all-screens" && call.screens.length > 0;

    function fullscreen() {
      const element = video.current;
      if (element?.requestFullscreen) void element.requestFullscreen().catch(() => setFullscreenError("Fullscreen isn’t available in this window."));
      else setFullscreenError("Fullscreen isn’t available in this window.");
    }
    const route = navigation?.target.route?.params ?? navigation?.target.params;
    if (workspace.selected || workspaces.validRoute(route)) return <workspaces.Content navigation={navigation}>
      {call.phase !== "idle" && <div className="meeting-workspace-callbar"><Button label={`Return to ${call.roomName}`} icon="headphones" variant="ghost" onClick={() => { workspaces.clear(); open(); }} /><Controls call={call} /></div>}
    </workspaces.Content>;
    return <section className="meeting-page text-body" data-buzz-ui="" aria-label="Meeting">
      <header className="panel-header"><div className="panel-header-title"><div className="panel-header-label"><span className="panel-header-label-icon"><Icon name={state.selected ? "headphones" : "meetings"} /></span><h2>{call.roomName || state.selected || "Meetings"}</h2><span className="meeting-header-count text-caption text-metadata">{call.participants.length ? `${call.participants.length} participant${call.participants.length === 1 ? "" : "s"}` : state.selected ? "Voice channel" : ""}</span></div></div>
        <div className="panel-header-actions">{(localScreen || person?.video || remoteScreen || allScreens) && <Button label="Fullscreen" icon="expand" iconOnly variant="ghost" onClick={fullscreen} />}<Button ref={transcriptTrigger} label={chatOpen && state.roomPanel === "transcript" ? "Hide transcript" : "Show transcript"} icon="transcript" iconOnly variant="ghost" active={chatOpen && state.roomPanel === "transcript"} onClick={() => { if (chatOpen && state.roomPanel === "transcript") setChatOpen(false); else showPanel("transcript"); }} /><Button label="Meeting agents" icon="agent" iconOnly variant="ghost" active={chatOpen && state.roomPanel === "agents"} onClick={() => { if (chatOpen && state.roomPanel === "agents") setChatOpen(false); else showPanel("agents"); }} /><Button label={chatOpen && state.roomPanel === "chat" ? "Hide room chat" : "Show room chat"} icon="chat" iconOnly variant="ghost" active={chatOpen && state.roomPanel === "chat"} onClick={() => { if (chatOpen && state.roomPanel === "chat") setChatOpen(false); else showPanel("chat"); }} /><Button label="Connection settings" icon="settings" iconOnly variant="ghost" onClick={openSettings} /></div>
      </header>
      {(state.error || call.error) && <div className="meeting-error text-body-sm" role="alert"><span>{state.error || call.error}</span>{!call.cameraDenied && <Button label="Connection settings" variant="ghost" onClick={openSettings} />}</div>}
      {call.cameraDenied && connected && <CameraAccess />}
      {connected && call.audioBlocked && <div className="meeting-recovery"><Button label="Enable audio playback" onClick={() => { void media.resumeAudio(); }} /></div>}
      {call.participants.some(person => person.transcribing || person.listener) && <div className="meeting-listener-status text-caption" role="status"><Icon name="transcript" />{call.participants.some(person => person.transcribing) && <span>Live transcription via {call.participants.filter(person => person.transcribing).map(person => person.name).join(", ")}</span>}{call.participants.some(person => person.listener) && <span>{call.participants.filter(person => person.listener).map(person => `${person.listener} is listening via ${person.name}`).join(" · ")}</span>}</div>}
      <div className="meeting-body" data-chat-open={(chatOpen && !!(call.roomName || state.selected)) || undefined}><div className="meeting-content">
        <div className="meeting-stage" ref={video}>
          {localScreen ? <div className="meeting-focused-screen"><Video stream={localScreen.preview} label="Your screen on stage" /></div>
            : person ? <div className={`meeting-focused-screen${person.video ? "" : " meeting-focused-person"}`}>{person.video ? <Video stream={person.video} label={`${person.name}’s camera on stage`} /> : <Avatar person={person} large />}<span className="text-body-sm">{person.name}</span><Button label="Back to participants" variant="ghost" onClick={() => chooseStage("participants")} /></div>
            :
          allScreens ? <div className="meeting-screen-grid">{call.screens.map(screen => <button type="button" className="meeting-screen-tile" key={screen.id} aria-label={`Focus ${screen.presenter}’s screen`} onClick={() => chooseStage(`screen:${screen.id}`)}><Video stream={screen.video} label={`${screen.presenter}’s screen`} /><div className="meeting-screen-caption"><Icon name="screen" /><span>{screen.presenter}’s screen</span><span className="meeting-live">Live</span></div></button>)}<div className="meeting-view-actions"><Button label="Stop watching" variant="ghost" onClick={() => chooseStage("participants")} /></div></div>
            : remoteScreen ? <div className="meeting-focused-screen"><Video stream={remoteScreen} label="Shared screen" /><div className="meeting-focused-caption"><span className="text-body-sm">{watching?.presenter}’s screen</span><div className="meeting-view-actions"><label className="sr-only" htmlFor="meeting-view-quality">Viewer quality</label><select className="buzz-input" id="meeting-view-quality" data-size="sm" value={call.quality} onChange={event => media.quality(event.target.value === "auto" ? "auto" : Number(event.target.value))}><option value="auto">Auto quality</option>{call.layers.map(layer => <option key={layer.value} value={layer.value}>{layer.height}p</option>)}</select><Button label="Stop watching" variant="ghost" onClick={() => chooseStage("participants")} /></div></div></div>
            : call.participants.length ? <Roster call={call} tiles /> : call.phase === "connecting" ? <div className="meeting-empty" role="status"><div className="meeting-empty-icon"><Icon name="headphones" /></div><h3 className="text-body-lg">Joining {call.roomName}…</h3><p className="text-body-sm text-subtle">Connecting to the room and preparing your microphone.</p><Button label="Cancel joining" icon="close" onClick={() => media.leave()} /></div> : <div className="meeting-empty"><div className="meeting-empty-icon"><Icon name="headphones" /></div><h3 className="text-body-lg">Make room for a conversation</h3><p className="text-body-sm text-subtle">{state.selected ? `Join ${state.selected} to talk, share a screen, or work through something together.` : "Create a voice channel to start a conversation."}</p><Button label={state.selected ? `Join ${state.selected}` : "Manage voice channels"} icon={state.selected ? "headphones" : "plus"} variant="prominent" onClick={() => state.selected ? join(state.selected) : openManagement()} />{state.selected && <span className="text-caption text-metadata">Your microphone turns on when you join.</span>}</div>}
          {fullscreenError && <p role="alert" className="text-body-sm text-danger">{fullscreenError}</p>}
        </div>
        {(call.streams.length > 0 || call.sharing) && <aside className="meeting-streams" aria-label="Live streams"><div className="meeting-streams-header"><h3 className="text-caption text-metadata">Screen sharing</h3>{call.streams.length > 1 && <Button label="Watch all screens" icon="screen" iconOnly variant="ghost" onClick={() => chooseStage("all-screens")} />}</div>
          {call.sharing && <div className="meeting-preview"><button type="button" className="meeting-preview-select" aria-label="Show your screen on stage" aria-pressed={stageChoice === "your-screen"} onClick={() => chooseStage("your-screen")}><Video stream={call.sharing.preview} label="Your stream preview" /></button><div className="meeting-preview-caption"><span className="text-caption text-subtle">{call.sharing.label} · Your screen</span><Button label="Change source" icon="screen" iconOnly variant="ghost" disabled={call.picking || call.stopping || !connected} onClick={() => { void media.share(preset, state.shareSound); }} /></div></div>}
          {call.streams.map(stream => <button className="navigation-item" data-buzz-ui="" data-variant="row" data-selected={stageChoice === `screen:${stream.id}` || undefined} type="button" key={stream.id} aria-label={`Watch ${stream.presenter}’s stream`} aria-pressed={stageChoice === `screen:${stream.id}`} disabled={!connected} onClick={() => chooseStage(`screen:${stream.id}`)}><Icon name="screen" /><span className="navigation-item-label">{stream.presenter}’s screen</span><span className="meeting-live">Live</span></button>)}
        </aside>}
      </div>{chatOpen && !!(call.roomName || state.selected) && (state.roomPanel === "transcript" ? <Transcript roomName={call.roomName || state.selected} close={() => { setChatOpen(false); transcriptTrigger.current?.focus(); }} /> : <RoomChat key={`${connection.scope}:${call.roomName || state.selected}`} room={call.roomName || state.selected} />)}</div>
      {call.phase !== "idle" && <footer className="meeting-footer"><div className="meeting-footer-status text-caption"><span className="meeting-status-dot" /><span>{call.phase === "connected" ? "Connected" : call.phase === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span></div><Controls call={call} /></footer>}
    </section>;
  }
  function Toolbar() {
    const call = useCall(); const state = useUI();
    if (call.phase === "idle" || state.visible > 0) return null;
    return <div className="meeting-toolbar" data-buzz-ui=""><Button label={call.roomName || "Meetings"} icon="headphones" variant="ghost" onClick={open} /><Controls call={call} compact /></div>;
  }
  ctx.settingsCards.register({ id: "connection", title: "Meetings", component: Settings });
  ctx.settingsCards.register({ id: "rooms", title: "Voice channels", component: RoomManagement });
  const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="' + glyphs.meetings + '"/></svg>')}`;
  ctx.pages.register({ id: "meeting", title: "Meetings", primary: true, placement: "dock", icon, layout: "workspace", route: { version: 1, validate: workspaces.validRoute }, component: Page, sidebar: Sidebar });
  ctx.panels.register({ id: "meeting-call", title: "Meeting", matches: () => false, component: () => <Page />, toolbar: Toolbar });
}
