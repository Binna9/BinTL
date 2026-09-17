use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::workspace_repo::{chip_matches_workspace_owner, write_workspace_graph};
use crate::*;

struct ChipCloneSrc {
    id: String,
    owner_user_id: String,
    name: String,
    kind: String,
    extract_id: Option<String>,
    transform_id: Option<String>,
    load_id: Option<String>,
    config_json: Option<String>,
    x: f64,
    y: f64,
}

struct DatasetRewrite<'a> {
    source_workspace_id: &'a str,
    target_workspace_id: &'a str,
    id_map: &'a HashMap<String, String>,
}

impl Store {
    pub async fn paste_chips(
        &self,
        target_workspace_id: &str,
        input: ChipPasteInput,
    ) -> Result<ChipPasteResult, StorageError> {
        let source_workspace_id = required_text(&input.source_workspace_id, "source workspace")?;
        let source = self
            .get_workspace(source_workspace_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("source workspace not found".into()))?;
        let target = self
            .get_workspace(target_workspace_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace not found".into()))?;
        if input.expected_version != target.version {
            return Err(StorageError::Conflict(
                "workspace has changed, reload and save again".into(),
            ));
        }
        let mut seen = HashSet::new();
        let mut chip_ids = Vec::new();
        for chip_id in &input.chip_ids {
            let chip_id = required_text(chip_id, "chip id")?;
            if seen.insert(chip_id.to_string()) {
                chip_ids.push(chip_id.to_string());
            }
        }
        if chip_ids.is_empty() {
            return Err(StorageError::Invalid("chip ids required".into()));
        }

        let mut sources = Vec::with_capacity(chip_ids.len());
        for chip_id in &chip_ids {
            let row = sqlx::query(
                "SELECT c.id, c.owner_user_id, c.name, c.kind, c.extract_id, c.transform_id, c.load_id,
                        c.config_json, wc.x, wc.y
                 FROM chips c
                 INNER JOIN workspace_chips wc ON wc.chip_id = c.id AND wc.workspace_id = ?
                 WHERE c.id = ?",
            )
            .bind(source_workspace_id)
            .bind(chip_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| {
                StorageError::NotFound(format!("chip {chip_id} is not on the source canvas"))
            })?;
            sources.push(ChipCloneSrc {
                id: row.get("id"),
                owner_user_id: row.get("owner_user_id"),
                name: row.get("name"),
                kind: row.get("kind"),
                extract_id: row.get("extract_id"),
                transform_id: row.get("transform_id"),
                load_id: row.get("load_id"),
                config_json: row.get("config_json"),
                x: row.get("x"),
                y: row.get("y"),
            });
        }
        for src in &sources {
            let chip = ChipRow {
                id: src.id.clone(),
                owner_user_id: src.owner_user_id.clone(),
                name: src.name.clone(),
                kind: src.kind.clone(),
                config_json: src.config_json.clone(),
                revision: 1,
                active: 1,
                created_at: String::new(),
                updated_at: String::new(),
            };
            chip_matches_workspace_owner(&chip, &source)?;
            chip_matches_workspace_owner(&chip, &target)?;
        }

        let min_x = sources.iter().map(|src| src.x).fold(f64::INFINITY, f64::min);
        let min_y = sources.iter().map(|src| src.y).fold(f64::INFINITY, f64::min);
        let dx = input.origin_x - min_x;
        let dy = input.origin_y - min_y;
        let id_map: HashMap<String, String> = sources
            .iter()
            .map(|src| (src.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let rewrite = DatasetRewrite {
            source_workspace_id,
            target_workspace_id,
            id_map: &id_map,
        };

        let source_edges: Vec<ChipEdgeRow> = sqlx::query_as(
            "SELECT we.id, we.workspace_id, fc.chip_id AS from_chip_id, tc.chip_id AS to_chip_id,
                    we.kind, we.from_port, we.to_port, we.created_at
             FROM workspace_edges we
             INNER JOIN workspace_chips fc ON fc.id = we.from_workspace_chip_id
             INNER JOIN workspace_chips tc ON tc.id = we.to_workspace_chip_id
             WHERE we.workspace_id = ?",
        )
        .bind(source_workspace_id)
        .fetch_all(&self.pool)
        .await?;

        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let mut taken_names: HashMap<String, HashSet<String>> = HashMap::new();
        for src in &sources {
            let names = taken_names.entry(src.owner_user_id.clone()).or_insert_with(HashSet::new);
            if names.is_empty() {
                let existing: Vec<String> = sqlx::query_scalar(
                    "SELECT name FROM chips WHERE owner_user_id = ?",
                )
                .bind(&src.owner_user_id)
                .fetch_all(&mut *tx)
                .await?;
                names.extend(existing.into_iter().map(|name| name.trim().to_lowercase()));
            }
            let name = next_copy_name(&src.name, names);
            names.insert(name.trim().to_lowercase());
            clone_chip(
                &mut tx,
                src,
                id_map.get(&src.id).expect("clone id"),
                &name,
                &now,
                &rewrite,
                &input.serve_configs,
            )
            .await?;
        }

        let existing_ids: Vec<String> =
            sqlx::query_scalar("SELECT chip_id FROM workspace_chips WHERE workspace_id = ?")
                .bind(target_workspace_id)
                .fetch_all(&mut *tx)
                .await?;
        let existing_edges: Vec<ChipEdgeRow> = sqlx::query_as(
            "SELECT we.id, we.workspace_id, fc.chip_id AS from_chip_id, tc.chip_id AS to_chip_id,
                    we.kind, we.from_port, we.to_port, we.created_at
             FROM workspace_edges we
             INNER JOIN workspace_chips fc ON fc.id = we.from_workspace_chip_id
             INNER JOIN workspace_chips tc ON tc.id = we.to_workspace_chip_id
             WHERE we.workspace_id = ?",
        )
        .bind(target_workspace_id)
        .fetch_all(&mut *tx)
        .await?;

        let mut layout: Value = serde_json::from_str(&target.layout_json)
            .unwrap_or_else(|_| json!({}));
        if !layout.is_object() {
            layout = json!({});
        }
        let nodes = layout
            .as_object_mut()
            .expect("layout object")
            .entry("nodes")
            .or_insert_with(|| json!({}));
        if !nodes.is_object() {
            *nodes = json!({});
        }
        let nodes = nodes.as_object_mut().expect("nodes object");
        for src in &sources {
            let new_id = id_map.get(&src.id).expect("clone id");
            nodes.insert(
                new_id.clone(),
                json!({ "x": src.x + dx, "y": src.y + dy }),
            );
        }
        let layout_json = serde_json::to_string(&layout)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;

        let mut next_ids = existing_ids;
        for src in &sources {
            next_ids.push(id_map.get(&src.id).expect("clone id").clone());
        }
        let mut next_edges: Vec<WorkspaceSaveEdge> = existing_edges
            .into_iter()
            .map(|edge| WorkspaceSaveEdge {
                id: edge.id,
                from_chip_id: edge.from_chip_id,
                to_chip_id: edge.to_chip_id,
                kind: edge.kind,
                from_port: edge.from_port,
                to_port: edge.to_port,
            })
            .collect();
        for edge in source_edges {
            let Some(from) = id_map.get(&edge.from_chip_id) else {
                continue;
            };
            let Some(to) = id_map.get(&edge.to_chip_id) else {
                continue;
            };
            next_edges.push(WorkspaceSaveEdge {
                id: Uuid::new_v4().to_string(),
                from_chip_id: from.clone(),
                to_chip_id: to.clone(),
                kind: edge.kind,
                from_port: edge.from_port,
                to_port: edge.to_port,
            });
        }

        let (saved_chips, saved_edges) = write_workspace_graph(
            &mut tx,
            &target,
            &layout_json,
            &next_ids,
            &next_edges,
            input.expected_version,
            &now,
        )
        .await?;
        tx.commit().await?;
        for new_id in id_map.values() {
            search::sync_search_best_effort(self, "chip", self.sync_search_chip(new_id)).await;
        }
        let workspace = self.get_workspace(target_workspace_id).await?.ok_or_else(|| {
            StorageError::NotFound("workspace disappeared after paste".into())
        })?;
        Ok(ChipPasteResult {
            workspace,
            chips: saved_chips,
            edges: saved_edges,
            id_map,
        })
    }
}

async fn clone_chip(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    src: &ChipCloneSrc,
    new_id: &str,
    name: &str,
    now: &str,
    rewrite: &DatasetRewrite<'_>,
    serve_configs: &HashMap<String, String>,
) -> Result<(), StorageError> {
    match src.kind.as_str() {
        "extract" => clone_extract(tx, src, new_id, name, now).await,
        "transform" => clone_transform(tx, src, new_id, name, now, rewrite).await,
        "load" => clone_load(tx, src, new_id, name, now, rewrite).await,
        "serve" => {
            let config = serve_configs.get(&src.id).ok_or_else(|| {
                StorageError::Invalid("serve chip copy needs a new path and API key".into())
            })?;
            require_config_json(config)?;
            insert_config_chip(tx, new_id, src, name, config, now).await
        }
        "validation" | "sql" | "script" => {
            let mut config: Value = src
                .config_json
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| StorageError::Invalid(error.to_string()))?
                .unwrap_or_else(|| json!({}));
            rewrite_json_datasets(&mut config, rewrite);
            let config_json = serde_json::to_string(&config)
                .map_err(|error| StorageError::Invalid(error.to_string()))?;
            require_config_json(&config_json)?;
            insert_config_chip(tx, new_id, src, name, &config_json, now).await
        }
        other => Err(StorageError::Invalid(format!(
            "cannot copy chip kind {other}"
        ))),
    }
}

async fn clone_extract(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    src: &ChipCloneSrc,
    new_id: &str,
    name: &str,
    now: &str,
) -> Result<(), StorageError> {
    if let Some(extract_id) = src.extract_id.as_deref() {
        let delimiter: String = sqlx::query_scalar(
            "SELECT COALESCE(delimiter, ',') FROM extracts WHERE id = ?",
        )
        .bind(extract_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StorageError::NotFound("extract definition not found".into()))?;
        let new_extract_id = Uuid::new_v4().to_string();
        let copied = sqlx::query(
            "INSERT INTO extracts
             (id, owner_user_id, name, source_type, connection_id, source_json, output_format,
              output_filename, delimiter, has_header, add_sequence, revision, active, created_at, updated_at)
             SELECT ?, owner_user_id, ?, source_type, connection_id, source_json, output_format,
                    ?, delimiter, has_header, add_sequence, 1, 1, ?, ?
             FROM extracts WHERE id = ?",
        )
        .bind(&new_extract_id)
        .bind(name)
        .bind(chip_slot::display_filename(name, "extract", &delimiter))
        .bind(now)
        .bind(now)
        .bind(extract_id)
        .execute(&mut **tx)
        .await?;
        if copied.rows_affected() == 0 {
            return Err(StorageError::NotFound("extract definition not found".into()));
        }
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, extract_id, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'extract', ?, NULL, 1, 1, ?, ?)",
        )
        .bind(new_id)
        .bind(&src.owner_user_id)
        .bind(name)
        .bind(&new_extract_id)
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }
    let config = src.config_json.as_deref().unwrap_or("{}");
    require_config_json(config)?;
    insert_config_chip(tx, new_id, src, name, config, now).await
}

async fn clone_transform(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    src: &ChipCloneSrc,
    new_id: &str,
    name: &str,
    now: &str,
    rewrite: &DatasetRewrite<'_>,
) -> Result<(), StorageError> {
    if let Some(transform_id) = src.transform_id.as_deref() {
        let row = sqlx::query(
            "SELECT default_input_file_id, spec_json, output_format FROM transforms WHERE id = ?",
        )
        .bind(transform_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let spec_raw: String = row.get("spec_json");
        let mut spec: Value = serde_json::from_str(&spec_raw)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;
        rewrite_json_datasets(&mut spec, rewrite);
        let spec_json = serde_json::to_string(&spec)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;
        let input_id: Option<String> = row.get("default_input_file_id");
        let input_id = input_id.and_then(|id| rewrite_dataset_id(&id, rewrite));
        let output_format: String = row.get("output_format");
        let new_transform_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO transforms
             (id, owner_user_id, name, default_input_file_id, spec_json, output_format,
              output_filename_template, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .bind(&new_transform_id)
        .bind(&src.owner_user_id)
        .bind(name)
        .bind(input_id.as_deref())
        .bind(&spec_json)
        .bind(output_format)
        .bind(chip_slot::display_filename(name, "transform", ","))
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, transform_id, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'transform', ?, NULL, 1, 1, ?, ?)",
        )
        .bind(new_id)
        .bind(&src.owner_user_id)
        .bind(name)
        .bind(&new_transform_id)
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }
    let mut config: Value = src
        .config_json
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| StorageError::Invalid(error.to_string()))?
        .unwrap_or_else(|| json!({}));
    rewrite_json_datasets(&mut config, rewrite);
    let config_json =
        serde_json::to_string(&config).map_err(|error| StorageError::Invalid(error.to_string()))?;
    require_config_json(&config_json)?;
    insert_config_chip(tx, new_id, src, name, &config_json, now).await
}

async fn clone_load(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    src: &ChipCloneSrc,
    new_id: &str,
    name: &str,
    now: &str,
    rewrite: &DatasetRewrite<'_>,
) -> Result<(), StorageError> {
    if let Some(load_id) = src.load_id.as_deref() {
        let row = sqlx::query(
            "SELECT default_input_file_id, destination_type, connection_id, destination_json,
                    write_mode, batch_size, conflict_keys_json
             FROM loads WHERE id = ?",
        )
        .bind(load_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StorageError::NotFound("load definition not found".into()))?;
        let input_id: Option<String> = row.get("default_input_file_id");
        let input_id = input_id.and_then(|id| rewrite_dataset_id(&id, rewrite));
        let destination_json: String = row.get("destination_json");
        let mut destination: Value = serde_json::from_str(&destination_json)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;
        rewrite_json_datasets(&mut destination, rewrite);
        let destination_json = serde_json::to_string(&destination)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;
        let new_load_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO loads
             (id, owner_user_id, name, default_input_file_id, destination_type, connection_id,
              destination_json, write_mode, batch_size, conflict_keys_json, revision, active,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .bind(&new_load_id)
        .bind(&src.owner_user_id)
        .bind(name)
        .bind(input_id.as_deref())
        .bind(row.get::<String, _>("destination_type"))
        .bind(row.get::<Option<String>, _>("connection_id"))
        .bind(destination_json)
        .bind(row.get::<String, _>("write_mode"))
        .bind(row.get::<i64, _>("batch_size"))
        .bind(row.get::<String, _>("conflict_keys_json"))
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, load_id, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'load', ?, NULL, 1, 1, ?, ?)",
        )
        .bind(new_id)
        .bind(&src.owner_user_id)
        .bind(name)
        .bind(&new_load_id)
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }
    let mut config: Value = src
        .config_json
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| StorageError::Invalid(error.to_string()))?
        .unwrap_or_else(|| json!({}));
    rewrite_json_datasets(&mut config, rewrite);
    let config_json =
        serde_json::to_string(&config).map_err(|error| StorageError::Invalid(error.to_string()))?;
    require_config_json(&config_json)?;
    insert_config_chip(tx, new_id, src, name, &config_json, now).await
}

async fn insert_config_chip(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    new_id: &str,
    src: &ChipCloneSrc,
    name: &str,
    config_json: &str,
    now: &str,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO chips
         (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)",
    )
    .bind(new_id)
    .bind(&src.owner_user_id)
    .bind(name)
    .bind(&src.kind)
    .bind(config_json)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn rewrite_dataset_id(raw: &str, rewrite: &DatasetRewrite<'_>) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("contract:") {
        let mut parts = rest.splitn(3, ':');
        let workspace_id = parts.next().unwrap_or("");
        let chip_id = parts.next().unwrap_or("");
        let extra = parts.next();
        if chip_id.is_empty() {
            return None;
        }
        if let Some(new_chip) = rewrite.id_map.get(chip_id) {
            let mut next = format!("contract:{}:{}", rewrite.target_workspace_id, new_chip);
            if let Some(extra) = extra {
                next.push(':');
                next.push_str(extra);
            }
            return Some(next);
        }
        if rewrite.source_workspace_id == rewrite.target_workspace_id
            && workspace_id == rewrite.source_workspace_id
        {
            return Some(raw.to_string());
        }
        return None;
    }
    if rewrite.source_workspace_id == rewrite.target_workspace_id {
        Some(raw.to_string())
    } else {
        None
    }
}

fn rewrite_json_datasets(value: &mut Value, rewrite: &DatasetRewrite<'_>) {
    match value {
        Value::Object(map) => {
            for key in [
                "input_dataset_id",
                "right_dataset_id",
                "source_data_file_id",
                "target_data_file_id",
            ] {
                if let Some(Value::String(current)) = map.get(key) {
                    let next = rewrite_dataset_id(current, rewrite).unwrap_or_default();
                    map.insert(key.to_string(), json!(next));
                }
            }
            for key in ["union_dataset_ids", "dataset_ids"] {
                if let Some(Value::Array(items)) = map.get_mut(key) {
                    *items = items
                        .iter()
                        .filter_map(|item| {
                            item.as_str()
                                .and_then(|id| rewrite_dataset_id(id, rewrite))
                                .map(Value::String)
                        })
                        .collect();
                }
            }
            for nested in map.values_mut() {
                rewrite_json_datasets(nested, rewrite);
            }
        }
        Value::Array(items) => {
            for nested in items {
                rewrite_json_datasets(nested, rewrite);
            }
        }
        _ => {}
    }
}

pub(crate) fn next_copy_name(base: &str, taken: &HashSet<String>) -> String {
    let (stem, mut index) = split_copy_name(base);
    loop {
        index += 1;
        let candidate = if index == 1 {
            format!("{stem} copy")
        } else {
            format!("{stem} copy {index}")
        };
        if !taken.contains(&candidate.trim().to_lowercase()) {
            return candidate;
        }
    }
}

fn split_copy_name(name: &str) -> (String, u32) {
    let name = name.trim();
    if let Some((stem, number)) = name.rsplit_once(" copy ") {
        if !stem.is_empty() && number.chars().all(|ch| ch.is_ascii_digit()) {
            if let Ok(index) = number.parse::<u32>() {
                if index >= 1 {
                    return (stem.to_string(), index);
                }
            }
        }
    }
    if let Some(stem) = name.strip_suffix(" copy") {
        if !stem.is_empty() {
            return (stem.to_string(), 1);
        }
    }
    (name.to_string(), 0)
}

pub fn next_copy_slug(base: &str, taken: &HashSet<String>) -> String {
    let (stem, mut index) = split_copy_slug(base);
    loop {
        index += 1;
        let candidate = if index == 1 {
            format!("{stem}-copy")
        } else {
            format!("{stem}-copy-{index}")
        };
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
}

fn split_copy_slug(slug: &str) -> (String, u32) {
    let slug = slug.trim();
    if let Some((stem, number)) = slug.rsplit_once("-copy-") {
        if !stem.is_empty() && number.chars().all(|ch| ch.is_ascii_digit()) {
            if let Ok(index) = number.parse::<u32>() {
                if index >= 1 {
                    return (stem.to_string(), index);
                }
            }
        }
    }
    if let Some(stem) = slug.strip_suffix("-copy") {
        if !stem.is_empty() {
            return (stem.to_string(), 1);
        }
    }
    let stem = if slug.is_empty() { "api" } else { slug };
    (stem.to_string(), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_names_follow_finder_suffixes() {
        let mut taken = HashSet::new();
        taken.insert("users".into());
        assert_eq!(next_copy_name("Users", &taken), "Users copy");
        taken.insert("users copy".into());
        assert_eq!(next_copy_name("Users", &taken), "Users copy 2");
        taken.insert("users copy 2".into());
        assert_eq!(next_copy_name("Users copy 2", &taken), "Users copy 3");
    }

    #[test]
    fn copy_slugs_avoid_spaces() {
        let mut taken = HashSet::new();
        taken.insert("orders".into());
        assert_eq!(next_copy_slug("orders", &taken), "orders-copy");
        taken.insert("orders-copy".into());
        assert_eq!(next_copy_slug("orders-copy", &taken), "orders-copy-2");
    }
}
