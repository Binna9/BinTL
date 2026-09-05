use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;
use chrono::{SecondsFormat, Utc};

use crate::{StorageError, Store};

const MAX_RECENT_SEARCHES: i64 = 8;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SearchHit {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub subtitle: String,
    pub preview: String,
    pub route: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
struct SearchDocInput {
    entity_type: &'static str,
    entity_id: String,
    title: String,
    subtitle: String,
    keywords: String,
    route: String,
    scope: &'static str,
    workspace_id: Option<String>,
    owner_user_id: Option<String>,
    updated_at: String,
}

impl Store {
    pub async fn search_documents(
        &self,
        user_id: &str,
        can_see_all: bool,
        query: &str,
        limit: i64,
    ) -> Result<Vec<SearchHit>, StorageError> {
        let needle = query.trim();
        let limit = limit.clamp(1, 50);
        if needle.is_empty() {
            return self.browse_search_documents(user_id, can_see_all, limit.max(24)).await;
        }
        let pattern = like_pattern(needle);
        let can_all = i64::from(can_see_all);
        sqlx::query_as::<_, SearchHit>(
            "SELECT entity_type, entity_id, title, subtitle, route, updated_at,
                    substr(keywords, 1, 140) AS preview
             FROM search_documents
             WHERE (
                 scope = 'global'
                 OR (scope = 'user' AND owner_user_id = ?)
                 OR (
                     scope = 'workspace'
                     AND (
                         ? = 1
                         OR workspace_id IN (
                             SELECT id FROM workspaces WHERE owner_user_id = ?
                         )
                     )
                 )
             )
             AND (
                 lower(title) LIKE ? ESCAPE '\\'
                 OR lower(subtitle) LIKE ? ESCAPE '\\'
                 OR lower(keywords) LIKE ? ESCAPE '\\'
             )
             ORDER BY
                 CASE
                     WHEN lower(title) LIKE ? ESCAPE '\\' THEN 0
                     WHEN lower(title) LIKE ? ESCAPE '\\' THEN 1
                     ELSE 2
                 END,
                 updated_at DESC
             LIMIT ?",
        )
        .bind(user_id)
        .bind(can_all)
        .bind(user_id)
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .bind(format!("{}%", escape_like(needle).to_lowercase()))
        .bind(&pattern)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)
    }

    pub async fn browse_search_documents(
        &self,
        user_id: &str,
        can_see_all: bool,
        limit: i64,
    ) -> Result<Vec<SearchHit>, StorageError> {
        let limit = limit.clamp(1, 60);
        let can_all = i64::from(can_see_all);
        sqlx::query_as::<_, SearchHit>(
            "SELECT entity_type, entity_id, title, subtitle, route, updated_at,
                    substr(keywords, 1, 140) AS preview
             FROM search_documents
             WHERE (
                 scope = 'global'
                 OR (scope = 'user' AND owner_user_id = ?)
                 OR (
                     scope = 'workspace'
                     AND (
                         ? = 1
                         OR workspace_id IN (
                             SELECT id FROM workspaces WHERE owner_user_id = ?
                         )
                     )
                 )
             )
             ORDER BY updated_at DESC
             LIMIT ?",
        )
        .bind(user_id)
        .bind(can_all)
        .bind(user_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)
    }

    pub async fn list_recent_searches(
        &self,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<String>, StorageError> {
        let limit = limit.clamp(1, MAX_RECENT_SEARCHES);
        sqlx::query_scalar::<_, String>(
            "SELECT query
             FROM search_recent_queries
             WHERE user_id = ?
             ORDER BY searched_at DESC
             LIMIT ?",
        )
        .bind(user_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)
    }

    pub async fn record_recent_search(
        &self,
        user_id: &str,
        query: &str,
    ) -> Result<Vec<String>, StorageError> {
        let needle = query.trim();
        if needle.is_empty() {
            return self.list_recent_searches(user_id, MAX_RECENT_SEARCHES).await;
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let id = Uuid::new_v4().to_string();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM search_recent_queries
             WHERE user_id = ? AND lower(query) = lower(?)",
        )
        .bind(user_id)
        .bind(needle)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO search_recent_queries (id, user_id, query, searched_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(needle)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "DELETE FROM search_recent_queries
             WHERE user_id = ?
               AND id NOT IN (
                 SELECT id
                 FROM search_recent_queries
                 WHERE user_id = ?
                 ORDER BY searched_at DESC
                 LIMIT ?
               )",
        )
        .bind(user_id)
        .bind(user_id)
        .bind(MAX_RECENT_SEARCHES)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.list_recent_searches(user_id, MAX_RECENT_SEARCHES).await
    }

    pub async fn delete_search_document(
        &self,
        entity_type: &str,
        entity_id: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("DELETE FROM search_documents WHERE entity_type = ? AND entity_id = ?")
            .bind(entity_type)
            .bind(entity_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn upsert_search_document(&self, doc: SearchDocInput) -> Result<(), StorageError> {
        let id = format!("{}:{}", doc.entity_type, doc.entity_id);
        sqlx::query(
            "INSERT INTO search_documents
             (id, entity_type, entity_id, title, subtitle, keywords, route, scope,
              workspace_id, owner_user_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(entity_type, entity_id) DO UPDATE SET
               title = excluded.title,
               subtitle = excluded.subtitle,
               keywords = excluded.keywords,
               route = excluded.route,
               scope = excluded.scope,
               workspace_id = excluded.workspace_id,
               owner_user_id = excluded.owner_user_id,
               updated_at = excluded.updated_at",
        )
        .bind(&id)
        .bind(doc.entity_type)
        .bind(&doc.entity_id)
        .bind(&doc.title)
        .bind(&doc.subtitle)
        .bind(&doc.keywords)
        .bind(&doc.route)
        .bind(doc.scope)
        .bind(&doc.workspace_id)
        .bind(&doc.owner_user_id)
        .bind(&doc.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn sync_search_workspace_folder(&self, folder_id: &str) -> Result<(), StorageError> {
        let Some(folder) = self.get_folder(folder_id).await? else {
            return self.delete_search_document("workspace_folder", folder_id).await;
        };
        let path = self.folder_path_label(folder_id).await?;
        self.upsert_search_document(SearchDocInput {
            entity_type: "workspace_folder",
            entity_id: folder.id.clone(),
            title: folder.name.clone(),
            subtitle: "작업구분".into(),
            keywords: join_keywords([&folder.name, &path]),
            route: "/workspace".into(),
            scope: "user",
            workspace_id: None,
            owner_user_id: Some(folder.owner_user_id.clone()),
            updated_at: folder.updated_at.clone(),
        })
        .await
    }

    pub async fn sync_search_workspace(&self, workspace_id: &str) -> Result<(), StorageError> {
        let Some(workspace) = self.get_workspace(workspace_id).await? else {
            return self.delete_search_document("workspace", workspace_id).await;
        };
        let folder_hint = match workspace.folder_id.as_deref() {
            Some(folder_id) => self.folder_path_label(folder_id).await.unwrap_or_default(),
            None => String::new(),
        };
        self.upsert_search_document(SearchDocInput {
            entity_type: "workspace",
            entity_id: workspace.id.clone(),
            title: workspace.name.clone(),
            subtitle: if folder_hint.is_empty() {
                "워크스페이스".into()
            } else {
                format!("워크스페이스 · {folder_hint}")
            },
            keywords: join_keywords([
                &workspace.name,
                workspace.description.as_deref().unwrap_or(""),
                &folder_hint,
            ]),
            route: format!("/workspace/{}", workspace.id),
            scope: "workspace",
            workspace_id: Some(workspace.id.clone()),
            owner_user_id: workspace.owner_user_id.clone(),
            updated_at: workspace.updated_at.clone(),
        })
        .await
    }

    pub async fn sync_search_chip(&self, chip_id: &str) -> Result<(), StorageError> {
        let Some(chip) = self.get_chip(chip_id).await? else {
            return self.delete_search_document("chip", chip_id).await;
        };
        let subtitle = match chip.kind.as_str() {
            "extract" => "칩 · 추출",
            "transform" => "칩 · 변환",
            _ => "칩 · 적재",
        };
        let mut keyword_parts = vec![chip.name.as_str(), chip.kind.as_str()];
        let binding_keywords = self.chip_binding_keywords(chip_id).await?;
        keyword_parts.push(binding_keywords.as_str());
        self.upsert_search_document(SearchDocInput {
            entity_type: "chip",
            entity_id: chip.id.clone(),
            title: chip.name.clone(),
            subtitle: subtitle.into(),
            keywords: join_keywords(keyword_parts),
            route: format!("/chips?chip={}", chip.id),
            scope: "user",
            workspace_id: None,
            owner_user_id: Some(chip.owner_user_id.clone()),
            updated_at: chip.updated_at.clone(),
        })
        .await
    }

    pub async fn sync_search_dataset(&self, dataset_id: &str) -> Result<(), StorageError> {
        let Some(dataset) = self.get_dataset(dataset_id).await? else {
            return self.delete_search_document("dataset", dataset_id).await;
        };
        let subtitle = match dataset.kind.as_str() {
            "upload" => "파일 · 업로드",
            "database" => "파일 · DB 추출",
            "api" => "파일 · API",
            "transform" => "파일 · 변환",
            _ => "파일",
        };
        let route = if dataset.kind == "upload" {
            "/files".into()
        } else {
            "/transform/clean".into()
        };
        self.upsert_search_document(SearchDocInput {
            entity_type: "dataset",
            entity_id: dataset.id.clone(),
            title: dataset.filename.clone(),
            subtitle: subtitle.into(),
            keywords: join_keywords([
                &dataset.filename,
                dataset.stored_path.as_str(),
                &dataset.kind,
            ]),
            route,
            scope: "workspace",
            workspace_id: Some(dataset.workspace_id.clone()),
            owner_user_id: None,
            updated_at: dataset.updated_at.clone(),
        })
        .await
    }

    pub async fn sync_search_connection(&self, connection_id: &str) -> Result<(), StorageError> {
        let Some(connection) = self.get_connection(connection_id).await? else {
            return self.delete_search_document("connection", connection_id).await;
        };
        self.upsert_search_document(SearchDocInput {
            entity_type: "connection",
            entity_id: connection.id.clone(),
            title: connection.name.clone(),
            subtitle: format!("커넥션 · {}", connection.driver),
            keywords: join_keywords([
                &connection.name,
                &connection.driver,
                &connection.host,
                &connection.database_name,
                &connection.username,
            ]),
            route: "/connections".into(),
            scope: "global",
            workspace_id: None,
            owner_user_id: None,
            updated_at: connection.created_at.clone(),
        })
        .await
    }

    pub async fn sync_search_extract(&self, extract_id: &str) -> Result<(), StorageError> {
        let Some(extract) = self.get_extract(extract_id).await? else {
            return self.delete_search_document("extract", extract_id).await;
        };
        let title = extract
            .filename
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                let table = extract.table_name.trim();
                if table.is_empty() {
                    None
                } else {
                    Some(table.to_string())
                }
            })
            .unwrap_or_else(|| "extract".into());
        let updated_at = extract
            .finished_at
            .clone()
            .or(extract.started_at.clone())
            .unwrap_or(extract.created_at.clone());
        self.upsert_search_document(SearchDocInput {
            entity_type: "extract",
            entity_id: extract.id.clone(),
            title,
            subtitle: "추출 파일".into(),
            keywords: join_keywords([
                extract.filename.as_deref().unwrap_or(""),
                extract.table_name.as_str(),
                extract.sql_text.as_deref().unwrap_or(""),
                extract.kind.as_str(),
            ]),
            route: "/extracts".into(),
            scope: "workspace",
            workspace_id: Some(extract.workspace_id.clone()),
            owner_user_id: None,
            updated_at,
        })
        .await
    }

    pub async fn sync_search_transform(&self, transform_id: &str) -> Result<(), StorageError> {
        let Some(transform) = self.get_transform(transform_id).await? else {
            return self.delete_search_document("transform", transform_id).await;
        };
        let dataset_name = self
            .get_dataset(&transform.dataset_id)
            .await?
            .map(|row| row.filename)
            .unwrap_or_default();
        self.upsert_search_document(SearchDocInput {
            entity_type: "transform",
            entity_id: transform.id.clone(),
            title: transform.name.clone(),
            subtitle: "변환 정의".into(),
            keywords: join_keywords([&transform.name, &dataset_name]),
            route: format!("/transform/clean/{}", transform.id),
            scope: "workspace",
            workspace_id: Some(transform.workspace_id.clone()),
            owner_user_id: None,
            updated_at: transform.updated_at.clone(),
        })
        .await
    }

    async fn folder_path_label(&self, folder_id: &str) -> Result<String, StorageError> {
        let mut segments = Vec::new();
        let mut cursor = Some(folder_id.to_string());
        while let Some(id) = cursor {
            let Some(folder) = self.get_folder(&id).await? else {
                break;
            };
            segments.push(folder.name.clone());
            cursor = folder.parent_id.clone();
        }
        segments.reverse();
        Ok(segments.join("/"))
    }

    async fn chip_binding_keywords(&self, chip_id: &str) -> Result<String, StorageError> {
        let Some(binding) = self.get_chip_binding(chip_id).await? else {
            return Ok(String::new());
        };
        match binding.ref_kind.as_str() {
            "extract_definition" => {
                let Some(def) = self.get_extract_definition(&binding.ref_id).await? else {
                    return Ok(String::new());
                };
                let conn = self
                    .get_connection(&def.connection_id)
                    .await?
                    .map(|row| row.name)
                    .unwrap_or_default();
                Ok(join_keywords([&def.source_json, &conn]))
            }
            "transform" => {
                let Some(transform) = self.get_transform(&binding.ref_id).await? else {
                    return Ok(String::new());
                };
                Ok(transform.name)
            }
            "load_definition" => {
                let Some(definition) = self.get_load_definition(&binding.ref_id).await? else {
                    return Ok(String::new());
                };
                Ok(join_keywords([&definition.name, &definition.destination_type, &definition.spec_json]))
            }
            _ => Ok(String::new()),
        }
    }
}

fn join_keywords(parts: impl IntoIterator<Item = impl AsRef<str>>) -> String {
    parts
        .into_iter()
        .map(|part| part.as_ref().trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_like(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn like_pattern(raw: &str) -> String {
    format!("%{}%", escape_like(raw).to_lowercase())
}

pub(crate) async fn sync_search_best_effort(_store: &Store, label: &str, sync: impl std::future::Future<Output = Result<(), StorageError>>) {
    if let Err(error) = sync.await {
        tracing::warn!(%error, target = label, "search index sync failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    async fn test_store() -> (Store, String) {
        let root = std::env::temp_dir().join(format!("bintl-search-recent-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-session-secret").await.unwrap();
        let admin = store.ensure_bootstrap("admin", "admin").await.unwrap();
        (store, admin.id)
    }

    #[tokio::test]
    async fn recent_searches_dedupe_and_cap() {
        let (store, user_id) = test_store().await;
        for query in ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"] {
            store.record_recent_search(&user_id, query).await.unwrap();
        }
        let recent = store.list_recent_searches(&user_id, 8).await.unwrap();
        assert_eq!(recent.len(), 8);
        assert!(!recent.iter().any(|item| item == "alpha"));
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        store.record_recent_search(&user_id, "beta").await.unwrap();
        let recent = store.list_recent_searches(&user_id, 8).await.unwrap();
        assert_eq!(recent[0], "beta");
        assert_eq!(recent.iter().filter(|item| **item == "beta").count(), 1);
        store.pool.close().await;
    }
}
