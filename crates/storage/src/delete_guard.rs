use sqlx::SqlitePool;

use crate::StorageError;

#[derive(Debug, Clone, Default)]
pub struct NamedRef {
    #[allow(dead_code)]
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default)]
pub struct DatasetDeleteUsage {
    pub transform_recipes: Vec<NamedRef>,
    pub chips: Vec<NamedRef>,
}

impl DatasetDeleteUsage {
    pub fn is_blocked(&self) -> bool {
        !self.transform_recipes.is_empty() || !self.chips.is_empty()
    }

    pub fn chip_block_message(&self) -> String {
        let names = self
            .chips
            .iter()
            .map(|item| format!("\"{}\"", item.name))
            .collect::<Vec<_>>()
            .join(", ");
        format!("Cannot delete: registered workspace chip(s): {names}. Remove the chip first.")
    }

    pub fn conflict_message(&self) -> String {
        if !self.chips.is_empty() {
            return self.chip_block_message();
        }
        let names = self
            .transform_recipes
            .iter()
            .map(|item| format!("\"{}\"", item.name))
            .collect::<Vec<_>>()
            .join(", ");
        format!("Cannot delete dataset: still used by transform definition(s): {names}.")
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConnectionDeleteUsage {
    pub extract_recipes: Vec<NamedRef>,
    pub chips: Vec<NamedRef>,
    pub extract_count: i64,
}

impl ConnectionDeleteUsage {
    pub fn is_blocked(&self) -> bool {
        !self.extract_recipes.is_empty() || !self.chips.is_empty() || self.extract_count > 0
    }

    pub fn conflict_message(&self) -> String {
        let mut parts = Vec::new();
        if !self.extract_recipes.is_empty() {
            let names = self
                .extract_recipes
                .iter()
                .map(|item| format!("\"{}\"", item.name))
                .collect::<Vec<_>>()
                .join(", ");
            parts.push(format!("extract definitions: {names}"));
        }
        if !self.chips.is_empty() {
            let names = self
                .chips
                .iter()
                .map(|item| format!("\"{}\"", item.name))
                .collect::<Vec<_>>()
                .join(", ");
            parts.push(format!("chips: {names}"));
        }
        if self.extract_count > 0 {
            parts.push(format!("extract runs: {} record(s)", self.extract_count));
        }
        format!(
            "Cannot delete connection: still used by {}. Remove them first.",
            parts.join("; ")
        )
    }
}

pub fn map_delete_sql(error: sqlx::Error) -> StorageError {
    if let sqlx::Error::Database(db) = &error {
        if db.code().as_deref() == Some("787") {
            return StorageError::Conflict(
                "Cannot delete: still referenced by other records.".into(),
            );
        }
    }
    StorageError::from(error)
}

async fn fetch_named_refs(
    pool: &SqlitePool,
    sql: &str,
    ids: &[String],
) -> Result<Vec<NamedRef>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut query = sqlx::query_as::<_, (String, String)>(sql);
    for id in ids {
        query = query.bind(id);
    }
    Ok(query
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(id, name)| NamedRef { id, name })
        .collect())
}

pub async fn dataset_delete_usage(
    pool: &SqlitePool,
    dataset_ids: &[String],
) -> Result<DatasetDeleteUsage, StorageError> {
    if dataset_ids.is_empty() {
        return Ok(DatasetDeleteUsage::default());
    }
    let placeholders = placeholders(dataset_ids.len());
    let transform_sql = format!(
        "SELECT id, name FROM transforms WHERE default_input_file_id IN ({placeholders}) ORDER BY name"
    );
    let transform_recipes = fetch_named_refs(pool, &transform_sql, dataset_ids).await?;

    let chip_sql = format!(
        "SELECT DISTINCT c.id, c.name
         FROM chips c
         INNER JOIN transforms t ON t.id = c.transform_id
         WHERE t.default_input_file_id IN ({placeholders})
         ORDER BY c.name"
    );
    let chips = fetch_named_refs(pool, &chip_sql, dataset_ids).await?;

    let slot_sql = format!(
        "SELECT DISTINCT c.id, c.name
         FROM chips c
         INNER JOIN workspace_chips wc ON wc.chip_id = c.id
         INNER JOIN workspace_chip_outputs s ON s.workspace_chip_id = wc.id
         WHERE s.current_data_file_id IN ({placeholders})
         ORDER BY c.name"
    );
    let slot_chips = fetch_named_refs(pool, &slot_sql, dataset_ids).await?;
    let mut chips = chips;
    for chip in slot_chips {
        if !chips.iter().any(|item| item.id == chip.id) {
            chips.push(chip);
        }
    }
    chips.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(DatasetDeleteUsage {
        transform_recipes,
        chips,
    })
}

pub async fn ensure_datasets_deletable(
    pool: &SqlitePool,
    dataset_ids: &[String],
) -> Result<(), StorageError> {
    let usage = dataset_delete_usage(pool, dataset_ids).await?;
    if usage.is_blocked() {
        return Err(StorageError::Conflict(usage.conflict_message()));
    }
    Ok(())
}

pub async fn ensure_datasets_deletable_by_chips(
    pool: &SqlitePool,
    dataset_ids: &[String],
) -> Result<(), StorageError> {
    let usage = dataset_delete_usage(pool, dataset_ids).await?;
    if !usage.chips.is_empty() {
        return Err(StorageError::Conflict(usage.chip_block_message()));
    }
    Ok(())
}

pub async fn delete_transforms_for_datasets(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    dataset_ids: &[String],
) -> Result<Vec<String>, StorageError> {
    if dataset_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = placeholders(dataset_ids.len());
    let select_sql =
        format!("SELECT id FROM transforms WHERE default_input_file_id IN ({placeholders})");
    let mut select = sqlx::query_scalar::<_, String>(&select_sql);
    for id in dataset_ids {
        select = select.bind(id);
    }
    let transform_ids = select.fetch_all(&mut **tx).await?;

    let delete_sql =
        format!("DELETE FROM transforms WHERE default_input_file_id IN ({placeholders})");
    let mut delete = sqlx::query(&delete_sql);
    for id in dataset_ids {
        delete = delete.bind(id);
    }
    delete.execute(&mut **tx).await?;
    Ok(transform_ids)
}

pub async fn connection_delete_usage(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<ConnectionDeleteUsage, StorageError> {
    let extract_recipes = sqlx::query_as::<_, (String, String)>(
        "SELECT id, name FROM extracts WHERE connection_id = ? ORDER BY name",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, name)| NamedRef { id, name })
    .collect::<Vec<_>>();

    let chips = sqlx::query_as::<_, (String, String)>(
        "SELECT DISTINCT c.id, c.name
         FROM chips c
         INNER JOIN extracts e ON e.id = c.extract_id
         WHERE e.connection_id = ?
         ORDER BY c.name",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, name)| NamedRef { id, name })
    .collect();

    let extract_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM execution_steps s INNER JOIN extracts e ON e.id=s.extract_id WHERE e.connection_id = ?")
            .bind(connection_id)
            .fetch_one(pool)
            .await?;

    Ok(ConnectionDeleteUsage {
        extract_recipes,
        chips,
        extract_count,
    })
}

pub async fn ensure_connection_deletable(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<(), StorageError> {
    let usage = connection_delete_usage(pool, connection_id).await?;
    if usage.is_blocked() {
        return Err(StorageError::Conflict(usage.conflict_message()));
    }
    Ok(())
}

pub async fn transform_delete_usage(
    pool: &SqlitePool,
    transform_id: &str,
) -> Result<Vec<NamedRef>, StorageError> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT c.id, c.name
         FROM chips c
         WHERE c.transform_id = ?
         ORDER BY c.name",
    )
    .bind(transform_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, name)| NamedRef { id, name })
    .collect())
}

pub async fn ensure_transform_deletable(
    pool: &SqlitePool,
    transform_id: &str,
) -> Result<(), StorageError> {
    let chips = transform_delete_usage(pool, transform_id).await?;
    if chips.is_empty() {
        return Ok(());
    }
    let names = chips
        .iter()
        .map(|item| format!("\"{}\"", item.name))
        .collect::<Vec<_>>()
        .join(", ");
    Err(StorageError::Conflict(format!(
        "Cannot delete transform recipe: still registered as workspace chip(s): {names}. Remove the chip first."
    )))
}

fn placeholders(count: usize) -> String {
    if count == 0 {
        return "NULL".into();
    }
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use crate::Store;
    use uuid::Uuid;

    #[tokio::test]
    async fn delete_upload_cascades_linked_transforms() {
        let root = std::env::temp_dir().join(format!("bintl-delete-guard-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-session-secret").await.unwrap();
        let admin = store.ensure_bootstrap("admin", "admin").await.unwrap();
        let workspace = store
            .list_visible_workspaces(Some(&crate::DataScope::for_user(&admin)))
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .id;
        let upload = store
            .save_upload(
                "sales.csv",
                b"name,amount\na,1\n",
                Some(","),
                Some(true),
                &workspace,
            )
            .await
            .unwrap();
        store
            .insert_transform(
                "Sales clean",
                &upload.id,
                r#"{"version":2,"steps":[],"sink":"parquet"}"#,
                None,
            )
            .await
            .unwrap();

        store.delete_upload(&upload.id).await.unwrap();
        assert!(store.get_dataset(&upload.id).await.unwrap().is_none());
        assert!(store.list_transforms(None).await.unwrap().is_empty());

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
