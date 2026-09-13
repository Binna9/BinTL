//! Workspace runs prepare every recipe before dispatching any side effects.
//! Execution remains sequential; standalone chip runs retain their existing path.
use super::*;
use storage::ChipEdgeRow;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Succeeded,
    Failed,
    Skipped,
}

fn condition_blocked(
    chip_id: &str,
    edges: &[ChipEdgeRow],
    outcomes: &HashMap<String, Outcome>,
) -> bool {
    edges
        .iter()
        .filter(|edge| edge.to_chip_id == chip_id)
        .any(|edge| {
            let outcome = outcomes.get(&edge.from_chip_id);
            match edge.kind.as_str() {
                "on_success" => outcome != Some(&Outcome::Succeeded),
                "on_error" => outcome != Some(&Outcome::Failed),
                // Preserve existing "always" behavior, including skipped predecessors.
                "always" => outcome.is_none(),
                _ => false,
            }
        })
}

fn data_edges<'a>(chip: &ChipRow, edges: &'a [ChipEdgeRow]) -> Vec<&'a ChipEdgeRow> {
    let mut incoming = edges
        .iter()
        .filter(|edge| edge.kind == "data" && edge.to_chip_id == chip.id)
        .collect::<Vec<_>>();
    if chip.kind == "validation" && incoming.len() == 2 {
        // Match the standalone validation convention, including legacy in/in edges.
        if let Some(index) = incoming.iter().position(|edge| edge.to_port == "source") {
            incoming.swap(0, index);
        } else if incoming[0].to_port == "target" {
            incoming.swap(0, 1);
        }
    }
    incoming
}

async fn require_input(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    id: &str,
) -> Result<(), AppError> {
    let dataset = access::require_dataset(&state.store, user, id).await?;
    if dataset.workspace_id != workspace_id || dataset.status != "materialized" {
        return Err(AppError::bad(
            "input dataset is not materialized in this workspace",
        ));
    }
    if !state.store.resolve(&dataset.stored_path).is_file() {
        return Err(AppError::not_found("input dataset file missing"));
    }
    Ok(())
}

async fn prepare_config(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    chip: &ChipRow,
    chips: &[ChipRow],
    edges: &[ChipEdgeRow],
    raw: &str,
) -> Result<Value, AppError> {
    let mut config: Value = serde_json::from_str(raw).map_err(|e| AppError::bad(e.to_string()))?;
    reject_forbidden_config(&config)?;
    let incoming = data_edges(chip, edges);
    for edge in edges.iter().filter(|edge| edge.to_chip_id == chip.id) {
        let source = chips
            .iter()
            .find(|source| source.id == edge.from_chip_id)
            .ok_or_else(|| {
                AppError::bad("input connection references an inactive or missing chip")
            })?;
        if edge.kind == "data" && !matches!(source.kind.as_str(), "extract" | "transform") {
            return Err(AppError::bad(
                "data connections require an extract or transform output",
            ));
        }
    }
    if incoming.len() > if chip.kind == "validation" { 2 } else { 1 } {
        return Err(AppError::bad("too many data inputs"));
    }
    match chip.kind.as_str() {
        "extract" => {
            if !incoming.is_empty() {
                return Err(AppError::bad("extract chips do not accept data inputs"));
            }
            let validated = validate_extract_config(&state.store, config.clone()).await?;
            if validated["connection_id"].as_str().unwrap_or("").is_empty() {
                return Err(AppError::bad("configure the extract chip before running"));
            }
        }
        "transform" | "load" => {
            let expected = if chip.kind == "transform" {
                "transform"
            } else {
                "load_recipe"
            };
            if !state
                .store
                .get_chip_binding(&chip.id)
                .await?
                .is_some_and(|binding| binding.ref_kind == expected)
            {
                return Err(AppError::bad("칩의 레시피를 설정하고 저장해 주세요."));
            }
            if chip.kind == "transform" {
                // A connected input is resolved from this run, never a saved dataset ID.
                if !incoming.is_empty() {
                    config["input_dataset_id"] = Value::Null;
                }
                let validated =
                    validate_transform_config(&state.store, workspace_id, config.clone()).await?;
                if incoming.is_empty() {
                    let id = validated
                        .input_dataset_id
                        .as_deref()
                        .ok_or_else(|| AppError::bad("transform input is not connected"))?;
                    require_input(state, user, workspace_id, id).await?;
                }
            } else {
                // Connected loads do not use a recipe's previous dataset.
                config["input_dataset_id"] = Value::Null;
                crate::load::validate_load_config(&state.store, config.clone()).await?;
                if incoming.is_empty() {
                    return Err(AppError::bad("load input is not connected"));
                }
            }
        }
        "validation" => {
            if incoming.is_empty() {
                return Err(AppError::bad("validation target input is not connected"));
            }
            if incoming.len() == 2 {
                config["source_data_file_id"] = json!("");
            }
            let mut validated =
                validate_validation_config(&state.store, workspace_id, config.clone()).await?;
            if let Some(rule_id) = validated.validation_rule_id.as_deref() {
                let rule = state
                    .store
                    .get_validation_rule(rule_id)
                    .await?
                    .ok_or_else(|| AppError::not_found("validation rule not found"))?;
                validated.keys = serde_json::from_str(&rule.keys_json)
                    .map_err(|e| AppError::bad(e.to_string()))?;
                validated.columns = serde_json::from_str(&rule.columns_json)
                    .map_err(|e| AppError::bad(e.to_string()))?;
                validated.compare_row_count = rule.compare_row_count != 0;
                validated.compare_schema = rule.compare_schema != 0;
            }
            if validated.keys.is_empty() {
                return Err(AppError::bad("at least one validation key required"));
            }
            if incoming.len() == 1 {
                require_input(state, user, workspace_id, &validated.source_data_file_id).await?;
            }
            config = serde_json::to_value(validated).map_err(|e| AppError::bad(e.to_string()))?;
            config["workspace_rule_snapshot"] = json!(true);
        }
        _ => return Err(AppError::bad("unsupported chip kind")),
    }
    Ok(config)
}

pub(super) async fn execute(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    execution_id: &str,
) -> Result<Vec<String>, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    let chips = state.store.list_chips(workspace_id).await?;
    let edges = state.store.list_chip_edges(workspace_id).await?;
    let ordered = workspace_run_order(chips, &edges)?;
    if ordered.is_empty() {
        return Err(AppError::bad("workspace has no active chips"));
    }

    // Collect all errors first. No extract, transformation, or load is dispatched here.
    let mut prepared = Vec::new();
    let mut errors = HashMap::new();
    for chip in &ordered {
        let raw = state.store.resolve_chip_config_json(chip).await;
        let result = match &raw {
            Ok(raw) => prepare_config(state, user, workspace_id, chip, &ordered, &edges, raw).await,
            Err(error) => Err(AppError::bad(error.to_string())),
        };
        match result {
            Ok(config) => prepared.push(config.to_string()),
            Err(error) => {
                errors.insert(chip.id.clone(), error.message().to_string());
                prepared.push(
                    raw.ok()
                        .filter(|raw| serde_json::from_str::<Value>(raw).is_ok())
                        .unwrap_or_else(|| "{}".into()),
                );
            }
        }
    }

    // Persist all recipe snapshots before starting the first chip. Revision checks
    // reject edits during preparation; later edits cannot change these snapshots.
    let mut runs = Vec::new();
    for (chip, config) in ordered.iter().zip(&prepared) {
        runs.push(
            state
                .store
                .create_chip_run_in_execution(
                    &chip.id,
                    workspace_id,
                    chip.revision,
                    config,
                    None,
                    Some(execution_id),
                )
                .await?,
        );
    }
    state.store.append_execution_log(&runs[0].id, "info", "workspace_plan",
        "전체 실행의 칩 설정과 연결을 고정했습니다.",
        Some(&json!({ "edges": edges, "chips": ordered.iter().map(|chip| json!({"id": chip.id, "name": chip.name, "revision": chip.revision})).collect::<Vec<_>>() }).to_string()),
    ).await?;
    if !errors.is_empty() {
        let mut messages = Vec::new();
        for (chip, run) in ordered.iter().zip(&runs) {
            if let Some(reason) = errors.get(&chip.id) {
                state
                    .store
                    .set_chip_run_failed_with_code(&run.id, "WORKSPACE_PREFLIGHT_FAILED", reason)
                    .await?;
                state
                    .store
                    .append_execution_log(&run.id, "error", "preflight_failed", reason, None)
                    .await?;
                messages.push(format!("{}: {}", chip.name, reason));
            } else {
                state
                    .store
                    .skip_workspace_step(
                        &run.id,
                        "사전 검증 오류가 있어 전체 실행을 시작하지 않았습니다.",
                    )
                    .await?;
            }
        }
        return Err(AppError::bad(format!(
            "전체 실행 사전 검증 실패:\n{}",
            messages.join("\n")
        )));
    }

    let mut outputs = HashMap::<String, String>::new();
    let mut outcomes = HashMap::<String, Outcome>::new();
    let mut first_failure = None;
    for (chip, run) in ordered.iter().zip(&runs) {
        if condition_blocked(&chip.id, &edges, &outcomes) {
            state
                .store
                .skip_workspace_step(&run.id, "실행 조건이 충족되지 않아 건너뛰었습니다.")
                .await?;
            outcomes.insert(chip.id.clone(), Outcome::Skipped);
            continue;
        }
        let incoming = data_edges(chip, &edges);
        if let Some(edge) = incoming
            .iter()
            .find(|edge| !outputs.contains_key(&edge.from_chip_id))
        {
            let source = ordered
                .iter()
                .find(|source| source.id == edge.from_chip_id)
                .unwrap();
            let reason = format!(
                "상위 칩 '{}'이 이번 실행에서 데이터를 생성하지 않아 건너뛰었습니다.",
                source.name
            );
            state.store.skip_workspace_step(&run.id, &reason).await?;
            outcomes.insert(chip.id.clone(), Outcome::Skipped);
            // A failed upstream already sets the overall failure. A conditional
            // skip alone is normal and should not make the workspace fail.
            continue;
        }
        let config: Value = serde_json::from_str(&run.config_snapshot_json)
            .map_err(|e| AppError::bad(e.to_string()))?;
        let source = if chip.kind == "validation" && incoming.len() == 2 {
            outputs.get(&incoming[0].from_chip_id).map(String::as_str)
        } else {
            None
        };
        let input = incoming
            .last()
            .and_then(|edge| outputs.get(&edge.from_chip_id))
            .map(String::as_str)
            .or_else(|| {
                if chip.kind == "transform" {
                    config["input_dataset_id"].as_str()
                } else {
                    None
                }
            });
        let result = async {
            if let Some(id) = input {
                require_input(state, user, workspace_id, id).await?;
            }
            if chip.kind == "validation" {
                let source_id = source
                    .or_else(|| config["source_data_file_id"].as_str())
                    .ok_or_else(|| AppError::bad("validation source input missing"))?;
                require_input(state, user, workspace_id, source_id).await?;
                if Some(source_id) == input {
                    return Err(AppError::bad("source and target data files must differ"));
                }
            }
            state
                .store
                .bind_workspace_step_input(&run.id, input, source)
                .await?;
            state
                .execution_tx
                .try_send(ExecutionTask::Chip(run.id.clone()))
                .map_err(|_| AppError::new(StatusCode::SERVICE_UNAVAILABLE, "chip queue full"))?;
            wait_for_chip_run(state, &run.id).await
        }
        .await;
        match result {
            Ok(()) => {
                let completed = state
                    .store
                    .get_chip_run(&run.id)
                    .await?
                    .ok_or_else(|| AppError::not_found("completed chip run not found"))?;
                if let Some(output) = completed.output_dataset_id {
                    outputs.insert(chip.id.clone(), output);
                } else if matches!(chip.kind.as_str(), "extract" | "transform") {
                    // Successful producers must yield a dataset, even an empty one.
                    // Do not silently report success for an incomplete worker result.
                    first_failure.get_or_insert_with(|| {
                        format!("{}: 실행 결과 데이터가 없습니다.", chip.name)
                    });
                    outcomes.insert(chip.id.clone(), Outcome::Failed);
                    continue;
                }
                outcomes.insert(chip.id.clone(), Outcome::Succeeded);
            }
            Err(error) => {
                // The worker records execution failures; this also covers failures
                // before dispatch (missing files, full queue).
                if state
                    .store
                    .get_chip_run(&run.id)
                    .await?
                    .is_some_and(|run| run.status == "queued")
                {
                    crate::execution_error::record_chip_failure(
                        &state.store,
                        &run.id,
                        &chip.kind,
                        error.message(),
                    )
                    .await;
                }
                outcomes.insert(chip.id.clone(), Outcome::Failed);
                first_failure.get_or_insert_with(|| format!("{}: {}", chip.name, error.message()));
            }
        }
    }
    match first_failure {
        Some(reason) => Err(AppError::bad(reason)),
        None => Ok(runs.into_iter().map(|run| run.id).collect()),
    }
}
