use crate::models::*;
use crate::*;

const EXECUTION_COLS: &str = "id, workspace_id, requested_by, source, trigger_id, status,
    created_at, started_at, finished_at, error_message";
const STEP_COLS: &str = "id, execution_id, workspace_chip_id, chip_id, kind, extract_id,
    transform_id, load_id, definition_revision, definition_snapshot_json, source_path,
    output_path, status, input_rows, output_rows, rejected_rows, input_bytes, output_bytes,
    result_json, error_code, error_message, queued_at, started_at, finished_at";

impl Store {
    pub async fn create_standalone_load_step(
        &self,
        workspace_id: &str,
        requested_by: Option<&str>,
        snapshot_json: &str,
        input_file_id: &str,
    ) -> Result<ExecutionStepRow, StorageError> {
        self.require_workspace(workspace_id).await?;
        require_config_json(snapshot_json)?;
        let execution_id = Uuid::new_v4().to_string();
        let step_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO executions (id, workspace_id, requested_by, source, status, created_at)
                     VALUES (?, ?, ?, 'load_page', 'queued', ?)",
        )
        .bind(&execution_id)
        .bind(workspace_id)
        .bind(requested_by)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO execution_steps (id, execution_id, kind, definition_revision,
                     definition_snapshot_json, status, queued_at) VALUES (?, ?, 'load', 1, ?, 'queued', ?)")
            .bind(&step_id).bind(&execution_id).bind(snapshot_json).bind(&now).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO execution_inputs (execution_step_id, port_name, data_file_id, ordinal)
                     VALUES (?, 'in', ?, 0)",
        )
        .bind(&step_id)
        .bind(input_file_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.get_execution_step(&step_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("load execution step disappeared".into()))
    }

    pub async fn create_execution_step(
        &self,
        input: &NewExecutionStep<'_>,
    ) -> Result<ExecutionStepRow, StorageError> {
        self.require_workspace(input.workspace_id).await?;
        require_config_json(input.definition_snapshot_json)?;
        if !matches!(input.kind, "extract" | "transform" | "load") {
            return Err(StorageError::Invalid("invalid execution step kind".into()));
        }
        if !matches!(
            input.source,
            "extract_page" | "transform_page" | "load_page" | "chip" | "workspace"
        ) {
            return Err(StorageError::Invalid("invalid execution source".into()));
        }
        let execution_id = Uuid::new_v4().to_string();
        let step_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let (extract_id, transform_id, load_id) = match input.kind {
            "extract" => (Some(input.definition_id), None, None),
            "transform" => (None, Some(input.definition_id), None),
            "load" => (None, None, Some(input.definition_id)),
            _ => unreachable!(),
        };
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO executions
             (id, workspace_id, requested_by, source, trigger_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        )
        .bind(&execution_id)
        .bind(input.workspace_id)
        .bind(input.requested_by)
        .bind(input.source)
        .bind(input.trigger_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO execution_steps
             (id, execution_id, workspace_chip_id, chip_id, kind, extract_id, transform_id,
              load_id, definition_revision, definition_snapshot_json, source_path, status, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
        )
        .bind(&step_id)
        .bind(&execution_id)
        .bind(input.workspace_chip_id)
        .bind(input.chip_id)
        .bind(input.kind)
        .bind(extract_id)
        .bind(transform_id)
        .bind(load_id)
        .bind(input.definition_revision)
        .bind(input.definition_snapshot_json)
        .bind(input.source_path)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.get_execution_step(&step_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("execution step disappeared".into()))
    }

    pub async fn get_execution(&self, id: &str) -> Result<Option<ExecutionRow>, StorageError> {
        Ok(sqlx::query_as::<_, ExecutionRow>(&format!(
            "SELECT {EXECUTION_COLS} FROM executions WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn get_execution_step(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionStepRow>, StorageError> {
        Ok(sqlx::query_as::<_, ExecutionStepRow>(&format!(
            "SELECT {STEP_COLS} FROM execution_steps WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn set_execution_step_running(
        &self,
        id: &str,
        output_path: Option<&str>,
    ) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let execution_id: String = sqlx::query_scalar(
            "SELECT execution_id FROM execution_steps WHERE id = ? AND status = 'queued'",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StorageError::Invalid("execution step must be queued".into()))?;
        sqlx::query(
            "UPDATE execution_steps SET status = 'running', started_at = ?, output_path = ?,
             error_code = NULL, error_message = NULL WHERE id = ? AND status = 'queued'",
        )
        .bind(&now)
        .bind(output_path)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE executions SET status = 'running', started_at = COALESCE(started_at, ?),
             error_message = NULL WHERE id = ? AND status = 'queued'",
        )
        .bind(&now)
        .bind(execution_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn finish_execution_step(
        &self,
        id: &str,
        status: &str,
        result_json: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<(), StorageError> {
        if !matches!(status, "succeeded" | "failed" | "canceled") {
            return Err(StorageError::Invalid("invalid terminal status".into()));
        }
        if let Some(raw) = result_json {
            require_config_json(raw)?;
        }
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let execution_id: String =
            sqlx::query_scalar("SELECT execution_id FROM execution_steps WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| StorageError::NotFound("execution step not found".into()))?;
        let changed = sqlx::query(
            "UPDATE execution_steps SET status = ?, result_json = COALESCE(?, result_json), error_message = ?,
             finished_at = ? WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(status)
        .bind(result_json)
        .bind(error_message)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "execution step is already finished".into(),
            ));
        }
        sqlx::query(
            "UPDATE executions SET status = ?, error_message = ?, finished_at = ? WHERE id = ?",
        )
        .bind(status)
        .bind(error_message)
        .bind(&now)
        .bind(execution_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn append_execution_log(
        &self,
        step_id: &str,
        level: &str,
        event_type: &str,
        message: &str,
        context_json: Option<&str>,
    ) -> Result<(), StorageError> {
        if let Some(raw) = context_json {
            require_config_json(raw)?;
        }
        sqlx::query(
            "INSERT INTO execution_logs
             (execution_step_id, sequence, level, event_type, message, context_json, created_at)
             SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?
             FROM execution_logs WHERE execution_step_id = ?",
        )
        .bind(step_id)
        .bind(level)
        .bind(event_type)
        .bind(message)
        .bind(context_json)
        .bind(now_rfc3339())
        .bind(step_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
