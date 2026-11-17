# Persistent Meetings workspaces

The development build extends the persistence foundation introduced in v0.2.0. Meetings remains its
own installable dock app. A workspace is a permanent Buzz stream channel, and
its existing identity, membership, conversation, attachments, and Canvas are
reused. Renaming changes the channel name without copying its content.

## Using a workspace

Choose **+** beside **Meetings**, enter a name and choose **Create meeting**.
The private meeting opens immediately. **Manage workspaces** beside the heading
links an existing permanent channel you can write to or changes visibility. Invite
people using Buzz's native channel controls. Channel members using Meetings
discover the shared link as Buzz synchronizes its artifacts.

**Notes** embeds the Channels plugin's native Canvas. **Chat & files** embeds
Buzz's conversation workspace. Those components retain their existing membership,
read-only, revision, attachment, and error handling. Guests can read but cannot
link or rename. Renaming requires channel owner/admin permission and a fresh
channel-details version.

Opening a workspace never starts audio. **Join voice** joins the same channel's
stable call destination. On first use, a channel owner/admin explicitly enables
the Meetings service's guest access after reviewing the disclosure. The service
checks a native signature and fresh relay membership on admission, then monitors
revocations even after a broker restart. Voice, Transcript, Agents, Notes,
Chat & files and Meeting records share this destination.

The last selected workspace is saved
for the current identity/community on this device, and navigation targets carry
the same scope and stable channel UUID. Losing membership or switching to a
different account/community makes an old route unavailable. A cached record
does not establish current access.

Canvas is a revisioned Markdown document, not a live collaborative whiteboard.
Reload or reopen it to see another person's changes. Its native conflict flow
preserves a draft when the saved revision has changed. Files remain native chat
attachments; this release does not add a separate file browser.

## Data ownership

| Data | Owner and storage |
| --- | --- |
| Channel identity, name, visibility, roles | Buzz channel services and relay |
| Notes | Native channel Canvas and its revision history |
| Messages and files | Native conversation and media services |
| Shared workspace discovery | NIP-AR artifact kind 45010, type `studio.h2s2.meetings.workspace` |
| Last view and unfinished link intent | Buzz artifact collection preferences, scoped by identity/community/plugin on this device |
| Connected participants and media tracks | Existing LiveKit room session |
| Live transcript | One service RTC subscriber and bounded temporary timeline per call |
| Deliberately saved meeting records | Native channel artifacts with exact chunk revisions and task references |

The registry contains only `{"version":1,"channelId":"<channel UUID>"}`.
Its artifact identity is UUIDv5 using the channel UUID as namespace and the
workspace type as name. This lets concurrent clients converge on one link. The
artifact's `h` tag must equal the payload channel, and the deterministic `d` must
match that channel. Unknown versions, malformed records, and deleted heads are
not overwritten. No transcript, room access key, audio, or user credentials are
stored in this record.

Discovery uses the public `artifactStorage` collection and host synchronization.
The plugin never maintains a second shared chat/notes database. Collections are
filtered against the current verified channel list and closed when the session
or identity changes. Fresh `snapshotRead` requests use the explicit artifact
**head** view, which includes deletion, before a create attempt or reconciliation.

## Recovery

Before publishing a link, the plugin persists the exact signed create event in
local collection preferences. An interrupted request remains **Unconfirmed**.
**Check saved link** performs a fresh read. **Retry saved link** sends the same
signed event after rechecking access; it cannot silently replace another
writer's accepted record. Startup reconciles by reading and never publishes an
unfinished operation automatically. If local intent cannot be saved, publication
does not start.

Channel creation has a separate durable intent written before invoking Buzz's
channel command. Once a channel ID is returned, it is saved before linking.
**Finish workspace link** reuses that channel after a failure or restart. If the
host returned no ID, the outcome is uncertain: inspect **Channels** and **Outbox**,
link the existing channel if present, then clear the reviewed intent. The UI
does not offer a new creation until that uncertainty is resolved. Permanent
channel creation omits the lifetime field; it does not pass a zero duration.

Rename delegates to Buzz's channel-details service and its version checks. An
unconfirmed name change exposes the host's check operation. Archived or revoked
channels disappear from accessible workspace discovery. There is no shared
workspace-delete control in this release; channel lifecycle stays with Buzz.

## Relationship to existing voice rooms

Existing device-local voice shortcuts remain intact. A linked voice-room chat
offers **Save as shared workspace**, which explicitly links its existing channel.
No background migration creates channels or assumes a name match is an identity.

A call can remain active while you open Notes or Chat, and the workspace retains
call controls plus a return-to-call button. **Quick rooms** retain the deployment's
broker/access boundary. Workspace calls additionally verify the stable channel
and current membership. Existing quick rooms are not silently converted into
private channel calls.

## Validation and remaining checks

The unit suite covers stable identity, private/permanent creation, concurrent
linking, permission loss, deletion, invalid saved operations, signing teardown,
failed reads/storage, lost receipts, and restart recovery without duplicate
channels. Chromium and WebKit exercise two isolated client identities against a
shared HTTP/SSE fixture. Canvas and conversation stand-ins are explicitly marked
and model native reload/conflict behavior; these are integration contract tests.

The real-media suite additionally runs the Rust broker and LiveKit with synthetic
audio/video, testing mute/deafen/camera, simultaneous screen shares, source
changes, navigation between call and workspace, and capture cleanup.

On 2026-11-17 a separate authenticated probe in a disposable private channel on
the deployed Buzz relay verified artifact create/update, current/head/history,
stale-revision rejection, and exact-event replay preserving the accepted head.
That probe used one authorized agent identity; it did not exercise the plugin's
native UI or establish two-user authorization behavior.

Before calling native rollout complete, check:

1. Install the exact built revision through Buzz's plugin review and verify
   activation, page/settings registration, and no runtime errors.
2. On two independently authorized Buzz clients, link a shared permanent channel
   on one client and discover it on the other without linking again.
3. Save native notes and an attachment, reload/restart, and rename. Verify the
   channel ID and content remain unchanged and no microphone prompt appears.
4. Exercise native Canvas conflicting drafts, guest access, membership removal,
   identity/community switching, and interrupted creation/link recovery.
5. Check actual microphone/camera/screen capture and reconnects separately on
   the target desktop OS and production network.

Verified workspace admission, shared transcription, live-agent tools and deliberate
meeting records are implemented in this development build. The native checks above
remain required; fixtures cannot establish real agent execution or device behavior.
Collaborative whiteboards remain outside this build.
