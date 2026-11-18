# Changelog

## Unreleased

- Icon-only call controls, upward sharing settings drawer, pane-size-aware layout, native workspace menu action, bounded stage tiles, and retained local preferences.
- Native agent selection, channel access review, explicit chat tasks, Activity and Stop controls.
- Optional self-hosted speech service for speaker-attributed live context and an owner-enabled autonomous task role. Separate participant microphones retain overlapping speech and timestamps. Native agent tools publish task progress as the agent.
- Room-visible live listening status; stopping listening preserves the call.
- Shared-screen sound capability and media-source grant, with source ownership and viewer subscription tied to the watched screens.


## 0.1.1 — Native Buzz presentation

- Use Buzz’s pane headers, navigation rows, controls, typography and color roles.
- Keep a single call bar in the meeting; show toolbar controls when navigating away.
- Move connection setup into a dedicated Meetings Settings destination.
- Add room chat through Buzz’s native conversation workspace.
- Explain when the server must be upgraded instead of showing “Invalid room request.”
- Verify fixtures against Buzz 1.0.4’s real design-system styles in light and dark.

## 0.1.0 — Meetings

- Consolidate the voice-room and screen-sharing experience into a Meetings dock app.
- Create the Voice Channels section with General Voice automatically.
- Join named rooms with microphone audio and live participants from one click.
- Add mute, deafen, camera, and persistent leave controls.
- Reuse the LiveKit screen transport with source changes, quality selection, and a multiple-screen grid.
- Package the Rust admission server and a Compose/Caddy deployment beside a Buzz relay.
- Stop capture and playback on leave, community changes, plugin shutdown, and canceled joins.

The earlier screen-sharing transport history remains in this repository.
