use connectors::{list_columns, run_sql, with_database};
use serde_json::{json, Value};
use storage::LiveConnection;

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
    if upstream.kind != "extract" && upstream.kind != "transform" {
        return Err(AppError::bad("upstream chip must produce data"));
    }
    let upstream_name = chip_input_display_name(&state.store, &upstream).await?;
    let schema = planned_schema_for_chip(state, workspace_id, upstream_chip_id).await?;
    let columns = schema.columns;
    let columns_json =
        serde_json::to_string(&columns).map_err(|error| AppError::bad(error.to_string()))?;
    let dataset = state
        .store
        .upsert_planned_input_dataset(
            workspace_id,
            transform_chip_id,
            upstream_chip_id,
            schema.source_extract_definition_id.as_deref(),
            &format!("{}.planned", upstream_name),
            &columns_json,
            &schema.delimiter,
            schema.header,
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

struct PlannedSchema {
    columns: Vec<Value>,
    delimiter: String,
    header: bool,
    source_extract_definition_id: Option<String>,
}

async fn planned_schema_for_chip(
    state: &AppState,
    workspace_id: &str,
    producer_chip_id: &str,
) -> Result<PlannedSchema, AppError> {
    let edges = state.store.list_chip_edges(workspace_id).await?;
    let mut transforms = Vec::new();
    let mut current_id = producer_chip_id.to_string();
    let mut depth = 0usize;
    let mut schema = loop {
        depth += 1;
        if depth > 128 {
            return Err(AppError::bad("data edge chain is too deep"));
        }
        if let Some(dataset_id) = state
            .store
            .latest_chip_output_for_workspace(workspace_id, &current_id)
            .await?
        {
            let dataset = state.store.get_dataset(&dataset_id).await?
                .ok_or_else(|| AppError::not_found("dataset not found"))?;
            break schema_from_dataset(&dataset);
        }
        let chip = state.store.get_chip(&current_id).await?
            .ok_or_else(|| AppError::not_found("chip not found"))?;
        match chip.kind.as_str() {
            "extract" => break schema_from_extract(state, &chip).await?,
            "transform" => {
                transforms.push(chip);
                if let Some(edge) = edges.iter().find(|edge| {
                    edge.kind == "data" && edge.to_chip_id == current_id
                }) {
                    current_id = edge.from_chip_id.clone();
                    continue;
                }
                let config_raw = state.store.resolve_chip_config_json(transforms.last().unwrap())
                    .await.map_err(|error| AppError::bad(error.to_string()))?;
                let config: Value = serde_json::from_str(&config_raw)
                    .map_err(|error| AppError::bad(error.to_string()))?;
                let dataset_id = config.get("input_dataset_id").and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| AppError::bad("upstream transform input is not connected"))?;
                let dataset = state.store.get_dataset(dataset_id).await?
                    .ok_or_else(|| AppError::not_found("input dataset not found"))?;
                break schema_from_dataset(&dataset);
            }
            _ => return Err(AppError::bad("upstream chip must produce data")),
        }
    };
    for chip in transforms.iter().rev() {
        let config_raw = state.store.resolve_chip_config_json(chip).await
            .map_err(|error| AppError::bad(error.to_string()))?;
        let config: Value = serde_json::from_str(&config_raw)
            .map_err(|error| AppError::bad(error.to_string()))?;
        apply_transform_schema(state, &mut schema.columns, config.get("spec")).await?;
    }
    Ok(schema)
}

fn schema_from_dataset(dataset: &storage::DatasetRow) -> PlannedSchema {
    PlannedSchema {
        columns: dataset.columns_json.as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default(),
        delimiter: dataset.delimiter.clone().unwrap_or_else(|| ",".into()),
        header: dataset.has_header.unwrap_or(1) != 0,
        source_extract_definition_id: dataset.source_extract_definition_id.clone(),
    }
}

async fn schema_from_extract(
    state: &AppState,
    chip: &storage::ChipRow,
) -> Result<PlannedSchema, AppError> {
    let config_raw = state.store.resolve_chip_config_json(chip).await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(error.to_string()))?;
    let connection_id = config.get("connection_id").and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::bad("extract chip is not configured"))?;
    let source = config.get("source").cloned()
        .ok_or_else(|| AppError::bad("extract source required"))?;
    let live = state.store.live_connection(connection_id).await?;
    Ok(PlannedSchema {
        columns: introspect_extract_source(&live, &source).await?,
        delimiter: config.get("delimiter").and_then(Value::as_str).unwrap_or(",").into(),
        header: config.get("header").and_then(Value::as_bool).unwrap_or(true),
        source_extract_definition_id: state.store.get_chip_binding(&chip.id).await?
            .filter(|binding| binding.ref_kind == "extract_definition")
            .map(|binding| binding.ref_id),
    })
}

async fn apply_transform_schema(
    state: &AppState,
    columns: &mut Vec<Value>,
    spec: Option<&Value>,
) -> Result<(), AppError> {
    let Some(spec) = spec else { return Ok(()); };
    if spec.get("version").and_then(Value::as_u64) == Some(3) {
        for operation in spec.get("operations").and_then(Value::as_array).into_iter().flatten() {
            match operation.get("type").and_then(Value::as_str) {
                Some("clean") => apply_clean_steps(columns, operation.get("steps")),
                Some("join") => append_dataset_columns(state, columns, operation.get("right_dataset_id")).await?,
                Some("union") => {
                    for id in operation.get("dataset_ids").and_then(Value::as_array).into_iter().flatten() {
                        append_dataset_columns(state, columns, Some(id)).await?;
                    }
                }
                Some("aggregate") => apply_aggregate_schema(columns, operation),
                _ => {}
            }
        }
    } else {
        if let Some(combine) = spec.get("combine") {
            if combine.get("mode").and_then(Value::as_str) == Some("join") {
                append_dataset_columns(state, columns, combine.get("right_dataset_id")).await?;
            } else {
                for id in combine.get("union_dataset_ids").and_then(Value::as_array).into_iter().flatten() {
                    append_dataset_columns(state, columns, Some(id)).await?;
                }
            }
        }
        apply_clean_steps(columns, spec.get("steps"));
    }
    Ok(())
}

fn apply_clean_steps(columns: &mut Vec<Value>, steps: Option<&Value>) {
    for step in steps.and_then(Value::as_array).into_iter().flatten() {
        match step.get("op").and_then(Value::as_str) {
            Some("select") => {
                let selected = string_set(step.get("columns"));
                columns.retain(|column| selected.contains(column_name(column)));
            }
            Some("drop") => {
                let dropped = string_set(step.get("columns"));
                columns.retain(|column| !dropped.contains(column_name(column)));
            }
            Some("rename") => {
                if let Some(map) = step.get("map").and_then(Value::as_object) {
                    for column in columns.iter_mut() {
                        if let Some(next) = map.get(column_name(column)).and_then(Value::as_str) {
                            column["name"] = json!(next);
                        }
                    }
                }
            }
            Some("cast") => {
                if let Some(map) = step.get("columns").and_then(Value::as_object) {
                    for column in columns.iter_mut() {
                        if let Some(dtype) = map.get(column_name(column)).and_then(Value::as_str) {
                            column["dtype"] = json!(dtype);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

async fn append_dataset_columns(
    state: &AppState,
    columns: &mut Vec<Value>,
    dataset_id: Option<&Value>,
) -> Result<(), AppError> {
    let Some(id) = dataset_id.and_then(Value::as_str) else { return Ok(()); };
    let Some(dataset) = state.store.get_dataset(id).await? else { return Ok(()); };
    let extra = schema_from_dataset(&dataset).columns;
    for column in extra {
        if !columns.iter().any(|current| column_name(current) == column_name(&column)) {
            columns.push(column);
        }
    }
    Ok(())
}

fn apply_aggregate_schema(columns: &mut Vec<Value>, operation: &Value) {
    let original = columns.clone();
    let groups = string_set(operation.get("group_by"));
    let mut next = original.iter().filter(|column| groups.contains(column_name(column)))
        .cloned().collect::<Vec<_>>();
    for aggregation in operation.get("aggregations").and_then(Value::as_array).into_iter().flatten() {
        let Some(alias) = aggregation.get("alias").and_then(Value::as_str) else { continue };
        let source = aggregation.get("column").and_then(Value::as_str).unwrap_or("");
        let function = aggregation.get("function").and_then(Value::as_str).unwrap_or("");
        let dtype = if function == "count" { "Int64" } else {
            original.iter().find(|column| column_name(column) == source)
                .and_then(|column| column.get("dtype")).and_then(Value::as_str).unwrap_or("Float64")
        };
        next.push(json!({ "name": alias, "dtype": dtype }));
    }
    *columns = next;
}

fn string_set(value: Option<&Value>) -> std::collections::HashSet<&str> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

fn column_name(column: &Value) -> &str {
    column.get("name").and_then(Value::as_str).unwrap_or("")
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
        return Ok(json!({ "mode": "unwired" }));
    };
    let source_chip = state.store.get_chip(&edge.from_chip_id).await?;
    let source_name = match source_chip.as_ref() {
        Some(chip) => chip_input_display_name(&state.store, chip).await?,
        None => String::new(),
    };
    let source_kind = source_chip.as_ref().map(|chip| chip.kind.as_str());
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
            "source_chip_kind": source_kind,
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
        "source_chip_kind": source_kind,
        "planned": planned,
    }))
}

async fn chip_input_display_name(
    store: &storage::Store,
    chip: &storage::ChipRow,
) -> Result<String, AppError> {
    if chip.kind == "transform" {
        if let Some(binding) = store.get_chip_binding(&chip.id).await? {
            if binding.ref_kind == "transform" {
                if let Some(transform) = store.get_transform(&binding.ref_id).await? {
                    return Ok(transform.name);
                }
            }
        }
        if let Some(transform) = store.get_transform_for_chip(&chip.id).await? {
            return Ok(transform.name);
        }
    }
    Ok(chip.name.clone())
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
    // A planned dataset is only a schema cache derived from a data edge. Once
    // that edge is removed it must never become an implicit fixed input.
    if dataset.status != "materialized" {
        return Ok(None);
    }
    Ok(Some(json!({
        "mode": "materialized",
        "dataset_id": dataset.id,
        "source_chip_name": dataset.filename,
        "dataset": crate::transform::dataset_json_public(&state.store, &dataset),
    })))
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
    let Some(dataset_id) = config_input else {
        return Err(AppError::bad("transform input is not connected"));
    };
    let dataset = crate::access::require_dataset(&state.store, user, &dataset_id).await?;
    if dataset.status != "materialized" {
        return Err(AppError::bad("transform input is not connected"));
    }
    Ok(dataset_id)
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
        other => Err(AppError::bad(format!(
            "unsupported extract source type {other}"
        ))),
    }
}
