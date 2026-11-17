# Live meeting agents (development build)

Live agents are enabled explicitly from **Meeting agents** in a voice room linked
to a Buzz channel. Choose one of your agents that is running on this device and
already has channel access. Select **Take notes and propose tasks** or **Create
and carry out tasks**, review its mission, and choose **Start live agent**.

The room shows who is listening through which participant. The plugin captures
one microphone stream per media participant; a separate speech service returns
transcript segments with source IDs and start/end times. Overlapping speakers
remain separate. Display names identify media participants but do not prove a
Buzz identity or authorize commands. Agent actions follow the role you enabled
and the harness's existing permissions.

Start live agent sends one explicit owner assignment through Buzz’s native Outbox. Capture begins after its delivery is confirmed. Later transcript notifications continue that same task thread.

The agent receives context through Buzz's public plugin wake and tool APIs.
`meetings_live_context` exposes only the selected agent's authorized channel and
session. `meetings_task_record` records proposals or progress and publishes in the assignment thread as
that agent through its native client. These calls do not borrow the owner's
signer. Native Activity shows actual execution and provides Stop controls.

**Stop listening** stops capture, queued transcription, and new notifications.
It preserves your voice call and does not cancel tasks already running. Use
**Stop task** for those. Leaving voice, losing channel/agent access, changing
community or disabling Meetings stops capture. The listener requires this Buzz
instance to remain open and connected.

## Speech service

The optional Compose `speech` profile runs faster-whisper on CPU, using the
English `base.en` model by default. The default model revision is pinned. Models
and language can be changed in the private speech service configuration. No
external transcription account is required; initial model download is from
Hugging Face, and inference runs on your machine. The broker forwards bounded
16 kHz mono WAV segments over loopback. Audio and live transcript buffers are
held in memory. Task posts and agent results remain in native Buzz chat; this
version does not create a permanent full-call transcript archive.

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
