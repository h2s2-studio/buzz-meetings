import * as React from "react";
import { createRoot } from "react-dom/client";
import { apply } from "../plugin.js";

const viewer = "a".repeat(64);
const authority = "b".repeat(64);
const guest = "c".repeat(64);
const studio = "10000000-0000-4000-8000-000000000001";
const playtesting = "10000000-0000-4000-8000-000000000002";
const general = "10000000-0000-4000-8000-000000000003";
const guests = "10000000-0000-4000-8000-000000000004";
const call = "20000000-0000-4000-8000-000000000001";
const now = Math.floor(Date.now() / 1000);

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    snapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update(next) { value = next; for (const listener of listeners) listener(); },
  };
}

const inventory = store({ channels: [
  { id: studio, name: "Studio", channelType: "stream", members: [viewer, guest], labels: ["h2s2:voice"] },
  { id: playtesting, name: "Playtesting", channelType: "stream", private: true, members: [viewer] },
  { id: general, name: "general", channelType: "stream", members: [viewer] },
  { id: guests, name: "Announcements", channelType: "stream", readOnly: true, members: [viewer] },
] });
const events = store({ status: "ready", events: [] });
const profiles = store(new Map([[viewer, { name: "Alex" }], [guest, { name: "Riley" }]]));
const observed = [];
const session = {
  relayAuthor: authority,
  channels: { list: inventory.snapshot, subscribeList: inventory.subscribe },
  profiles,
  observe(filters) {
    const view = { filters, disposed: false };
    observed.push(view);
    return { ...events, async refresh() {}, dispose() { view.disposed = true; } };
  },
};
const relay = store({ scope: "one", status: "ready", viewer, session });
let contribution;
let card;
apply({
  react: React,
  relay,
  settingsCards: { register(entry) { card = entry; } },
  reflect: { get: () => ({ version: 1, register(entry) { contribution = entry; } }) },
  effect(setup) { window.addEventListener("pagehide", setup(), { once: true }); },
});
function record(kind, author, who, age) {
  return {
    id: `${kind}:${who}`, kind, pubkey: author, created_at: now - age,
    tags: [["h", studio], ["p", who]], content: JSON.stringify({ ephemeral_channel_id: call }),
  };
}
window.fixture = {
  join() {
    events.update({ status: "ready", events: [
      record(48100, viewer, viewer, 20),
      record(48101, authority, viewer, 10),
      record(48101, authority, guest, 5),
    ] });
  },
  leave() {
    events.update({ status: "ready", events: [
      ...events.snapshot().events, record(48103, authority, viewer, 1),
    ] });
  },
  activeViews: () => observed.filter((view) => !view.disposed).map(({ filters }) => filters[0]["#h"][0]),
  revoke() {
    inventory.update({ channels: inventory.snapshot().channels.filter((channel) => channel.id !== studio) });
  },
  switchCommunity() { relay.update({ ...relay.snapshot(), scope: "two" }); },
};

function Fixture() {
  const [opened, setOpened] = React.useState("general");
  const { channels } = React.useSyncExternalStore(inventory.subscribe, inventory.snapshot);
  function row(channel) {
    const original = <button type="button" data-buzz-ui="" data-variant="row" data-channel-id={channel.id}
      data-selected={opened === channel.name ? "" : undefined}
      className="navigation-item fixture-channel" onClick={() => setOpened(channel.name)}>
      <span aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
          {channel.private ? <path d="M5 6V5a3 3 0 0 1 6 0v1M3 6h10v8H3z" /> : <path d="M6 2 4 14M12 2l-2 12M2 6h12M1 10h12" />}
        </svg>
      </span><span className="navigation-item-label">{channel.name}</span>
    </button>;
    return <div key={channel.id}>{contribution.render({ kind: "team", channel }, original)}</div>;
  }
  return <>
    <nav aria-label="Buzz sidebar" className="buzz-sidebar-navigation">
      <header><span>All</span><span>Solo</span><span>Team</span></header>
      <section>
        <h2>Team</h2>
        <h3>Channels</h3>
        {channels.filter(({ id }) => id === general).map(row)}
        <h3>Voice channels</h3>
        {channels.filter(({ id }) => id === studio || id === playtesting).map(row)}
        <h3>Direct messages</h3>
        <div>Jordan</div>
      </section>
    </nav>
    <main>
      <h1>{card.title}</h1>
      <card.component active={() => true} />
      <p>Open channel <output>{opened}</output></p>
    </main>
  </>;
}
createRoot(document.querySelector("#app")).render(<Fixture />);
