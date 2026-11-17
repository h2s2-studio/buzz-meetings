# Meetings experience and architecture

A persistent meeting destination is a Buzz channel. Its voice room derives from
the community origin and channel UUID, so a rename keeps the same destination.
Notes, conversation, agents, transcript and saved records are views of that
workspace. Opening a workspace never requests a microphone; **Join voice** does.
Legacy name-based quick rooms remain compatible personal shortcuts.

One plugin-lifetime LiveKit session owns microphone/camera publication, playback
and screen subscriptions. Changing views keeps it alive. Leaving, changing
identity/community or disabling the plugin stops owned tracks immediately. Late
capture results are retired independently of transport cleanup.

Workspace admission binds a native signature to a fresh challenge, the exact
request and channel. The broker checks current relay-signed channel state through
its own ordinary service identity. Explicit **Enable voice & join** adds that
identity as a channel guest; it does not borrow a human or agent's credentials.
The broker verifies membership periodically and removes revoked participants.
Quick rooms retain the existing access-key/trusted-proxy boundary and unverified
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
