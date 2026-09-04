mod connections;
mod extracts;
mod files;
mod jobs;

use connections::*;
use extracts::*;
use files::*;
use jobs::*;

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, SET_COOKIE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use connectors::{
    catalog_layout, db_source_path, export_sheet_to_csv, list_columns, list_databases,
    list_relations, list_schemas, list_sheets, list_tables, normalize_sql, parse_delimiter,
    parse_http_spec, parse_ident, parse_table, preview_http, preview_table, run_sql,
    sniff_delimiter, spreadsheet_format, sql_kind, test_connection, with_database, HttpKv,
    HttpRequestSpec, SqlKind,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::Path as FsPath;

use crate::access::{self, CurrentUser};
use crate::auth;
use crate::error::AppError;
use crate::state::AppState;

pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
}

pub fn protected_routes(max_upload_bytes: usize) -> Router<AppState> {
    Router::new()
        .route("/api/files", post(upload_file).get(list_files))
        .route("/api/files/stage", post(stage_spreadsheet))
        .route("/api/files/commit", post(commit_spreadsheet))
        .route("/api/files/stage/{id}", axum::routing::delete(cancel_stage))
        .route("/api/files/{id}", axum::routing::delete(delete_file))
        .route("/api/files/{id}/preview", get(preview_file))
        .route(
            "/api/connections",
            post(create_connection).get(list_connections),
        )
        .route(
            "/api/connections/{id}",
            get(get_connection)
                .put(update_connection)
                .delete(delete_connection),
        )
        .route("/api/connections/{id}/test", post(test_saved_connection))
        .route("/api/connections/{id}/tables", get(connection_tables))
        .route("/api/connections/{id}/databases", get(connection_databases))
        .route("/api/connections/{id}/schemas", get(connection_schemas))
        .route("/api/connections/{id}/relations", get(connection_relations))
        .route("/api/connections/{id}/columns", get(connection_columns))
        .route("/api/connections/{id}/preview", get(connection_preview))
        .route("/api/connections/{id}/query", post(connection_query))
        .route("/api/logs/{area}/{id}", get(process_logs))
        .route("/api/extracts", post(create_extract).get(list_extracts))
        .route("/api/extracts/{id}/logs", get(extract_logs))
        .route("/api/extracts/{id}/file", get(extract_file))
        .route("/api/extracts/{id}/preview", get(preview_extract))
        .route("/api/http/preview", post(http_preview))
        .route(
            "/api/extracts/{id}",
            get(get_extract).delete(delete_extract),
        )
        .route("/api/jobs", post(create_job).get(list_jobs))
        .route("/api/jobs/{id}", get(get_job))
        .route("/api/jobs/{id}/run", post(run_job))
        .route("/api/jobs/{id}/result", get(job_result))
        .merge(crate::workspace::routes())
        .merge(crate::chip::routes())
        .merge(crate::transform::routes())
        .merge(crate::users::routes())
        .merge(crate::search::routes())
        .layer(DefaultBodyLimit::max(max_upload_bytes))
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize)]
struct LoginBody {
    #[serde(alias = "username")]
    userid: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> Result<impl IntoResponse, AppError> {
    let user = state
        .store
        .authenticate(&body.userid, &body.password)
        .await?
        .ok_or_else(AppError::unauthorized)?;
    let cookie = auth::session_cookie(&state.config.session_secret, &user.id);
    Ok(([(SET_COOKIE, cookie)], Json(json!({ "ok": true }))))
}

async fn logout() -> impl IntoResponse {
    (
        [(SET_COOKIE, auth::clear_cookie())],
        Json(json!({ "ok": true })),
    )
}

async fn process_logs(
    State(state): State<AppState>,
    Path((area, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let text = state.store.read_process_log(&area, &id).await?;
    Ok(Json(json!({ "area": area, "id": id, "text": text })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_upload_validation_requires_rows_and_consistent_width() {
        assert!(validate_csv(b"name,amount\nalice,10\n", b',').is_ok());
        assert!(validate_csv(b"name|amount\nalice|10\n", b'|').is_ok());
        assert!(validate_csv(b"", b',').is_err());
        assert!(validate_csv(b"\n\n", b',').is_err());
        assert!(validate_csv(b"a,b\n1\n", b',').is_err());
        assert!(validate_csv(b"a,b\n\"unterminated\n", b',').is_err());
    }

    #[test]
    fn commit_sheet_validation_requires_unique_names_and_csv_filenames() {
        let valid = normalize_commit_sheets(vec![CommitSheet {
            name: "Sales".into(),
            filename: "sales.csv".into(),
        }])
        .unwrap();
        assert_eq!(valid[0].filename, "sales.csv");

        assert!(normalize_commit_sheets(vec![CommitSheet {
            name: "Sales".into(),
            filename: "sales.xlsx".into(),
        }])
        .is_err());
        assert!(normalize_commit_sheets(vec![
            CommitSheet {
                name: "Sales".into(),
                filename: "sales.csv".into(),
            },
            CommitSheet {
                name: "Sales".into(),
                filename: "sales-copy.csv".into(),
            },
        ])
        .is_err());
    }
}
