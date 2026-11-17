# Self-host Buzz Meetings

Run one room service and one LiveKit SFU for your group. Both can share a Linux
VM with the Buzz relay. The service uses separate listeners and does not need
the relay's credentials, database, or configuration. Video consumes additional
network bandwidth, especially with several publishers and viewers.

## Run beside the relay

Use the sample [Compose deployment](../deploy/compose.yaml) with your existing
TLS reverse proxy. Its room broker listens on loopback TCP 8091 and LiveKit
signaling listens on loopback TCP 7880. The compose stack uses Linux host
networking. Verify 7880, 7881, 7882, and 8091 are available before starting it.

1. Point a separate hostname such as `meetings.example.org` at the VM. Add the
   [Caddy example](../deploy/Caddyfile.example) to your existing TLS proxy or
   adapt it for your proxy. Route `/rooms` and `/health` to 8091 and other paths
   including `/rtc` to 7880. Preserve WebSocket upgrades.
2. On the VM, allow TCP 7881 and UDP 7882 from the client networks. LiveKit
   advertises the `LIVEKIT_NODE_IP` that clients use for media. Use the VPN
   address for a VPN-only install, or the reachable public IP for a public
   install. Some restrictive networks need a TURN deployment. [LiveKit firewall reference](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
3. Create a deployment env file outside version control with restrictive file
   permissions. Set values for the following fields.

   | Variable | Value |
   | --- | --- |
   | `LIVEKIT_URL` | Browser-facing LiveKit URL such as `wss://meetings.example.org` |
   | `LIVEKIT_NODE_IP` | IP address reachable by clients for media |
   | `LIVEKIT_API_KEY` | A randomly generated LiveKit key |
   | `LIVEKIT_API_SECRET` | A randomly generated LiveKit secret |
   | `MEETING_ACCESS_KEY` | A separate random key of 24–256 bytes, shared with meeting participants |

   Generate the LiveKit credentials with `livekit-server generate-keys` or
   generate them independently with `openssl rand -hex 32`. Generate a separate
   random value for `MEETING_ACCESS_KEY`. Keep LiveKit credentials server-side.
4. From the checked-out plugin repository, validate and start the stack. Replace
   `/path/to/meetings.env` with the file you created.

   ```sh
   docker compose --env-file /path/to/meetings.env -f deploy/compose.yaml config --quiet
   docker compose --env-file /path/to/meetings.env -f deploy/compose.yaml up -d --build
   curl -fsSI https://meetings.example.org/
   curl -fsS https://meetings.example.org/health
   ```

5. Give participants `wss://meetings.example.org/rooms` and the access key. Test
   with two presenters and one viewer on the networks you expect users to use.

## One-click joining on a private community

When the Buzz community hostname serves `/rooms`, a room click uses that
endpoint. For a private deployment with access enforced by your VPN or another
authenticated proxy, set `MEETING_PROXY_KEY` to a separate `openssl rand -hex 32`
value. Keep the broker on loopback. Configure only the private listener to send
that value as `X-Buzz-Streams-Proxy-Key` upstream. The proxy must overwrite any
client copy of the header and preserve `Origin`. A Caddy `header_up` directive
in the `/rooms` handler does this. Restrict read access to the proxy secret
config to the proxy's service user and the system administrator.

The broker accepts a keyless room admission only with the configured proxy credential
and a recognized Buzz desktop origin. The proxy and its network policy control
who can enter rooms. Use the regular access key when you expose a service on
a public listener. Every named-room join uses the same private-proxy admission.

Configure TLS with a certificate trusted by the stock Buzz webview. Meeting
admission and LiveKit signaling use WebSockets. The SFU terminates WebRTC
transport encryption to relay media to viewers.

## Operation

Named rooms resolve deterministically from community origin and room name.
The broker needs no room database. Participant presence lives in LiveKit; room
shortcuts are local app preferences. Already connected participants use LiveKit directly.
Restarting LiveKit can interrupt active meeting rooms. Roll back the room service
and plugin together using a tested release tag. No Buzz relay restart is
necessary for either operation.

For a local developer run, start LiveKit with `--dev` and use `cargo run --locked`
with the same credential variables, `LIVEKIT_URL=ws://127.0.0.1:7880` and
`BUZZ_MEETINGS_BIND_ADDR=127.0.0.1:8091`. The Playwright fixture can use plain
loopback WebSockets. Use trusted WSS when testing inside stock Buzz Desktop.

## Install the app after deployment

In Buzz, add `https://github.com/h2s2-studio/buzz-meetings` as a Git plugin.
Open Meetings, expand Connection settings if using a separate hostname, and
enter `wss://meetings.example.org/rooms` plus the meeting access key. Click
General Voice on two devices. Verify speech both ways, mute/deafen, camera,
screen source changes, simultaneous screen playback, and leaving.

Admission authorizes deployment access; it does not enforce Buzz channel roles.
Do not expose a keyless proxy publicly: only use that configuration behind the
private network/authentication boundary described above.

## Migrating the old plugins

Deploy this server alongside the relay and install Meetings first. Leave old
Huddles/Streams sessions before joining Meetings. Remove **Voice channels** and
**Screen sharing** from Manage plugins after the replacement works. Meetings
has its own plugin ID (`studio.h2s2.meetings`) and needs an installation review.
The older prototypes' local room choices are not imported.
