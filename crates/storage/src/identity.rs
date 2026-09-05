use std::collections::HashMap;

use serde::Serialize;
use sqlx::Error as SqlxError;
use uuid::Uuid;

use super::{
    now_rfc3339, required_text, StorageError, Store, WorkspaceRow, DEFAULT_WORKSPACE_ID,
};
use crate::password::{hash_password, verify_password};

pub const PERM_USER_MANAGE: &str = "USER_MANAGE";
pub const PERM_CONNECTION_WRITE: &str = "CONNECTION_WRITE";
pub const PERM_WORKSPACE_ALL: &str = "WORKSPACE_ALL";

const USER_COLS: &str = "id, userid, username, avatar_data_url, active, created_at, updated_at";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RoleRow {
    pub id: String,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PermissionRow {
    pub id: String,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoleWithPermissions {
    pub id: String,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserRow {
    pub id: String,
    pub userid: String,
    pub username: String,
    pub avatar_data_url: Option<String>,
    pub active: i64,
    pub created_at: String,
    pub updated_at: String,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
}

impl UserRow {
    pub fn has_permission(&self, code: &str) -> bool {
        self.permissions.iter().any(|item| item == code)
    }

    pub fn can_manage_users(&self) -> bool {
        self.has_permission(PERM_USER_MANAGE)
    }

    pub fn can_write_connections(&self) -> bool {
        self.has_permission(PERM_CONNECTION_WRITE)
    }

    pub fn can_see_all_workspaces(&self) -> bool {
        self.has_permission(PERM_WORKSPACE_ALL)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct UserCoreRow {
    pub id: String,
    pub userid: String,
    pub username: String,
    pub avatar_data_url: Option<String>,
    pub active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct UserSecretRow {
    pub id: String,
    pub password: String,
    pub active: i64,
}

#[derive(Debug, Clone)]
pub struct DataScope {
    pub user_id: String,
    pub admin: bool,
    pub workspace_id: Option<String>,
}

impl DataScope {
    pub fn for_user(user: &UserRow) -> Self {
        Self {
            user_id: user.id.clone(),
            admin: user.can_see_all_workspaces(),
            workspace_id: None,
        }
    }

    pub fn workspace(mut self, workspace_id: Option<String>) -> Self {
        self.workspace_id = workspace_id.filter(|value| !value.trim().is_empty());
        self
    }
}

impl UserCoreRow {
    fn into_user(self, roles: Vec<String>, permissions: Vec<String>) -> UserRow {
        UserRow {
            id: self.id,
            userid: self.userid,
            username: self.username,
            avatar_data_url: self.avatar_data_url,
            active: self.active,
            created_at: self.created_at,
            updated_at: self.updated_at,
            roles,
            permissions,
        }
    }
}

impl Store {
    pub async fn ensure_bootstrap(
        &self,
        userid: &str,
        password: &str,
    ) -> Result<UserRow, StorageError> {
        if let Some(existing) = self.count_users().await? {
            if existing > 0 {
                if let Some(admin) = self.find_bootstrap_admin().await? {
                    self.claim_unowned_workspaces(&admin.id).await?;
                    return Ok(admin);
                }
                return self
                    .list_users()
                    .await?
                    .into_iter()
                    .next()
                    .ok_or_else(|| {
                        StorageError::Invalid("users exist but none could be loaded".into())
                    });
            }
        }
        self.create_user_inner(userid, userid, password, &["admin".into()], true)
            .await
    }

    pub async fn authenticate(
        &self,
        userid: &str,
        password: &str,
    ) -> Result<Option<UserRow>, StorageError> {
        let row = sqlx::query_as::<_, UserSecretRow>(
            "SELECT id, password, active FROM users WHERE userid = ? COLLATE NOCASE",
        )
        .bind(userid.trim())
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.active == 0 || !verify_password(password, &row.password) {
            return Ok(None);
        }
        self.get_user(&row.id).await
    }

    pub async fn get_user(&self, id: &str) -> Result<Option<UserRow>, StorageError> {
        let row = sqlx::query_as::<_, UserCoreRow>(&format!(
            "SELECT {USER_COLS} FROM users WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(self.hydrate_users(vec![row]).await?.into_iter().next()),
            None => Ok(None),
        }
    }

    pub async fn get_user_by_userid(&self, userid: &str) -> Result<Option<UserRow>, StorageError> {
        let row = sqlx::query_as::<_, UserCoreRow>(&format!(
            "SELECT {USER_COLS} FROM users WHERE userid = ? COLLATE NOCASE"
        ))
        .bind(userid.trim())
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(self.hydrate_users(vec![row]).await?.into_iter().next()),
            None => Ok(None),
        }
    }

    pub async fn list_users(&self) -> Result<Vec<UserRow>, StorageError> {
        let rows = sqlx::query_as::<_, UserCoreRow>(&format!(
            "SELECT {USER_COLS} FROM users ORDER BY created_at ASC"
        ))
        .fetch_all(&self.pool)
        .await?;
        self.hydrate_users(rows).await
    }

    pub async fn list_roles(&self) -> Result<Vec<RoleWithPermissions>, StorageError> {
        let roles = sqlx::query_as::<_, RoleRow>(
            "SELECT id, code, name, description, created_at, updated_at FROM roles ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        let grants = sqlx::query_as::<_, (String, String)>(
            "SELECT rp.role_id, p.code
             FROM role_permissions rp
             JOIN permissions p ON p.id = rp.permission_id
             ORDER BY p.code ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut by_role: HashMap<String, Vec<String>> = HashMap::new();
        for (role_id, code) in grants {
            by_role.entry(role_id).or_default().push(code);
        }
        Ok(roles
            .into_iter()
            .map(|role| RoleWithPermissions {
                permissions: by_role.remove(&role.id).unwrap_or_default(),
                id: role.id,
                code: role.code,
                name: role.name,
                description: role.description,
                created_at: role.created_at,
                updated_at: role.updated_at,
            })
            .collect())
    }

    pub async fn list_permissions(&self) -> Result<Vec<PermissionRow>, StorageError> {
        Ok(sqlx::query_as::<_, PermissionRow>(
            "SELECT id, code, name, description, created_at, updated_at
             FROM permissions ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn create_user(
        &self,
        userid: &str,
        username: &str,
        password: &str,
        roles: &[String],
    ) -> Result<UserRow, StorageError> {
        self.create_user_inner(userid, username, password, roles, false)
            .await
    }

    pub async fn update_user(
        &self,
        id: &str,
        username: Option<&str>,
        password: Option<&str>,
        roles: Option<&[String]>,
        active: Option<bool>,
    ) -> Result<UserRow, StorageError> {
        let current = self
            .get_user(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("user not found".into()))?;
        let username = match username {
            Some(value) => required_text(value, "username")?.to_string(),
            None => current.username.clone(),
        };
        let active = active.map(i64::from).unwrap_or(current.active);
        let next_roles = match roles {
            Some(value) if !value.is_empty() => value.to_vec(),
            Some(_) => {
                return Err(StorageError::Invalid("at least one role is required".into()));
            }
            None => current.roles.clone(),
        };
        let losing_manage = current.can_manage_users()
            && (active == 0 || !self.roles_have_permission(&next_roles, PERM_USER_MANAGE).await?);
        if losing_manage {
            self.guard_last_admin(&current.id).await?;
        }
        let password_hash = match password {
            Some(value) if !value.trim().is_empty() => Some(hash_password(value)?),
            _ => None,
        };
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        if let Some(hash) = password_hash {
            sqlx::query(
                "UPDATE users SET username = ?, active = ?, password = ?, updated_at = ?
                 WHERE id = ?",
            )
            .bind(&username)
            .bind(active)
            .bind(hash)
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("UPDATE users SET username = ?, active = ?, updated_at = ? WHERE id = ?")
                .bind(&username)
                .bind(active)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        replace_user_roles(&mut tx, id, &next_roles, &now).await?;
        tx.commit().await?;
        self.get_user(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("user disappeared after update".into()))
    }

    pub async fn update_user_profile(
        &self,
        id: &str,
        username: &str,
        avatar_data_url: Option<&str>,
    ) -> Result<UserRow, StorageError> {
        let username = required_text(username, "username")?;
        let now = now_rfc3339();
        let result = sqlx::query(
            "UPDATE users SET username = ?, avatar_data_url = ?, updated_at = ? WHERE id = ?",
        )
        .bind(username)
        .bind(avatar_data_url)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("user not found".into()));
        }
        self.get_user(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("user disappeared".into()))
    }

    pub async fn require_workspace_access(
        &self,
        user_id: &str,
        admin: bool,
        workspace_id: &str,
    ) -> Result<WorkspaceRow, StorageError> {
        let workspace = self
            .get_workspace(workspace_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace not found".into()))?;
        if admin {
            return Ok(workspace);
        }
        if workspace.owner_user_id.as_deref() == Some(user_id) {
            return Ok(workspace);
        }
        Err(StorageError::NotFound("workspace not found".into()))
    }

    pub async fn resolve_write_workspace(
        &self,
        scope: &DataScope,
    ) -> Result<String, StorageError> {
        if let Some(workspace_id) = scope.workspace_id.as_deref() {
            self.require_workspace_access(&scope.user_id, scope.admin, workspace_id)
                .await?;
            return Ok(workspace_id.to_string());
        }
        let owned = self.list_visible_workspaces(Some(scope)).await?;
        let Some(workspace) = owned.first() else {
            return Err(StorageError::Invalid(
                "workspace required: create a workspace first".into(),
            ));
        };
        Ok(workspace.id.clone())
    }

    pub fn workspace_scope_sql(scope: &DataScope, column: &str) -> (String, Vec<String>) {
        if let Some(workspace_id) = &scope.workspace_id {
            (format!("AND {column} = ?"), vec![workspace_id.clone()])
        } else if scope.admin {
            (String::new(), Vec::new())
        } else {
            (
                format!("AND {column} IN (SELECT id FROM workspaces WHERE owner_user_id = ?)"),
                vec![scope.user_id.clone()],
            )
        }
    }

    async fn create_user_inner(
        &self,
        userid: &str,
        username: &str,
        password: &str,
        roles: &[String],
        bootstrap: bool,
    ) -> Result<UserRow, StorageError> {
        let userid = normalize_userid(userid)?;
        let username = required_text(username, "username")?;
        let role_codes = if roles.is_empty() {
            vec!["analyst".to_string()]
        } else {
            roles.to_vec()
        };
        let password_hash = hash_password(password)?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let insert = sqlx::query(
            "INSERT INTO users
             (id, userid, username, password, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(userid)
        .bind(username)
        .bind(&password_hash)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await;
        if let Err(error) = insert {
            return Err(map_user_sql(error));
        }
        replace_user_roles(&mut tx, &id, &role_codes, &now).await?;

        if bootstrap {
            let default_exists = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM workspaces WHERE id = ?",
            )
            .bind(DEFAULT_WORKSPACE_ID)
            .fetch_one(&mut *tx)
            .await?
                > 0;
            if default_exists {
                sqlx::query(
                    "UPDATE workspaces SET owner_user_id = ?, updated_at = ? WHERE id = ?",
                )
                .bind(&id)
                .bind(&now)
                .bind(DEFAULT_WORKSPACE_ID)
                .execute(&mut *tx)
                .await?;
            } else {
                insert_owned_workspace(&mut tx, &id, username, &now).await?;
            }
            sqlx::query(
                "UPDATE workspaces SET owner_user_id = ?
                 WHERE owner_user_id IS NULL",
            )
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        } else {
            insert_owned_workspace(&mut tx, &id, username, &now).await?;
        }
        tx.commit().await?;
        self.get_user(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("user disappeared after insert".into()))
    }

    async fn hydrate_users(&self, rows: Vec<UserCoreRow>) -> Result<Vec<UserRow>, StorageError> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let role_sql = format!(
            "SELECT ur.user_id, r.code
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id IN ({placeholders})
             ORDER BY r.code ASC"
        );
        let perm_sql = format!(
            "SELECT DISTINCT ur.user_id, p.code
             FROM user_roles ur
             JOIN role_permissions rp ON rp.role_id = ur.role_id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE ur.user_id IN ({placeholders})
             ORDER BY p.code ASC"
        );
        let mut role_query = sqlx::query_as::<_, (String, String)>(&role_sql);
        let mut perm_query = sqlx::query_as::<_, (String, String)>(&perm_sql);
        for id in &ids {
            role_query = role_query.bind(id);
            perm_query = perm_query.bind(id);
        }
        let role_rows = role_query.fetch_all(&self.pool).await?;
        let perm_rows = perm_query.fetch_all(&self.pool).await?;
        let mut roles: HashMap<String, Vec<String>> = HashMap::new();
        for (user_id, code) in role_rows {
            roles.entry(user_id).or_default().push(code);
        }
        let mut permissions: HashMap<String, Vec<String>> = HashMap::new();
        for (user_id, code) in perm_rows {
            permissions.entry(user_id).or_default().push(code);
        }
        Ok(rows
            .into_iter()
            .map(|row| {
                let id = row.id.clone();
                row.into_user(
                    roles.remove(&id).unwrap_or_default(),
                    permissions.remove(&id).unwrap_or_default(),
                )
            })
            .collect())
    }

    async fn count_users(&self) -> Result<Option<i64>, StorageError> {
        Ok(Some(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
                .fetch_one(&self.pool)
                .await?,
        ))
    }

    async fn find_bootstrap_admin(&self) -> Result<Option<UserRow>, StorageError> {
        let id = sqlx::query_scalar::<_, String>(
            "SELECT u.id FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
             JOIN role_permissions rp ON rp.role_id = ur.role_id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE u.active = 1 AND p.code = ?
             ORDER BY u.created_at ASC LIMIT 1",
        )
        .bind(PERM_USER_MANAGE)
        .fetch_optional(&self.pool)
        .await?;
        match id {
            Some(id) => self.get_user(&id).await,
            None => Ok(None),
        }
    }

    async fn claim_unowned_workspaces(&self, owner_id: &str) -> Result<(), StorageError> {
        sqlx::query("UPDATE workspaces SET owner_user_id = ? WHERE owner_user_id IS NULL")
            .bind(owner_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn roles_have_permission(
        &self,
        roles: &[String],
        code: &str,
    ) -> Result<bool, StorageError> {
        if roles.is_empty() {
            return Ok(false);
        }
        let placeholders = roles.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT COUNT(*) FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE r.code IN ({placeholders}) AND p.code = ?"
        );
        let mut query = sqlx::query_scalar::<_, i64>(&sql);
        for role in roles {
            query = query.bind(role);
        }
        query = query.bind(code);
        Ok(query.fetch_one(&self.pool).await? > 0)
    }

    async fn guard_last_admin(&self, user_id: &str) -> Result<(), StorageError> {
        let others = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(DISTINCT u.id) FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
             JOIN role_permissions rp ON rp.role_id = ur.role_id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE u.active = 1 AND u.id != ? AND p.code = ?",
        )
        .bind(user_id)
        .bind(PERM_USER_MANAGE)
        .fetch_one(&self.pool)
        .await?;
        if others == 0 {
            return Err(StorageError::Invalid("cannot remove the last admin".into()));
        }
        Ok(())
    }
}

async fn replace_user_roles(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
    role_codes: &[String],
    now: &str,
) -> Result<(), StorageError> {
    if role_codes.is_empty() {
        return Err(StorageError::Invalid("at least one role is required".into()));
    }
    let mut role_ids = Vec::with_capacity(role_codes.len());
    for code in role_codes {
        let id = sqlx::query_scalar::<_, String>("SELECT id FROM roles WHERE code = ? COLLATE NOCASE")
            .bind(code.trim())
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| StorageError::Invalid(format!("unknown role '{code}'")))?;
        role_ids.push(id);
    }
    sqlx::query("DELETE FROM user_roles WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    for role_id in role_ids {
        sqlx::query("INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)")
            .bind(user_id)
            .bind(&role_id)
            .bind(now)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn insert_owned_workspace(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner_id: &str,
    name: &str,
    now: &str,
) -> Result<String, StorageError> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO workspaces
         (id, name, description, layout_json, version, created_at, updated_at, owner_user_id)
         VALUES (?, ?, NULL, '{}', 1, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(now)
    .bind(now)
    .bind(owner_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
         VALUES (?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(crate::empty_workspace_snapshot())
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

fn normalize_userid(value: &str) -> Result<&str, StorageError> {
    let value = required_text(value, "userid")?;
    if value.len() < 2 || value.len() > 64 {
        return Err(StorageError::Invalid("userid must be 2-64 characters".into()));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
    {
        return Err(StorageError::Invalid(
            "userid may contain letters, numbers, '.', '_' and '-'".into(),
        ));
    }
    Ok(value)
}

fn map_user_sql(error: SqlxError) -> StorageError {
    if let SqlxError::Database(db) = &error {
        if db.is_unique_violation() {
            return StorageError::Conflict("userid already exists".into());
        }
    }
    error.into()
}
