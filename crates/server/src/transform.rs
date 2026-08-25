use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use engine::{FramePreview, PolarsEngine, TransformSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use storage::{DatasetRow, Store, TransformRow};

use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/datasets", get(list_datasets))
        .route("/api/datasets/{id}", get(get_dataset))
        .route("/api/datasets/{id}/inspect", post(inspect_dataset))
        .route("/api/datasets/{id}/preview", post(preview_dataset))
        .route(
            "/api/transforms",
            get(list_transforms).post(create_transform),
        )
        .route(
            "/api/transforms/{id}",
            get(get_transform).patch(update_transform),
        )
        .route("/api/transforms/{id}/run", post(run_transform))
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<usize>,
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
}

#[derive(Deserialize)]
struct PatchTransformBody {
    name: Option<String>,
    dataset_id: Option<String>,
    spec: Option<Value>,
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(50).clamp(1, 200)
}

fn dataset_json(store: &Store, row: &DatasetRow) -> Value {
    let available = store.resolve(&row.stored_path).is_file();
    let columns = row
        .columns_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!([]));
    json!({
        "id": row.id,
        "kind": row.kind,
        "filename": row.filename,
        "stored_path": row.stored_path,
        "size_bytes": row.size_bytes,
        "delimiter": row.delimiter,
        "has_header": row.has_header.map(|h| h != 0),
        "columns": columns,
        "row_count": row.row_count,
        "inspected_at": row.inspected_at,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "workspace_id": row.workspace_id,
        "producer_task_run_id": row.producer_task_run_id,
        "available": available,
        "origin": if row.kind == "database" {
            json!({
                "extract_id": row.extract_id,
                "table_name": row.table_name,
                "connection_name": row.connection_name,
            })
        } else {
            Value::Null
        },
    })
}

fn transform_json(row: &TransformRow) -> Value {
    let spec = serde_json::from_str::<Value>(&row.spec_json).unwrap_or(json!({}));
    json!({
        "id": row.id,
        "name": row.name,
        "dataset_id": row.dataset_id,
        "spec": spec,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
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

fn parse_v2_spec(value: &Value, row: &DatasetRow) -> Result<TransformSpec, AppError> {
    let mut obj = value
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::bad("spec must be an object"))?;
    obj.entry("version").or_insert(json!(2));
    obj.entry("sink").or_insert(json!("parquet"));
    if obj.get("steps").is_none() {
        obj.insert("steps".into(), json!([]));
    }
    let spec = TransformSpec::parse_json(&Value::Object(obj).to_string())
        .map_err(|e| AppError::bad(e.to_string()))?;
    if spec.version != 2 {
        return Err(AppError::bad("transform spec must be version 2"));
    }
    Ok(merge_read(spec, row))
}

fn default_v2_spec(row: &DatasetRow) -> TransformSpec {
    merge_read(TransformSpec::v2(), row)
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

async fn require_dataset(store: &Store, id: &str) -> Result<DatasetRow, AppError> {
    store
        .get_dataset(id)
        .await?
        .ok_or_else(|| AppError::not_found("dataset not found"))
}

async fn list_datasets(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = state.store.list_datasets().await?;
    let datasets: Vec<Value> = rows
        .iter()
        .map(|row| dataset_json(&state.store, row))
        .collect();
    Ok(Json(json!({ "datasets": datasets })))
}

async fn get_dataset(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = require_dataset(&state.store, &id).await?;
    Ok(Json(dataset_json(&state.store, &row)))
}

async fn inspect_dataset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Value>, AppError> {
    let row = require_dataset(&state.store, &id).await?;
    let path = state.store.resolve(&row.stored_path);
    if !path.is_file() {
        return Err(AppError::not_found("dataset file missing"));
    }
    let limit = clamp_limit(q.limit);
    let inferred_delim = row.delimiter.clone().or_else(|| {
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
    Path(id): Path<String>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<Value>, AppError> {
    let row = require_dataset(&state.store, &id).await?;
    let path = state.store.resolve(&row.stored_path);
    if !path.is_file() {
        return Err(AppError::not_found("dataset file missing"));
    }
    let spec = if let Some(value) = &body.spec {
        parse_v2_spec(value, &row)?
    } else {
        default_v2_spec(&row)
    };
    let limit = clamp_limit(body.limit);
    let preview = tokio::task::spawn_blocking(move || PolarsEngine.preview(&path, &spec, limit))
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(preview_json(preview)))
}

async fn list_transforms(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = state.store.list_transforms().await?;
    let transforms: Vec<Value> = rows.iter().map(transform_json).collect();
    Ok(Json(json!({ "transforms": transforms })))
}

async fn get_transform(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = state
        .store
        .get_transform(&id)
        .await?
        .ok_or_else(|| AppError::not_found("transform not found"))?;
    Ok(Json(transform_json(&row)))
}

fn spec_to_json(spec: &TransformSpec) -> Result<String, AppError> {
    serde_json::to_string(spec).map_err(|e| AppError::bad(e.to_string()))
}

async fn create_transform(
    State(state): State<AppState>,
    Json(body): Json<CreateTransformBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let dataset = require_dataset(&state.store, &body.dataset_id).await?;
    let spec = if let Some(value) = &body.spec {
        parse_v2_spec(value, &dataset)?
    } else {
        default_v2_spec(&dataset)
    };
    let row = state
        .store
        .insert_transform(&body.name, &body.dataset_id, &spec_to_json(&spec)?)
        .await?;
    Ok((StatusCode::CREATED, Json(transform_json(&row))))
}

async fn update_transform(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchTransformBody>,
) -> Result<Json<Value>, AppError> {
    let current = state
        .store
        .get_transform(&id)
        .await?
        .ok_or_else(|| AppError::not_found("transform not found"))?;
    let dataset_id = body
        .dataset_id
        .as_deref()
        .unwrap_or(current.dataset_id.as_str());
    let dataset = require_dataset(&state.store, dataset_id).await?;
    let spec_json = if let Some(value) = &body.spec {
        Some(spec_to_json(&parse_v2_spec(value, &dataset)?)?)
    } else {
        None
    };
    let row = state
        .store
        .update_transform(
            &id,
            body.name.as_deref(),
            body.dataset_id.as_deref(),
            spec_json.as_deref(),
        )
        .await?;
    Ok(Json(transform_json(&row)))
}

async fn run_transform(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let transform = state
        .store
        .get_transform(&id)
        .await?
        .ok_or_else(|| AppError::not_found("transform not found"))?;
    let dataset = require_dataset(&state.store, &transform.dataset_id).await?;
    if !state.store.resolve(&dataset.stored_path).is_file() {
        return Err(AppError::not_found("dataset file missing"));
    }
    let spec = parse_v2_spec(
        &serde_json::from_str(&transform.spec_json).unwrap_or(json!({})),
        &dataset,
    )?;
    let job = state
        .store
        .insert_transform_job(
            &dataset.stored_path,
            &spec_to_json(&spec)?,
            &transform.id,
            &dataset.id,
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
