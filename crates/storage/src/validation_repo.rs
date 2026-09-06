use crate::*;

const RULE_COLS: &str = "id, owner_user_id, name, description, keys_json, columns_json,
    compare_row_count, compare_schema, active, revision, created_at, updated_at";
const RESULT_COLS: &str = "id, owner_user_id, workspace_id, validation_rule_id,
    execution_step_id, source_data_file_id, target_data_file_id, passed, report_json, created_at";

impl Store {
    pub async fn list_validation_rules(
        &self,
        owner_user_id: &str,
        admin: bool,
    ) -> Result<Vec<ValidationRuleRow>, StorageError> {
        let sql = if admin {
            format!("SELECT {RULE_COLS} FROM validation_rules ORDER BY updated_at DESC")
        } else {
            format!("SELECT {RULE_COLS} FROM validation_rules WHERE owner_user_id=? ORDER BY updated_at DESC")
        };
        let mut query = sqlx::query_as::<_, ValidationRuleRow>(&sql);
        if !admin {
            query = query.bind(owner_user_id);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn get_validation_rule(
        &self,
        id: &str,
    ) -> Result<Option<ValidationRuleRow>, StorageError> {
        Ok(sqlx::query_as::<_, ValidationRuleRow>(&format!(
            "SELECT {RULE_COLS} FROM validation_rules WHERE id=?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn save_validation_rule(
        &self,
        id: Option<&str>,
        owner_user_id: &str,
        name: &str,
        description: &str,
        keys_json: &str,
        columns_json: &str,
        compare_row_count: bool,
        compare_schema: bool,
        active: bool,
    ) -> Result<ValidationRuleRow, StorageError> {
        let name = required_text(name, "validation rule name")?;
        require_config_json(keys_json)?;
        require_config_json(columns_json)?;
        let now = now_rfc3339();
        let id = id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        sqlx::query("INSERT INTO validation_rules
            (id, owner_user_id, name, description, keys_json, columns_json, compare_row_count,
             compare_schema, active, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
             keys_json=excluded.keys_json, columns_json=excluded.columns_json,
             compare_row_count=excluded.compare_row_count, compare_schema=excluded.compare_schema,
             active=excluded.active, revision=validation_rules.revision+1, updated_at=excluded.updated_at
            WHERE validation_rules.owner_user_id=excluded.owner_user_id")
            .bind(&id).bind(owner_user_id).bind(name).bind(description.trim()).bind(keys_json)
            .bind(columns_json).bind(i64::from(compare_row_count)).bind(i64::from(compare_schema))
            .bind(i64::from(active)).bind(&now).bind(&now).execute(&self.pool).await?;
        self.get_validation_rule(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("validation rule not found".into()))
    }

    pub async fn delete_validation_rule(
        &self,
        id: &str,
        owner_user_id: &str,
    ) -> Result<(), StorageError> {
        let result = sqlx::query("DELETE FROM validation_rules WHERE id=? AND owner_user_id=?")
            .bind(id)
            .bind(owner_user_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("validation rule not found".into()));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_validation_result(
        &self,
        owner_user_id: &str,
        workspace_id: &str,
        rule_id: Option<&str>,
        step_id: Option<&str>,
        source_id: &str,
        target_id: &str,
        passed: bool,
        report_json: &str,
    ) -> Result<ValidationResultRow, StorageError> {
        require_config_json(report_json)?;
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO validation_results
            (id, owner_user_id, workspace_id, validation_rule_id, execution_step_id,
             source_data_file_id, target_data_file_id, passed, report_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(workspace_id)
        .bind(rule_id)
        .bind(step_id)
        .bind(source_id)
        .bind(target_id)
        .bind(i64::from(passed))
        .bind(report_json)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        sqlx::query_as::<_, ValidationResultRow>(&format!(
            "SELECT {RESULT_COLS} FROM validation_results WHERE id=?"
        ))
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn list_validation_results(
        &self,
        owner_user_id: &str,
        admin: bool,
    ) -> Result<Vec<ValidationResultRow>, StorageError> {
        let sql = if admin {
            format!("SELECT {RESULT_COLS} FROM validation_results ORDER BY created_at DESC")
        } else {
            format!("SELECT {RESULT_COLS} FROM validation_results WHERE owner_user_id=? ORDER BY created_at DESC")
        };
        let mut query = sqlx::query_as::<_, ValidationResultRow>(&sql);
        if !admin {
            query = query.bind(owner_user_id);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }
}
