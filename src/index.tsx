import type * as ReactRuntime from "react";
import { publicKey, recentParticipants, roomLifetime, uuid, type LifecycleEvent } from "./presence";
import css from "./sidebar.css";

type Channel = {
  id: string;
  name: string;
  channelType?: string;
  labels?: readonly string[];
  members?: readonly string[];
  ttlSeconds?: number;
  parentChannelId?: string;
  archived?: boolean;
  cached?: boolean;
  metadataCached?: boolean;
  metadataPending?: boolean;
  pending?: boolean;
  readOnly?: boolean;
  huddle?: boolean;
  private?: boolean;
  visibility?: string;
};
type Store<T> = { snapshot(): T; subscribe(listener: () => void): () => void };
type Filter = { kinds: number[]; "#h": string[]; since: number; limit: number };
type EventView = Store<{ status: string; events: readonly LifecycleEvent[] }> & {
  refresh(): Promise<void>;
  dispose(): void;
};
type Profile = { name?: string; picture?: string };
type Session = {
  relayAuthor?: string;
  channels: {
    list(): { channels: readonly Channel[] };
    subscribeList(listener: () => void): () => void;
    ensureList?(): void;
  };
  profiles: Store<ReadonlyMap<string, Profile>> & { ensure?(keys: string[], priority: "background"): Promise<unknown> };
  media?(url: string, size: "small"): string | undefined;
  observe?(filters: Filter[]): EventView;
};
type Connection = { status: string; scope?: string; viewer?: string; session: Session };
type SidebarRow = { kind: string; channel: Channel };
type SidebarRows = {
  version: number;
  register(entry: {
    version: 1;
    id: string;
    render(row: SidebarRow, original: ReactRuntime.ReactElement | null): ReactRuntime.ReactNode;
  }): void;
};
type PluginContext = {
  react: typeof ReactRuntime;
  relay: Store<Connection>;
  reflect: { get(name: "sidebarRows"): SidebarRows | undefined };
  settingsCards: { register(card: {
    id: string;
    title: string;
    component: ReactRuntime.ComponentType<{ active(): boolean }>;
  }): void };
  effect(setup: () => () => void): void;
};
type Preferences = { rooms: Record<string, boolean>; preview: boolean };
const initial: Preferences = { rooms: {}, preview: false };
const sample = ["Alex", "Riley", "Sam"];
const noParticipants: readonly string[] = [];
const channelLabel = "h2s2:voice";

export const inject = ["react", "relay", "settingsCards"];

function eligible(channel: Channel, connection: Connection) {
  return connection.status === "ready" && Boolean(connection.scope && connection.viewer) &&
    uuid.test(channel.id) && channel.channelType === "stream" && !channel.huddle && !channel.parentChannelId &&
    channel.ttlSeconds === undefined && !channel.archived && !channel.cached && !channel.metadataCached &&
    !channel.metadataPending && !channel.pending && !channel.readOnly && channel.members?.includes(connection.viewer!);
}

function selected(channel: Channel, prefs: Preferences) {
  return prefs.rooms[channel.id] ?? channel.labels?.includes(channelLabel) ?? false;
}

function storageKey(scope: string) {
  return `studio.h2s2.voice-channels:v1:${scope}`;
}

function readPreferences(scope: string): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(scope)) ?? "null");
    if (!saved || typeof saved.rooms !== "object" || !saved.rooms) return initial;
    return {
      rooms: Object.fromEntries(Object.entries(saved.rooms)
        .filter((entry): entry is [string, boolean] => uuid.test(entry[0]) && typeof entry[1] === "boolean")),
      preview: saved.preview === true,
    };
  } catch {
    return initial;
  }
}

function avatarSource(picture: string | undefined, session: Session) {
  if (!picture) return;
  if (picture.length <= 512 * 1024 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(picture)) return picture;
  if (picture.length > 2048) return;
  try {
    const url = new URL(picture);
    if (url.protocol === "https:" && !url.username && !url.password) return session.media?.(url.href, "small");
  } catch {
    return undefined;
  }
}

export function apply(ctx: PluginContext) {
  const React = ctx.react;
  const { useEffect, useId, useState, useSyncExternalStore } = React;
  const prefsByScope = new Map<string, Preferences>();
  const listeners = new Set<() => void>();
  const sidebar = ctx.reflect.get("sidebarRows");

  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });

  function getPreferences(scope?: string) {
    if (!scope) return initial;
    const previous = prefsByScope.get(scope);
    if (previous) return previous;
    const saved = readPreferences(scope);
    prefsByScope.set(scope, saved);
    return saved;
  }

  function usePreferences(scope?: string) {
    return useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      () => getPreferences(scope),
    );
  }

  function updatePreferences(scope: string, update: (latest: Preferences) => Preferences) {
    if (ctx.relay.snapshot().scope !== scope || ctx.relay.snapshot().status !== "ready") return;
    const next = update(getPreferences(scope));
    prefsByScope.set(scope, next);
    try { localStorage.setItem(storageKey(scope), JSON.stringify(next)); } catch { /* Keep this visit usable. */ }
    for (const listener of listeners) listener();
  }

  function usePresence(session: Session, parent: string) {
    const [roster, setRoster] = useState<{ session: Session; parent: string; people: readonly string[] }>();
    useEffect(() => {
      const author = session.relayAuthor;
      if (!session.observe || !author || !publicKey.test(author)) return;
      const since = Math.floor(Date.now() / 1000) - roomLifetime;
      let view: EventView;
      try {
        view = session.observe([
          { kinds: [48100], "#h": [parent], since, limit: 24 },
          { kinds: [48101, 48102, 48103], "#h": [parent], since, limit: 160 },
        ]);
      } catch {
        return;
      }
      function sync() {
        const snapshot = view.snapshot();
        const people = snapshot.status === "error" ? noParticipants :
          recentParticipants(snapshot.events, parent, author!, Math.floor(Date.now() / 1000));
        setRoster((previous) => previous?.session === session && previous.parent === parent &&
          previous.people.length === people.length && previous.people.every((person, i) => person === people[i])
          ? previous : { session, parent, people });
      }
      const stop = view.subscribe(sync);
      const refresh = () => { sync(); void view.refresh().catch(() => {}); };
      refresh();
      // A sidebar room may not have its conversation's live subscription open.
      const interval = setInterval(refresh, 20_000);
      return () => { clearInterval(interval); stop(); view.dispose(); };
    }, [session, parent]);
    return roster?.session === session && roster.parent === parent ? roster.people : noParticipants;
  }

  function Avatar({ source, name }: { source?: string; name: string }) {
    const [failed, setFailed] = useState<string>();
    return <span className="h2s2-voice-avatar" aria-hidden="true">
      {source && source !== failed
        ? <img alt="" src={source} onError={() => setFailed(source)} />
        : name.trim().slice(0, 1).toLocaleUpperCase()}
    </span>;
  }

  function RoomRow({ channel, original, session, preview }: {
    channel: Channel; original: ReactRuntime.ReactElement; session: Session; preview: boolean;
  }) {
    const people = usePresence(session, channel.id);
    const profiles = useSyncExternalStore(session.profiles.subscribe, session.profiles.snapshot);
    const [expanded, setExpanded] = useState(true);
    const [showAll, setShowAll] = useState(false);
    const listId = useId();
    const profileKeys = people.join(",");
    useEffect(() => {
      if (profileKeys) void session.profiles.ensure?.(profileKeys.split(","), "background")?.catch(() => {});
    }, [session, profileKeys]);

    const isSample = people.length === 0 && preview;
    const shown = isSample ? sample : people;
    const isPrivate = channel.private || channel.visibility === "private";
    const rosterLabel = isSample ? "Sample roster" : "Recent Huddle participants";
    const name = (key: string) => isSample ? key : profiles.get(key)?.name || `Participant ${key.slice(0, 6)}`;
    return <div className="h2s2-voice-room" data-buzz-ui="" data-voice-icon={isPrivate ? undefined : ""}>
      <div className="h2s2-voice-room-header">
        {original}
        {shown.length > 0 ? <button type="button" className="buzz-button" data-size="xs" data-buzz-ui=""
          data-variant="ghost" aria-label={`${channel.name} · ${rosterLabel} · ${shown.length}`}
          aria-controls={listId} aria-expanded={expanded} title={rosterLabel} onClick={() => setExpanded(!expanded)}>
          <span className="buzz-button-label">{isPrivate && <span className="h2s2-voice-glyph" aria-hidden="true" />}{shown.length}</span>
        </button> : isPrivate && <span className="h2s2-voice-room-icon" title="Voice channel">
          <span className="h2s2-voice-glyph" aria-hidden="true" />
        </span>}
      </div>
      <div id={listId} hidden={!expanded || shown.length === 0} className="h2s2-voice-roster">
        <div className="h2s2-voice-caption">{rosterLabel}</div>
        <ul aria-label={rosterLabel}>
          {(showAll ? shown : shown.slice(0, 5)).map((key) => <li key={key}>
            <Avatar source={isSample ? undefined : avatarSource(profiles.get(key)?.picture, session)} name={name(key)} />
            <span className="h2s2-voice-name" title={name(key)}>{name(key)}</span>
          </li>)}
        </ul>
        {shown.length > 5 && <button className="buzz-button" data-size="xs" data-variant="ghost"
          type="button" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show ${shown.length - 5} more`}</button>}
      </div>
    </div>;
  }

  function VoiceRow({ channel, original }: { channel: Channel; original: ReactRuntime.ReactElement }) {
    const connection = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const prefs = usePreferences(connection.scope);
    if (!eligible(channel, connection) || !selected(channel, prefs)) return original;
    return <RoomRow key={`${connection.scope}:${channel.id}`} channel={channel} original={original}
      session={connection.session} preview={prefs.preview} />;
  }

  function Settings({ active }: { active(): boolean }) {
    const connection = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const { scope, session } = connection;
    const list = useSyncExternalStore(session.channels.subscribeList, session.channels.list);
    const prefs = usePreferences(scope);
    useEffect(() => { if (active()) session.channels.ensureList?.(); }, [session, active]);
    if (sidebar?.version !== 1) return <p>This version of Buzz needs the sidebar rows plugin API.</p>;
    if (!scope || connection.status !== "ready") return <p>Connect to a Buzz community to choose rooms.</p>;

    const rooms = list.channels.filter((channel) => eligible(channel, connection))
      .sort((a, b) => a.name.localeCompare(b.name));
    return <div className="h2s2-voice-settings" data-buzz-ui="">
      <p>Choose which channels to mark for voice in your Team sidebar. Open a room and use the headphones button to start or join its Huddle.</p>
      {rooms.length ? <fieldset>
        <legend>Sidebar rooms</legend>
        {rooms.map((channel) => <label key={channel.id}>
          <input type="checkbox" checked={selected(channel, prefs)} onChange={(event) => {
            const checked = event.currentTarget.checked;
            updatePreferences(scope, (latest) => ({ ...latest, rooms: { ...latest.rooms, [channel.id]: checked } }));
          }} />
          {channel.name}
        </label>)}
      </fieldset> : <p>Voice channels appear here once Buzz confirms your membership in a Team channel.</p>}
      <label>
        <input type="checkbox" checked={prefs.preview} onChange={(event) => {
          const preview = event.currentTarget.checked;
          updatePreferences(scope, (latest) => ({ ...latest, preview }));
        }} />
        Show sample roster
      </label>
      <p className="h2s2-voice-caption">Selections are local to this device. Recent Huddle activity is advisory.</p>
    </div>;
  }

  ctx.settingsCards.register({ id: "rooms", title: "Voice channels", component: Settings });
  if (sidebar?.version === 1) sidebar.register({
    version: 1,
    id: "voice-rooms",
    render: (row, original) => row.kind === "team" && original
      ? <VoiceRow channel={row.channel} original={original} /> : original,
  });
}
