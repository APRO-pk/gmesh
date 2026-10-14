//! GMESH — standalone, browser-based mesh generation tool.
//!
//! Application layer (this Rust binary) is responsible for the web server,
//! request handling, and file I/O. All real meshing computation is
//! delegated to a Python/Gmsh worker subprocess (see [`worker`]).

mod api;
mod error;
mod routes;
mod worker;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use routes::AppState;

#[tokio::main]
async fn main() -> Result<(), String> {
    init_tracing()?;

    let python = std::env::var("GMESH_PYTHON").unwrap_or_else(|_| "python".to_string());
    let worker_script = worker::worker_script_path();
    tracing::info!(
        "starting Gmsh python worker: python={python} script={}",
        worker_script.display()
    );

    let worker = Arc::new(worker::Worker::spawn(&python, &worker_script)?);
    tracing::info!("python worker spawned");

    let state = AppState {
        worker,
        next_job: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        work_dir: work_dir(),
        entity_snapshot: Arc::new(std::sync::RwLock::new(None)),
        busy: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        gmsh_version: Arc::new(std::sync::RwLock::new(None)),
    };
    std::fs::create_dir_all(&state.work_dir)
        .map_err(|e| format!("failed to create work dir: {e}"))?;
    tracing::info!("work dir: {}", state.work_dir.display());

    // Warm up the Gmsh worker in the background: the first `ping` normally pays
    // the cost of importing + initialising Gmsh (seconds), which made the UI
    // look "not connected yet". Doing it now means the browser's first health
    // check answers in milliseconds.
    {
        let worker = state.worker.clone();
        let version_slot = state.gmsh_version.clone();
        tokio::spawn(async move {
            match worker.ping().await {
                Ok(resp) if resp.is_ok() => {
                    if let Some(v) = resp.data.get("gmsh_version").and_then(|v| v.as_str()) {
                        if let Ok(mut slot) = version_slot.write() {
                            *slot = Some(v.to_string());
                        }
                    }
                    tracing::info!("Gmsh worker warm-up complete");
                }
                other => tracing::warn!(
                    "Gmsh worker warm-up failed: {}",
                    other.err().unwrap_or_else(|| "unknown".into())
                ),
            }
        });
    }

    let web_dir = web_dir();
    let app = Router::new()
        .route("/api/ping", axum::routing::get(routes::ping))
        .route(
            "/api/restart-engine",
            axum::routing::post(routes::restart_engine),
        )
        .route("/api/mesh", axum::routing::post(routes::import_mesh))
        .route("/api/pick", axum::routing::post(routes::pick))
        .route("/api/entities", axum::routing::get(routes::entities))
        .route("/api/progress/:token", axum::routing::get(routes::progress))
        .route(
            "/preview/:job_id/:file",
            axum::routing::get(routes::preview),
        )
        .fallback_service(ServeDir::new(&web_dir))
        .layer(middleware::from_fn(no_cache))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = listen_addr();
    // If the preferred port is taken (e.g. an older instance is still running),
    // try the next few ports instead of exiting — a dead server is worse than a
    // shifted URL, and the chosen URL is printed loudly below.
    let mut listener = None;
    let mut bound = addr;
    let mut last_err = String::new();
    for offset in 0..10u16 {
        let candidate = SocketAddr::new(addr.ip(), addr.port() + offset);
        match tokio::net::TcpListener::bind(candidate).await {
            Ok(l) => {
                listener = Some(l);
                bound = candidate;
                break;
            }
            Err(e) => last_err = format!("{candidate}: {e}"),
        }
    }
    let listener = listener.ok_or_else(|| {
        format!(
            "could not bind any port in {}..{} (is another GMESH already running?) — last error: {last_err}",
            addr.port(),
            addr.port() + 9
        )
    })?;
    if bound.port() != addr.port() {
        tracing::warn!("port {} was busy; using {bound} instead", addr.port());
    }
    tracing::info!("GMESH listening on http://{bound}");
    tracing::info!("static assets served from {}", web_dir.display());
    println!();
    println!("  GMESH is running. Open:  http://{bound}/");
    println!("  Keep this window open. If it ever stops, the launcher restarts it.");
    println!();

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("server error: {e}"))?;

    Ok(())
}

fn init_tracing() -> Result<(), String> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gmesh=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .try_init()
        .map_err(|e| format!("failed to init tracing: {e}"))
}

fn listen_addr() -> SocketAddr {
    std::env::var("GMESH_ADDR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| "127.0.0.1:3000".parse().expect("static fallback addr"))
}

/// Locates the static web assets.
///
/// Order: explicit env var, then a `web/` folder next to the executable (so a
/// shipped build is relocatable), then the source tree it was compiled from.
fn web_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("GMESH_WEB_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // .../gmesh.exe -> .../web
            let cand = dir.join("web");
            if cand.is_dir() {
                return cand;
            }
            // .../target/release/gmesh.exe -> <root>/web
            if let Some(root) = dir.parent().and_then(|p| p.parent()) {
                let cand = root.join("web");
                if cand.is_dir() {
                    return cand;
                }
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web")
}

/// Disable browser caching so the always-evolving frontend assets are
/// never served stale (no `Cache-Control` means browsers may keep old JS).
async fn no_cache(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    res
}

fn work_dir() -> PathBuf {
    std::env::var_os("GMESH_WORK_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("gmesh"))
}
