# Changelog

## Unreleased

## 0.3.0 — Persistent meetings, live agents and shared work

- One Meetings list. A workspace is `Home · Chat · Library`, plus `Call` while in one; Library holds documents and boards, notes and meeting records. Earlier quick rooms appear as Temporary meetings.
- Call view with a stage and filmstrip, labeled controls, and a Chat / Transcript / Agent side panel. A viewer's stage changes only when they change it.
- Pre-join Home: an audio check, join muted, and who is already in the call when the meeting service supports it.
- Shared speaker-attributed transcripts and saved meeting records. Each call has its own occurrence ID, so tasks and records never carry over from an earlier call. A resumed transcript no longer duplicates speech; an unsaved transcript survives leaving and rejoining until it is saved or discarded; records keep same-name speakers distinct.
- Live agents in a call: add one from the roster, speak to give it work, and see its status on its tile. An agent can ask a question on its tile with buttons; its owner's click answers it and a spoken reply is offered to the agent as a suggestion. Results open in the call's own chat.
- Agents can search earlier meeting records in channels they belong to, and are told to cite what they rely on.
- Preview: documents and whiteboards with co-editing, per-block authors and Keep mine / Keep theirs when two edits clash. They are kept in memory only and are not saved to Buzz yet.
- Quieter design throughout: no tinted fills or colored outlines, one dropdown style and one expandable-row style.

Requires an updated meeting service for per-call IDs and the pre-join participant list; the plugin still works against the 0.2.1 service without them. Native agent execution, physical devices, screen readers and long calls have not been accepted in the Buzz app.

Earlier unreleased notes, now part of 0.3.0:

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
