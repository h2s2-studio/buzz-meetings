import * as React from "react";
import { createRoot } from "react-dom/client";
const cleanups = [], listeners = new Set(), captures = [], microphones = [], cameras = [], contexts = [];
const query = new URLSearchParams(location.search);
const viewer = query.get("viewer") || "Alex";
const origin = query.get("relay") || location.origin;
let connection = { status: "ready", viewer, origin, scope: origin + ":" + viewer,
  session: { profiles: { snapshot: () => new Map([[viewer, { name: viewer, picture: "https://example.com/avatar.png" }]]), subscribe: () => () => {} }, media: () => undefined } };
let page, panel, rejectCapture = false, rejectMicrophone = query.has("deny"), holdMicrophone = query.has("hold");
let releaseMicrophone;
let navigation;
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
  const draw = () => { context.fillStyle = (++frame % 2 ? "#316586" : "#345d77"); context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "white"; context.font = "48px sans-serif"; context.fillText(viewer + " · " + frame, 40, 100); };
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
  pages: { register(entry) { page = entry; } }, panels: { register(entry) { panel = entry; } },
  navigation: { async open() { navigation?.(true); return { status: "opened" }; } },
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
      React.createElement("button", { onClick: () => setOpen(!open) }, open ? "Messages" : "Meetings"),
      React.createElement("div", { role: "toolbar", "aria-label": "Buzz toolbar" }, React.createElement(panel.toolbar))),
    open ? React.createElement("div", { className: "fixture-layout" }, React.createElement(page.sidebar), React.createElement(page.component))
      : React.createElement("p", null, "Messages stay available during your meeting."));
}
createRoot(document.querySelector("#app")).render(React.createElement(Fixture));
