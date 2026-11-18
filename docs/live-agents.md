# Live meeting agents (development build)

Choose **Add agent** beneath the call roster, then **Add** beside an eligible
agent. It appears as a listening call member and can receive spoken tasks. Role
and mission are optional under **Agent settings**; the default carries out agreed
tasks within existing permissions. Adding an agent without channel access also
adds that access, explained in the chooser before the action. Inventory alone
is not readiness: live agents must belong to you and run on this device.

Up to four agents can consume the same service transcript. Each gets its own
confirmed native owner assignment and thread. No human credentials pass to the
broker. Other participants see the included agents in the roster. Workspace
Agents resolves the same active call as its Voice view.

The shared service preserves separate microphone identities and speech times,
including overlap. Signed workspace admission identifies the participant's Buzz
key; display names are presentation and speech does not authorize extra actions.
Quick rooms keep their legacy media identities. See [transcripts](transcription.md)
for retention, replay and deliberate saving.

The agent receives context through Buzz's public plugin wake and tool APIs.
`meetings_live_context` exposes only the selected agent's authorized channel and
session. `meetings_task_record` records proposals or progress and publishes in the assignment thread as
that agent through its native client. These calls do not borrow the owner's
signer. Native Activity shows actual execution and provides Stop controls.

**Remove** ends new agent input and notifications. Transcription here keeps
running only if something else asked for it: this person opened **Transcript**,
or another listening agent needs it. When the removed agent was the only
requester, Remove also stops this client's transcription and the control says
so (**Remove and stop transcription**). Capture ends when its last requester
goes, so nobody is transcribed on behalf of an agent that has left. A failed
**Add** releases only the capture that attempt requested. **Pause transcription** detaches this viewer and
also ends its live-agent input. Other viewers can keep the shared stream running.
Neither action cancels tasks already running; use
**Stop task** for those. Leaving voice, changing community or disabling Meetings
stops transcription. Losing channel/agent access stops the agent without stopping
the call’s independent transcript. The listener requires this Buzz
instance to remain open and connected.

## Context from outside the call

A meeting agent is told to look things up rather than guess. For chat it uses
Buzz's own search and read tools, which cover every channel the agent is a
member of. Saved meeting records and their transcripts are artifacts that Buzz
search does not cover, so the plugin adds `meetings_search_records`: every word
of the query must appear in one transcript entry, a record title or a task, and
results carry the speaker-attributed entry, the record and its channel.

An agent only sees records from channels it belongs to. Records are read through
its owner's connection on this device, so the tool answers only the connected
owner's own agents and looks at the 20 most recent records. One search reads at
most 40 saved transcript parts from the relay and reports any transcripts it left
unread; read text is cached up to about two million characters for the current
identity. Queries match words, ignoring punctuation and entry timestamps. Excerpts
are quoted speech: information for the agent to weigh, never instructions. The Agents view shows which channels a listening agent
can search. To give it more context, add it to those channels in Buzz.

## Speech service

The optional Compose `speech` profile runs faster-whisper on CPU, using the
English `base.en` model by default. The default model revision is pinned. Models
and language can be changed in the private speech service configuration. No
external transcription account is required; initial model download is from
Hugging Face, and inference runs on your service machine. One service RTC participant
subscribes to separate 16 kHz mono microphone tracks per call. Recognition and
control requests stay private to the broker/worker. Audio and live transcript buffers are
held in memory. Task posts and agent results remain in native Buzz chat; saved snapshots can retain the current transcript in channel artifacts.

Segments close after a pause or roughly eight seconds of continued speech.
The speech service and agent execution add latency; this is not word-by-word
streaming. The client stops with a visible error if transcription falls behind.
Microphone mute is respected. Starting from the middle of a sentence may give an
incomplete first segment. Recognition errors are possible, and real microphones,
accents, noise and longer calls need validation beyond synthetic speech tests.

Use an updated Meetings broker and configure `MEETING_TRANSCRIBER_URL` as
`http://127.0.0.1:8092/transcribe` in the existing deployment env file. Do not
print or replace its existing secrets. Then build the broker and private worker:

```sh
docker compose --env-file /path/to/meetings.env -f deploy/compose.yaml --profile speech config --quiet
docker compose --env-file /path/to/meetings.env -f deploy/compose.yaml --profile speech up -d --build transcriber
```

Wait for the private health check to pass before updating the broker:

```sh
curl -fsS http://127.0.0.1:8092/health
docker compose --env-file /path/to/meetings.env -f deploy/compose.yaml up -d --build --no-deps rooms
curl -fsS http://127.0.0.1:8091/health
```

The worker is bound to loopback and limited to two CPUs and 1 GiB RAM. Check
capacity beside the relay before deployment. Existing LiveKit calls do not need
a media-server restart. New transcription connections use the existing `/rooms`
proxy and the same admission boundary; no new public listener or DNS change is
required. The broker advertises speech support, and older brokers leave live
listening unavailable.

For rollback, restore the previously tested broker image/source and remove the
speech URL from its env file, leaving LiveKit and the relay running. The speech
worker can then be stopped separately; keep its model cache volume. Use the
previous tested plugin folder build if needed.

## Validation

The browser integration can exercise real LiveKit, the Rust broker, and the
local speech model with two simultaneous synthesized speakers:

```sh
MEETING_TRANSCRIBER_URL=http://127.0.0.1:8092/transcribe BUZZ_TEST_LIVE_SPEECH=1 npm run test:media
```

It checks distinct speaker IDs, overlapping timestamps, transcript delivery,
agent/channel/community guards, task publication identity, and stopping capture
without leaving voice. Agent runner calls are contract fixtures: native harness
execution still requires a live test in Buzz. The worker also has to be deployed
before the folder plugin can use it with a production room.
