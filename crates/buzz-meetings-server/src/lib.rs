mod captions;
pub mod workspaces;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header::ORIGIN, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use livekit_api::access_token::{AccessToken, VideoGrants};
use livekit_protocol::RoomConfiguration;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{sync::Semaphore, time::timeout};
use url::Url;

const INVITE_TTL: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_INVITES: usize = 128;
const MAX_HANDSHAKES: usize = 64;
const MAX_MESSAGE_BYTES: usize = 2048;
const MAX_AUDIO_MESSAGE_BYTES: usize = 440_000;
const PROXY_KEY_HEADER: &str = "x-buzz-streams-proxy-key";
const MAX_PARTICIPANTS: u32 = 13;
const EMPTY_TIMEOUT: u32 = 120;
const DEPARTURE_TIMEOUT: u32 = 20;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
    Workspace(workspaces::WorkspaceRequest),
    Service,
    Create {
        name: String,
        key: Option<String>,
    },
    Join {
        name: String,
        code: String,
    },
    Captions {
        name: String,
        community: String,
        room: String,
        picture: Option<String>,
        key: Option<String>,
    },
    Listen {
        name: String,
        community: String,
        room: String,
        picture: Option<String>,
        key: Option<String>,
    },
    Meeting {
        name: String,
        community: String,
        room: String,
        picture: Option<String>,
        key: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Reply<'a> {
    Admitted {
        url: &'a str,
        token: String,
        room: String,
        // The media server's room SID: one per call occurrence, shared by every
        // attendee, replaced once the room empties past its departure timeout.
        #[serde(rename = "occurrenceId", skip_serializing_if = "Option::is_none")]
        occurrence_id: Option<String>,
        capabilities: Capabilities,
        #[serde(skip_serializing_if = "Option::is_none")]
        invite: Option<Invite>,
    },
    Error {
        error: &'static str,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    screen_audio: bool,
    transcription: bool,
    shared_transcription: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Invite {
    code: String,
    expires_at: u64,
}

struct Room {
    name: String,
    expires_at: u64,
}

pub struct RoomService {
    livekit_url: Url,
    api_key: String,
    api_secret: String,
    creation_key_digest: [u8; 32],
    proxy_key_digest: Option<[u8; 32]>,
    invitations: Mutex<HashMap<String, Room>>,
    handshakes: Arc<Semaphore>,
    transcription_url: Option<Url>,
    transcription_jobs: Semaphore,
    http: reqwest::Client,
    workspace_access: Option<Arc<workspaces::WorkspaceAccess>>,
}

impl RoomService {
    pub fn new(livekit_url: Url, api_key: String, api_secret: String, creation_key: &str) -> Self {
        Self {
            livekit_url,
            api_key,
            api_secret,
            creation_key_digest: Sha256::digest(creation_key.as_bytes()).into(),
            proxy_key_digest: None,
            invitations: Mutex::default(),
            handshakes: Arc::new(Semaphore::new(MAX_HANDSHAKES)),
            transcription_url: None,
            transcription_jobs: Semaphore::new(4),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("HTTP client"),
            workspace_access: None,
        }
    }

    pub fn with_workspace_access(mut self, access: workspaces::WorkspaceAccess) -> Self {
        self.workspace_access = Some(Arc::new(access));
        self
    }

    fn capabilities(&self, meeting: bool) -> Capabilities {
        Capabilities {
            screen_audio: meeting,
            transcription: meeting && self.transcription_url.is_some(),
            shared_transcription: meeting && self.transcription_url.is_some(),
        }
    }

    pub fn with_transcriber(mut self, url: Url) -> Self {
        self.transcription_url = Some(url);
        self
    }

    pub fn with_proxy_key(mut self, key: &str) -> Self {
        self.proxy_key_digest = Some(Sha256::digest(key.as_bytes()).into());
        self
    }

    fn media_token(
        &self,
        name: &str,
        room_name: &str,
        metadata: &str,
        meeting: bool,
        identity: &str,
    ) -> Result<String, &'static str> {
        AccessToken::with_api_key(&self.api_key, &self.api_secret)
            .with_identity(identity)
            .with_name(name)
            .with_metadata(metadata)
            .with_ttl(Duration::from_secs(90))
            .with_grants(VideoGrants {
                room: room_name.to_owned(),
                room_join: true,
                can_subscribe: Some(true),
                can_publish: Some(true),
                can_publish_sources: if meeting {
                    vec![
                        "microphone".into(),
                        "camera".into(),
                        "screen_share".into(),
                        "screen_share_audio".into(),
                    ]
                } else {
                    vec!["screen_share".into()]
                },
                can_publish_data: Some(false),
                can_update_own_metadata: Some(meeting),
                ..Default::default()
            })
            .with_room_config(RoomConfiguration {
                max_participants: MAX_PARTICIPANTS,
                empty_timeout: EMPTY_TIMEOUT,
                departure_timeout: DEPARTURE_TIMEOUT,
                ..Default::default()
            })
            .to_jwt()
            .map_err(|_| {
                tracing::error!("could not sign media admission");
                "Could not issue media admission."
            })
    }

    /// Open (or find) the media room and return its SID, the call occurrence.
    /// CreateRoom is idempotent: an existing room keeps its SID. Admission does
    /// not depend on it; clients confirm the SID from the room they joined.
    pub(crate) async fn occurrence(&self, room: &str) -> Option<String> {
        let jwt = AccessToken::with_api_key(&self.api_key, &self.api_secret)
            .with_ttl(Duration::from_secs(60))
            .with_grants(VideoGrants {
                room: room.to_owned(),
                room_create: true,
                ..Default::default()
            })
            .to_jwt()
            .ok()?;
        let endpoint = workspaces::media_api(&self.livekit_url, "CreateRoom")?;
        let value: serde_json::Value = self
            .http
            .post(endpoint)
            .bearer_auth(jwt)
            .json(&serde_json::json!({
                "name": room,
                "empty_timeout": EMPTY_TIMEOUT,
                "departure_timeout": DEPARTURE_TIMEOUT,
                "max_participants": MAX_PARTICIPANTS,
            }))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        value
            .get("sid")
            .and_then(serde_json::Value::as_str)
            .filter(|sid| valid_occurrence(sid))
            .map(str::to_owned)
    }

    fn trusted_proxy(&self, headers: &HeaderMap) -> bool {
        let Some(expected) = &self.proxy_key_digest else {
            return false;
        };
        let desktop_origin = matches!(
            headers.get(ORIGIN).and_then(|origin| origin.to_str().ok()),
            Some("tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost")
        );
        desktop_origin
            && headers
                .get(PROXY_KEY_HEADER)
                .is_some_and(|value| matches_key(expected, value.as_bytes()))
    }

    fn admit(
        &self,
        request: Request,
        now: u64,
        trusted_proxy: bool,
    ) -> Result<Reply<'_>, &'static str> {
        if matches!(&request, Request::Workspace(_) | Request::Service) {
            return Err("Workspace admission requires a signed challenge.");
        }
        let mut invitations = self
            .invitations
            .lock()
            .map_err(|_| "Room service unavailable.")?;
        invitations.retain(|_, room| room.expires_at > now);
        let meeting = matches!(
            &request,
            Request::Meeting { .. } | Request::Listen { .. } | Request::Captions { .. }
        );
        let mut metadata = None;
        let (name, room_name, invite) = match request {
            Request::Workspace(_) | Request::Service => return Err("Invalid room request."),
            Request::Meeting {
                name,
                community,
                room,
                picture,
                key,
            }
            | Request::Captions {
                name,
                community,
                room,
                picture,
                key,
            }
            | Request::Listen {
                name,
                community,
                room,
                picture,
                key,
            } => {
                if let Some(key) = key {
                    if !matches_key(&self.creation_key_digest, key.as_bytes()) {
                        return Err("The meeting access key was rejected.");
                    }
                } else if !trusted_proxy {
                    return Err("Meeting access requires an access key or a configured private community proxy.");
                }
                let origin = Url::parse(&community).map_err(|_| "Invalid meeting community.")?;
                if !matches!(origin.scheme(), "https" | "http")
                    || origin.host_str().is_none()
                    || !origin.username().is_empty()
                    || origin.password().is_some()
                    || origin.path() != "/"
                    || origin.query().is_some()
                    || origin.fragment().is_some()
                {
                    return Err("Invalid meeting community.");
                }
                let room = room.trim().to_lowercase();
                if room.is_empty()
                    || room.chars().count() > 64
                    || room.chars().any(char::is_control)
                {
                    return Err("Enter a room name of 1–64 characters.");
                }
                let picture = picture.filter(|value| value.len() <= 2048).filter(|value| {
                    Url::parse(value).is_ok_and(|url| {
                        url.scheme() == "https"
                            && url.host_str().is_some()
                            && url.username().is_empty()
                            && url.password().is_none()
                    })
                });
                metadata = Some(serde_json::json!({ "picture": picture }).to_string());
                let digest = Sha256::digest(
                    format!("{}\n{}", origin.origin().ascii_serialization(), room).as_bytes(),
                );
                (
                    name,
                    format!("meeting-{}", URL_SAFE_NO_PAD.encode(digest)),
                    None,
                )
            }
            Request::Create { name, key } => {
                if let Some(key) = key {
                    if !matches_key(&self.creation_key_digest, key.as_bytes()) {
                        return Err("The room creation key was rejected.");
                    }
                } else if !trusted_proxy {
                    return Err("Quick sharing is unavailable here. Use Room service settings or contact your administrator.");
                }
                if invitations.len() >= MAX_INVITES {
                    return Err("The room service is busy.");
                }
                let invite = Invite {
                    code: random_code(),
                    expires_at: now + INVITE_TTL.as_millis() as u64,
                };
                (name, format!("buzz-{}", random_code()), Some(invite))
            }
            Request::Join { name, code } => {
                let room = invitations
                    .get(&code)
                    .ok_or("This invite is invalid or has expired.")?;
                (name, room.name.clone(), None)
            }
        };
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 48 || name.chars().any(char::is_control) {
            return Err("Enter a display name of 1–48 characters.");
        }
        let token = self.media_token(
            name,
            &room_name,
            &metadata.unwrap_or_default(),
            meeting,
            &random_code(),
        )?;
        if let Some(invite) = &invite {
            invitations.insert(
                invite.code.clone(),
                Room {
                    name: room_name.clone(),
                    expires_at: invite.expires_at,
                },
            );
        }
        Ok(Reply::Admitted {
            url: self.livekit_url.as_str(),
            token,
            room: room_name,
            occurrence_id: None,
            capabilities: Capabilities {
                screen_audio: meeting,
                transcription: meeting && self.transcription_url.is_some(),
                shared_transcription: meeting && self.transcription_url.is_some(),
            },
            invite,
        })
    }
}

pub(crate) fn valid_occurrence(sid: &str) -> bool {
    sid.len() <= 64
        && sid.starts_with("RM_")
        && sid.len() > 3
        && sid[3..].chars().all(|c| c.is_ascii_alphanumeric())
}

fn random_code() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>())
}

fn matches_key(expected: &[u8; 32], supplied: &[u8]) -> bool {
    bool::from(expected.ct_eq(Sha256::digest(supplied).as_slice()))
}

pub fn router(rooms: RoomService) -> Router {
    let rooms = Arc::new(rooms);
    if rooms.workspace_access.is_some() {
        tokio::spawn(workspaces::guard(rooms.clone()));
    }
    Router::new()
        .route("/health", get(|| async { StatusCode::OK }))
        .route("/rooms", get(upgrade))
        .with_state(rooms)
}

async fn upgrade(
    State(rooms): State<Arc<RoomService>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(permit) = rooms.handshakes.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let trusted_proxy = rooms.trusted_proxy(&headers);
    ws.max_message_size(MAX_AUDIO_MESSAGE_BYTES)
        .max_frame_size(MAX_AUDIO_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            admit_socket(socket, rooms, trusted_proxy).await;
        })
}

async fn admit_socket(mut socket: WebSocket, rooms: Arc<RoomService>, trusted_proxy: bool) {
    let Ok(Some(Ok(Message::Text(message)))) = timeout(REQUEST_TIMEOUT, socket.recv()).await else {
        return;
    };
    if message.len() > MAX_MESSAGE_BYTES {
        return;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let request = serde_json::from_str::<Request>(&message);
    match request {
        Ok(Request::Workspace(input)) => {
            workspaces::serve(&mut socket, rooms, &message, input).await;
            return;
        }
        Ok(Request::Service) => {
            let workspace = rooms.workspace_access.as_ref();
            let value = serde_json::json!({"type":"service", "workspaceVoice":workspace.is_some(), "identity":workspace.map(|access| access.public_key()), "community":workspace.map(|access| access.origin())});
            let _ = socket.send(Message::Text(value.to_string().into())).await;
            return;
        }
        _ => {}
    }
    let shared = request
        .as_ref()
        .is_ok_and(|request| matches!(request, Request::Captions { .. }));
    let listening = request
        .as_ref()
        .is_ok_and(|request| matches!(request, Request::Listen { .. }));
    let mut reply = request
        .map_err(|_| "Invalid room request.")
        .and_then(|request| rooms.admit(request, now.as_millis() as u64, trusted_proxy))
        .unwrap_or_else(|error| Reply::Error { error });
    if !shared && !listening {
        if let Reply::Admitted {
            room,
            occurrence_id,
            ..
        } = &mut reply
        {
            *occurrence_id = rooms.occurrence(room).await;
        }
    }
    if shared {
        match reply {
            Reply::Admitted { room, .. } => captions::serve(&mut socket, &rooms, &room, None).await,
            error => {
                if let Ok(text) = serde_json::to_string(&error) {
                    let _ = socket.send(Message::Text(text.into())).await;
                }
            }
        }
    } else if listening && matches!(&reply, Reply::Admitted { .. }) {
        if rooms.transcription_url.is_none() {
            let _ = socket.send(Message::Text(r#"{"type":"error","error":"Live transcription is not configured on this meeting service."}"#.into())).await;
        } else {
            transcribe_socket(&mut socket, &rooms).await;
        }
    } else if let Ok(text) = serde_json::to_string(&reply) {
        let _ = socket.send(Message::Text(text.into())).await;
    }
    let _ = socket.send(Message::Close(None)).await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AudioChunk {
    seq: u64,
    speaker_id: String,
    speaker_name: String,
    started_at: u64,
    ended_at: u64,
    wav: String,
}

fn decode_chunk(chunk: &AudioChunk, previous: u64) -> Result<Vec<u8>, &'static str> {
    if chunk.seq <= previous
        || chunk.speaker_id.is_empty()
        || chunk.speaker_id.len() > 128
        || chunk.speaker_name.len() > 192
        || chunk.speaker_name.chars().any(char::is_control)
        || chunk.ended_at <= chunk.started_at
        || chunk.ended_at - chunk.started_at > 11_000
        || chunk.wav.len() > 427_000
    {
        return Err("Invalid audio segment.");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&chunk.wav)
        .map_err(|_| "Invalid audio encoding.")?;
    if !(44..=320_044).contains(&bytes.len()) || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE"
    {
        return Err("Expected a bounded WAV segment.");
    }
    Ok(bytes)
}

async fn transcribe_socket(socket: &mut WebSocket, rooms: &RoomService) {
    let Some(url) = &rooms.transcription_url else {
        return;
    };
    if socket
        .send(Message::Text(r#"{"type":"listening"}"#.into()))
        .await
        .is_err()
    {
        return;
    }
    let mut previous = 0;
    while let Ok(Some(Ok(message))) = timeout(Duration::from_secs(90), socket.recv()).await {
        if matches!(message, Message::Close(_)) {
            break;
        }
        if matches!(message, Message::Ping(_) | Message::Pong(_)) {
            continue;
        }
        let Message::Text(text) = message else {
            break;
        };
        if text.as_str() == r#"{"type":"ping"}"# {
            if socket
                .send(Message::Text(r#"{"type":"pong"}"#.into()))
                .await
                .is_err()
            {
                break;
            }
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<AudioChunk>(&text) else {
            break;
        };
        let Ok(bytes) = decode_chunk(&chunk, previous) else {
            break;
        };
        previous = chunk.seq;
        let Ok(_job) = rooms.transcription_jobs.try_acquire() else {
            let _ = socket
                .send(Message::Text(
                    r#"{"type":"error","error":"Transcription is busy. Stop and try again."}"#
                        .into(),
                ))
                .await;
            break;
        };
        let response = timeout(Duration::from_secs(30), async {
            let mut response = rooms
                .http
                .post(url.clone())
                .header("Content-Type", "audio/wav")
                .body(bytes)
                .send()
                .await?
                .error_for_status()?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > 24_000 {
                    return Err(anyhow::anyhow!("Oversized transcript"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<serde_json::Value, anyhow::Error>(serde_json::from_slice(&bytes)?)
        })
        .await;
        let Ok(Ok(value)) = response else {
            let _ = socket.send(Message::Text(r#"{"type":"error","error":"Speech transcription failed. Stop and try again."}"#.into())).await;
            break;
        };
        let result = serde_json::json!({"type":"transcript", "seq":chunk.seq,"speakerId":chunk.speaker_id,"speakerName":chunk.speaker_name,"startedAt":chunk.started_at,"endedAt":chunk.ended_at,"segments":value.get("segments").unwrap_or(&serde_json::Value::Null)});
        if socket
            .send(Message::Text(result.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting(community: &str, room: &str, key: Option<&str>) -> Request {
        Request::Meeting {
            name: "Alex".into(),
            community: community.into(),
            room: room.into(),
            picture: Some("javascript:alert(1)".into()),
            key: key.map(str::to_owned),
        }
    }

    fn claims(reply: Reply<'_>) -> serde_json::Value {
        let Reply::Admitted { token, .. } = reply else {
            panic!("expected admission");
        };
        serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(token.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn meetings_require_access_and_scope_media_to_one_named_room() {
        let service = RoomService::new(
            Url::parse("ws://127.0.0.1:7880").unwrap(),
            "devkey".into(),
            "secret".into(),
            "meeting-key",
        );
        assert!(service
            .admit(
                meeting("https://buzz.example.org", "General Voice", None),
                0,
                false
            )
            .is_err());
        assert!(service
            .admit(
                meeting("https://buzz.example.org", "General Voice", Some("wrong")),
                0,
                true
            )
            .is_err());
        let first = claims(
            service
                .admit(
                    meeting(
                        "https://buzz.example.org",
                        "General Voice",
                        Some("meeting-key"),
                    ),
                    0,
                    false,
                )
                .unwrap(),
        );
        let same = claims(
            service
                .admit(
                    meeting("https://buzz.example.org", "general voice", None),
                    0,
                    true,
                )
                .unwrap(),
        );
        let other_room = claims(
            service
                .admit(meeting("https://buzz.example.org", "Design", None), 0, true)
                .unwrap(),
        );
        let other_community = claims(
            service
                .admit(
                    meeting("https://another.example.org", "General Voice", None),
                    0,
                    true,
                )
                .unwrap(),
        );
        assert_eq!(first["video"]["room"], same["video"]["room"]);
        assert_ne!(first["sub"], same["sub"]);
        assert_ne!(first["video"]["room"], other_room["video"]["room"]);
        assert_ne!(first["video"]["room"], other_community["video"]["room"]);
        assert_eq!(first["video"]["canPublishData"], false);
        assert_eq!(
            first["video"]["canPublishSources"],
            serde_json::json!(["microphone", "camera", "screen_share", "screen_share_audio"])
        );
        let metadata: serde_json::Value =
            serde_json::from_str(first["metadata"].as_str().unwrap()).unwrap();
        assert!(metadata["picture"].is_null());
        for (origin, room) in [
            ("https://user:pass@buzz.example.org", "General"),
            ("https://buzz.example.org/path", "General"),
            ("https://buzz.example.org", "\n"),
        ] {
            assert!(service
                .admit(meeting(origin, room, Some("meeting-key")), 0, false)
                .is_err());
        }
    }

    #[test]
    fn speech_and_shared_audio_keep_the_meeting_admission_boundary() {
        let service = RoomService::new(
            Url::parse("ws://127.0.0.1:7880").unwrap(),
            "devkey".into(),
            "secret".into(),
            "test-creation-key",
        );
        let listen = || Request::Listen {
            name: "Alex".into(),
            community: "https://buzz.example.org".into(),
            room: "General Voice".into(),
            picture: None,
            key: None,
        };
        assert!(service.admit(listen(), 0, false).is_err());
        let reply = service.admit(listen(), 0, true).unwrap();
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["capabilities"]["screenAudio"], true);
        assert_eq!(value["capabilities"]["transcription"], false);
        let token = claims(reply);
        assert_eq!(token["video"]["canUpdateOwnMetadata"], true);
        assert_eq!(token["video"]["canPublishData"], false);
        let service =
            service.with_transcriber(Url::parse("http://127.0.0.1:8092/transcribe").unwrap());
        assert_eq!(
            serde_json::to_value(service.admit(listen(), 0, true).unwrap()).unwrap()
                ["capabilities"]["transcription"],
            true
        );
        let quick = service
            .admit(
                Request::Create {
                    name: "Alex".into(),
                    key: Some("test-creation-key".into()),
                },
                0,
                false,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&quick).unwrap()["capabilities"]["screenAudio"],
            false
        );
        assert_eq!(
            claims(quick)["video"]["canPublishSources"],
            serde_json::json!(["screen_share"])
        );
    }

    #[test]
    fn rejects_replayed_oversized_and_invalid_speech_segments() {
        let mut wav = vec![0_u8; 44];
        wav[..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        let mut chunk = AudioChunk {
            seq: 1,
            speaker_id: "speaker-one".into(),
            speaker_name: "Same display name".into(),
            started_at: 1000,
            ended_at: 2000,
            wav: base64::engine::general_purpose::STANDARD.encode(wav),
        };
        assert!(decode_chunk(&chunk, 0).is_ok());
        assert!(decode_chunk(&chunk, 1).is_err());
        chunk.ended_at = 20_000;
        assert!(decode_chunk(&chunk, 0).is_err());
        chunk.ended_at = 2000;
        chunk.wav = "A".repeat(427_001);
        assert!(decode_chunk(&chunk, 0).is_err());
    }

    #[test]
    fn room_admission_requires_creation_key_or_current_invite() {
        let key = "test-creation-key-only-for-tests";
        let service = RoomService::new(
            Url::parse("ws://127.0.0.1:7880").unwrap(),
            "devkey".into(),
            "secret".into(),
            key,
        );
        let create = |key: &str| Request::Create {
            name: "Presenter".into(),
            key: Some(key.into()),
        };
        assert!(service.admit(create("incorrect"), 0, false).is_err());
        let Reply::Admitted {
            invite: Some(invite),
            ..
        } = service.admit(create(key), 0, false).unwrap()
        else {
            panic!("creator should get an invite");
        };
        let join = || Request::Join {
            name: "Viewer".into(),
            code: invite.code.clone(),
        };
        assert!(matches!(
            service.admit(join(), invite.expires_at - 1, false),
            Ok(Reply::Admitted { invite: None, .. })
        ));
        assert!(service.admit(join(), invite.expires_at, false).is_err());
    }

    #[test]
    fn keyless_creation_requires_the_configured_proxy() {
        let service = RoomService::new(
            Url::parse("ws://127.0.0.1:7880").unwrap(),
            "devkey".into(),
            "secret".into(),
            "test-creation-key",
        )
        .with_proxy_key("test-proxy-key");
        let request = || Request::Create {
            name: "Presenter".into(),
            key: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, "tauri://localhost".parse().unwrap());
        for key in [None, Some("untrusted")] {
            if let Some(key) = key {
                headers.insert(PROXY_KEY_HEADER, key.parse().unwrap());
            }
            assert!(service
                .admit(request(), 0, service.trusted_proxy(&headers))
                .is_err());
        }
        headers.insert(PROXY_KEY_HEADER, "test-proxy-key".parse().unwrap());
        assert!(service
            .admit(request(), 0, service.trusted_proxy(&headers))
            .is_ok());
        for origin in ["https://example.org", "null"] {
            headers.insert(ORIGIN, origin.parse().unwrap());
            assert!(service
                .admit(request(), 0, service.trusted_proxy(&headers))
                .is_err());
        }
    }

    #[tokio::test]
    async fn admission_reports_the_media_room_occurrence_and_survives_its_absence() {
        use axum::{routing::post, Json};
        use futures_util::{SinkExt, StreamExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio_tungstenite::tungstenite::Message as Ws;
        let created = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let failing = Arc::new(AtomicUsize::new(0));
        let (seen, fail) = (created.clone(), failing.clone());
        let media = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let media_url = format!("ws://{}", media.local_addr().unwrap());
        let media_app = Router::new().route(
            "/twirp/livekit.RoomService/CreateRoom",
            post(move |Json(body): Json<serde_json::Value>| {
                let (seen, fail) = (seen.clone(), fail.clone());
                async move {
                    if fail.load(Ordering::SeqCst) > 0 {
                        return Err(StatusCode::SERVICE_UNAVAILABLE);
                    }
                    seen.lock().unwrap().push(body);
                    Ok(Json(
                        serde_json::json!({"sid":"RM_Occurrence1","name":"ignored"}),
                    ))
                }
            }),
        );
        let media_task = tokio::spawn(async move { axum::serve(media, media_app).await.unwrap() });
        let service = RoomService::new(
            Url::parse(&media_url).unwrap(),
            "devkey".into(),
            "secret".into(),
            "test-access",
        );
        let broker = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_url = format!("ws://{}/rooms", broker.local_addr().unwrap());
        let broker_task =
            tokio::spawn(async move { axum::serve(broker, router(service)).await.unwrap() });
        let admit = || async {
            let (mut socket, _) = tokio_tungstenite::connect_async(&broker_url).await.unwrap();
            socket
                .send(Ws::Text(
                    serde_json::json!({"type":"meeting","name":"Alex","community":"https://buzz.example/","room":"General Voice","key":"test-access"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let Some(Ok(Ws::Text(text))) = socket.next().await else {
                panic!("no admission")
            };
            serde_json::from_str::<serde_json::Value>(&text).unwrap()
        };
        let first = admit().await;
        assert_eq!(first["type"], "admitted");
        assert_eq!(first["occurrenceId"], "RM_Occurrence1");
        let body = created.lock().unwrap()[0].clone();
        assert_eq!(body["name"], first["room"]);
        assert_eq!(body["departure_timeout"], DEPARTURE_TIMEOUT);
        failing.store(1, Ordering::SeqCst);
        let degraded = admit().await;
        assert_eq!(degraded["type"], "admitted");
        assert!(degraded.get("occurrenceId").is_none());
        assert!(
            !valid_occurrence("RM_") && !valid_occurrence("XX_abc") && !valid_occurrence("RM_a\"b")
        );
        media_task.abort();
        broker_task.abort();
    }
}
