# Live transcripts

Open **Transcript** from the meeting header, then choose **Start transcription**.
A transcript works in any supported voice room, including rooms with no linked
chat or agent. Joining a call alone does not start transcription.

Each microphone remains a separate source. Entries show the speaker and time;
overlapping speech keeps its source identity. Text arrives after a short pause
or a bounded speech segment, rather than word by word. The room shows which
participant is transcribing. Other people can start their own local transcript;
the current service does not broadcast one shared transcript to every viewer.

**Pause transcription** stops this device's transcription and new input to its
live agent. **Stop listening** detaches the agent while transcription continues.
Neither action leaves voice or cancels tasks already running. Use native
**Stop task** for existing agent work. Closing Transcript or browsing Messages
keeps transcription running; the compact call controls retain a pause action.

Text remains available after pausing and leaving the call. Joining another call,
rejoining, changing community or identity, disabling the plugin, and reloading
clear this local buffer. It holds at most 2,000 segments and stops visibly when
full. This build has no permanent transcript archive, export, or editing flow.
Recognition can make mistakes; display names identify media participants rather
than verifying a Buzz identity.

At wide pane sizes, Transcript appears beside the stage. At smaller sizes,
Transcript, Agents and Chat use the available content area; close the selected
panel to return to the stage. The call controls remain visible below it.

## Ownership

- `room.ts` owns the voice connection, microphone publications, capability
  discovery, and the room's participant metadata.
- `speech.ts` owns per-source speech segmentation and WAV encoding.
- `transcription.ts` owns the bounded broker connection and response parsing.
- `meeting-transcription.ts` owns one local transcription stream for the active
  call, its buffer, cancellation, pause/resume, and reconnection state. It does
  not depend on channels, agent inventory, or the native agent runner.
- `live-agents.ts` subscribes to new transcript segments only after its explicit
  owner assignment is confirmed. Agent stop does not dispose the shared local
  transcription controller. It retains its channel/identity/thread checks.
- `transcript-ui.tsx` renders the buffer and controls. Mounting or closing this
  view does not acquire or release audio.

Transcription and agent metadata updates are serialized so clearing one status
does not erase the other. Late startup completions are retired after cancellation.
Calls, transcripts and assignments retain distinct identities and lifetimes.

The optional speech service and deployment procedure remain in
[live-agents.md](live-agents.md). No service rollout is needed for this client
separation when the deployed broker already advertises transcription support.
