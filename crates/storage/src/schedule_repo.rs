use crate::{now_rfc3339, StorageError, Store, WorkspaceScheduleRow};
use uuid::Uuid;

const SCHEDULE_COLS: &str = "id, workspace_id, owner_user_id, name, schedule_type,
    interval_value, interval_unit, second, hour, minute, day_of_month, month_of_year,
    timezone, enabled, next_run_at,
    last_run_at, last_status, created_at, updated_at";

impl Store {
    pub async fn list_workspace_schedules(
        &self,
        owner_user_id: &str,
        all_workspaces: bool,
    ) -> Result<Vec<WorkspaceScheduleRow>, StorageError> {
        let filter = if all_workspaces {
            ""
        } else {
            "WHERE owner_user_id = ?"
        };
        let sql = format!(
            "SELECT {SCHEDULE_COLS} FROM workspace_schedules {filter} ORDER BY updated_at DESC"
        );
        let query = sqlx::query_as::<_, WorkspaceScheduleRow>(&sql);
        Ok(if all_workspaces {
            query.fetch_all(&self.pool).await?
        } else {
            query.bind(owner_user_id).fetch_all(&self.pool).await?
        })
    }

    pub async fn get_workspace_schedule(
        &self,
        id: &str,
    ) -> Result<Option<WorkspaceScheduleRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceScheduleRow>(&format!(
            "SELECT {SCHEDULE_COLS} FROM workspace_schedules WHERE id=?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_workspace_schedule(
        &self,
        workspace_id: &str,
        owner_user_id: &str,
        name: &str,
        interval_value: i64,
        interval_unit: &str,
        second: Option<i64>,
        hour: Option<i64>,
        minute: Option<i64>,
        day_of_month: Option<i64>,
        month_of_year: Option<i64>,
        next_run_at: &str,
    ) -> Result<WorkspaceScheduleRow, StorageError> {
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO workspace_schedules
            (id, workspace_id, owner_user_id, name, schedule_type, interval_value, interval_unit,
             second, hour, minute, day_of_month, month_of_year, timezone, enabled, next_run_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'interval', ?, ?, ?, ?, ?, ?, ?, 'Asia/Seoul', 1, ?, ?, ?)",
        )
        .bind(&id)
        .bind(workspace_id)
        .bind(owner_user_id)
        .bind(name)
        .bind(interval_value)
        .bind(interval_unit)
        .bind(second)
        .bind(hour)
        .bind(minute)
        .bind(day_of_month)
        .bind(month_of_year)
        .bind(next_run_at)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_workspace_schedule(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("schedule disappeared after insert".into()))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_workspace_schedule(
        &self,
        id: &str,
        workspace_id: &str,
        name: &str,
        interval_value: i64,
        interval_unit: &str,
        second: Option<i64>,
        hour: Option<i64>,
        minute: Option<i64>,
        day_of_month: Option<i64>,
        month_of_year: Option<i64>,
        enabled: bool,
        next_run_at: &str,
    ) -> Result<WorkspaceScheduleRow, StorageError> {
        let changed = sqlx::query(
            "UPDATE workspace_schedules SET workspace_id=?, name=?, schedule_type='interval', interval_value=?, interval_unit=?,
            second=?, hour=?, minute=?, day_of_month=?, month_of_year=?, enabled=?, next_run_at=?, updated_at=? WHERE id=?",
        )
        .bind(workspace_id)
        .bind(name)
        .bind(interval_value)
        .bind(interval_unit)
        .bind(second)
        .bind(hour)
        .bind(minute)
        .bind(day_of_month)
        .bind(month_of_year)
        .bind(i64::from(enabled))
        .bind(next_run_at)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StorageError::NotFound("schedule not found".into()));
        }
        self.get_workspace_schedule(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("schedule not found".into()))
    }

    pub async fn delete_workspace_schedule(&self, id: &str) -> Result<(), StorageError> {
        if sqlx::query("DELETE FROM workspace_schedules WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected()
            == 0
        {
            return Err(StorageError::NotFound("schedule not found".into()));
        }
        Ok(())
    }

    pub async fn due_workspace_schedules(
        &self,
        now: &str,
    ) -> Result<Vec<WorkspaceScheduleRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceScheduleRow>(&format!(
            "SELECT {SCHEDULE_COLS} FROM workspace_schedules WHERE enabled=1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 16"
        )).bind(now).fetch_all(&self.pool).await?)
    }

    pub async fn advance_workspace_schedule(
        &self,
        id: &str,
        next_run_at: &str,
        status: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE workspace_schedules SET next_run_at=?, last_run_at=?, last_status=?, updated_at=? WHERE id=?")
            .bind(next_run_at).bind(now_rfc3339()).bind(status).bind(now_rfc3339()).bind(id)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn set_workspace_schedule_status(
        &self,
        id: &str,
        status: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE workspace_schedules SET last_status=?, updated_at=? WHERE id=?")
            .bind(status)
            .bind(now_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn workspace_has_active_execution(
        &self,
        workspace_id: &str,
    ) -> Result<bool, StorageError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM executions WHERE workspace_id=? AND status IN ('queued','running')")
            .bind(workspace_id).fetch_one(&self.pool).await?;
        Ok(count > 0)
    }
}
