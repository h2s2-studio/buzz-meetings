use std::{env, net::SocketAddr};

use anyhow::{ensure, Context, Result};
use url::{Host, Url};

pub struct Config {
    pub bind_addr: SocketAddr,
    pub livekit_url: Url,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub room_creation_key: String,
    pub transcription_url: Option<Url>,
    pub room_proxy_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind_addr: SocketAddr = env::var("BUZZ_MEETINGS_BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8091".into())
            .parse()
            .context("invalid BUZZ_MEETINGS_BIND_ADDR")?;
        let livekit_url = Url::parse(&required("LIVEKIT_URL")?).context("invalid LIVEKIT_URL")?;
        let loopback = match livekit_url.host() {
            Some(Host::Domain("localhost")) => true,
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        ensure!(
            (livekit_url.scheme() == "wss" || (livekit_url.scheme() == "ws" && loopback))
                && livekit_url.host().is_some()
                && livekit_url.username().is_empty()
                && livekit_url.password().is_none()
                && livekit_url.query().is_none()
                && livekit_url.fragment().is_none(),
            "LIVEKIT_URL must be a wss URL or a loopback ws URL"
        );
        let room_creation_key = required("MEETING_ACCESS_KEY")?;
        ensure!(
            (24..=256).contains(&room_creation_key.len()),
            "MEETING_ACCESS_KEY must be 24–256 bytes"
        );
        let room_proxy_key = env::var("MEETING_PROXY_KEY")
            .ok()
            .filter(|key| !key.is_empty());
        if let Some(key) = &room_proxy_key {
            ensure!(
                bind_addr.ip().is_loopback(),
                "MEETING_PROXY_KEY requires a loopback listener"
            );
            ensure!(
                key.len() == 64
                    && key.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && key != &room_creation_key,
                "MEETING_PROXY_KEY must be a separate 64-character hexadecimal key"
            );
        }
        let transcription_url = env::var("MEETING_TRANSCRIBER_URL")
            .ok()
            .filter(|value| !value.is_empty())
            .map(|value| Url::parse(&value))
            .transpose()
            .context("invalid MEETING_TRANSCRIBER_URL")?;
        if let Some(url) = &transcription_url {
            ensure!(
                url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "MEETING_TRANSCRIBER_URL must be a private loopback HTTP endpoint"
            );
        }
        Ok(Self {
            bind_addr,
            livekit_url,
            room_creation_key,
            room_proxy_key,
            transcription_url,
            livekit_api_key: required("LIVEKIT_API_KEY")?,
            livekit_api_secret: required("LIVEKIT_API_SECRET")?,
        })
    }
}

fn required(name: &str) -> Result<String> {
    let value = env::var(name).with_context(|| format!("missing {name}"))?;
    ensure!(!value.is_empty(), "{name} is empty");
    Ok(value)
}
