use crate::models::*;
use crate::*;

impl Store {
    pub async fn list_chips(&self, workspace_id: &str) -> Result<Vec<ChipRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipRow>(&format!(
            "SELECT {CHIP_JOIN_COLS} FROM chips c
             INNER JOIN workspace_chips wc ON wc.chip_id = c.id
             WHERE wc.workspace_id = ? ORDER BY c.updated_at DESC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn list_owned_chips(
        &self,
        owner_user_id: &str,
    ) -> Result<Vec<ChipRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipRow>(&format!(
            "SELECT {CHIP_COLS} FROM chips
             WHERE owner_user_id = ? ORDER BY updated_at DESC"
        ))
        .bind(owner_user_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn get_chip(&self, id: &str) -> Result<Option<ChipRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, ChipRow>(&format!("SELECT {CHIP_COLS} FROM chips WHERE id = ?"))
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn attach_chip_to_workspace(
        &self,
        workspace_id: &str,
        chip_id: &str,
    ) -> Result<(), StorageError> {
        self.require_workspace(workspace_id).await?;
        self.get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(workspace_id, chip_id) DO NOTHING",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_chip_binding(
        &self,
        chip_id: &str,
    ) -> Result<Option<ChipBindingRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipBindingRow>(
            "SELECT chip_id, ref_kind, ref_id FROM chip_bindings WHERE chip_id = ?",
        )
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn get_extract_definition(
        &self,
        id: &str,
    ) -> Result<Option<ExtractDefinitionRow>, StorageError> {
        Ok(sqlx::query_as::<_, ExtractDefinitionRow>(&format!(
            "SELECT {EXTRACT_DEFINITION_COLS} FROM extract_definitions WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn resolve_chip_config_json(&self, chip: &ChipRow) -> Result<String, StorageError> {
        if let Some(binding) = self.get_chip_binding(&chip.id).await? {
            return self.config_json_for_binding(&binding).await;
        }
        let legacy = chip
            .config_json
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| StorageError::Invalid("chip has no binding or config".into()))?;
        Ok(legacy.to_string())
    }

    pub(crate) async fn config_json_for_binding(
        &self,
        binding: &ChipBindingRow,
    ) -> Result<String, StorageError> {
        match binding.ref_kind.as_str() {
            "extract_definition" => {
                let row = self
                    .get_extract_definition(&binding.ref_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("extract definition not found".into()))?;
                let source: serde_json::Value = serde_json::from_str(&row.source_json)
                    .map_err(|error| StorageError::Invalid(error.to_string()))?;
                Ok(serde_json::json!({
                    "connection_id": row.connection_id,
                    "source": source,
                    "delimiter": row.delimiter,
                    "header": row.header != 0,
                })
                .to_string())
            }
            "transform" => {
                let row = self
                    .get_transform(&binding.ref_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
                let spec: serde_json::Value = serde_json::from_str(&row.spec_json)
                    .map_err(|error| StorageError::Invalid(error.to_string()))?;
                Ok(serde_json::json!({
                    "input_dataset_id": row.dataset_id,
                    "spec": spec,
                })
                .to_string())
            }
            "load_definition" => {
                let row = self
                    .get_load_definition(&binding.ref_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("load definition not found".into()))?;
                Ok(row.spec_json)
            }
            other => Err(StorageError::Invalid(format!(
                "unknown chip binding kind {other}"
            ))),
        }
    }

    pub async fn register_extract_chip(
        &self,
        input: &RegisterExtractChip,
    ) -> Result<ChipRow, StorageError> {
        validate_extract_kind(&input.kind)?;
        let name = required_text(&input.name, "chip name")?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            self.require_workspace(workspace_id).await?;
        } else if let Some(workspace_id) = input
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.require_workspace(workspace_id).await?;
        }
        let _ = self
            .get_connection(&input.connection_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        require_config_json(&input.source_json)?;
        let extract_id = Uuid::new_v4().to_string();
        let chip_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO extract_definitions
             (id, name, kind, connection_id, source_json, delimiter, header, add_sequence,
              workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&extract_id)
        .bind(name)
        .bind(&input.kind)
        .bind(&input.connection_id)
        .bind(&input.source_json)
        .bind(&input.delimiter)
        .bind(i64::from(input.header))
        .bind(i64::from(input.add_sequence))
        .bind(input.workspace_id.as_deref())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'extract', NULL, 1, 1, ?, ?)",
        )
        .bind(&chip_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chip_bindings (chip_id, ref_kind, ref_id)
             VALUES (?, 'extract_definition', ?)",
        )
        .bind(&chip_id)
        .bind(&extract_id)
        .execute(&mut *tx)
        .await?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            sqlx::query(
                "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(workspace_id, chip_id) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(&chip_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(&chip_id)).await;
        self.get_chip(&chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after register".into()))
    }

    pub async fn register_transform_chip(
        &self,
        input: &RegisterTransformChip,
    ) -> Result<ChipRow, StorageError> {
        let name = required_text(&input.name, "chip name")?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            self.require_workspace(workspace_id).await?;
        } else if let Some(workspace_id) = input
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.require_workspace(workspace_id).await?;
        }
        let transform = self
            .get_transform(&input.transform_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let _ = transform;
        let chip_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'transform', NULL, 1, 1, ?, ?)",
        )
        .bind(&chip_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chip_bindings (chip_id, ref_kind, ref_id)
             VALUES (?, 'transform', ?)",
        )
        .bind(&chip_id)
        .bind(&input.transform_id)
        .execute(&mut *tx)
        .await?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            sqlx::query(
                "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(workspace_id, chip_id) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(&chip_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(&chip_id)).await;
        self.get_chip(&chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after register".into()))
    }

    pub async fn register_load_chip(
        &self,
        input: &RegisterLoadChip,
    ) -> Result<ChipRow, StorageError> {
        let name = required_text(&input.name, "chip name")?;
        let definition = self.get_load_definition(&input.load_definition_id).await?
            .ok_or_else(|| StorageError::NotFound("load definition not found".into()))?;
        if definition.owner_user_id != input.owner_user_id {
            return Err(StorageError::NotFound("load definition not found".into()));
        }
        if input.place_on_workspace {
            self.require_workspace(input.workspace_id.as_deref().filter(|v| !v.trim().is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?).await?;
        }
        let chip_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO chips (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at) VALUES (?, ?, ?, 'load', NULL, 1, 1, ?, ?)")
            .bind(&chip_id).bind(&input.owner_user_id).bind(name).bind(&now).bind(&now)
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO chip_bindings (chip_id, ref_kind, ref_id) VALUES (?, 'load_definition', ?)")
            .bind(&chip_id).bind(&input.load_definition_id).execute(&mut *tx).await?;
        if input.place_on_workspace {
            sqlx::query("INSERT INTO workspace_chips (workspace_id, chip_id, created_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id, chip_id) DO NOTHING")
                .bind(input.workspace_id.as_deref()).bind(&chip_id).bind(&now).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        self.get_chip(&chip_id).await?.ok_or_else(|| StorageError::NotFound("chip disappeared after register".into()))
    }

    pub async fn insert_chip(
        &self,
        owner_user_id: &str,
        workspace_id: &str,
        name: &str,
        kind: &str,
        config_json: &str,
    ) -> Result<ChipRow, StorageError> {
        let name = required_text(name, "chip name")?;
        validate_chip_kind(kind)?;
        require_config_json(config_json)?;
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(name)
        .bind(kind)
        .bind(config_json)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(&id)).await;
        self.get_chip(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after insert".into()))
    }

    pub async fn update_chip(
        &self,
        id: &str,
        name: Option<&str>,
        kind: Option<&str>,
        config_json: Option<&str>,
        active: Option<bool>,
    ) -> Result<ChipRow, StorageError> {
        let current = self
            .get_chip(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if name.is_none() && kind.is_none() && config_json.is_none() && active.is_none() {
            return Ok(current);
        }
        let name = match name {
            Some(value) => required_text(value, "chip name")?,
            None => current.name.as_str(),
        };
        let kind = kind.unwrap_or(current.kind.as_str());
        validate_chip_kind(kind)?;
        let config_json = match config_json {
            Some(value) => {
                if self.get_chip_binding(id).await?.is_some() {
                    return Err(StorageError::Invalid(
                        "registered chips update definitions, not inline config".into(),
                    ));
                }
                require_config_json(value)?;
                Some(value.to_string())
            }
            None => current.config_json.clone(),
        };
        let bump =
            name != current.name || kind != current.kind || config_json != current.config_json;
        sqlx::query(
            "UPDATE chips
             SET name = ?, kind = ?, config_json = ?, revision = revision + ?,
                 active = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(name)
        .bind(kind)
        .bind(config_json.as_deref())
        .bind(i64::from(bump))
        .bind(active.map(i64::from).unwrap_or(current.active))
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(id)).await;
        self.get_chip(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after update".into()))
    }

    pub async fn delete_chip(&self, id: &str) -> Result<(), StorageError> {
        let mut tx = self.pool.begin().await?;
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM chips WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if found.is_none() {
            return Err(StorageError::NotFound("chip not found".into()));
        }
        sqlx::query(
            "UPDATE datasets SET producer_chip_run_id = NULL
             WHERE producer_chip_run_id IN (SELECT id FROM chip_runs WHERE chip_id = ?)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM chip_edges WHERE from_chip_id = ? OR to_chip_id = ?")
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chip_runs WHERE chip_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chips WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let _ = self.delete_search_document("chip", id).await;
        Ok(())
    }
}
