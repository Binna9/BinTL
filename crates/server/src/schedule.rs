use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use storage::WorkspaceScheduleRow;

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/schedules", get(list).post(create))
        .route(
            "/api/schedules/{id}",
            axum::routing::patch(update).delete(remove),
        )
}

#[derive(Deserialize)]
struct ScheduleBody {
    name: String,
    workspace_id: String,
    #[serde(default = "interval_type")]
    schedule_type: String,
    interval_value: i64,
    interval_unit: String,
    second: Option<i64>,
    hour: Option<i64>,
    minute: Option<i64>,
    day_of_month: Option<i64>,
    month_of_year: Option<i64>,
    #[serde(default = "enabled_default")]
    enabled: bool,
}

fn enabled_default() -> bool {
    true
}

fn interval_type() -> String {
    "interval".into()
}

fn validate(body: &ScheduleBody) -> Result<(), AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::bad("schedule name is required"));
    }
    if body.schedule_type != "interval" || body.interval_value < 1 {
        return Err(AppError::bad("invalid schedule interval"));
    }
    if !matches!(
        body.interval_unit.as_str(),
        "second" | "minute" | "hour" | "day" | "month" | "year"
    ) {
        return Err(AppError::bad("unsupported interval unit"));
    }
    if !matches!(body.second, None | Some(0..=59))
        || !matches!(body.minute, None | Some(0..=59))
        || !matches!(body.hour, None | Some(0..=23))
        || !matches!(body.day_of_month, None | Some(1..=31))
        || !matches!(body.month_of_year, None | Some(1..=12))
    {
        return Err(AppError::bad("invalid schedule fields"));
    }
    Ok(())
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    (NaiveDate::from_ymd_opt(next_year, next_month, 1).unwrap() - Duration::days(1)).day()
}

fn next_run(
    interval_value: i64,
    interval_unit: &str,
    second: Option<i64>,
    hour: Option<i64>,
    minute: Option<i64>,
    day: Option<i64>,
    month_of_year: Option<i64>,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, AppError> {
    let interval_value = interval_value.max(1);
    if interval_unit == "second" {
        return Ok(after + Duration::seconds(interval_value));
    }
    if interval_unit == "minute" {
        return Ok(after + Duration::minutes(interval_value));
    }
    if interval_unit == "hour" {
        return Ok(after + Duration::hours(interval_value));
    }
    let kst = FixedOffset::east_opt(9 * 3600).unwrap();
    let local = after.with_timezone(&kst);
    let hour = hour.unwrap_or(0) as u32;
    let minute = minute.unwrap_or(0) as u32;
    let second = second.unwrap_or(0) as u32;
    if interval_unit == "day" {
        let today = kst
            .with_ymd_and_hms(
                local.year(),
                local.month(),
                local.day(),
                hour,
                minute,
                second,
            )
            .single()
            .unwrap();
        return Ok(if today > local {
            today
        } else {
            today + Duration::days(interval_value)
        }
        .with_timezone(&Utc));
    }
    let requested_day = day.unwrap_or(1) as u32;
    let mut year = local.year();
    let mut month = if interval_unit == "year" {
        month_of_year.unwrap_or(1) as u32
    } else {
        local.month()
    };
    for attempt in 0..2 {
        let actual_day = requested_day.min(days_in_month(year, month));
        let candidate = kst
            .with_ymd_and_hms(year, month, actual_day, hour, minute, second)
            .single()
            .unwrap();
        if candidate > local {
            return Ok(candidate.with_timezone(&Utc));
        }
        if interval_unit == "year" {
            year += interval_value as i32;
        } else {
            let total = year as i64 * 12 + month as i64 - 1 + interval_value;
            year = (total / 12) as i32;
            month = (total % 12 + 1) as u32;
        }
        let _ = attempt;
    }
    Err(AppError::bad("could not calculate next schedule time"))
}

fn schedule_json(row: &WorkspaceScheduleRow) -> Value {
    json!({
        "id": row.id, "workspace_id": row.workspace_id, "name": row.name,
        "schedule_type": row.schedule_type, "interval_value": row.interval_value,
        "interval_unit": row.interval_unit, "second": row.second,
        "hour": row.hour, "minute": row.minute, "day_of_month": row.day_of_month,
        "month_of_year": row.month_of_year,
        "timezone": row.timezone, "enabled": row.enabled != 0, "next_run_at": row.next_run_at,
        "last_run_at": row.last_run_at, "last_status": row.last_status,
        "created_at": row.created_at, "updated_at": row.updated_at,
    })
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    let rows = state
        .store
        .list_workspace_schedules(user.id(), user.can_see_all_workspaces())
        .await?;
    Ok(Json(
        json!({ "schedules": rows.iter().map(schedule_json).collect::<Vec<_>>() }),
    ))
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<ScheduleBody>,
) -> Result<Json<Value>, AppError> {
    validate(&body)?;
    access::require_workspace(&state.store, &user, &body.workspace_id).await?;
    let next = next_run(
        body.interval_value,
        &body.interval_unit,
        body.second,
        body.hour,
        body.minute,
        body.day_of_month,
        body.month_of_year,
        Utc::now(),
    )?
    .to_rfc3339();
    let row = state
        .store
        .create_workspace_schedule(
            &body.workspace_id,
            user.id(),
            body.name.trim(),
            body.interval_value,
            &body.interval_unit,
            body.second,
            body.hour,
            body.minute,
            body.day_of_month,
            body.month_of_year,
            &next,
        )
        .await?;
    Ok(Json(schedule_json(&row)))
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<ScheduleBody>,
) -> Result<Json<Value>, AppError> {
    validate(&body)?;
    let current = state
        .store
        .get_workspace_schedule(&id)
        .await?
        .ok_or_else(|| AppError::not_found("schedule not found"))?;
    access::require_workspace(&state.store, &user, &current.workspace_id).await?;
    access::require_workspace(&state.store, &user, &body.workspace_id).await?;
    let next = next_run(
        body.interval_value,
        &body.interval_unit,
        body.second,
        body.hour,
        body.minute,
        body.day_of_month,
        body.month_of_year,
        Utc::now(),
    )?
    .to_rfc3339();
    let row = state
        .store
        .update_workspace_schedule(
            &id,
            &body.workspace_id,
            body.name.trim(),
            body.interval_value,
            &body.interval_unit,
            body.second,
            body.hour,
            body.minute,
            body.day_of_month,
            body.month_of_year,
            body.enabled,
            &next,
        )
        .await?;
    Ok(Json(schedule_json(&row)))
}

async fn remove(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = state
        .store
        .get_workspace_schedule(&id)
        .await?
        .ok_or_else(|| AppError::not_found("schedule not found"))?;
    access::require_workspace(&state.store, &user, &row.workspace_id).await?;
    state.store.delete_workspace_schedule(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn scheduler_loop(state: AppState) {
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        timer.tick().await;
        let now = Utc::now();
        let Ok(due) = state.store.due_workspace_schedules(&now.to_rfc3339()).await else {
            continue;
        };
        for row in due {
            let next = match next_run(
                row.interval_value,
                &row.interval_unit,
                row.second,
                row.hour,
                row.minute,
                row.day_of_month,
                row.month_of_year,
                now,
            ) {
                Ok(value) => value.to_rfc3339(),
                Err(_) => continue,
            };
            let active = state
                .store
                .workspace_has_active_execution(&row.workspace_id)
                .await
                .unwrap_or(true);
            let initial_status = if active { "skipped" } else { "running" };
            if state
                .store
                .advance_workspace_schedule(&row.id, &next, initial_status)
                .await
                .is_err()
                || active
            {
                continue;
            }
            let run_state = state.clone();
            tokio::spawn(async move {
                let status = match run_state.store.get_user(&row.owner_user_id).await {
                    Ok(Some(user)) => crate::chip::run_workspace_internal(
                        &run_state,
                        &CurrentUser(user),
                        &row.workspace_id,
                    )
                    .await
                    .map(|_| "succeeded")
                    .unwrap_or("failed"),
                    _ => "failed",
                };
                let _ = run_state
                    .store
                    .set_workspace_schedule_status(&row.id, status)
                    .await;
            });
        }
    }
}
