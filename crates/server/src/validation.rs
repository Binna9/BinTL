use axum::{extract::{Path, State}, routing::{get, post}, Json, Router};
use engine::{PolarsEngine, TransformSpec, ValidationReport, ValidationSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use storage::ValidationRuleRow;
use crate::{access::CurrentUser, error::AppError, state::AppState};

#[derive(Deserialize)]
struct ValidateBody {
    source_data_file_id: String,
    target_data_file_id: String,
    #[serde(default)] validation_rule_id: Option<String>,
    #[serde(default)] keys: Vec<String>,
    #[serde(default)] columns: Vec<String>,
    #[serde(default = "yes")] compare_row_count: bool,
    #[serde(default = "yes")] compare_schema: bool,
}

#[derive(Deserialize)]
struct SaveRuleBody {
    name: String,
    #[serde(default)] description: String,
    #[serde(default)] keys: Vec<String>,
    #[serde(default)] columns: Vec<String>,
    #[serde(default = "yes")] compare_row_count: bool,
    #[serde(default = "yes")] compare_schema: bool,
    #[serde(default = "yes")] active: bool,
}

fn yes() -> bool { true }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/validations/run", post(run_validation))
        .route("/api/validation-rules", get(list_rules).post(create_rule))
        .route("/api/validation-rules/{id}", get(get_rule).put(update_rule).delete(delete_rule))
        .route("/api/validation-results", get(list_results))
}

fn rule_json(row: ValidationRuleRow) -> Result<Value, AppError> {
    Ok(json!({
        "id": row.id, "owner_user_id": row.owner_user_id, "name": row.name,
        "description": row.description,
        "keys": serde_json::from_str::<Value>(&row.keys_json).map_err(|e| AppError::bad(e.to_string()))?,
        "columns": serde_json::from_str::<Value>(&row.columns_json).map_err(|e| AppError::bad(e.to_string()))?,
        "compare_row_count": row.compare_row_count != 0, "compare_schema": row.compare_schema != 0,
        "active": row.active != 0, "revision": row.revision,
        "created_at": row.created_at, "updated_at": row.updated_at,
    }))
}

async fn list_rules(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    let rows = state.store.list_validation_rules(user.id(), user.can_see_all_workspaces()).await?;
    Ok(Json(json!({"rules": rows.into_iter().map(rule_json).collect::<Result<Vec<_>, _>>()?})))
}

async fn get_rule(State(state): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> Result<Json<Value>, AppError> {
    let row = state.store.get_validation_rule(&id).await?.ok_or_else(|| AppError::not_found("validation rule not found"))?;
    if row.owner_user_id != user.id() && !user.can_see_all_workspaces() { return Err(AppError::not_found("validation rule not found")); }
    Ok(Json(rule_json(row)?))
}

fn validate_rule(body: &SaveRuleBody) -> Result<(), AppError> {
    if body.name.trim().is_empty() { return Err(AppError::bad("validation rule name required")); }
    if body.keys.iter().all(|v| v.trim().is_empty()) { return Err(AppError::bad("at least one validation key required")); }
    Ok(())
}

async fn save_rule(state: &AppState, user: &CurrentUser, id: Option<&str>, body: SaveRuleBody) -> Result<Json<Value>, AppError> {
    validate_rule(&body)?;
    if let Some(id) = id {
        let current = state.store.get_validation_rule(id).await?.ok_or_else(|| AppError::not_found("validation rule not found"))?;
        if current.owner_user_id != user.id() { return Err(AppError::forbidden()); }
    }
    let keys = body.keys.into_iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>();
    let columns = body.columns.into_iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>();
    let row = state.store.save_validation_rule(id, user.id(), &body.name, &body.description,
        &serde_json::to_string(&keys).unwrap(), &serde_json::to_string(&columns).unwrap(),
        body.compare_row_count, body.compare_schema, body.active).await?;
    Ok(Json(rule_json(row)?))
}

async fn create_rule(State(state): State<AppState>, user: CurrentUser, Json(body): Json<SaveRuleBody>) -> Result<Json<Value>, AppError> { save_rule(&state, &user, None, body).await }
async fn update_rule(State(state): State<AppState>, user: CurrentUser, Path(id): Path<String>, Json(body): Json<SaveRuleBody>) -> Result<Json<Value>, AppError> { save_rule(&state, &user, Some(&id), body).await }
async fn delete_rule(State(state): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> Result<Json<Value>, AppError> {
    state.store.delete_validation_rule(&id, user.id()).await?; Ok(Json(json!({"ok": true})))
}

async fn list_results(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    let rows = state.store.list_validation_results(user.id(), user.can_see_all_workspaces()).await?;
    let results = rows.into_iter().map(|row| -> Result<Value, AppError> { Ok(json!({
        "id": row.id, "workspace_id": row.workspace_id, "validation_rule_id": row.validation_rule_id,
        "execution_step_id": row.execution_step_id, "source_data_file_id": row.source_data_file_id,
        "target_data_file_id": row.target_data_file_id, "passed": row.passed != 0,
        "report": serde_json::from_str::<Value>(&row.report_json).map_err(|e| AppError::bad(e.to_string()))?,
        "created_at": row.created_at,
    })) }).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"results": results})))
}

async fn run_validation(State(state): State<AppState>, user: CurrentUser, Json(mut body): Json<ValidateBody>) -> Result<Json<Value>, AppError> {
    if body.source_data_file_id == body.target_data_file_id { return Err(AppError::bad("source and target data files must differ")); }
    if let Some(rule_id) = body.validation_rule_id.as_deref().filter(|v| !v.trim().is_empty()) {
        let rule = state.store.get_validation_rule(rule_id).await?.ok_or_else(|| AppError::not_found("validation rule not found"))?;
        if rule.owner_user_id != user.id() && !user.can_see_all_workspaces() { return Err(AppError::not_found("validation rule not found")); }
        if rule.active == 0 { return Err(AppError::bad("validation rule is inactive")); }
        body.keys = serde_json::from_str(&rule.keys_json).map_err(|e| AppError::bad(e.to_string()))?;
        body.columns = serde_json::from_str(&rule.columns_json).map_err(|e| AppError::bad(e.to_string()))?;
        body.compare_row_count = rule.compare_row_count != 0; body.compare_schema = rule.compare_schema != 0;
    }
    let source = crate::access::require_dataset(&state.store, &user, &body.source_data_file_id).await?;
    let target = crate::access::require_dataset(&state.store, &user, &body.target_data_file_id).await?;
    let source_path = state.store.resolve(&source.stored_path); let target_path = state.store.resolve(&target.stored_path);
    if !source_path.is_file() || !target_path.is_file() { return Err(AppError::bad("validation requires materialized data files")); }
    let source_read = TransformSpec::identity().with_read(source.delimiter.clone(), source.has_header.map(|v| v != 0));
    let target_read = TransformSpec::identity().with_read(target.delimiter.clone(), target.has_header.map(|v| v != 0));
    let validation = ValidationSpec { keys: body.keys, columns: body.columns, compare_row_count: body.compare_row_count, compare_schema: body.compare_schema };
    let report: ValidationReport = tokio::task::spawn_blocking(move || PolarsEngine.validate_files(&source_path, &target_path, &source_read, &target_read, &validation))
        .await.map_err(|e| AppError::bad(e.to_string()))?.map_err(|e| AppError::bad(e.to_string()))?;
    let result = state.store.insert_validation_result(user.id(), &target.workspace_id, body.validation_rule_id.as_deref(), None,
        &source.id, &target.id, report.passed, &serde_json::to_string(&report).map_err(|e| AppError::bad(e.to_string()))?).await?;
    Ok(Json(json!({"result_id": result.id, "report": report})))
}
