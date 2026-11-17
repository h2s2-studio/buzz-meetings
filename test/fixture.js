import * as React from "react";
import { createRoot } from "react-dom/client";
const cleanups = [], listeners = new Set(), captures = [], microphones = [], cameras = [], contexts = [];
const query = new URLSearchParams(location.search);
const viewer = query.get("viewer") || "Alex";
const origin = query.get("relay") || location.origin;
let connection = { status: "ready", viewer, origin, scope: origin + ":" + viewer,
  session: { profiles: { snapshot: () => new Map([[viewer, { name: viewer, picture: "https://example.com/avatar.png" }]]), subscribe: () => () => {} }, media: () => undefined } };
let page, panel, settings, rejectCapture = false, rejectMicrophone = query.has("deny"), holdMicrophone = query.has("hold");
let releaseMicrophone;
let navigation;
let chatChannels = ["General Voice", "Design"].map((name, index) => ({ id: `chat-${index}`, name, channelType: "stream", members: [viewer] }));
const chatListeners = new Set();
connection.session.channels = { list: () => chatSnapshot, subscribeList(listener) { chatListeners.add(listener); return () => chatListeners.delete(listener); }, ensureList() {} };
let chatSnapshot = { channels: chatChannels };
function Workspace({ target, label }) {
  const [messages, setMessages] = React.useState([]), [draft, setDraft] = React.useState("");
  return React.createElement("section", { className: "fixture-chat", "aria-label": "Native conversation", "data-channel": target.channelId },
    React.createElement("header", { className: "panel-header" }, React.createElement("div", { className: "panel-header-label" }, React.createElement("h2", null, label))),
    React.createElement("div", { className: "fixture-chat-history" }, React.createElement("p", { className: "text-caption text-metadata" }, "Room conversation"), ...messages.map((text, index) => React.createElement("p", { key: index, className: "text-body-sm" }, text))),
    React.createElement("form", { onSubmit(event) { event.preventDefault(); if(draft.trim()) {setMessages([...messages,draft]);setDraft("");} } }, React.createElement("input", { className: "buzz-input", "aria-label": "Room message", placeholder: "Message the room…", value: draft, onChange: event => setDraft(event.target.value) })));
}
const mockMicrophone = async (options) => {
  if (options.video) {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext("2d"); context.fillStyle = "#516683"; context.fillRect(0, 0, 640, 360);
    const stream = canvas.captureStream(12); cameras.push(stream.getVideoTracks()[0]);
    const timer = setInterval(() => { if (stream.getVideoTracks()[0].readyState === "ended") clearInterval(timer); else context.fillRect(0, 0, 640, 360); }, 84);
    return stream;
  }
  if (holdMicrophone) await new Promise(resolve => { releaseMicrophone = resolve; });
  if (rejectMicrophone) throw new DOMException("Permission denied", "NotAllowedError");
  const audio = new AudioContext(); contexts.push(audio); void audio.resume();
  const oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
  oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
  const track = destination.stream.getAudioTracks()[0]; microphones.push(track);
  return destination.stream;
};
const mockScreen = async ({ video }) => {
  if (rejectCapture) { rejectCapture = false; throw new DOMException("Capture canceled", "NotAllowedError"); }
  const canvas = document.createElement("canvas"); canvas.width = video.width.ideal; canvas.height = video.height.ideal;
  const context = canvas.getContext("2d"); let frame = 0;
  const draw = () => {
    ++frame;
    context.fillStyle = "#fafafa"; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / 1280; context.save(); context.scale(scale, scale);
    context.fillStyle = "#f0f0f0"; context.fillRect(0, 0, 1280, 64);
    context.fillStyle = "#666"; context.font = "18px sans-serif"; context.fillText("" + viewer + " · Shared workspace", 32, 40);
    context.fillStyle = "#232323"; context.font = "32px sans-serif"; context.fillText(viewer === "Alex" ? "A room for every conversation" : "Meetings · Release plan", 70, 145);
    context.fillStyle = "#777"; context.font = "18px sans-serif"; context.fillText(viewer === "Alex" ? "ONE PLACE TO TALK, SHOW, AND BUILD TOGETHER" : "VOICE ROOMS / SCREEN SHARING / NATIVE BUZZ", 70, 185);
    const items = viewer === "Alex" ? ["Join a voice channel", "Bring your team into the room", "Share what you’re working on"] : ["Transport and room admission", "Participant and speaker states", "Desktop and device validation"];
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
apply({ react: React,
  relay: { snapshot: () => connection, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
  conversation: { ui: { Workspace } },
  pages: { register(entry) { page = entry; } }, panels: { register(entry) { panel = entry; } },
  settingsCards: { register(entry) { settings = entry; } },
  navigation: { async open(target) { navigation?.(target.kind === "settings" ? "settings" : true); return { status: "opened" }; } },
  effect(setup) { cleanups.push(setup()); },
});
window.meetingTest = {
  cancelNextCapture() { rejectCapture = true; },
  microphoneStates: () => microphones.map(track => track.readyState),
  cameraStates: () => cameras.map(track => track.readyState),
  captureStates: () => captures.map(track => track.readyState),
  releaseMicrophone() { holdMicrophone = false; releaseMicrophone?.(); },
  switchCommunity() { connection = { ...connection, origin: "https://another.example", scope: "another" }; for (const listener of listeners) listener(); },
  disable() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
};
window.addEventListener("pagehide", () => { window.meetingTest.disable(); for (const audio of contexts) void audio.close(); }, { once: true });
function Fixture() {
  const [open, setOpen] = React.useState(true); navigation = setOpen;
  return React.createElement(React.Fragment, null,
    React.createElement("header", { className: "fixture-topbar" },
      React.createElement("div", { className: "fixture-brand text-body-sm" }, "Buzz", React.createElement("span", { className: "text-metadata" }, " / "), "Meetings"),
      React.createElement("button", { className: "buzz-button", "data-buzz-ui": "", "data-variant": "ghost", "data-size": "sm", onClick: () => setOpen(open === true ? false : true) }, React.createElement("span", { className: "buzz-button-label" }, open === true ? "Messages" : "Meetings")),
      React.createElement("div", { role: "toolbar", "aria-label": "Buzz toolbar" }, React.createElement(panel.toolbar))),
    open === "settings" ? React.createElement("div", { className: "fixture-settings" }, React.createElement("h2", { className: "text-heading" }, "Meetings"), React.createElement(settings.component))
      : open ? React.createElement("div", { className: "fixture-layout" }, React.createElement(page.sidebar), React.createElement("div", { className: "fixture-main" }, React.createElement(page.component)))
      : React.createElement("p", null, "Messages stay available during your meeting."));
}
createRoot(document.querySelector("#app")).render(React.createElement(Fixture));
