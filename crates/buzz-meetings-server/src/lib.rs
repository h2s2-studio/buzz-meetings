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
const PROXY_KEY_HEADER: &str = "x-buzz-streams-proxy-key";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
    Create {
        name: String,
        key: Option<String>,
    },
    Join {
        name: String,
        code: String,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        invite: Option<Invite>,
    },
    Error {
        error: &'static str,
    },
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
        }
    }

    pub fn with_proxy_key(mut self, key: &str) -> Self {
        self.proxy_key_digest = Some(Sha256::digest(key.as_bytes()).into());
        self
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
        let mut invitations = self
            .invitations
            .lock()
            .map_err(|_| "Room service unavailable.")?;
        invitations.retain(|_, room| room.expires_at > now);
        let meeting = matches!(&request, Request::Meeting { .. });
        let mut metadata = None;
        let (name, room_name, invite) = match request {
            Request::Meeting {
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
        let token = AccessToken::with_api_key(&self.api_key, &self.api_secret)
            .with_identity(&random_code())
            .with_name(name)
            .with_metadata(&metadata.unwrap_or_default())
            .with_ttl(Duration::from_secs(90))
            .with_grants(VideoGrants {
                room: room_name.clone(),
                room_join: true,
                can_subscribe: Some(true),
                can_publish: Some(true),
                can_publish_sources: if meeting {
                    vec!["microphone".into(), "camera".into(), "screen_share".into()]
                } else {
                    vec!["screen_share".into()]
                },
                can_publish_data: Some(false),
                can_update_own_metadata: Some(false),
                ..Default::default()
            })
            .with_room_config(RoomConfiguration {
                max_participants: 12,
                empty_timeout: 120,
                departure_timeout: 20,
                ..Default::default()
            })
            .to_jwt()
            .map_err(|_| {
                tracing::error!("could not sign media admission");
                "Could not issue media admission."
            })?;
        if let Some(invite) = &invite {
            invitations.insert(
                invite.code.clone(),
                Room {
                    name: room_name,
                    expires_at: invite.expires_at,
                },
            );
        }
        Ok(Reply::Admitted {
            url: self.livekit_url.as_str(),
            token,
            invite,
        })
    }
}

fn random_code() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>())
}

fn matches_key(expected: &[u8; 32], supplied: &[u8]) -> bool {
    bool::from(expected.ct_eq(Sha256::digest(supplied).as_slice()))
}

pub fn router(rooms: RoomService) -> Router {
    Router::new()
        .route("/health", get(|| async { StatusCode::OK }))
        .route("/rooms", get(upgrade))
        .with_state(Arc::new(rooms))
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
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let _ = timeout(REQUEST_TIMEOUT, admit_socket(socket, rooms, trusted_proxy)).await;
        })
}

async fn admit_socket(mut socket: WebSocket, rooms: Arc<RoomService>, trusted_proxy: bool) {
    let Some(Ok(Message::Text(message))) = socket.recv().await else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let reply = serde_json::from_str::<Request>(&message)
        .map_err(|_| "Invalid room request.")
        .and_then(|request| rooms.admit(request, now.as_millis() as u64, trusted_proxy))
        .unwrap_or_else(|error| Reply::Error { error });
    if let Ok(text) = serde_json::to_string(&reply) {
        let _ = socket.send(Message::Text(text.into())).await;
    }
    let _ = socket.send(Message::Close(None)).await;
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
            serde_json::json!(["microphone", "camera", "screen_share"])
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
}
