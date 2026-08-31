use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::access::CurrentUser;
use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default = "default_limit")]
    limit: i64,
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
