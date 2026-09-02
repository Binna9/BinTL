use connectors::{list_columns, run_sql, with_database};
use storage::LiveConnection;
use serde_json::{json, Value};
use storage::Store;

use crate::access::CurrentUser;
use crate::error::AppError;
use crate::state::AppState;

pub async fn sync_workspace_planned_inputs(
    state: &AppState,
    workspace_id: &str,
) -> Result<(), AppError> {
    let edges = state.store.list_chip_edges(workspace_id).await?;
    for edge in edges {
        if edge.kind != "data" {
            continue;
        }
        let to_chip = match state.store.get_chip(&edge.to_chip_id).await? {
            Some(chip) => chip,
            None => continue,
        };
        if to_chip.kind != "transform" {
            continue;
        }
        let from_chip = match state.store.get_chip(&edge.from_chip_id).await? {
            Some(chip) => chip,
            None => continue,
        };
        if from_chip.kind != "extract" {
            continue;
        }
        let _ = ensure_planned_input_for_transform(
            state,
            workspace_id,
            &edge.to_chip_id,
            &edge.from_chip_id,
        )
        .await;
    }
    Ok(())
}

pub async fn ensure_planned_input_for_transform(
    state: &AppState,
    workspace_id: &str,
    transform_chip_id: &str,
    upstream_chip_id: &str,
) -> Result<Value, AppError> {
    let upstream = state
        .store
        .get_chip(upstream_chip_id)
        .await?
        .ok_or_else(|| AppError::not_found("chip not found"))?;
    if upstream.kind != "extract" {
        return Err(AppError::bad("upstream chip must be an extract chip"));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(&upstream)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(error.to_string()))?;
    let connection_id = config
        .get("connection_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::bad("extract chip is not configured"))?;
    let source = config
        .get("source")
        .cloned()
        .ok_or_else(|| AppError::bad("extract source required"))?;
    let delimiter = config
        .get("delimiter")
        .and_then(Value::as_str)
        .unwrap_or(",");
    let header = config
        .get("header")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let source_extract_definition_id = state
        .store
        .get_chip_binding(upstream_chip_id)
        .await?
        .filter(|binding| binding.ref_kind == "extract_definition")
        .map(|binding| binding.ref_id);
    let live = state.store.live_connection(connection_id).await?;
    let columns = introspect_extract_source(&live, &source).await?;
    let columns_json =
        serde_json::to_string(&columns).map_err(|error| AppError::bad(error.to_string()))?;
    let dataset = state
        .store
        .upsert_planned_input_dataset(
            workspace_id,
            transform_chip_id,
            upstream_chip_id,
            source_extract_definition_id.as_deref(),
            &format!("{}.planned", upstream.name),
            &columns_json,
            delimiter,
            header,
        )
        .await?;
    Ok(json!({
        "dataset_id": dataset.id,
        "status": dataset.status,
        "source_chip_id": upstream_chip_id,
        "consumer_chip_id": transform_chip_id,
        "columns": columns,
    }))
}

pub async fn get_transform_input_slot(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    transform_chip_id: &str,
) -> Result<Value, AppError> {
    crate::access::require_workspace(&state.store, user, workspace_id).await?;
    let chip = crate::access::require_chip(&state.store, user, transform_chip_id).await?;
    let incoming = state
        .store
        .list_chip_edges(workspace_id)
        .await?
        .into_iter()
        .find(|edge| edge.to_chip_id == transform_chip_id && edge.kind == "data");
    let Some(edge) = incoming else {
        if let Some(fixed) = slot_from_fixed_dataset(state, user, &chip).await? {
            return Ok(fixed);
        }
        if let Some(planned) = state
            .store
            .find_planned_input_dataset(workspace_id, transform_chip_id)
            .await?
        {
            return Ok(slot_with_names(state, planned_input_json(&state.store, &planned)).await?);
        }
        return Ok(json!({ "mode": "unwired" }));
    };
    let source_name = state
        .store
        .get_chip(&edge.from_chip_id)
        .await?
        .map(|chip| chip.name)
        .unwrap_or_default();
    if let Some(materialized) = state
        .store
        .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
        .await?
    {
        let dataset = state
            .store
            .get_dataset(&materialized)
            .await?
            .ok_or_else(|| AppError::not_found("dataset not found"))?;
        return Ok(json!({
            "mode": "materialized",
            "dataset_id": dataset.id,
            "source_chip_id": edge.from_chip_id,
            "source_chip_name": source_name,
            "dataset": crate::transform::dataset_json_public(&state.store, &dataset),
        }));
    }
    let planned = ensure_planned_input_for_transform(
        state,
        workspace_id,
        transform_chip_id,
        &edge.from_chip_id,
    )
    .await?;
    Ok(json!({
        "mode": "planned",
        "source_chip_id": edge.from_chip_id,
        "source_chip_name": source_name,
        "planned": planned,
    }))
}

async fn slot_from_fixed_dataset(
    state: &AppState,
    user: &CurrentUser,
    chip: &storage::ChipRow,
) -> Result<Option<Value>, AppError> {
    let config_raw = match state.store.resolve_chip_config_json(chip).await {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    let config: Value = serde_json::from_str(&config_raw).unwrap_or(json!({}));
    let dataset_id = config
        .get("input_dataset_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(dataset_id) = dataset_id else {
        return Ok(None);
    };
    let dataset = match crate::access::require_dataset(&state.store, user, dataset_id).await {
        Ok(row) => row,
        Err(_) => return Ok(None),
    };
    Ok(Some(json!({
        "mode": "materialized",
        "dataset_id": dataset.id,
        "source_chip_name": dataset.filename,
        "dataset": crate::transform::dataset_json_public(&state.store, &dataset),
    })))
}

async fn slot_with_names(state: &AppState, mut body: Value) -> Result<Value, AppError> {
    if let Some(id) = body.get("source_chip_id").and_then(Value::as_str) {
        if let Some(chip) = state.store.get_chip(id).await? {
            body["source_chip_name"] = json!(chip.name);
        }
    }
    Ok(body)
}

pub fn planned_input_json(store: &Store, row: &storage::DatasetRow) -> Value {
    let columns = row
        .columns_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!([]));
    json!({
        "mode": "planned",
        "dataset_id": row.id,
        "status": row.status,
        "source_chip_id": row.source_chip_id,
        "consumer_chip_id": row.consumer_chip_id,
        "columns": columns,
        "dataset": crate::transform::dataset_json_public(store, row),
    })
}

pub async fn resolve_materialized_transform_input(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    transform_chip_id: &str,
    requested: Option<String>,
    config_input: Option<String>,
) -> Result<String, AppError> {
    if let Some(dataset_id) = requested {
        return Ok(dataset_id);
    }
    let incoming = state
        .store
        .list_chip_edges(workspace_id)
        .await?
        .into_iter()
        .filter(|edge| edge.to_chip_id == transform_chip_id && edge.kind == "data")
        .collect::<Vec<_>>();
    if incoming.len() > 1 {
        return Err(AppError::bad(
            "multiple data edges into a chip are not supported",
        ));
    }
    if let Some(edge) = incoming.first() {
        if let Some(dataset_id) = state
            .store
            .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
            .await?
        {
            return Ok(dataset_id);
        }
        crate::chip::run_extract_chip_sync(state, user, workspace_id, &edge.from_chip_id).await?;
        return state
            .store
            .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
            .await?
            .ok_or_else(|| AppError::bad("upstream extract did not produce a dataset"));
    }
    config_input.ok_or_else(|| AppError::bad("transform input_dataset_id required"))
}

async fn introspect_extract_source(
    live: &LiveConnection,
    source: &Value,
) -> Result<Vec<Value>, AppError> {
    let source_type = source
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("table");
    match source_type {
        "table" => {
            let table = source
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::bad("extract source table required"))?;
            let database = source.get("database").and_then(Value::as_str);
            let live = with_database(live, database);
            let columns = list_columns(&live, table).await?;
            Ok(columns
                .into_iter()
                .map(|column| {
                    json!({
                        "name": column.name,
                        "dtype": column.data_type,
                    })
                })
                .collect())
        }
        "query" => {
            let sql = source
                .get("sql")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::bad("extract source sql required"))?;
            let database = source.get("database").and_then(Value::as_str);
            let live = with_database(live, database);
            let result = run_sql(&live, sql, 1, None).await?;
            Ok(result
                .columns
                .into_iter()
                .map(|name| {
                    json!({
                        "name": name,
                        "dtype": "String",
                    })
                })
                .collect())
        }
        other => Err(AppError::bad(format!("unsupported extract source type {other}"))),
    }
}
