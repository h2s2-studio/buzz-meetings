mod config;

use anyhow::{Context, Result};
use buzz_meetings_server::{router, RoomService};
use config::Config;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    let listener = TcpListener::bind(config.bind_addr)
        .await
        .context("bind Buzz Meetings service")?;
    let mut rooms = RoomService::new(
        config.livekit_url,
        config.livekit_api_key,
        config.livekit_api_secret,
        &config.room_creation_key,
    );
    if let Some(key) = &config.room_proxy_key {
        rooms = rooms.with_proxy_key(key);
    }
    tracing::info!(addr = %listener.local_addr()?, "Buzz Meetings room service listening");
    axum::serve(listener, router(rooms))
        .with_graceful_shutdown(shutdown())
        .await
        .context("serve Buzz Meetings requests")
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
