# Meetings experience and architecture

Meetings is a Buzz dock app with an app-specific sidebar. The Voice Channels
section and General Voice exist on first launch. An explicit room click starts
microphone capture and joins its named media session. Connected people appear
beneath the active room and in the main stage, with speaking and mute state.

One plugin-lifetime LiveKit session owns audio playback, microphone/camera
capture, screen publishing, and video subscriptions. Changing pages does not
change that lifetime. Leaving or changing identity/community immediately stops
local tracks, tears down playback, and disconnects the room. A canceled join
also stops a late microphone permission result. Room switching waits for the
previous transport teardown before connecting the next session.

The Rust broker hashes a canonical community origin and normalized room name
into a stable LiveKit destination. A short-lived token grants microphone,
camera, and screen-video publication only for that destination. A deployment
access key or trusted private proxy is required for each admission. Tokens use
random participant IDs; profile names/pictures are presentation supplied by
clients. This is independent of native Huddles and does not verify Buzz channel
membership. Do not present these profile names as cryptographically verified.

Screen publishers choose a source explicitly. Viewers can focus one presenter
and select quality layers, or watch several screens in a grid. Stopping a share
keeps voice connected. The screen source picker belongs to the OS; changing it
preserves the existing source if canceled. The app never shows controls for
unimplemented application-audio capture.

The initial room list is local to the viewer/community/device. General Voice
is common to everyone; additional names resolve to the same server destination
when another member adds that name. Shared room administration and live
cross-room occupancy are future work, as are application audio and native agent participation. Room text chat reuses
Buzz’s conversation Workspace: a uniquely named joined channel links
automatically, and other rooms offer explicit channel linking/creation.
Buzz owns the reader, composer, attachments, and text permissions. The product reference is Discord's
persistent voice rooms and stream stage; this release does not claim complete
feature parity.
