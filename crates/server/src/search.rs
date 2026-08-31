use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::access::CurrentUser;
use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search", get(search))
        .route("/api/search/recent", get(list_recent).post(record_recent))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default = "default_limit")]
    limit: i64,
}

#[derive(Deserialize)]
struct RecordRecentBody {
    query: String,
}

fn default_limit() -> i64 {
    20
}

async fn search(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let query_text = query.q.trim();
    let hits = state
        .store
        .search_documents(
            user.id(),
            user.can_see_all_workspaces(),
            query_text,
            query.limit,
        )
        .await?;
    Ok(Json(json!({
        "query": query_text,
        "items": hits,
        "total": hits.len(),
    })))
}

async fn list_recent(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<serde_json::Value>, AppError> {
    let items = state
        .store
        .list_recent_searches(user.id(), 8)
        .await?;
    Ok(Json(json!({ "items": items })))
}

async fn record_recent(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<RecordRecentBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let items = state
        .store
        .record_recent_search(user.id(), body.query.trim())
        .await?;
    Ok(Json(json!({ "items": items })))
}
