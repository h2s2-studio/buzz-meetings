import * as React from "react";
import { createRoot } from "react-dom/client";
import { fixtureWorkspaceHost } from "./workspace-browser.js";
const cleanups = [], listeners = new Set(), captures = [], microphones = [], cameras = [], contexts = [];
const query = new URLSearchParams(location.search);
const displayName = query.get("viewer") || "Alex";
const viewer = ({ Alex: "a", Riley: "b", Sam: "c" }[displayName] || "a").repeat(64);
const origin = query.get("relay") || location.origin;
const host = await fixtureWorkspaceHost({ viewer, realm: query.get("realm") || "default" });
let connection = { status: "ready", viewer, origin, scope: origin + ":" + viewer,
  session: { ...host.session, profiles: { snapshot: () => new Map([[viewer, { name: displayName, picture: "https://example.com/avatar.png" }]]), subscribe: () => () => {} }, media: () => undefined } };
const settings = new Map();
let page, panel, rejectCapture = false, rejectMicrophone = query.has("deny"), holdMicrophone = query.has("hold");
let releaseMicrophone, navigation, microphoneRequests = 0;
let holdCamera = false, holdScreen = false, releaseCamera, releaseScreen, denyCamera = false;
const cameraSettingsCommands = [];
// These two components stand in for Buzz's native conversation/Canvas owners.
// Their shared state comes from the test HTTP service, never browser-local data.
function Workspace({ target, label }) {
  const shared = React.useSyncExternalStore(host.subscribe, host.snapshot);
  const [draft, setDraft] = React.useState(""), [error, setError] = React.useState("");
  const channel = shared.channels.find(channel => channel.id === target.channelId);
  const messages = shared.messages[target.channelId] || [];
  const readOnly = !channel || channel.readOnly;
  return React.createElement("section", { className: "fixture-chat", "aria-label": "Native conversation", "data-channel": target.channelId },
    React.createElement("header", { className: "panel-header" }, React.createElement("div", { className: "panel-header-label" }, React.createElement("h2", null, label))),
    React.createElement("div", { className: "fixture-chat-history" }, React.createElement("p", { className: "text-caption text-metadata" }, "Conversation contract fixture"), ...messages.map(message => React.createElement("p", { key: message.id, className: "text-body-sm" }, message.text))),
    error && React.createElement("p", { role: "alert" }, error),
    React.createElement("form", { onSubmit(event) { event.preventDefault(); if (draft.trim() && !readOnly) void host.request("message", { id: target.channelId, text: draft }).then(() => { setDraft(""); setError(""); }).catch(error => setError(error.message)); } }, React.createElement("input", { className: "buzz-input", "aria-label": "Room message", placeholder: "Message the room…", value: draft, disabled: readOnly, onChange: event => setDraft(event.target.value) })));
}
function Canvas({ channelContext }) {
  const shared = React.useSyncExternalStore(host.subscribe, host.snapshot);
  const id = channelContext.channelId, current = shared.canvases[id];
  const channel = shared.channels.find(channel => channel.id === id);
  const [base, setBase] = React.useState(current), [draft, setDraft] = React.useState(current?.content || "");
  const [dirty, setDirty] = React.useState(false), [error, setError] = React.useState(""), [busy, setBusy] = React.useState(false);
  const readOnly = !channel || channel.readOnly;
  // Buzz's Canvas editor loads on mount or explicit reload. A remote save does
  // not replace the open editor, even when its draft is clean.
  const load = () => { setBase(current); setDraft(current?.content || ""); setDirty(false); setError(""); };
  return React.createElement("section", { className: "fixture-canvas", "aria-label": "Native Canvas", "data-channel": id },
    React.createElement("p", { className: "text-caption text-metadata" }, "Canvas contract fixture"),
    React.createElement("label", null, "Shared notes", React.createElement("textarea", { className: "buzz-input", "aria-label": "Shared notes", value: draft, readOnly, disabled: busy, onChange: event => { setDraft(event.target.value); setDirty(true); } })),
    error && React.createElement("p", { role: "alert" }, error),
    React.createElement("div", { className: "fixture-canvas-actions" },
      React.createElement("button", { type: "button", className: "buzz-button", "data-buzz-ui": "", "data-variant": "subtle", "data-size": "sm", disabled: readOnly || !dirty || busy, onClick() { setBusy(true); void host.request("canvas", { id, content: draft, expected: base?.id }).then(saved => { setBase(saved); setDirty(false); setError(""); }).catch(error => setError(error.message)).finally(() => setBusy(false)); } }, React.createElement("span", { className: "buzz-button-label" }, "Save notes")),
      React.createElement("button", { type: "button", className: "buzz-button", "data-buzz-ui": "", "data-variant": "ghost", "data-size": "sm", onClick: load }, React.createElement("span", { className: "buzz-button-label" }, "Load current notes"))));
}
const nativePanels = [{ id: "canvas", pluginId: "buzz.channels", revision: "fixture", component: Canvas }];
const mockMicrophone = async (options) => {
  if (options.video) {
    if (denyCamera) { denyCamera = false; throw new DOMException("Permission denied", "NotAllowedError"); }
    if (holdCamera) await new Promise(resolve => { releaseCamera = resolve; });
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext("2d"); context.fillStyle = "#516683"; context.fillRect(0, 0, 640, 360);
    const stream = canvas.captureStream(12); cameras.push(stream.getVideoTracks()[0]);
    const timer = setInterval(() => { if (stream.getVideoTracks()[0].readyState === "ended") clearInterval(timer); else context.fillRect(0, 0, 640, 360); }, 84);
    return stream;
  }
  microphoneRequests++;
  if (holdMicrophone) await new Promise(resolve => { releaseMicrophone = resolve; });
  if (rejectMicrophone) throw new DOMException("Permission denied", "NotAllowedError");
  const audio = new AudioContext(); contexts.push(audio); void audio.resume();
  const oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
  oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
  const track = destination.stream.getAudioTracks()[0]; microphones.push(track);
  return destination.stream;
};
const mockScreen = async ({ video }) => {
  if (holdScreen) await new Promise(resolve => { releaseScreen = resolve; });
  if (rejectCapture) { rejectCapture = false; throw new DOMException("Capture canceled", "NotAllowedError"); }
  const canvas = document.createElement("canvas"); canvas.width = video === true ? 1280 : video.width.ideal; canvas.height = video === true ? 720 : video.height.ideal;
  const context = canvas.getContext("2d"); let frame = 0;
  const draw = () => {
    ++frame;
    context.fillStyle = "#fafafa"; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / 1280; context.save(); context.scale(scale, scale);
    context.fillStyle = "#f0f0f0"; context.fillRect(0, 0, 1280, 64);
    context.fillStyle = "#666"; context.font = "18px sans-serif"; context.fillText("" + displayName + " · Shared workspace", 32, 40);
    context.fillStyle = "#232323"; context.font = "32px sans-serif"; context.fillText(displayName === "Alex" ? "A room for every conversation" : "Meetings · Release plan", 70, 145);
    context.fillStyle = "#777"; context.font = "18px sans-serif"; context.fillText(displayName === "Alex" ? "ONE PLACE TO TALK, SHOW, AND BUILD TOGETHER" : "VOICE ROOMS / SCREEN SHARING / NATIVE BUZZ", 70, 185);
    const items = displayName === "Alex" ? ["Join a voice channel", "Bring your team into the room", "Share what you’re working on"] : ["Transport and room admission", "Participant and speaker states", "Desktop and device validation"];
    items.forEach((item, index) => {
      context.fillStyle = "#eee"; context.fillRect(70, 240 + index * 100, 1130, 76);
      context.fillStyle = "#555"; context.font = "22px sans-serif"; context.fillText("0" + (index + 1), 100, 286 + index * 100);
      context.fillStyle = "#333"; context.fillText(item, 180, 286 + index * 100);
    });
    context.fillStyle = "#aaa"; context.font = "15px sans-serif"; context.fillText("Live test screen · " + frame, 70, 635);
    context.restore();
  };
  draw(); const stream = canvas.captureStream(12), track = stream.getVideoTracks()[0];
  Object.defineProperty(track, "label", { value: `Window ${captures.length + 1}` }); captures.push(track);
  const interval = setInterval(() => { if (track.readyState === "live") draw(); else clearInterval(interval); }, 84);
  return stream;
};
const devices = navigator.mediaDevices;
Object.defineProperty(navigator, "mediaDevices", { value: new Proxy(devices, { get(target, property) {
  if (property === "getUserMedia") return mockMicrophone;
  if (property === "getDisplayMedia") return mockScreen;
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
} }) });
const { apply } = await import("../plugin.js");
apply({ react: React, artifactStorage: host.storage,
  host: { async runCommand(id) { cameraSettingsCommands.push(id); return null; } },
  relay: { snapshot: () => connection, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
  conversation: { ui: { Workspace } },
  pages: { register(entry) { page = entry; } }, panels: { register(entry) { panel = entry; }, snapshot: () => nativePanels, subscribe: () => () => {} },
  settingsCards: { register(entry) { settings.set(entry.id, entry); } },
  navigation: { async open(target) { navigation?.(target); return { status: "opened" }; } },
  effect(setup) { cleanups.push(setup()); },
});
window.meetingTest = {
  workspaceControl: input => host.request("control", input),
  workspaceState: host.snapshot,
  navigate: target => navigation?.(target),
  cancelNextCapture() { rejectCapture = true; },
  denyNextCamera() { denyCamera = true; },
  cameraSettingsCommands: () => cameraSettingsCommands,
  holdCamera() { holdCamera = true; },
  releaseCamera() { holdCamera = false; releaseCamera?.(); },
  holdScreen() { holdScreen = true; },
  releaseScreen() { holdScreen = false; releaseScreen?.(); },
  microphoneRequests: () => microphoneRequests,
  microphoneStates: () => microphones.map(track => track.readyState),
  cameraStates: () => cameras.map(track => track.readyState),
  captureStates: () => captures.map(track => track.readyState),
  releaseMicrophone() { holdMicrophone = false; releaseMicrophone?.(); },
  switchCommunity() { connection = { ...connection, origin: "https://another.example", scope: "another" }; for (const listener of listeners) listener(); },
  disable() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
};
window.addEventListener("pagehide", () => { window.meetingTest.disable(); host.close(); for (const audio of contexts) void audio.close(); }, { once: true });
function Fixture() {
  const [open, setOpen] = React.useState(true);
  const [target, setTarget] = React.useState(query.get("workspace") ? { version: 1, kind: "page", route: { version: 1, params: { workspace: query.get("workspace") } } } : {});
  navigation = destination => {
    if (destination.kind === "settings") setOpen(destination.section);
    else {
      setOpen(true); setTarget(destination);
      const url = new URL(location.href);
      const workspace = destination.route?.params?.workspace || destination.params?.workspace;
      if (workspace) url.searchParams.set("workspace", workspace); else url.searchParams.delete("workspace");
      history.replaceState({}, "", url);
    }
  };
  const card = typeof open === "string" ? settings.get(open.split("/").at(-1)) : undefined;
  return React.createElement(React.Fragment, null,
    React.createElement("header", { className: "fixture-topbar" },
      React.createElement("div", { className: "fixture-brand text-body-sm" }, "Buzz", React.createElement("span", { className: "text-metadata" }, " / "), "Meetings"),
      React.createElement("button", { className: "buzz-button", "data-buzz-ui": "", "data-variant": "ghost", "data-size": "sm", onClick: () => setOpen(open === true ? false : true) }, React.createElement("span", { className: "buzz-button-label" }, open === true ? "Messages" : "Meetings")),
      React.createElement("div", { role: "toolbar", "aria-label": "Buzz toolbar" }, React.createElement(panel.toolbar))),
    card ? React.createElement("div", { className: "fixture-settings" }, React.createElement("h2", { className: "text-heading" }, card.title), React.createElement(card.component))
      : open ? React.createElement("div", { className: "fixture-layout" }, React.createElement(page.sidebar, null, React.createElement("nav", { className: "fixture-pages", style: { flex: 1, height: "100%" } }, React.createElement("button", { className: "navigation-item", "data-buzz-ui": "", "data-variant": "row" }, "Activity"))), React.createElement("div", { className: "fixture-main" }, React.createElement(page.component, { navigation: { target } })))
      : React.createElement("p", null, "Messages stay available during your meeting."));
}
createRoot(document.querySelector("#app")).render(React.createElement(Fixture));
