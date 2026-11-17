import type * as ReactRuntime from "react";
import { makeRoomSession, type RoomSnapshot } from "./room";
import { communityBroker, pluginId, socketUrl } from "./protocol";
import { presets, type Preset } from "./capture";
import css from "./meeting.css";

type Profile = { name?: string; picture?: string };
type Connection = { status?: string; origin?: string; viewer?: string; scope?: string;
  session: { profiles: { snapshot(): ReadonlyMap<string, Profile>; subscribe(listener: () => void): () => void };
    media?(url: string, size: "small"): string | undefined } };
type Context = {
  react: typeof ReactRuntime;
  relay: { snapshot(): Connection; subscribe(listener: () => void): () => void };
  effect(setup: () => () => void): void;
  navigation: { open(target: { version: 1; kind: "plugin"; pluginId: string; pageId: string } | { version: 1; kind: "settings"; section: string }): Promise<unknown> };
  settingsCards: { register(card: { id: string; title: string; component: ReactRuntime.ComponentType }): void };
  pages: { register(page: { id: string; title: string; primary: boolean; placement: "dock"; layout: "workspace";
    icon: string; component: ReactRuntime.ComponentType; sidebar: ReactRuntime.ComponentType<{ children?: ReactRuntime.ReactNode }> }): void };
  panels: { register(panel: { id: string; title: string; matches(target: string): boolean;
    toolbar: ReactRuntime.ComponentType; component: ReactRuntime.ComponentType }): void };
};
export const inject = ["react", "relay", "pages", "panels", "navigation", "settingsCards"];
const glyphs = {
  headphones: "M3 13v-1a9 9 0 0 1 18 0v1M3 13h3v7H3zm18 0h-3v7h3z",
  microphone: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8",
  screen: "M3 4h18v13H3zM8 21h8m-4-4v4",
  camera: "M3 5h12v14H3zm12 5 6-4v12l-6-4z",
  leave: "m4 14 4-2 3 3h2l3-3 4 2v5h-4l-2-3h-4l-2 3H4z",
  plus: "M12 5v14M5 12h14", expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
} as const;
const validName = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
const roomKey = (value: string) => validName(value).toLocaleLowerCase("en-US");
function readRooms(key: string) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(saved)) return ["General Voice", ...saved.filter((x): x is string =>
      typeof x === "string" && x.length <= 64 && !/[\p{Cc}]/u.test(x) && roomKey(x) !== "general voice").slice(0, 31)];
  } catch { /* Start with the default room. */ }
  return ["General Voice"];
}
export function apply(ctx: Context) {
  const React = ctx.react;
  const { useEffect, useRef, useState, useSyncExternalStore } = React;
  const media = makeRoomSession();
  const listeners = new Set<() => void>();
  let connection = ctx.relay.snapshot();
  const storageKey = () => `studio.h2s2.meeting:${connection.scope || connection.origin}:${connection.viewer}:rooms`;
  let rooms = readRooms(storageKey());
  let selected = rooms[0];
  let broker = communityBroker(connection.origin) || "";
  let accessKey = "";
  let visible = 0;
  let ui = { rooms, selected, broker, accessKey, visible, error: "" };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function publish(error = "") {
    ui = { rooms, selected, broker, accessKey, visible, error };
    for (const listener of listeners) listener();
  }
  function useUI() { return useSyncExternalStore(subscribe, () => ui); }
  function useCall() { return useSyncExternalStore(media.subscribe, media.snapshot); }
  const open = () => { void ctx.navigation.open({ version: 1, kind: "plugin", pluginId, pageId: "meeting" }); };
  const openSettings = () => { void ctx.navigation.open({ version: 1, kind: "settings", section: `${pluginId}/connection` }); };
  function join(name: string) {
    const current = ctx.relay.snapshot();
    if (!current.viewer || !current.origin || (current.status && current.status !== "ready")) {
      publish("Connect to your community before joining a room."); return;
    }
    if (media.snapshot().roomName === name && media.snapshot().phase !== "idle") { open(); return; }
    let service: string;
    try { service = socketUrl(broker); } catch { publish("Set your meeting service address in Connection settings."); return; }
    media.leave();
    selected = name;
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
        media.leave(); connection = next; rooms = readRooms(storageKey()); selected = rooms[0];
        broker = communityBroker(next.origin) || ""; accessKey = ""; publish();
      } else connection = next;
    });
    return () => { stop(); media.leave(); style.remove(); };
  });
  function Icon({ name }: { name: keyof typeof glyphs }) {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name]} /></svg>;
  }
  function Button({ label, icon, active, danger, iconOnly = false, variant = "subtle", ...props }: ReactRuntime.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string; icon?: keyof typeof glyphs; active?: boolean; danger?: boolean; iconOnly?: boolean; variant?: "ghost" | "subtle" | "prominent";
  }) {
    return <button {...props} type="button" className="buzz-button meeting-control" data-buzz-ui="" data-size="sm"
      aria-label={label} title={label} aria-pressed={active} data-disabled={props.disabled || undefined}
      data-button-shape={iconOnly ? "icon" : "capsule"} data-icon-variant={iconOnly ? danger ? "destructive" : variant : undefined}
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
    return <ul className={tiles ? "meeting-tiles" : "meeting-roster"} aria-label={tiles ? "Meeting participants" : "Connected participants"}>
      {call.participants.map(person => <li key={person.id} data-speaking={person.speaking || undefined}>
        {tiles && person.video ? <Video stream={person.video} label={`${person.name}’s camera`} /> : <Avatar person={person} large={tiles} />}
        <span>{person.name}{person.local ? " (you)" : ""}</span>
        {person.muted && <span className="meeting-muted" title="Muted"><Icon name="microphone" /><span className="sr-only">Muted</span></span>}
        {call.streams.some(stream => stream.presenter === person.name) && <span className="meeting-live">Live</span>}
      </li>)}
    </ul>;
  }
  function Controls({ call, compact = false, children }: { call: RoomSnapshot; compact?: boolean; children?: ReactRuntime.ReactNode }) {
    const [busy, setBusy] = useState(false);
    async function change(action: () => Promise<void>) { setBusy(true); try { await action(); } finally { setBusy(false); } }
    if (call.phase === "idle") return null;
    return <div className="meeting-callbar" role="group" aria-label="Meeting controls" data-compact={compact || undefined}>
      <span className="sr-only" role="status">{call.phase === "connected" ? "Voice connected" : call.phase === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
      <Button label={call.muted ? "Unmute" : "Mute"} icon="microphone" iconOnly active={call.muted} disabled={busy || call.phase !== "connected" || call.deafened}
        onClick={() => { void change(() => media.setMuted(!call.muted)); }} />
      <Button label={call.deafened ? "Undeafen" : "Deafen"} icon="headphones" iconOnly active={call.deafened} disabled={busy || call.phase !== "connected"}
        onClick={() => { void change(() => media.setDeafened(!call.deafened)); }} />
      {!compact && <Button label={call.camera ? "Camera off" : "Camera on"} icon="camera" iconOnly active={call.camera} disabled={busy || call.phase !== "connected"}
        onClick={() => { void change(() => media.setCamera(!call.camera)); }} />}
      {children}<span className="meeting-control-divider" />
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
        rooms = [...rooms, value]; try { localStorage.setItem(storageKey(), JSON.stringify(rooms)); } catch { /* Keep this visit usable. */ }
        publish();
      }
      setName(""); setAdding(false);
    }
    return <div className="shell-sidebar-default meeting-sidebar" data-buzz-ui="">
      {children}<nav className="navigation-section" aria-label="Meeting rooms"><header className="navigation-section-heading"><h2 className="navigation-section-heading-label text-caption text-metadata">Voice Channels</h2><span className="navigation-section-heading-actions"><Button label="Add voice channel" icon="plus" iconOnly variant="ghost" onClick={() => setAdding(!adding)} /></span></header>
        {adding && <form onSubmit={add}><label>Room name<input value={name} maxLength={64} autoFocus onChange={event => setName(event.target.value)} /></label><Button label="Add room" onClick={add} /></form>}
        {state.rooms.map(name => <div className="meeting-room" key={name}>
          <button type="button" className="navigation-item" data-buzz-ui="" data-variant="row" data-selected={call.roomName === name || undefined} aria-label={`Join ${name}`} aria-current={call.roomName === name ? "true" : undefined}
            onClick={() => join(name)}><Icon name="headphones" /><span className="navigation-item-label">{name}</span>{call.roomName === name && <span className="buzz-count-badge">{call.participants.length || "…"}</span>}</button>
          {call.roomName === name && <Roster call={call} />}
        </div>)}
      </nav>{call.phase !== "idle" && <div className="meeting-sidebar-status"><span className="meeting-status-dot" /><div><span>{call.phase === "connected" ? "Voice connected" : "Connecting…"}</span><small>{call.roomName}</small></div></div>}
    </div>;
  }
  function Video({ stream, label }: { stream: MediaStream; label: string }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => { const element = ref.current; if (!element) return; element.srcObject = stream;
      return () => { element.srcObject = null; }; }, [stream]);
    return <video ref={ref} aria-label={label} autoPlay muted playsInline />;
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
  function Page() {
    const state = useUI(); const call = useCall(); const video = useRef<HTMLDivElement>(null);
    const [preset, setPreset] = useState<Preset>("balanced"); const [fullscreenError, setFullscreenError] = useState("");
    useEffect(() => { visible++; publish(); return () => { visible--; publish(); }; }, []);
    const connected = call.phase === "connected";
    const watching = call.streams.find(stream => stream.id === call.watching);
    function fullscreen() {
      const element = video.current;
      if (element?.requestFullscreen) void element.requestFullscreen().catch(() => setFullscreenError("Fullscreen isn’t available in this window."));
      else setFullscreenError("Fullscreen isn’t available in this window.");
    }
    return <section className="meeting-page text-body" data-buzz-ui="" aria-label="Meeting">
      <header className="panel-header"><div className="panel-header-title"><div className="panel-header-label"><span className="panel-header-label-icon"><Icon name="headphones" /></span><h2>{call.roomName || state.selected}</h2><span className="meeting-header-count text-caption text-metadata">{call.participants.length ? `${call.participants.length} participants` : "Voice channel"}</span></div></div>
        <div className="panel-header-actions">{(call.video || call.screens.length > 0) && <Button label="Fullscreen" icon="expand" iconOnly variant="ghost" onClick={fullscreen} />}<Button label="Connection settings" icon="settings" iconOnly variant="ghost" onClick={openSettings} /></div>
      </header>
      {(state.error || call.error) && <div className="meeting-error text-body-sm" role="alert"><span>{state.error || call.error}</span><Button label="Connection settings" variant="ghost" onClick={openSettings} /></div>}
      {connected && call.audioBlocked && <div className="meeting-recovery"><Button label="Enable audio playback" onClick={() => { void media.resumeAudio(); }} /></div>}
      <div className="meeting-content">
        <div className="meeting-stage" ref={video}>
          {call.screens.length ? <div className="meeting-screen-grid">{call.screens.map(screen => <div className="meeting-screen-tile" key={screen.id}><Video stream={screen.video} label={`${screen.presenter}’s screen`} /><div className="meeting-screen-caption"><Icon name="screen" /><span>{screen.presenter}’s screen</span><span className="meeting-live">Live</span></div></div>)}<div className="meeting-view-actions"><Button label="Stop watching" variant="ghost" onClick={() => media.changeWatch()} /></div></div>
            : call.video ? <div className="meeting-focused-screen"><Video stream={call.video} label="Shared screen" /><div className="meeting-focused-caption"><span className="text-body-sm">{watching?.presenter}’s screen</span><div className="meeting-view-actions"><label className="sr-only" htmlFor="meeting-view-quality">Viewer quality</label><select className="buzz-input" id="meeting-view-quality" data-size="sm" value={call.quality} onChange={event => media.quality(event.target.value === "auto" ? "auto" : Number(event.target.value))}><option value="auto">Auto quality</option>{call.layers.map(layer => <option key={layer.value} value={layer.value}>{layer.height}p</option>)}</select><Button label="Stop watching" variant="ghost" onClick={() => media.changeWatch()} /></div></div></div>
            : call.participants.length ? <Roster call={call} tiles /> : <div className="meeting-empty"><div className="meeting-empty-icon"><Icon name="headphones" /></div><h3 className="text-body-lg">Make room for a conversation</h3><p className="text-body-sm text-subtle">Join {state.selected} to talk, share a screen,<br />or work through something together.</p><Button label={`Join ${state.selected}`} icon="headphones" variant="prominent" onClick={() => join(state.selected)} /><span className="text-caption text-metadata">Your microphone turns on when you join.</span></div>}
          {fullscreenError && <p role="alert" className="text-body-sm text-danger">{fullscreenError}</p>}
        </div>
        {(call.streams.length > 0 || call.sharing) && <aside className="meeting-streams" aria-label="Live streams"><div className="meeting-streams-header"><h3 className="text-caption text-metadata">Screen sharing</h3>{call.streams.length > 1 && <Button label="Watch all screens" icon="screen" iconOnly variant="ghost" onClick={() => media.watchAll()} />}</div>
          {call.sharing && <div className="meeting-preview"><Video stream={call.sharing.preview} label="Your stream preview" /><div className="meeting-preview-caption"><span className="text-caption text-subtle">{call.sharing.label} · Your screen</span><Button label="Change source" icon="screen" iconOnly variant="ghost" disabled={call.picking || call.stopping || !connected} onClick={() => { void media.share(preset); }} /></div></div>}
          {call.streams.map(stream => <button className="navigation-item" data-buzz-ui="" data-variant="row" data-selected={stream.id === call.watching || undefined} type="button" key={stream.id} aria-label={`Watch ${stream.presenter}’s stream`} aria-pressed={stream.id === call.watching} disabled={!connected} onClick={() => media.changeWatch(stream.id)}><Icon name="screen" /><span className="navigation-item-label">{stream.presenter}’s screen</span><span className="meeting-live">Live</span></button>)}
        </aside>}
      </div>
      {call.phase !== "idle" && <footer className="meeting-footer"><div className="meeting-footer-status text-caption"><span className="meeting-status-dot" /><span>{call.phase === "connected" ? "Connected" : call.phase === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span></div><Controls call={call}>
        {call.sharing ? <Button label="Stop sharing" icon="screen" iconOnly active disabled={call.stopping} onClick={() => { void media.stopSharing(); }} /> : <Button label={call.picking ? "Choosing screen…" : "Share screen"} icon="screen" iconOnly disabled={!connected || call.picking || call.stopping} onClick={() => { void media.share(preset); }} />}
      </Controls><details className="meeting-quality"><summary aria-label="Stream options" title="Stream options"><Icon name="settings" /></summary><label className="text-caption">Share quality<select className="buzz-input" data-size="sm" value={preset} disabled={call.picking} onChange={event => setPreset(event.target.value as Preset)}>{Object.entries(presets).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label></details></footer>}
    </section>;
  }
  function Toolbar() {
    const call = useCall(); const state = useUI();
    if (call.phase === "idle" || state.visible > 0) return null;
    return <div className="meeting-toolbar" data-buzz-ui=""><Button label={call.roomName || "Meetings"} icon="headphones" variant="ghost" onClick={open} /><Controls call={call} compact /></div>;
  }
  ctx.settingsCards.register({ id: "connection", title: "Meetings", component: Settings });
  const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="' + glyphs.headphones + '"/></svg>')}`;
  ctx.pages.register({ id: "meeting", title: "Meetings", primary: true, placement: "dock", icon, layout: "workspace", component: Page, sidebar: Sidebar });
  ctx.panels.register({ id: "meeting-call", title: "Meeting", matches: () => false, component: Page, toolbar: Toolbar });
}
