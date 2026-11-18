use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use livekit_api::access_token::{AccessToken, VideoGrants};
use serde_json::{json, Value};
use tokio::time::{interval, timeout, MissedTickBehavior};

use crate::{random_code, RoomService};

async fn send(socket: &mut WebSocket, value: Value) -> bool {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

pub(super) async fn serve(
    socket: &mut WebSocket,
    service: &RoomService,
    room: &str,
    authorization: Option<(&str, nostr::PublicKey)>,
) {
    let Some(endpoint) = &service.transcription_url else {
        send(
            socket,
            json!({"type":"error", "error":"Transcription is unavailable."}),
        )
        .await;
        return;
    };
    let Ok(base) = endpoint.join("/sessions") else {
        return;
    };
    let lease = random_code();
    let token = AccessToken::with_api_key(&service.api_key, &service.api_secret)
        .with_identity(&format!("transcription-{room}"))
        .with_name("Meeting transcription")
        .with_ttl(Duration::from_secs(120))
        .with_grants(VideoGrants {
            room: room.to_owned(),
            room_join: true,
            can_subscribe: Some(true),
            can_publish: Some(false),
            can_publish_data: Some(false),
            hidden: false,
            agent: true,
            ..Default::default()
        })
        .to_jwt();
    let Ok(token) = token else {
        return;
    };
    let result = timeout(
        Duration::from_secs(20),
        service
            .http
            .post(base.clone())
            .json(&json!({
                "room":room, "lease":lease, "url":service.livekit_url.as_str(), "token":token,
            }))
            .send(),
    )
    .await;
    let response = match result {
        Ok(Ok(response)) if response.status().is_success() => response,
        _ => {
            send(socket, json!({"type":"error", "error":"Meeting transcription could not start. Try again shortly."})).await;
            return;
        }
    };
    let mut packet = match response.json::<Value>().await {
        Ok(value) => value,
        Err(_) => return,
    };
    let Ok(mut session) = endpoint.join(&format!("/sessions/{room}")) else {
        return;
    };
    session.query_pairs_mut().append_pair("lease", &lease);
    let mut tick = interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut access_checked = std::time::Instant::now();
    loop {
        if access_checked.elapsed() > Duration::from_secs(10) {
            if let Some((channel, viewer)) = authorization {
                if let Some(access) = &service.workspace_access {
                    if access.roster(&service.http, channel, viewer).await.is_err() {
                        send(socket, json!({"type":"error", "error":"Transcript access changed. Check channel membership."})).await;
                        break;
                    }
                }
            }
            access_checked = std::time::Instant::now();
        }
        let stream = packet
            .get("streamId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let after = packet
            .get("next")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let behind = packet
            .get("head")
            .and_then(Value::as_u64)
            .is_some_and(|head| head > after);
        packet["type"] = json!("captions");
        if !send(socket, packet).await {
            break;
        }
        if !behind {
            tokio::select! {
                incoming = socket.recv() => {
                    match incoming {
                        Some(Ok(Message::Text(value))) if value.as_str() == r#"{"type":"ping"}"# => {},
                        Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                        _ => break,
                    }
                }
                _ = tick.tick() => {}
            }
        }
        let mut poll = session.clone();
        poll.query_pairs_mut()
            .append_pair("after", &after.to_string())
            .append_pair("stream", &stream);
        let result = timeout(Duration::from_secs(5), service.http.get(poll).send()).await;
        let response = match result {
            Ok(Ok(response)) if response.status().is_success() => response,
            _ => {
                send(socket, json!({"type":"error", "error":"The shared transcript disconnected. Resume to reconnect."})).await;
                break;
            }
        };
        packet = match response.json::<Value>().await {
            Ok(value) => value,
            Err(_) => break,
        };
    }
    let _ = timeout(Duration::from_secs(5), service.http.delete(session).send()).await;
}
