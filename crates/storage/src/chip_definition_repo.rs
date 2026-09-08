use crate::models::*;
use crate::workspace_repo::workspace_chip_id;
use crate::*;

impl Store {
    async fn ensure_chip_name_available(
        &self,
        owner_user_id: &str,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<(), StorageError> {
        let duplicate: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM chips
             WHERE owner_user_id = ? AND lower(trim(name)) = lower(trim(?))
               AND (? IS NULL OR id != ?)",
        )
        .bind(owner_user_id)
        .bind(name)
        .bind(exclude_id)
        .bind(exclude_id)
        .fetch_one(&self.pool)
        .await?;
        if duplicate > 0 {
            return Err(StorageError::Conflict("chip name already exists".into()));
        }
        Ok(())
    }

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
        let placement_id = workspace_chip_id(workspace_id, chip_id);
        sqlx::query(
            "INSERT INTO workspace_chips (id, workspace_id, chip_id, created_at, updated_at)
             SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS
             (SELECT 1 FROM workspace_chips WHERE workspace_id = ? AND chip_id = ?)",
        )
        .bind(placement_id)
        .bind(workspace_id)
        .bind(chip_id)
        .bind(&now)
        .bind(&now)
        .bind(workspace_id)
        .bind(chip_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_chip_binding(
        &self,
        chip_id: &str,
    ) -> Result<Option<ChipBindingRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipBindingRow>(
            "SELECT id AS chip_id,
                    CASE kind WHEN 'extract' THEN 'extract_recipe' WHEN 'transform' THEN 'transform' ELSE 'load_recipe' END AS ref_kind,
                    CASE kind WHEN 'extract' THEN extract_id WHEN 'transform' THEN transform_id ELSE load_id END AS ref_id
             FROM chips WHERE id = ? AND COALESCE(extract_id, transform_id, load_id) IS NOT NULL",
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
            "SELECT e.id, e.name, e.source_type AS kind, e.connection_id, e.source_json,
                    e.output_filename,
                    COALESCE(e.delimiter, ',') AS delimiter, COALESCE(e.has_header, 1) AS header,
                    e.add_sequence,
                    COALESCE((SELECT wc.workspace_id FROM workspace_chips wc INNER JOIN chips c ON c.id = wc.chip_id WHERE c.extract_id = e.id LIMIT 1), 'default') AS workspace_id,
                    e.created_at, e.updated_at FROM extracts e WHERE e.id = ?"
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
            "extract_recipe" => {
                let row = self
                    .get_extract_definition(&binding.ref_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("extract definition not found".into()))?;
                let source: serde_json::Value = serde_json::from_str(&row.source_json)
                    .map_err(|error| StorageError::Invalid(error.to_string()))?;
                Ok(serde_json::json!({
                    "connection_id": row.connection_id,
                    "source": source,
                    "output_filename": row.output_filename,
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
            "load_recipe" => {
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
        self.ensure_chip_name_available(&input.owner_user_id, name, None)
            .await?;
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
            "INSERT INTO extracts
             (id, owner_user_id, name, source_type, connection_id, source_json, output_format,
              output_filename, delimiter, has_header, add_sequence, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'csv', ?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .bind(&extract_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&input.kind)
        .bind(&input.connection_id)
        .bind(&input.source_json)
        .bind(
            input
                .output_filename
                .as_deref()
                .map(str::trim)
                .filter(|filename| !filename.is_empty())
                .map(crate::csv_output_filename)
                .unwrap_or_else(|| chip_slot::display_filename(name, "extract", &input.delimiter)),
        )
        .bind(&input.delimiter)
        .bind(i64::from(input.header))
        .bind(i64::from(input.add_sequence))
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, extract_id, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'extract', ?, NULL, 1, 1, ?, ?)",
        )
        .bind(&chip_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&extract_id)
        .bind(&now)
        .bind(&now)
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
                "INSERT INTO workspace_chips (id, workspace_id, chip_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(workspace_chip_id(workspace_id, &chip_id))
            .bind(workspace_id)
            .bind(&chip_id)
            .bind(&now)
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

    pub async fn update_extract_chip(
        &self,
        chip_id: &str,
        name: &str,
        connection_id: &str,
        source_json: &str,
        output_filename: Option<&str>,
        delimiter: &str,
        header: bool,
        add_sequence: bool,
    ) -> Result<ChipRow, StorageError> {
        let chip = self
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if chip.kind != "extract" {
            return Err(StorageError::Invalid("chip is not an extract chip".into()));
        }
        let name = required_text(name, "chip name")?;
        self.ensure_chip_name_available(&chip.owner_user_id, name, Some(chip_id))
            .await?;
        let binding = self
            .get_chip_binding(chip_id)
            .await?
            .filter(|binding| binding.ref_kind == "extract_recipe")
            .ok_or_else(|| StorageError::Invalid("extract chip has no extract recipe".into()))?;
        let _ = self
            .get_connection(connection_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        require_config_json(source_json)?;
        let filename = output_filename
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(crate::csv_output_filename)
            .unwrap_or_else(|| chip_slot::display_filename(name, "extract", delimiter));
        let source_type = serde_json::from_str::<serde_json::Value>(source_json)
            .ok()
            .and_then(|value| {
                value
                    .get("type")
                    .and_then(|kind| kind.as_str())
                    .map(str::to_owned)
            })
            .map(|kind| if kind == "http" { "api" } else { "database" })
            .unwrap_or("database");
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE extracts SET name = ?, source_type = ?, connection_id = ?, source_json = ?,
                    output_filename = ?, delimiter = ?, has_header = ?, add_sequence = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(source_type)
        .bind(connection_id)
        .bind(source_json)
        .bind(filename)
        .bind(delimiter)
        .bind(i64::from(header))
        .bind(i64::from(add_sequence))
        .bind(&now)
        .bind(&binding.ref_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chips SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(&now)
        .bind(chip_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(chip_id)).await;
        self.get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after update".into()))
    }

    pub async fn register_transform_chip(
        &self,
        input: &RegisterTransformChip,
    ) -> Result<ChipRow, StorageError> {
        let name = required_text(&input.name, "chip name")?;
        self.ensure_chip_name_available(&input.owner_user_id, name, None)
            .await?;
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
             (id, owner_user_id, name, kind, transform_id, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'transform', ?, NULL, 1, 1, ?, ?)",
        )
        .bind(&chip_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&input.transform_id)
        .bind(&now)
        .bind(&now)
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
                "INSERT INTO workspace_chips (id, workspace_id, chip_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(workspace_chip_id(workspace_id, &chip_id))
            .bind(workspace_id)
            .bind(&chip_id)
            .bind(&now)
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
        self.ensure_chip_name_available(&input.owner_user_id, name, None)
            .await?;
        let definition = self
            .get_load_definition(&input.load_definition_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("load definition not found".into()))?;
        if definition.owner_user_id != input.owner_user_id {
            return Err(StorageError::NotFound("load definition not found".into()));
        }
        if input.place_on_workspace {
            self.require_workspace(
                input
                    .workspace_id
                    .as_deref()
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?,
            )
            .await?;
        }
        let chip_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO chips (id, owner_user_id, name, kind, load_id, config_json, revision, active, created_at, updated_at) VALUES (?, ?, ?, 'load', ?, NULL, 1, 1, ?, ?)")
            .bind(&chip_id).bind(&input.owner_user_id).bind(name).bind(&input.load_definition_id).bind(&now).bind(&now)
            .execute(&mut *tx).await?;
        if input.place_on_workspace {
            let workspace_id = input.workspace_id.as_deref().unwrap();
            sqlx::query("INSERT INTO workspace_chips (id, workspace_id, chip_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
                .bind(workspace_chip_id(workspace_id, &chip_id)).bind(workspace_id).bind(&chip_id).bind(&now).bind(&now).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        self.get_chip(&chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after register".into()))
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
        self.ensure_chip_name_available(owner_user_id, name, None)
            .await?;
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
        self.ensure_chip_name_available(&current.owner_user_id, name, Some(id))
            .await?;
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
        let definitions: Option<(Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT extract_id, transform_id, load_id FROM chips WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some((extract_id, transform_id, load_id)) = definitions else {
            return Err(StorageError::NotFound("chip not found".into()));
        };
        let mut deleted_transform = false;
        let mut deleted_load = false;
        sqlx::query("DELETE FROM chips WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if let Some(definition_id) = extract_id.as_deref() {
            sqlx::query(
                "DELETE FROM extracts WHERE id = ?
                 AND NOT EXISTS (SELECT 1 FROM chips WHERE extract_id = ?)",
            )
            .bind(definition_id)
            .bind(definition_id)
            .execute(&mut *tx)
            .await?;
        }
        if let Some(definition_id) = transform_id.as_deref() {
            deleted_transform = sqlx::query(
                "DELETE FROM transforms WHERE id = ?
                 AND NOT EXISTS (SELECT 1 FROM chips WHERE transform_id = ?)",
            )
            .bind(definition_id)
            .bind(definition_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
                > 0;
        }
        if let Some(definition_id) = load_id.as_deref() {
            deleted_load = sqlx::query(
                "DELETE FROM loads WHERE id = ?
                 AND NOT EXISTS (SELECT 1 FROM chips WHERE load_id = ?)",
            )
            .bind(definition_id)
            .bind(definition_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
                > 0;
        }
        tx.commit().await?;
        let _ = self.delete_search_document("chip", id).await;
        if deleted_transform {
            if let Some(definition_id) = transform_id {
                let _ = self
                    .delete_search_document("transform", &definition_id)
                    .await;
            }
        }
        if deleted_load {
            if let Some(definition_id) = load_id {
                let _ = self.delete_search_document("load", &definition_id).await;
            }
        }
        Ok(())
    }
}
