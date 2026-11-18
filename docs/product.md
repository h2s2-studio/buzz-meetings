# Meetings experience and architecture

A persistent meeting destination is a Buzz channel. Its voice room derives from
the community origin and channel UUID, so a rename keeps the same destination.
Notes, conversation, agents, transcript and saved records are views of that
workspace. Opening a workspace never requests a microphone; **Join voice** does.
Name-based temporary meetings (formerly quick rooms) are personal shortcuts in
the same Meetings list, kept under their original storage key.

**Call shell.** One staged item fills the stage: a share, a person, or all
screens. With nothing staged, everyone fills the stage as a grid. The
filmstrip lists every share and, while something is staged, every person and
agent. Share tiles are not live video; only the staged share is subscribed. A
viewer's stage changes only on their own action. If the staged item ends, the
stage falls back to the next share, then to everyone, and says why. The control
bar is labeled (Mute, Camera, Share, Agent, Edit together, Transcript, Leave),
followed by secondary audio and capture controls in the same keyboard order.
The side panel is a Chat / Transcript / Agent tab set.

**Overview.** A workspace opens on Overview: who is in the call with its start
time and freshness, listening agents and their role, the agenda from shared
notes, the last record, and a Ready to join card with an audio check. Out of the
call, presence comes from a broker `presence` request. It is gated by the same
signed workspace admission as joining (access key or trusted proxy for temporary
meetings), mints no media token, and reads LiveKit `ListRooms` and
`ListParticipants`. The broker advertises it as `presence: true` in its `service` reply.
An older broker would treat a presence request as an admission and mint a join
token, so the client polls only when presence is advertised. Otherwise the
Overview says who's here appears after joining and sends no presence requests.

One plugin-lifetime LiveKit session owns microphone/camera publication, playback
and screen subscriptions. Changing views keeps it alive. Leaving, changing
identity/community or disabling the plugin stops owned tracks immediately. Late
capture results are retired independently of transport cleanup.

Workspace admission binds a native signature to a fresh challenge, the exact
request and channel. The broker checks current relay-signed channel state through
its own ordinary service identity. Explicit **Enable voice & join** adds that
identity as a channel guest; it does not borrow a human or agent's credentials.
The broker verifies membership periodically and removes revoked participants.
Temporary meetings retain the existing access-key/trusted-proxy boundary and unverified
random media identities.

The speech worker owns one microphone subscription per source per call, one
ordered timeline and bounded queues. Viewers use replay cursors; agents consume
that transcript after a confirmed native owner assignment. Each agent keeps one
thread, coalesces notifications while busy, and publishes task progress with its
own client. Up to four eligible local agents can be included in a call. A
listening badge is distinct from actual native runner activity and useful output.

Primary actions are direct: join voice; open Transcript; add an agent from the
roster; share through an upward drawer; save a transcript deliberately. Role and
mission customization are optional. Saved audio choices include device and
join-muted settings. A microphone test and participant volume controls use only
available web APIs; unsupported output switching uses system settings.

Buzz owns chat, attachments, Canvas editing, native task execution, Outbox and
channel membership. Meetings stores its own presentation preferences and unsent
agent request drafts. Saved meeting records use signed native artifacts with
journaled intent, readback and exact-revision references.

This architecture uses the plugin and adjacent Meetings services. It requires no
Buzz desktop fork. A physical-device session and a real native agent completing
a spoken task remain separate release evidence from browser contract fixtures.

## Identifiers

Tasks, transcripts, records and presentations are keyed by workspace and call
occurrence, never by a room name or a per-join value.

| ID | Definition | Notes |
|---|---|---|
| `workspaceId` | Community origin plus channel UUID. The media room name is `workspace-` + base64url(sha256(origin + "\n" + channel)). | A channel rename keeps the same workspace and room. Quick rooms use `meeting-` + the same digest of the normalized room name. |
| `occurrenceId` | The media room's LiveKit SID (`RM_…`): one per call, shared by every attendee. | The broker opens the room with `CreateRoom` at admission and returns the SID. The client trusts the SID of the room it actually joined and re-checks it after a full reconnect. The SID survives a rejoin. An empty room keeps it for the 20 s departure timeout, and a page closed mid-call keeps it until the media server times that participant out. After that the next join starts a new occurrence. |
| `joinId` | A local UUID per join. | UI lifecycle only. Never persisted or used as a key. |
| `agentId` | The agent's pubkey (hex). | An agent session takes the call's occurrence when it becomes known. If the occurrence changes to a different value under the same join, the session ends with a visible reason. |
| `artifactId` | The `d` UUID of a channel-scoped (`h`) kind-45010 artifact. | Meeting records today; documents and boards next. |
| `revisionId` | The accepted event ID of an artifact revision. | Records reference parts by exact revision. |

## Meeting records

A saved record is a kind-45010 artifact of type `studio.h2s2.meetings.record`.
Its transcript is split into `studio.h2s2.meetings.record.part` artifacts of up
to about 40 KB each. The record manifest is saved last and references each
part by exact revision.

- **Version 2 (current).** Each part holds `{ version: 2, channelId, entries }`.
  An entry is `{ id, speakerId, speakerName, startedAt, endedAt, text }`. The
  manifest adds `callId` (the occurrence), task results with author and
  message ID, and `covers` (`lastEntryId`, `count`, and for a shared stream
  `streamId` and the highest sequence `through`). A transcript counts as saved
  only when a record in its channel and occurrence covers its last entry.
- **Version 1.** Each part holds preformatted text. It is still read and shown
  as stored. Same-name speakers cannot be told apart in these records.

Readers label speakers across the whole record with the same stable suffix the
live view uses. Copy and Download use the same format.

An unsaved transcript is held in memory until it is saved and closed, or
discarded. That includes earlier joins kept after a rejoin. It does not survive
an app restart.

## Documents and boards (model)

`src/artifacts.ts` defines meeting documents and boards. Each revision is a full
snapshot in one kind-45010 artifact (`studio.h2s2.meetings.document` or
`.board`), capped at 48 KiB. The event's `title` tag follows the content title.

- **Edits:** an edit carries a stable `opId` and its base revision. Its operations
  are insert, update, move, remove and rename.
- **Update fields:** updates may change only the fields allowed for a node type.
  Document nodes allow text, href and type; cards and groups allow text and size;
  connectors allow their endpoints. Position is move-only.
- **References:** board references are type-checked.
- **Conflicts:** when the relay reports a conflict, the editor rebases pending
  edits onto the new head. The same field changed on both sides keeps the head
  and holds the local value for Keep mine / Keep theirs. An update beats a
  removal: removed nodes are restored with their original author, and a removal
  that lost is reported.
- **Anchors:** an insert whose anchor is gone follows the nearest surviving
  predecessor from the base order.
- **Authorship:** per-node `author` and `editedAt` are advisory. A revision is
  signed by one identity, so only the revision signer is verifiable. Per-paragraph
  author chips come from content; revision history shows signers.
