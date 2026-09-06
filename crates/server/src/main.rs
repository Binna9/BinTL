#[cfg(target_env = "musl")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod access;
mod api;
mod auth;
mod chip;
mod config;
mod error;
mod extract;
mod load;
mod planned_input;
mod search;
mod state;
mod transform;
mod ui;
mod users;
mod validation;
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
use crate::state::{AppState, ExecutionTask};

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
    let (execution_tx, mut execution_rx) = mpsc::channel::<ExecutionTask>(64);
    let worker_store = store.clone();
    let worker_tx = execution_tx.clone();
    let _worker = tokio::spawn(async move {
        while let Some(task) = execution_rx.recv().await {
            let Ok(permit) = execution_permits.clone().acquire_owned().await else {
                break;
            };
            let store = worker_store.clone();
            let tx = worker_tx.clone();
            tokio::spawn(async move {
                let _permit = permit;
                match task {
                    ExecutionTask::Job(id) => {
                        if let Err(error) = jobs::execute(&store, &id).await {
                            tracing::error!(execution_step_id = id, %error, "transform execution failed");
                            let _ = store.append_log(&id, "error", &error).await;
                            let _ = store.fail_chip_run_for_job(&id, &error).await;
                        }
                    }
                    ExecutionTask::Chip(id) => {
                        if let Err(error) = chip::run_one(&store, &tx, &id).await {
                            tracing::error!(execution_step_id = id, %error, "chip execution failed");
                            let _ = store.set_chip_run_failed(&id, &error).await;
                        }
                    }
                }
            });
        }
    });

    let state = AppState {
        store,
        execution_tx,
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
