# Live transcripts and meeting records

Open **Transcript** to start following the call. No agent is required. Joining
voice alone does not start transcription; opening the transcript is the explicit
action. A paused transcript stays paused until **Resume transcription**.

The service joins the call once and subscribes to separate microphone tracks.
Every viewer receives the same ordered entries with stable IDs, speaker labels
and start/end times, including overlapping speech. Adding viewers or agents
reuses the stream. Entries arrive after a pause or roughly eight seconds of
continued speech. The call shows the service's transcription presence.

**Pause transcription** detaches this viewer and its agents. Other viewers can
continue transcribing. Removing an agent leaves transcription running and stops
its new speech input; native **Stop task** controls work already assigned.
Closing the panel or browsing other content preserves the connection.

Use search, **Copy**, or **Download** to work with the current text. **Save meeting
record** deliberately saves a snapshot to the linked channel, with task results
and native message references. Saved records are available in that workspace's
**Meeting records** view. Saving requires write access. Signed chunks are
journaled before publication; an interrupted save offers a retry of those exact
bytes. The manifest is saved last and every publication is read back before
claiming success. A record never silently changes to a replacement chunk.

**Transcript options → Announce new speech** enables polite screen-reader
announcements of new entries. It defaults off and remembers your choice on this
device. Enabling it does not read the existing history aloud.

Unsaved text uses a bounded 4,000-entry window. The service retains at most 16
recent room timelines for up to 30 minutes; this is temporary memory, not a
permanent archive. Leaving preserves the device's text until another call,
identity/community change or reload. A new media room occurrence gets a new
stream. Replay gaps, worker restarts, failed recognition and overload show a
notice rather than claiming a complete transcript. Saving records only the text
available in the current buffer and preserves any coverage warning. Saved
artifacts follow channel access and history retention; this build offers no
per-record purge of artifact history. Raw audio is processed in memory.

The private CPU worker defaults to pinned faster-whisper `base.en`. It permits
four active rooms, bounds each room's queue to eight chunks, drops work older
than 15 seconds, and serializes recognition globally. These are resource bounds,
not a measured promise that four busy calls meet realtime latency. Physical
microphones, accents/noise, constrained networks and production load remain
acceptance tests. Recognition can make mistakes.

Workspace participants have signed Buzz admission identities. Display names still
come from profiles, and ordinary quick rooms use unverified media identities.
Speech never expands an agent's permissions.

Older brokers retain the client-capture fallback. It supports an independent
local transcript but does not share the service timeline. Update both broker and
worker for shared transcription; see [deployment](deployment.md).
