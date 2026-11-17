# Buzz Meetings

Voice rooms, cameras, and screen sharing in one Buzz app. Click **General Voice**
to join audio, see connected participants beneath the room, and share or watch
screens without copying a separate video invitation. Meetings uses the Rust
admission server and LiveKit for voice and video.

![Three participants sharing two screens in Meetings](docs/screenshots/meetings.png)

## Install in Buzz

1. Open **Settings → Plugins → Manage plugins → Add**.
2. Paste `https://github.com/h2s2-studio/buzz-meetings` into **Git or GitHub repository**.
   Leave Folder empty. Choose **Find → Install plugin** and enable **Meetings**.
3. Open **Meetings** in the app dock. Its **Voice Channels** sidebar includes
   **General Voice** automatically.
4. Click the room to join. Allow microphone permission when your system asks.
   Your avatar and name appear after connecting. Click **Share screen** to choose
   a screen or window in the system picker. Use **Watch** to view someone’s
   stream, or **Watch all screens** for a grid.

Your community must run the [Meetings deployment](docs/deployment.md). By default,
the app uses the community’s `/rooms` endpoint. For a separate service, open
the room header’s **Connection settings** button and enter its `wss://…/rooms` address and access key.
Access keys stay in memory and are cleared when your identity or community changes.

The root contains the built `plugin.js` and `manifest.json`; Buzz does not run a
build at install. Pin **Branch or tag** to `v0.1.1` for this release, or leave it
empty to follow main and use **Check for updates**.

## In a room

- Mute, deafen, turn your camera on/off, or leave from the call controls.
  Deafen also mutes your microphone; undeafening leaves it muted until you unmute.
- Change your screen source without ending the call. Stop sharing independently
  of leaving voice. Balanced and Sharp text presets offer up to 720p/30 and
  1080p/30; a focused viewer can choose available simulcast layers.
- Switch back to Messages while audio and screen sharing continue. The Buzz
  toolbar retains return-to-room, mute, deafen, and leave actions.
- Leaving, changing community/identity, or disabling the plugin stops capture
  and remote playback. Reconnecting is shown explicitly.
- Room chat uses Buzz’s native conversation reader and composer alongside the call.
  A uniquely matching joined channel is linked automatically; otherwise choose
  a channel or explicitly create an open one. Chat remains available when voice
  is disconnected.
- Add named rooms with the sidebar’s **+**. Room names are saved on this device;
  others add the same name to join the same room on the same community/service.

## Release boundaries

This first release provides the core room/call workflow; it is not full Discord
or Teams feature parity. The roster is live for the room you joined. Cross-room
occupancy and shared room discovery are not implemented. Display names and
avatars are supplied from client Buzz profiles; broker admission uses a deployment
access key or private proxy, not verified Buzz channel membership. Camera,
microphone, and screen capture depend on the desktop webview and OS permissions.
Application/system audio sharing is not implemented in this release.

The media workflow is exercised against the Rust broker and a real local
LiveKit instance using synthetic audio/video in Chromium and WebKit. Physical
microphone, camera, screen capture, and restrictive-network checks remain required
for your deployment. Native Huddles and its agent voice integration are separate.

## Develop

```sh
npm ci
npm run build
npm run check:build
npm test
cargo fmt --all --check
cargo test --locked --workspace
cargo build --locked
npx playwright install chromium webkit
LIVEKIT_SERVER_BIN=livekit-server npm run test:media
```

For reloadable local development, install the folder through **Manage plugins →
Add → Browse** under Add from folder, then reload after rebuilding.

Buzz Meetings consolidates the H2S2 Studio voice-channels and Huddle
screen-sharing prototypes. The existing video transport and its Git history are
retained here. Apache-2.0; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
