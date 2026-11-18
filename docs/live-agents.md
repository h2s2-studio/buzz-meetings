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
most 40 saved transcript parts from the relay, plus one transcript longer than
that, and reports any transcripts it left unread; read text is cached up to about two million characters for the current
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

## In the call, not in chat

People in a call talk and watch. Chat is the record, never a required step.

- **Questions:** an agent asks with `meetings_ask` (a question and 2–4 short
  options). The question appears on the agent's tile, on the stage or in the
  filmstrip, with a countdown. The owner answers by clicking, on the device that
  runs the agent. Anyone can answer by saying an option. Other participants see
  the question read-only through participant metadata.
- **Spoken answers:** a plain spoken reply ("yeah, go ahead", or an option's
  words) is offered to the agent as an unverified suggestion, with the words
  heard and the speaker's media label. The agent decides. A spoken answer can
  only settle a question the agent asked, within its existing role.
- **Status and results:** the tile shows what the agent is doing (listening,
  working, needs input, finished) from its latest task. **Open result** opens
  the call's own chat at that message. Questions and answers are posted to the
  assignment thread as the record.
- **Not yet supported:** remote clicks. They need a data-channel grant from the
  meeting service.

### `meetings_ask`

`meetings_ask { session_id, key, question (≤ 200), options (2–4, ≤ 40 each), timeout_seconds (15–600, default 120) }`

- **Who can answer:** the agent's owner, by clicking on the device that runs the agent. That click is the only answer that settles the question as the owner's.
- **Speech:** anyone may answer by speaking. A spoken match is a suggestion (`via: "speech", owner: false`), including the owner's own speech, because speaker labels are not verified. The tile then asks the owner to click to confirm.
- **Spoken matching:** generic yes/no replies must be four words or fewer with nothing else in them. A reply naming an option's own words may be up to eight words.
- **Bounds:** at most one suggestion per speaker per option and six per question. Speech wakes the agent at most once per 5 s. The thread gets one "Heard while asking …" summary per question.
- **What speech can settle:** only a question the agent asked, within its existing role. It never grants new permission.
- **Remote clicks:** other participants can't click to answer yet; that needs a data-channel grant from the meeting service.
