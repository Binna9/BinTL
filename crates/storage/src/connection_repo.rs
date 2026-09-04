use crate::models::*;
use crate::*;

impl Store {
    pub async fn insert_connection(
        &self,
        new: NewConnection,
    ) -> Result<ConnectionRow, StorageError> {
        let driver = new.driver.to_ascii_lowercase();
        if !supported_driver(&driver) {
            return Err(StorageError::Invalid(
                "driver must be postgres, redshift, cockroach, mysql, mariadb, mssql, sqlite, or http"
                    .into(),
            ));
        }
        if new.name.trim().is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if driver == "sqlite" {
            if new.database.trim().is_empty() && new.host.trim().is_empty() {
                return Err(StorageError::Invalid(
                    "sqlite needs a file path in database".into(),
                ));
            }
        } else if driver == "http" {
            if new.host.trim().is_empty() {
                return Err(StorageError::Invalid(
                    "http base URL required in host".into(),
                ));
            }
        } else if new.host.trim().is_empty() || new.database.trim().is_empty() {
            return Err(StorageError::Invalid("host and database required".into()));
        }
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let cipher = secret::encrypt(&self.secret_key, &new.password)?;
        sqlx::query(
            "INSERT INTO connections
             (id, name, driver, host, port, database_name, username, password_cipher, ssl, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(new.name.trim())
        .bind(&driver)
        .bind(new.host.trim())
        .bind(new.port as i64)
        .bind(new.database.trim())
        .bind(new.username.trim())
        .bind(&cipher)
        .bind(i64::from(new.ssl))
        .bind(&created_at)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "connection", self.sync_search_connection(&id)).await;
        self.get_connection(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection disappeared after insert".into()))
    }

    pub async fn update_connection(
        &self,
        id: &str,
        new: NewConnection,
    ) -> Result<ConnectionRow, StorageError> {
        if self.get_connection(id).await?.is_none() {
            return Err(StorageError::NotFound("connection not found".into()));
        }
        let driver = new.driver.to_ascii_lowercase();
        if !supported_driver(&driver) {
            return Err(StorageError::Invalid(
                "driver must be postgres, redshift, cockroach, mysql, mariadb, mssql, sqlite, or http"
                    .into(),
            ));
        }
        if new.name.trim().is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if driver == "sqlite" {
            if new.database.trim().is_empty() && new.host.trim().is_empty() {
                return Err(StorageError::Invalid(
                    "sqlite needs a file path in database".into(),
                ));
            }
        } else if driver == "http" {
            if new.host.trim().is_empty() {
                return Err(StorageError::Invalid(
                    "http base URL required in host".into(),
                ));
            }
        } else if new.host.trim().is_empty() || new.database.trim().is_empty() {
            return Err(StorageError::Invalid("host and database required".into()));
        }

        if new.password.is_empty() {
            sqlx::query(
                "UPDATE connections
                 SET name = ?, driver = ?, host = ?, port = ?, database_name = ?, username = ?, ssl = ?
                 WHERE id = ?",
            )
            .bind(new.name.trim())
            .bind(&driver)
            .bind(new.host.trim())
            .bind(new.port as i64)
            .bind(new.database.trim())
            .bind(new.username.trim())
            .bind(i64::from(new.ssl))
            .bind(id)
            .execute(&self.pool)
            .await?;
        } else {
            let cipher = secret::encrypt(&self.secret_key, &new.password)?;
            sqlx::query(
                "UPDATE connections
                 SET name = ?, driver = ?, host = ?, port = ?, database_name = ?, username = ?, password_cipher = ?, ssl = ?
                 WHERE id = ?",
            )
            .bind(new.name.trim())
            .bind(&driver)
            .bind(new.host.trim())
            .bind(new.port as i64)
            .bind(new.database.trim())
            .bind(new.username.trim())
            .bind(&cipher)
            .bind(i64::from(new.ssl))
            .bind(id)
            .execute(&self.pool)
            .await?;
        }

        search::sync_search_best_effort(self, "connection", self.sync_search_connection(id)).await;
        self.get_connection(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection disappeared after update".into()))
    }

    pub async fn get_connection(&self, id: &str) -> Result<Option<ConnectionRow>, StorageError> {
        let row = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, driver, host, port, database_name, username, ssl, created_at
             FROM connections WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_connections(&self) -> Result<Vec<ConnectionRow>, StorageError> {
        let rows = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, driver, host, port, database_name, username, ssl, created_at
             FROM connections ORDER BY created_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn delete_connection(&self, id: &str) -> Result<(), StorageError> {
        delete_guard::ensure_connection_deletable(&self.pool, id).await?;
        let res = sqlx::query("DELETE FROM connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound("connection not found".into()));
        }
        let _ = self.delete_search_document("connection", id).await;
        Ok(())
    }
}
