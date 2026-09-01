#[cfg(target_env = "musl")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod api;
mod access;
mod auth;
mod config;
mod error;
mod extract;
mod search;
mod state;
mod chip;
mod planned_input;
mod transform;
mod ui;
mod users;
mod workspace;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::Router;
use clap::Parser;
use tokio::sync::{mpsc, Semaphore};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[derive(Parser)]
#[command(name = "bintl", about = "BinTL ETL console")]
struct Cli {
    #[arg(long)]
    config: std::path::PathBuf,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let config = Config::load(&cli.config).unwrap_or_else(|e| {
        eprintln!("config error: {e}");
        std::process::exit(1);
    });

    let store = storage::Store::open(&config.data_dir, &config.session_secret)
        .await
        .unwrap_or_else(|e| {
            eprintln!("storage error: {e}");
            std::process::exit(1);
        });

    store
        .ensure_bootstrap(&config.auth.username, &config.auth.password)
        .await
        .unwrap_or_else(|e| {
            eprintln!("bootstrap user error: {e}");
            std::process::exit(1);
        });

    let execution_permits = Arc::new(Semaphore::new(config.max_concurrent_jobs.max(1)));
    let (job_tx, job_rx) = mpsc::channel::<String>(64);
    let _worker = jobs::spawn_worker(store.clone(), job_rx, execution_permits.clone());
    let (chip_tx, chip_rx) = mpsc::channel::<String>(64);
    let _chip_worker = chip::spawn_worker(
        store.clone(),
        chip_rx,
        job_tx.clone(),
        execution_permits,
    );

    let state = AppState {
        store,
        job_tx,
        chip_tx,
        config: Arc::new(config),
    };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "http://127.0.0.1:5173".parse().unwrap(),
            "http://localhost:5173".parse().unwrap(),
        ]))
        .allow_credentials(true)
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::COOKIE,
            axum::http::header::AUTHORIZATION,
        ])
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::PATCH,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ]);

    let auth_state = state.clone();
    let protected = api::protected_routes(state.config.max_upload_bytes()).layer(
        middleware::from_fn(move |request, next| {
            let auth_state = auth_state.clone();
            async move { auth::require_auth(auth_state, request, next).await }
        }),
    );

    let app = Router::new()
        .merge(api::public_routes())
        .merge(protected)
        .fallback(ui::fallback)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(DefaultBodyLimit::max(state.config.max_upload_bytes()))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(state.config.bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind {}: {e}", state.config.bind);
            std::process::exit(1);
        });
    tracing::info!(addr = %state.config.bind, "bintl listening");
    axum::serve(listener, app).await.unwrap_or_else(|e| {
        eprintln!("server error: {e}");
        std::process::exit(1);
    });
}
