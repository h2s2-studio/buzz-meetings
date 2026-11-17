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
  navigation: { open(target: { version: 1; kind: "plugin"; pluginId: string; pageId: string }): Promise<unknown> };
  pages: { register(page: { id: string; title: string; primary: boolean; placement: "dock"; layout: "workspace";
    icon: string; component: ReactRuntime.ComponentType; sidebar: ReactRuntime.ComponentType<{ children?: ReactRuntime.ReactNode }> }): void };
  panels: { register(panel: { id: string; title: string; matches(target: string): boolean;
    toolbar: ReactRuntime.ComponentType; component: ReactRuntime.ComponentType }): void };
};
export const inject = ["react", "relay", "pages", "panels", "navigation"];
const glyphs = {
  headphones: "M3 13v-1a9 9 0 0 1 18 0v1M3 13h3v7H3zm18 0h-3v7h3z",
  microphone: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8",
  screen: "M3 4h18v13H3zM8 21h8m-4-4v4",
  camera: "M3 5h12v14H3zm12 5 6-4v12l-6-4z",
  leave: "m4 14 4-2 3 3h2l3-3 4 2v5h-4l-2-3h-4l-2 3H4z",
  plus: "M12 5v14M5 12h14", expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
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
  let ui = { rooms, selected, broker, accessKey, error: "" };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function publish(error = "") {
    ui = { rooms, selected, broker, accessKey, error };
    for (const listener of listeners) listener();
  }
  function useUI() { return useSyncExternalStore(subscribe, () => ui); }
  function useCall() { return useSyncExternalStore(media.subscribe, media.snapshot); }
  const open = () => { void ctx.navigation.open({ version: 1, kind: "plugin", pluginId, pageId: "meeting" }); };
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
    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name]} /></svg>;
  }
  function Button({ label, icon, active, danger, ...props }: ReactRuntime.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string; icon?: keyof typeof glyphs; active?: boolean; danger?: boolean;
  }) {
    return <button {...props} type="button" className="buzz-button meeting-control" data-buzz-ui="" data-size="sm"
      data-variant={danger ? "destructive" : active ? "prominent" : "subtle"}>
      <span className="buzz-button-label">{icon && <Icon name={icon} />}{label}</span>
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
        {person.muted && <span className="meeting-muted">Muted</span>}
        {call.streams.some(stream => stream.presenter === person.name) && <span className="meeting-live">Live</span>}
      </li>)}
    </ul>;
  }
  function Controls({ call, compact = false }: { call: RoomSnapshot; compact?: boolean }) {
    const [busy, setBusy] = useState(false);
    async function change(action: () => Promise<void>) { setBusy(true); try { await action(); } finally { setBusy(false); } }
    if (call.phase === "idle") return null;
    return <div className="meeting-callbar" role="group" aria-label="Meeting controls" data-compact={compact || undefined}>
      <span className="meeting-connection" role="status">{call.phase === "connected" ? "Voice connected" : call.phase === "reconnecting" ? "Reconnecting…" : "Connecting…"}<small>{call.roomName}</small></span>
      <Button label={call.muted ? "Unmute" : "Mute"} icon="microphone" active={call.muted} disabled={busy || call.phase !== "connected" || call.deafened}
        onClick={() => { void change(() => media.setMuted(!call.muted)); }} />
      <Button label={call.deafened ? "Undeafen" : "Deafen"} icon="headphones" active={call.deafened} disabled={busy || call.phase !== "connected"}
        onClick={() => { void change(() => media.setDeafened(!call.deafened)); }} />
      {!compact && <Button label={call.camera ? "Camera off" : "Camera on"} icon="camera" active={call.camera} disabled={busy || call.phase !== "connected"}
        onClick={() => { void change(() => media.setCamera(!call.camera)); }} />}
      <Button label="Leave room" icon="leave" danger onClick={() => media.leave()} />
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
      {children}<nav aria-label="Meeting rooms"><header><h2>Voice Channels</h2><button type="button" aria-label="Add voice channel" onClick={() => setAdding(!adding)}><Icon name="plus" /></button></header>
        {adding && <form onSubmit={add}><label>Room name<input value={name} maxLength={64} autoFocus onChange={event => setName(event.target.value)} /></label><Button label="Add room" onClick={add} /></form>}
        {state.rooms.map(name => <div className="meeting-room" key={name}>
          <button type="button" className="navigation-item" aria-label={`Join ${name}`} aria-current={call.roomName === name ? "true" : undefined}
            onClick={() => join(name)}><Icon name="headphones" /><span>{name}</span>{call.roomName === name && <span className="meeting-count">{call.participants.length || "…"}</span>}</button>
          {call.roomName === name && <Roster call={call} />}
        </div>)}
      </nav><Controls call={call} compact />
    </div>;
  }
  function Video({ stream, label }: { stream: MediaStream; label: string }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => { const element = ref.current; if (!element) return; element.srcObject = stream;
      return () => { element.srcObject = null; }; }, [stream]);
    return <video ref={ref} aria-label={label} autoPlay muted playsInline />;
  }
  function Page() {
    const state = useUI(); const call = useCall(); const video = useRef<HTMLDivElement>(null);
    const [preset, setPreset] = useState<Preset>("balanced"); const [fullscreenError, setFullscreenError] = useState("");
    const connected = call.phase === "connected";
    const watching = call.streams.find(stream => stream.id === call.watching);
    return <section className="meeting-page" data-buzz-ui="" aria-label="Meeting">
      <header className="meeting-header"><div><h1>{call.roomName || state.selected}</h1><p>{call.phase === "idle" ? "Join voice and spend some time together." : `${call.participants.length} connected`}</p></div><Icon name="headphones" /></header>
      {(state.error || call.error) && <p className="meeting-error" role="alert">{state.error || call.error}</p>}
      {connected && call.audioBlocked && <Button label="Enable audio playback" onClick={() => { void media.resumeAudio(); }} />}
      <div className="meeting-content">
        <div className="meeting-stage" ref={video}>
          {call.screens.length ? <div className="meeting-screen-grid">{call.screens.map(screen => <div key={screen.id}><Video stream={screen.video} label={`${screen.presenter}’s screen`} /><span>{screen.presenter} · Live</span></div>)}<Button label="Stop watching" onClick={() => media.changeWatch()} /></div> : call.video ? <><div className="meeting-stage-heading"><span>Watching {watching?.presenter}</span><Button label="Fullscreen" icon="expand" onClick={() => {
            const element = video.current; if (element?.requestFullscreen) void element.requestFullscreen().catch(() => setFullscreenError("Fullscreen isn’t available in this window."));
            else setFullscreenError("Fullscreen isn’t available in this window.");
          }} /></div><Video stream={call.video} label="Shared screen" /><div className="meeting-stage-actions"><Button label="Stop watching" onClick={() => media.changeWatch()} />
            <label>Viewer quality<select value={call.quality} onChange={event => media.quality(event.target.value === "auto" ? "auto" : Number(event.target.value))}><option value="auto">Auto</option>{call.layers.map(layer => <option key={layer.value} value={layer.value}>{layer.height}p</option>)}</select></label></div></>
            : call.participants.length ? <Roster call={call} tiles /> : <div className="meeting-empty"><Icon name="headphones" /><h2>A place to meet</h2><p>Click a voice channel to join. Your microphone turns on when you connect.</p><Button label={`Join ${state.selected}`} icon="headphones" onClick={() => join(state.selected)} /></div>}
          {fullscreenError && <p role="alert">{fullscreenError}</p>}
        </div>
        {(call.streams.length > 0 || call.sharing) && <aside className="meeting-streams" aria-label="Live streams"><h2>Live screens</h2>{call.streams.length > 1 && <Button label="Watch all screens" onClick={() => media.watchAll()} />}
          {call.sharing && <div className="meeting-preview"><Video stream={call.sharing.preview} label="Your stream preview" /><span>{call.sharing.label} · Your screen</span><Button label="Change source" disabled={call.picking || call.stopping || !connected} onClick={() => { void media.share(preset); }} /></div>}
          {call.streams.map(stream => <button className="meeting-stream" type="button" key={stream.id} aria-label={`Watch ${stream.presenter}’s stream`} aria-pressed={stream.id === call.watching} disabled={!connected} onClick={() => media.changeWatch(stream.id)}><Icon name="screen" /><span>{stream.presenter}</span><span className="meeting-live">Live</span></button>)}
        </aside>}
      </div>
      <footer><div className="meeting-share-actions"><label>Share quality<select value={preset} disabled={call.picking} onChange={event => setPreset(event.target.value as Preset)}>{Object.entries(presets).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label>
        {call.sharing ? <Button label="Stop sharing" icon="screen" danger disabled={call.stopping} onClick={() => { void media.stopSharing(); }} /> : <Button label={call.picking ? "Choosing screen…" : "Share screen"} icon="screen" disabled={!connected || call.picking || call.stopping} onClick={() => { void media.share(preset); }} />}</div>
        <Controls call={call} />
      </footer>
      <details className="meeting-settings"><summary>Connection settings</summary><label>Meeting service<input value={state.broker} placeholder="wss://meet.example.org/rooms" onChange={event => { broker = event.target.value; publish(); }} /></label>
        <label>Access key<input type="password" autoComplete="off" value={state.accessKey} onChange={event => { accessKey = event.target.value; publish(); }} /></label>
        <p>Use your community’s meeting service. Access keys stay in memory on this device.</p>
      </details>
    </section>;
  }
  function Toolbar() {
    const call = useCall();
    if (call.phase === "idle") return null;
    return <div className="meeting-toolbar" data-buzz-ui=""><Button label={call.roomName || "Meeting"} icon="headphones" onClick={open} /><Controls call={call} compact /></div>;
  }
  const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="' + glyphs.headphones + '"/></svg>')}`;
  ctx.pages.register({ id: "meeting", title: "Meeting", primary: true, placement: "dock", icon, layout: "workspace", component: Page, sidebar: Sidebar });
  ctx.panels.register({ id: "meeting-call", title: "Meeting", matches: () => false, component: Page, toolbar: Toolbar });
}
