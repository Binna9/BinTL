use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use engine::{FramePreview, PolarsEngine, PreviewColumn, TransformSpec};
use connectors::sniff_delimiter;
use serde::Deserialize;
use serde_json::{json, Value};
use storage::{DatasetRow, Store, TransformRow};

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/datasets", get(list_datasets))
        .route(
            "/api/datasets/{id}",
            get(get_dataset).delete(delete_dataset),
        )
        .route("/api/datasets/{id}/file", get(dataset_file))
        .route("/api/datasets/{id}/inspect", post(inspect_dataset))
        .route("/api/datasets/{id}/preview", post(preview_dataset))
        .route(
            "/api/transforms",
            get(list_transforms).post(create_transform),
        )
        .route(
            "/api/transforms/{id}",
            get(get_transform)
                .patch(update_transform)
                .delete(delete_transform),
        )
        .route("/api/transforms/{id}/run", post(run_transform))
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<usize>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct PreviewBody {
    spec: Option<Value>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct CreateTransformBody {
    name: String,
    dataset_id: String,
    spec: Option<Value>,
    #[serde(default)]
    input_chip_id: Option<String>,
}

#[derive(Deserialize)]
struct PatchTransformBody {
    name: Option<String>,
    dataset_id: Option<String>,
    spec: Option<Value>,
    #[serde(default)]
    input_chip_id: Option<String>,
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(200).clamp(1, 200)
}

fn normalize_columns(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .map(|columns| {
            json!(
                columns
                    .iter()
                    .map(|column| {
                        json!({
                            "name": column.get("name").and_then(Value::as_str).unwrap_or(""),
                            "dtype": column
                                .get("dtype")
                                .or_else(|| column.get("type"))
                                .and_then(Value::as_str)
                                .unwrap_or("String"),
                        })
                    })
                    .collect::<Vec<_>>()
            )
        })
        .unwrap_or_else(|| json!([]))
}

pub fn dataset_json_public(store: &Store, row: &DatasetRow) -> Value {
    dataset_json(store, row)
}

fn dataset_json(store: &Store, row: &DatasetRow) -> Value {
    let planned = row.status == "planned";
    let available = !planned && store.resolve(&row.stored_path).is_file();
    let columns = row
        .columns_json
        .as_deref()
        .map(normalize_columns)
        .unwrap_or_else(|| json!([]));
    json!({
        "id": row.id,
        "kind": row.kind,
        "filename": row.filename,
        "size_bytes": row.size_bytes,
        "delimiter": row.delimiter,
        "has_header": row.has_header.map(|h| h != 0),
        "columns": columns,
        "row_count": row.row_count,
        "inspected_at": row.inspected_at,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "workspace_id": row.workspace_id,
        "producer_chip_run_id": row.producer_chip_run_id,
        "status": row.status,
        "source_chip_id": row.source_chip_id,
        "consumer_chip_id": row.consumer_chip_id,
        "available": available,
        "origin": match row.kind.as_str() {
            "database" | "api" => json!({
                "extract_id": row.extract_id,
                "table_name": row.table_name,
                "connection_name": row.connection_name,
            }),
            _ => Value::Null,
        },
    })
}

fn transform_json(row: &TransformRow) -> Value {
    let spec = serde_json::from_str::<Value>(&row.spec_json).unwrap_or(json!({}));
    json!({
        "id": row.id,
        "name": row.name,
        "dataset_id": row.dataset_id,
        "input_chip_id": row.input_chip_id,
        "spec": spec,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "workspace_id": row.workspace_id,
    })
}

fn planned_preview(row: &DatasetRow) -> Value {
    let columns: Vec<PreviewColumn> = row
        .columns_json
        .as_deref()
        .map(normalize_columns)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|column| {
            let name = column.get("name")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let dtype = column
                .get("dtype")
                .or_else(|| column.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("String")
                .to_string();
            Some(PreviewColumn { name, dtype })
        })
        .collect();
    preview_json(FramePreview {
        columns,
        rows: vec![],
        sampled_rows: 0,
        row_count: Some(0),
        truncated: false,
    })
}

fn read_spec_for(row: &DatasetRow) -> TransformSpec {
    TransformSpec::v2().with_read(row.delimiter.clone(), row.has_header.map(|h| h != 0))
}

fn merge_read(spec: TransformSpec, row: &DatasetRow) -> TransformSpec {
    let delimiter = spec
        .delimiter()
        .map(str::to_string)
        .or_else(|| row.delimiter.clone());
    let has_header = spec.has_header().or_else(|| row.has_header.map(|h| h != 0));
    spec.with_read(delimiter, has_header)
}

async fn hydrate_v2_spec(
    state: &AppState,
    user: &CurrentUser,
    value: &Value,
    row: &DatasetRow,
) -> Result<TransformSpec, AppError> {
    let mut spec = parse_v2_spec(value, row)?;
    if spec.version == 3 {
        let operations = value
            .get("operations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for operation in operations {
            match operation.get("type").and_then(Value::as_str).unwrap_or("") {
                "join" => {
                    let id = operation
                        .get("right_dataset_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| AppError::bad("join needs right_dataset_id"))?;
                    hydrate_recipe_dataset(state, user, &mut spec, id).await?;
                }
                "union" => {
                    let ids = operation
                        .get("dataset_ids")
                        .and_then(Value::as_array)
                        .ok_or_else(|| AppError::bad("union needs dataset_ids"))?;
                    for id in ids {
                        let id = id
                            .as_str()
                            .ok_or_else(|| AppError::bad("union dataset id must be a string"))?;
                        hydrate_recipe_dataset(state, user, &mut spec, id).await?;
                    }
                }
                "clean" | "aggregate" => {}
                other => return Err(AppError::bad(format!("unknown recipe operation `{other}`"))),
            }
        }
        return Ok(spec);
    }
    let Some(combine) = value.get("combine") else {
        return Ok(spec);
    };
    let mode = combine
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match mode {
        "join" => {
            let right_id = combine
                .get("right_dataset_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::bad("join needs right_dataset_id"))?;
            let right = access::require_dataset(&state.store, user, right_id).await?;
            let path = state.store.resolve(&right.stored_path);
            if !path.is_file() {
                return Err(AppError::not_found("right dataset file missing"));
            }
            spec.resolved_paths.insert(
                right_id.to_string(),
                path.to_string_lossy().into_owned(),
            );
        }
        "union" => {
            let ids = combine
                .get("union_dataset_ids")
                .and_then(|v| v.as_array())
                .ok_or_else(|| AppError::bad("union needs union_dataset_ids"))?;
            for id_val in ids {
                let id = id_val
                    .as_str()
                    .ok_or_else(|| AppError::bad("union dataset id must be a string"))?;
                let extra = access::require_dataset(&state.store, user, id).await?;
                let path = state.store.resolve(&extra.stored_path);
                if !path.is_file() {
                    return Err(AppError::not_found(format!(
                        "union dataset `{id}` file missing"
                    )));
                }
                spec.resolved_paths.insert(
                    id.to_string(),
                    path.to_string_lossy().into_owned(),
                );
            }
        }
        other => return Err(AppError::bad(format!("unknown combine mode `{other}`"))),
    }
    Ok(spec)
}

async fn hydrate_recipe_dataset(
    state: &AppState,
    user: &CurrentUser,
    spec: &mut TransformSpec,
    id: &str,
) -> Result<(), AppError> {
    let dataset = access::require_dataset(&state.store, user, id).await?;
    let path = state.store.resolve(&dataset.stored_path);
    if !path.is_file() {
        return Err(AppError::not_found(format!("recipe dataset `{id}` file missing")));
    }
    spec.resolved_paths
        .insert(id.to_string(), path.to_string_lossy().into_owned());
    Ok(())
}

fn parse_v2_spec(value: &Value, row: &DatasetRow) -> Result<TransformSpec, AppError> {
    let mut obj = value
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::bad("spec must be an object"))?;
    obj.entry("version").or_insert(json!(3));
    obj.entry("sink").or_insert(json!("parquet"));
    let version = obj.get("version").and_then(Value::as_u64).unwrap_or(3);
    if version == 2 && obj.get("steps").is_none() {
        obj.insert("steps".into(), json!([]));
    }
    if version == 3 && obj.get("operations").is_none() {
        obj.insert("operations".into(), json!([]));
    }
    let spec = TransformSpec::parse_json(&Value::Object(obj).to_string())
        .map_err(|e| AppError::bad(e.to_string()))?;
    if spec.version != 2 && spec.version != 3 {
        return Err(AppError::bad("transform spec must be version 2 or 3"));
    }
    Ok(merge_read(spec, row))
}

fn default_v2_spec(row: &DatasetRow) -> TransformSpec {
    merge_read(TransformSpec::v3(), row)
}

fn preview_json(preview: FramePreview) -> Value {
    json!({
        "columns": preview.columns,
        "rows": preview.rows,
        "sampled_rows": preview.sampled_rows,
        "row_count": preview.row_count,
        "truncated": preview.truncated,
    })
}

async fn list_datasets(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Value>, AppError> {
    let rows = state
        .store
        .list_datasets(Some(&user.scope(q.workspace_id)))
        .await?;
    let datasets: Vec<Value> = rows
        .iter()
        .filter(|row| row.status != "planned")
        .map(|row| dataset_json(&state.store, row))
        .collect();
    Ok(Json(json!({ "datasets": datasets })))
}

async fn get_dataset(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = access::require_dataset(&state.store, &user, &id).await?;
    Ok(Json(dataset_json(&state.store, &row)))
}

async fn delete_dataset(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _row = access::require_dataset(&state.store, &user, &id).await?;
    state.store.delete_transform_dataset(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn dataset_file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = access::require_dataset(&state.store, &user, &id).await?;
    let path = state.store.resolve(&row.stored_path);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::not_found("dataset file missing"))?;
    let disp = format!("attachment; filename=\"{}\"", row.filename);
    let ctype = if row.filename.ends_with(".parquet") {
        "application/vnd.apache.parquet"
    } else if row.filename.ends_with(".tsv") {
        "text/tab-separated-values; charset=utf-8"
    } else {
        "text/csv; charset=utf-8"
    };
    Ok((
        AppendHeaders([
            (CONTENT_TYPE, HeaderValue::from_str(ctype).unwrap()),
            (CONTENT_DISPOSITION, HeaderValue::from_str(&disp).unwrap()),
        ]),
        bytes,
    ))
}

async fn inspect_dataset(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Value>, AppError> {
    let row = access::require_dataset(&state.store, &user, &id).await?;
    if row.status == "planned" {
        let _ = clamp_limit(q.limit);
        return Ok(Json(json!({
            "dataset": dataset_json(&state.store, &row),
            "preview": planned_preview(&row),
        })));
    }
    let path = state.store.resolve(&row.stored_path);
    if !path.is_file() {
        return Err(AppError::not_found("dataset file missing"));
    }
    let limit = clamp_limit(q.limit);
    let inferred_delim = row.delimiter.clone().or_else(|| {
        std::fs::read(&path)
            .ok()
            .and_then(|bytes| sniff_delimiter(&bytes))
    }).or_else(|| {
        match path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "tsv" => Some("tab".into()),
            "csv" | "txt" => Some(",".into()),
            _ => None,
        }
    });
    let inferred_header = row.has_header.map(|h| h != 0).or(Some(true));
    let spec = read_spec_for(&row).with_read(inferred_delim.clone(), inferred_header);
    let preview = tokio::task::spawn_blocking(move || PolarsEngine.inspect(&path, &spec, limit))
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    let columns_json =
        serde_json::to_string(&preview.columns).map_err(|e| AppError::bad(e.to_string()))?;
    let size = tokio::fs::metadata(state.store.resolve(&row.stored_path))
        .await
        .ok()
        .map(|m| m.len() as i64);
    let updated = state
        .store
        .update_dataset_inspect(
            &id,
            &columns_json,
            preview.row_count.map(|n| n as i64),
            inferred_delim.as_deref(),
            inferred_header,
            size,
        )
        .await?;
    Ok(Json(json!({
        "dataset": dataset_json(&state.store, &updated),
        "preview": preview_json(preview),
    })))
}

async fn preview_dataset(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<Value>, AppError> {
    let row = access::require_dataset(&state.store, &user, &id).await?;
    if row.status == "planned" {
        if body.spec.is_some() {
            return Err(AppError::bad(
                "planned input preview with transform steps requires a materialized dataset",
            ));
        }
        return Ok(Json(planned_preview(&row)));
    }
    let path = state.store.resolve(&row.stored_path);
    if !path.is_file() {
        return Err(AppError::not_found("dataset file missing"));
    }
    let spec = if let Some(value) = &body.spec {
        hydrate_v2_spec(&state, &user, value, &row).await?
    } else {
        default_v2_spec(&row)
    };
    let limit = clamp_limit(body.limit);
    let preview = tokio::task::spawn_blocking(move || PolarsEngine.preview(&path, &spec, limit))
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(preview_json(preview)))
}

async fn list_transforms(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Value>, AppError> {
    let rows = state
        .store
        .list_transforms(Some(&user.scope(q.workspace_id)))
        .await?;
    let transforms: Vec<Value> = rows.iter().map(transform_json).collect();
    Ok(Json(json!({ "transforms": transforms })))
}

async fn get_transform(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = access::require_transform(&state.store, &user, &id).await?;
    Ok(Json(transform_json(&row)))
}

fn spec_to_json(spec: &TransformSpec) -> Result<String, AppError> {
    serde_json::to_string(spec).map_err(|e| AppError::bad(e.to_string()))
}

async fn create_transform(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateTransformBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let dataset = access::require_dataset(&state.store, &user, &body.dataset_id).await?;
    let spec = if let Some(value) = &body.spec {
        parse_v2_spec(value, &dataset)?
    } else {
        default_v2_spec(&dataset)
    };
    let row = state
        .store
        .insert_transform(
            &body.name,
            &body.dataset_id,
            &spec_to_json(&spec)?,
            body.input_chip_id.as_deref(),
        )
        .await?;
    Ok((StatusCode::CREATED, Json(transform_json(&row))))
}

async fn delete_transform(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _row = access::require_transform(&state.store, &user, &id).await?;
    state.store.delete_transform(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn update_transform(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PatchTransformBody>,
) -> Result<Json<Value>, AppError> {
    let current = access::require_transform(&state.store, &user, &id).await?;
    let dataset_id = body
        .dataset_id
        .as_deref()
        .unwrap_or(current.dataset_id.as_str());
    let dataset = access::require_dataset(&state.store, &user, dataset_id).await?;
    let spec_json = if let Some(value) = &body.spec {
        Some(spec_to_json(&parse_v2_spec(value, &dataset)?)?)
    } else {
        None
    };
    let input_chip_patch = body.input_chip_id.as_ref().map(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let row = state
        .store
        .update_transform(
            &id,
            body.name.as_deref(),
            body.dataset_id.as_deref(),
            spec_json.as_deref(),
            input_chip_patch,
        )
        .await?;
    Ok(Json(transform_json(&row)))
}

async fn run_transform(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let transform = access::require_transform(&state.store, &user, &id).await?;
    let dataset = access::require_dataset(&state.store, &user, &transform.dataset_id).await?;
    if dataset.status == "planned" {
        return Err(AppError::bad(
            "transform run needs a materialized input dataset",
        ));
    }
    if !state.store.resolve(&dataset.stored_path).is_file() {
        return Err(AppError::not_found("dataset file missing"));
    }
    let spec_value: Value =
        serde_json::from_str(&transform.spec_json).unwrap_or(json!({}));
    let spec = hydrate_v2_spec(&state, &user, &spec_value, &dataset).await?;
    let job = state
        .store
        .insert_transform_job(
            &dataset.stored_path,
            &spec_to_json(&spec)?,
            &transform.id,
            &dataset.id,
            &transform.workspace_id,
        )
        .await?;
    state
        .job_tx
        .try_send(job.id.clone())
        .map_err(|_| AppError::new(StatusCode::SERVICE_UNAVAILABLE, "job queue full"))?;
    Ok(Json(json!({
        "ok": true,
        "id": job.id,
        "status": "queued",
        "job": job,
    })))
}
