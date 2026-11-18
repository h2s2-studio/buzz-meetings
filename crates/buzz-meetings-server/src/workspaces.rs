use std::{fs::OpenOptions, io::Write, path::Path, sync::Arc, time::Duration};

use axum::extract::ws::{Message, WebSocket};
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, Timestamp};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::time::timeout;
use url::Url;

use crate::{captions, random_code, Reply, RoomService};

pub struct WorkspaceAccess {
    relay: Url,
    relay_author: PublicKey,
    keys: Keys,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceRequest {
    pub name: String,
    pub community: String,
    pub channel: String,
    pub picture: Option<String>,
    #[serde(default)]
    pub captions: bool,
    /// Read who is in the call without joining it (pre-join overview).
    #[serde(default)]
    pub presence: bool,
    /// Publish one of the requester's agents' screens: the agent's public key (hex).
    /// The admission is screen-share only and cannot subscribe.
    #[serde(default)]
    pub presenter: Option<String>,
}

/// The agent a presenter identity (`<owner>-presenter-<agent>-<nonce>`) publishes for.
pub(super) fn presenter_agent(identity: &str) -> Option<PublicKey> {
    let rest = identity.get(64..)?.strip_prefix("-presenter-")?;
    PublicKey::from_hex(rest.get(..64)?).ok()
}

impl WorkspaceAccess {
    pub fn load(relay: Url, relay_author: PublicKey, path: &Path) -> anyhow::Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let keys = match std::fs::read_to_string(path) {
            Ok(value) => Keys::parse(value.trim())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let keys = Keys::generate();
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(path)?;
                file.write_all(keys.secret_key().to_secret_hex().as_bytes())?;
                file.sync_all()?;
                keys
            }
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            relay.scheme() == "https"
                || matches!(relay.host_str(), Some("127.0.0.1" | "localhost")),
            "Workspace relay requires HTTPS"
        );
        anyhow::ensure!(
            relay.path() == "/"
                && relay.query().is_none()
                && relay.fragment().is_none()
                && relay.username().is_empty()
                && relay.password().is_none(),
            "Invalid workspace relay origin"
        );
        Ok(Self {
            relay,
            relay_author,
            keys,
        })
    }

    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let origin = std::env::var("MEETING_RELAY_URL")
            .ok()
            .filter(|value| !value.is_empty());
        let author = std::env::var("MEETING_RELAY_PUBLIC_KEY")
            .ok()
            .filter(|value| !value.is_empty());
        let identity = std::env::var("MEETING_IDENTITY_FILE")
            .ok()
            .filter(|value| !value.is_empty());
        match (origin, author, identity) {
            (None,None,None) => Ok(None),
            (Some(origin),Some(author),Some(identity)) => Ok(Some(Self::load(Url::parse(&origin)?, PublicKey::from_hex(&author)?, Path::new(&identity))?)),
            _ => anyhow::bail!("Workspace voice needs MEETING_RELAY_URL, MEETING_RELAY_PUBLIC_KEY and MEETING_IDENTITY_FILE"),
        }
    }

    pub fn public_key(&self) -> String {
        self.keys.public_key().to_hex()
    }
    pub fn origin(&self) -> String {
        self.relay.origin().ascii_serialization()
    }

    pub(super) async fn roster(
        &self,
        http: &reqwest::Client,
        channel: &str,
        viewer: PublicKey,
    ) -> Result<(), &'static str> {
        let url = self
            .relay
            .join("query")
            .map_err(|_| "Invalid workspace relay.")?;
        let body = json!([{"kinds":[39000,39002], "#d":[channel]}]).to_string();
        let digest = hex_digest(body.as_bytes());
        let tags = vec![
            Tag::parse(["u", url.as_str()]),
            Tag::parse(["method", "POST"]),
            Tag::parse(["payload", digest.as_str()]),
        ]
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Workspace authorization failed.")?;
        let event = EventBuilder::new(Kind::Custom(27235), "")
            .tags(tags)
            .sign_with_keys(&self.keys)
            .map_err(|_| "Workspace authorization failed.")?;
        let response = http
            .post(url)
            .header(
                "Authorization",
                format!("Nostr {}", STANDARD.encode(event.as_json())),
            )
            .header("Content-Type", "application/json")
            .header("Cache-Control", "no-store")
            .body(body)
            .send()
            .await
            .map_err(|_| "The channel access check could not reach Buzz.")?;
        if !response.status().is_success() {
            return Err("Add the Meetings service to this channel to enable its voice room.");
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "The channel access check failed.")?
        {
            if bytes.len() + chunk.len() > 256_000 {
                return Err("The channel access response was too large.");
            }
            bytes.extend_from_slice(&chunk);
        }
        let events: Vec<Event> = serde_json::from_slice(&bytes)
            .map_err(|_| "The channel access response was invalid.")?;
        self.validate_roster(&events, channel, viewer)
    }

    fn validate_roster(
        &self,
        events: &[Event],
        channel: &str,
        viewer: PublicKey,
    ) -> Result<(), &'static str> {
        let latest = |kind| {
            events
                .iter()
                .filter(|event| {
                    event.kind == Kind::Custom(kind)
                        && event.pubkey == self.relay_author
                        && event.verify().is_ok()
                        && exact_tag(event, "d") == Some(channel)
                })
                .max_by_key(|event| (event.created_at, event.id))
        };
        let metadata = latest(39000).ok_or("Current channel details could not be verified.")?;
        let roster = latest(39002).ok_or("Current channel members could not be verified.")?;
        if !matches!(exact_tag(metadata, "archived"), None | Some("false"))
            || exact_tag(metadata, "t") != Some("stream")
        {
            return Err("This channel cannot host a meeting.");
        }
        let member = |key: PublicKey| {
            roster.tags.iter().any(|tag| {
                tag.as_slice().get(0).map(String::as_str) == Some("p")
                    && tag
                        .as_slice()
                        .get(1)
                        .is_some_and(|value| *value == key.to_hex())
            })
        };
        if !member(viewer) || !member(self.keys.public_key()) {
            return Err("You and the Meetings service need current channel access.");
        }
        Ok(())
    }
}

fn exact_tag<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
    let mut matches = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|value| value == key));
    let first = matches.next()?;
    if matches.next().is_some() || first.as_slice().len() != 2 {
        return None;
    }
    first.as_slice().get(1).map(String::as_str)
}

fn proof(
    event: &Event,
    nonce: &str,
    digest: &str,
    channel: &str,
) -> Result<PublicKey, &'static str> {
    let now = Timestamp::now().as_secs();
    if event.kind != Kind::Custom(45010)
        || event.verify().is_err()
        || event.created_at.as_secs().abs_diff(now) > 30
        || exact_tag(event, "h") != Some(channel)
        || event.content != format!("Meetings admission {nonce} {digest}")
    {
        return Err("The meeting admission proof is invalid or expired.");
    }
    Ok(event.pubkey)
}

pub(super) async fn serve(
    socket: &mut WebSocket,
    service: Arc<RoomService>,
    raw: &str,
    request: WorkspaceRequest,
) {
    let result = authorize(socket, &service, raw, &request).await;
    match result {
        Ok((viewer, room)) => {
            if request.presence {
                let _ = socket
                    .send(Message::Text(
                        crate::presence(&service, &room).await.to_string().into(),
                    ))
                    .await;
            } else if request.captions {
                captions::serve(socket, &service, &room, Some((&request.channel, viewer))).await;
            } else if let Some(agent) = &request.presenter {
                // The owner is admitted above; the agent must also belong to the channel.
                // Clients show the stream under the agent only while that owner's own
                // participant lists the agent, so the owner vouches for it.
                let reply = match present(&service, &request, viewer, agent, &room).await {
                    Ok(token) => serde_json::to_string(&Reply::Admitted {
                        url: service.livekit_url.as_str(),
                        token,
                        occurrence_id: service.occurrence(&room).await,
                        room,
                        capabilities: service.capabilities(false),
                        invite: None,
                    })
                    .unwrap_or_default(),
                    Err(error) => json!({"type":"error","error":error}).to_string(),
                };
                let _ = socket.send(Message::Text(reply.into())).await;
            } else {
                let metadata =
                    json!({"picture":request.picture, "channel":request.channel}).to_string();
                let identity = format!("{}-{}", viewer.to_hex(), random_code());
                match service.media_token(&request.name, &room, &metadata, true, &identity) {
                    Ok(token) => {
                        let occurrence_id = service.occurrence(&room).await;
                        let reply = Reply::Admitted {
                            url: service.livekit_url.as_str(),
                            token,
                            room,
                            occurrence_id,
                            capabilities: service.capabilities(true),
                            invite: None,
                        };
                        if let Ok(text) = serde_json::to_string(&reply) {
                            let _ = socket.send(Message::Text(text.into())).await;
                        }
                    }
                    Err(error) => {
                        let _ = socket
                            .send(Message::Text(
                                json!({"type":"error","error":error}).to_string().into(),
                            ))
                            .await;
                    }
                }
            }
        }
        Err(error) => {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":error}).to_string().into(),
                ))
                .await;
        }
    }
}

async fn authorize(
    socket: &mut WebSocket,
    service: &RoomService,
    raw: &str,
    request: &WorkspaceRequest,
) -> Result<(PublicKey, String), &'static str> {
    let access = service
        .workspace_access
        .as_ref()
        .ok_or("Workspace voice is not configured on this meeting service.")?;
    if request.community != access.origin()
        || !valid_channel(&request.channel)
        || request.name.trim().is_empty()
        || request.name.chars().count() > 48
        || request.name.chars().any(char::is_control)
    {
        return Err("Invalid meeting destination.");
    }
    let nonce = random_code();
    let digest = hex_digest(raw.as_bytes());
    socket
        .send(Message::Text(
            json!({"type":"challenge","nonce":nonce,"digest":digest})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|_| "Meeting admission canceled.")?;
    let frame = timeout(Duration::from_secs(15), socket.recv())
        .await
        .map_err(|_| "Meeting admission timed out.")?;
    let Some(Ok(Message::Text(message))) = frame else {
        return Err("Meeting admission canceled.");
    };
    if message.len() > 8000 {
        return Err("Invalid meeting proof.");
    }
    let value: Value =
        serde_json::from_str(message.as_str()).map_err(|_| "Invalid meeting proof.")?;
    let event: Event = serde_json::from_value(value.get("event").cloned().unwrap_or(Value::Null))
        .map_err(|_| "Invalid meeting proof.")?;
    let viewer = proof(&event, &nonce, &digest, &request.channel)?;
    timeout(
        Duration::from_secs(8),
        access.roster(&service.http, &request.channel, viewer),
    )
    .await
    .map_err(|_| "Channel access verification timed out.")??;
    let room = format!(
        "workspace-{}",
        crate::URL_SAFE_NO_PAD.encode(Sha256::digest(format!(
            "{}\n{}",
            access.origin(),
            request.channel
        )))
    );
    Ok((viewer, room))
}

async fn present(
    service: &RoomService,
    request: &WorkspaceRequest,
    viewer: PublicKey,
    agent: &str,
    room: &str,
) -> Result<String, &'static str> {
    let access = service
        .workspace_access
        .as_ref()
        .ok_or("Workspace voice is not configured on this meeting service.")?;
    let agent = (agent.len() == 64)
        .then(|| PublicKey::from_hex(agent).ok())
        .flatten()
        .ok_or("Invalid agent.")?;
    timeout(
        Duration::from_secs(8),
        access.roster(&service.http, &request.channel, agent),
    )
    .await
    .map_err(|_| "Channel access verification timed out.")?
    .map_err(|_| "That agent is not a member of this channel.")?;
    let identity = format!(
        "{}-presenter-{}-{}",
        viewer.to_hex(),
        agent.to_hex(),
        random_code()
    );
    let metadata = json!({"channel":request.channel, "presenter":agent.to_hex()}).to_string();
    service.presenter_token(&request.name, room, &metadata, &identity)
}

fn valid_channel(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| {
            if [8, 13, 18, 23].contains(&index) {
                ch == '-'
            } else {
                ch.is_ascii_hexdigit()
            }
        })
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn media_api(base: &Url, action: &str) -> Option<Url> {
    let mut api = base.clone();
    let scheme = if api.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    api.set_scheme(scheme).ok()?;
    api.set_path(&format!(
        "{}/twirp/livekit.RoomService/{action}",
        base.path().trim_end_matches('/')
    ));
    Some(api)
}

// Reconstruct monitoring from the media server on every broker start. Admission-
// local tasks alone would lose revocation coverage after a broker restart.
pub(super) async fn guard(service: Arc<RoomService>) {
    use livekit_api::access_token::{AccessToken, VideoGrants};
    let Some(access) = &service.workspace_access else {
        return;
    };
    let token = |room: &str| {
        AccessToken::with_api_key(&service.api_key, &service.api_secret)
            .with_ttl(Duration::from_secs(60))
            .with_grants(VideoGrants {
                room: room.to_owned(),
                room_list: room.is_empty(),
                room_admin: !room.is_empty(),
                ..Default::default()
            })
            .to_jwt()
    };
    let mut failures = std::collections::HashMap::<String, u8>::new();
    loop {
        let cycle = async {
            let list = media_api(&service.livekit_url, "ListRooms")?;
            let rooms: Value = service
                .http
                .post(list)
                .bearer_auth(token("").ok()?)
                .json(&json!({}))
                .timeout(Duration::from_secs(5))
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json()
                .await
                .ok()?;
            let mut seen = std::collections::HashSet::new();
            if rooms.get("rooms").is_some_and(|value| !value.is_array()) {
                return None;
            }
            for room in rooms
                .get("rooms")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = room
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| name.starts_with("workspace-"))
                else {
                    continue;
                };
                let jwt = token(name).ok()?;
                let endpoint = media_api(&service.livekit_url, "ListParticipants")?;
                let people: Value = match service
                    .http
                    .post(endpoint)
                    .bearer_auth(&jwt)
                    .json(&json!({"room":name}))
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => match response.json().await {
                        Ok(value) => value,
                        Err(_) => continue,
                    },
                    _ => continue,
                };
                let Some(participants) = people.get("participants").and_then(Value::as_array)
                else {
                    continue;
                };
                for participant in participants {
                    let Some(identity) = participant.get("identity").and_then(Value::as_str) else {
                        continue;
                    };
                    if identity.starts_with("transcription-") {
                        continue;
                    }
                    let key = format!("{name}:{identity}");
                    seen.insert(key.clone());
                    let metadata: Value = serde_json::from_str(
                        participant
                            .get("metadata")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
                    .unwrap_or(Value::Null);
                    let channel = metadata
                        .get("channel")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let viewer = identity
                        .get(..64)
                        .and_then(|value| PublicKey::from_hex(value).ok());
                    let expected = format!(
                        "workspace-{}",
                        crate::URL_SAFE_NO_PAD.encode(Sha256::digest(format!(
                            "{}\n{}",
                            access.origin(),
                            channel
                        )))
                    );
                    let allowed = if valid_channel(channel) && expected == name {
                        if let Some(viewer) = viewer {
                            let owner = access.roster(&service.http, channel, viewer).await;
                            // A presenter stays only while its owner and its agent both belong.
                            match (owner, presenter_agent(identity)) {
                                (Ok(()), Some(agent)) => {
                                    access.roster(&service.http, channel, agent).await
                                }
                                (owner, _) => owner,
                            }
                        } else {
                            Err("Invalid participant identity.")
                        }
                    } else {
                        Err("Invalid meeting destination.")
                    };
                    if allowed.is_ok() {
                        failures.remove(&key);
                        continue;
                    }
                    // An unavailable relay gets bounded retry; explicit access denial does not.
                    if allowed == Err("The channel access check could not reach Buzz.") {
                        let count = failures.entry(key.clone()).or_default();
                        *count = count.saturating_add(1);
                        if *count < 3 {
                            continue;
                        }
                    }
                    let remove = media_api(&service.livekit_url, "RemoveParticipant")?;
                    match service
                        .http
                        .post(remove)
                        .bearer_auth(&jwt)
                        .json(&json!({"room":name,"identity":identity}))
                        .timeout(Duration::from_secs(5))
                        .send()
                        .await
                    {
                        Ok(response) if response.status().is_success() => {
                            failures.remove(&key);
                        }
                        _ => {
                            tracing::warn!("Workspace participant removal is retrying after a media API failure");
                        }
                    }
                }
            }
            failures.retain(|key, _| seen.contains(key));
            Some(())
        };
        if cycle.await.is_none() {
            tracing::warn!("Workspace access monitoring could not reach the media API; retrying");
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn signed(keys: &Keys, kind: u16, tags: Vec<Vec<&str>>, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
            .sign_with_keys(keys)
            .unwrap()
    }
    #[test]
    fn workspace_proofs_bind_the_signature_challenge_channel_and_request() {
        let keys = Keys::generate();
        let event = signed(
            &keys,
            45010,
            vec![vec!["h", "channel"]],
            "Meetings admission nonce digest",
        );
        assert_eq!(
            proof(&event, "nonce", "digest", "channel").unwrap(),
            keys.public_key()
        );
        for (nonce, digest, channel) in [
            ("other", "digest", "channel"),
            ("nonce", "other", "channel"),
            ("nonce", "digest", "other"),
        ] {
            assert!(proof(&event, nonce, digest, channel).is_err());
        }
        let mut altered = event.clone();
        altered.content = "changed".into();
        assert!(proof(&altered, "nonce", "digest", "channel").is_err());
    }
    #[test]
    fn current_roster_requires_the_relay_signature_and_both_members() {
        let relay = Keys::generate();
        let service = Keys::generate();
        let viewer = Keys::generate();
        let access = WorkspaceAccess {
            relay: Url::parse("https://example.org").unwrap(),
            relay_author: relay.public_key(),
            keys: service.clone(),
        };
        let service_key = service.public_key().to_hex();
        let viewer_key = viewer.public_key().to_hex();
        let metadata = signed(
            &relay,
            39000,
            vec![vec!["d", "channel"], vec!["t", "stream"]],
            "",
        );
        let roster = signed(
            &relay,
            39002,
            vec![
                vec!["d", "channel"],
                vec!["p", &service_key],
                vec!["p", &viewer_key],
            ],
            "",
        );
        assert!(access
            .validate_roster(&[metadata.clone(), roster], "channel", viewer.public_key())
            .is_ok());
        let revoked = signed(
            &relay,
            39002,
            vec![vec!["d", "channel"], vec!["p", &service_key]],
            "",
        );
        assert!(access
            .validate_roster(&[metadata.clone(), revoked], "channel", viewer.public_key())
            .is_err());
        let forged = signed(
            &viewer,
            39002,
            vec![
                vec!["d", "channel"],
                vec!["p", &service_key],
                vec!["p", &viewer_key],
            ],
            "",
        );
        assert!(access
            .validate_roster(&[metadata, forged], "channel", viewer.public_key())
            .is_err());
    }
    #[tokio::test]
    async fn admission_checks_a_live_relay_roster_and_keeps_room_identity_across_names() {
        use axum::{routing::post, Json, Router};
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message as Ws};
        let author = Keys::generate();
        let service_keys = Keys::generate();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let channel = "10000000-0000-4000-8000-000000000001";
        let data = Arc::new(std::sync::Mutex::new(vec![
            signed(
                &author,
                39000,
                vec![vec!["d", channel], vec!["t", "stream"]],
                "",
            ),
            signed(
                &author,
                39002,
                vec![
                    vec!["d", channel],
                    vec!["p", &owner.public_key().to_hex()],
                    vec!["p", &agent.public_key().to_hex()],
                    vec!["p", &service_keys.public_key().to_hex()],
                ],
                "",
            ),
        ]));
        let relay_socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", relay_socket.local_addr().unwrap());
        let expected_url = format!("{origin}/query");
        let key = service_keys.public_key();
        let rows = data.clone();
        let mock = Router::new().route(
            "/query",
            post(move |headers: axum::http::HeaderMap, body: String| {
                let rows = rows.clone();
                let url = expected_url.clone();
                async move {
                    let header = headers["Authorization"]
                        .to_str()
                        .unwrap()
                        .strip_prefix("Nostr ")
                        .unwrap();
                    let event = Event::from_json(STANDARD.decode(header).unwrap()).unwrap();
                    assert!(event.verify().is_ok());
                    assert_eq!(event.pubkey, key);
                    assert_eq!(exact_tag(&event, "u"), Some(url.as_str()));
                    assert_eq!(exact_tag(&event, "method"), Some("POST"));
                    assert_eq!(
                        exact_tag(&event, "payload"),
                        Some(hex_digest(body.as_bytes()).as_str())
                    );
                    Json(rows.lock().unwrap().clone())
                }
            }),
        );
        let relay_task = tokio::spawn(async move {
            axum::serve(relay_socket, mock).await.unwrap();
        });
        let access = WorkspaceAccess {
            relay: Url::parse(&format!("{origin}/")).unwrap(),
            relay_author: author.public_key(),
            keys: service_keys,
        };
        let rooms = RoomService::new(
            Url::parse("ws://127.0.0.1:9999").unwrap(),
            "test-key".into(),
            "test-secret".into(),
            "test-access",
        )
        .with_workspace_access(access);
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker = format!("ws://{}/rooms", socket.local_addr().unwrap());
        let app = crate::router(rooms);
        let service_task = tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        });
        // A presenter admission: the owner proves membership, the agent must be a member too,
        // and the token can only publish a screen share.
        let outsider = Keys::generate().public_key().to_hex();
        for (presenter, admitted) in [
            (agent.public_key().to_hex(), true),
            (outsider, false),
            ("not-a-key".to_owned(), false),
        ] {
            let (mut socket, _) = connect_async(&broker).await.unwrap();
            let raw = json!({"type":"workspace","name":"Studio","community":origin,"channel":channel,"presenter":presenter}).to_string();
            socket.send(Ws::Text(raw.into())).await.unwrap();
            let challenge: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            let content = format!(
                "Meetings admission {} {}",
                challenge["nonce"].as_str().unwrap(),
                challenge["digest"].as_str().unwrap()
            );
            let event = signed(&owner, 45010, vec![vec!["h", channel]], &content);
            socket
                .send(Ws::Text(json!({"event":event}).to_string().into()))
                .await
                .unwrap();
            let result: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            if !admitted {
                assert_eq!(result["type"], "error", "{presenter}");
                continue;
            }
            assert_eq!(result["type"], "admitted");
            let payload = result["token"].as_str().unwrap().split('.').nth(1).unwrap();
            let claims: Value =
                serde_json::from_slice(&crate::URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
            let identity = claims["sub"].as_str().unwrap();
            assert!(identity.starts_with(&format!(
                "{}-presenter-{}-",
                owner.public_key().to_hex(),
                agent.public_key().to_hex()
            )));
            assert_eq!(presenter_agent(identity), Some(agent.public_key()));
            assert_eq!(
                claims["video"]["canPublishSources"],
                json!(["screen_share"])
            );
            assert_eq!(claims["video"]["canSubscribe"], false);
            assert_eq!(claims["video"]["canPublishData"], false);
            assert_eq!(claims["video"]["canUpdateOwnMetadata"], false);
            let metadata: Value =
                serde_json::from_str(claims["metadata"].as_str().unwrap()).unwrap();
            assert_eq!(metadata["presenter"], agent.public_key().to_hex());
            assert_eq!(metadata["channel"], channel);
        }
        assert_eq!(
            presenter_agent(&format!("{}-abc", owner.public_key().to_hex())),
            None
        );
        let mut room_id = String::new();
        for name in ["Lounge", "Renamed Lounge", "Revoked Lounge"] {
            if name == "Revoked Lounge" {
                data.lock()
                    .unwrap()
                    .retain(|event| event.kind != Kind::Custom(39002));
            }
            let (mut socket, _) = connect_async(&broker).await.unwrap();
            let raw = json!({"type":"workspace","name":"Alex","community":origin,"channel":channel,"room":name}).to_string();
            socket.send(Ws::Text(raw.into())).await.unwrap();
            let challenge: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(challenge["type"], "challenge");
            let content = format!(
                "Meetings admission {} {}",
                challenge["nonce"].as_str().unwrap(),
                challenge["digest"].as_str().unwrap()
            );
            let event = signed(&owner, 45010, vec![vec!["h", channel]], &content);
            socket
                .send(Ws::Text(json!({"event":event}).to_string().into()))
                .await
                .unwrap();
            let result: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            if name == "Revoked Lounge" {
                assert_eq!(result["type"], "error");
            } else {
                assert_eq!(result["type"], "admitted");
                let id = result["room"].as_str().unwrap();
                if room_id.is_empty() {
                    room_id = id.to_owned();
                } else {
                    assert_eq!(id, room_id);
                }
            }
        }
        service_task.abort();
        relay_task.abort();
    }
    #[tokio::test]
    async fn restarted_guard_finds_existing_calls_and_retries_a_failed_removal() {
        use axum::{routing::post, Json, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let author = Keys::generate();
        let keys = Keys::generate();
        let owner = Keys::generate();
        let channel = "10000000-0000-4000-8000-000000000001";
        let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", relay.local_addr().unwrap());
        let rows = vec![
            signed(
                &author,
                39000,
                vec![vec!["d", channel], vec!["t", "stream"]],
                "",
            ),
            signed(
                &author,
                39002,
                vec![vec!["d", channel], vec!["p", &keys.public_key().to_hex()]],
                "",
            ),
        ];
        let relay_app = Router::new().route(
            "/query",
            post(move || {
                let rows = rows.clone();
                async move { Json(rows) }
            }),
        );
        let relay_task = tokio::spawn(async move {
            axum::serve(relay, relay_app).await.unwrap();
        });
        let room = format!(
            "workspace-{}",
            crate::URL_SAFE_NO_PAD.encode(Sha256::digest(format!("{origin}\n{channel}")))
        );
        let room_name = room.clone();
        let identity = format!("{}-existing", owner.public_key().to_hex());
        let removed = Arc::new(AtomicUsize::new(0));
        let attempts = removed.clone();
        let media = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/streams", media.local_addr().unwrap());
        let media_app=Router::new()
            .route("/streams/twirp/livekit.RoomService/ListRooms",post(move || { let room=room_name.clone(); async move { Json(json!({"rooms":[{"name":room}]})) } }))
            .route("/streams/twirp/livekit.RoomService/ListParticipants",post(move || { let identity=identity.clone(); async move { Json(json!({"participants":[{"identity":identity,"metadata":json!({"channel":channel}).to_string()}]})) } }))
            .route("/streams/twirp/livekit.RoomService/RemoveParticipant",post(move || { let attempts=attempts.clone(); async move { if attempts.fetch_add(1,Ordering::SeqCst)==0 { axum::http::StatusCode::SERVICE_UNAVAILABLE } else { axum::http::StatusCode::OK } } }));
        let media_task = tokio::spawn(async move {
            axum::serve(media, media_app).await.unwrap();
        });
        let service = RoomService::new(
            Url::parse(&url).unwrap(),
            "test-key".into(),
            "test-secret".into(),
            "test-access",
        )
        .with_workspace_access(WorkspaceAccess {
            relay: Url::parse(&format!("{origin}/")).unwrap(),
            relay_author: author.public_key(),
            keys,
        });
        let watcher = tokio::spawn(guard(Arc::new(service)));
        tokio::time::timeout(Duration::from_secs(16), async {
            while removed.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        watcher.abort();
        media_task.abort();
        relay_task.abort();
    }
}
