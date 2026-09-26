use super::*;
use crate::config::Config;
use std::sync::Arc;
use storage::{NewConnection, WorkspaceSaveEdge};
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

struct Fixture {
    state: AppState,
    user: CurrentUser,
    workspace: String,
    connection: String,
}

impl Fixture {
    async fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("bintl-workspace-plan-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&root, "test-secret").await.unwrap();
        let user = CurrentUser(store.ensure_bootstrap().await.unwrap());
        let workspace = store
            .insert_workspace("Execution test", None, user.id(), None)
            .await
            .unwrap()
            .id;
        let connection = store
            .insert_connection(NewConnection {
                http_auth: None,
                name: "Source".into(),
                driver: "sqlite".into(),
                host: String::new(),
                port: 0,
                database: ":memory:".into(),
                username: String::new(),
                password: String::new(),
                ssl: false,
            })
            .await
            .unwrap()
            .id;
        let config = Arc::new(Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            data_dir: root,
            max_upload_mb: 1,
            max_concurrent_jobs: 1,
            session_secret: "test-secret".into(),
            encryption_secret: "test-secret".into(),
            skip_auth: false,
            ui_dir: None,
        });
        Self {
            state: AppState {
                store,
                dispatch: Arc::new(Notify::new()),
                config,
            },
            user,
            workspace,
            connection,
        }
    }

    fn extract_config(&self, sql: &str) -> Value {
        json!({"connection_id": self.connection, "source": {"type": "query", "sql": sql}})
    }

    async fn chip(&self, name: &str, kind: &str, config: Value) -> ChipRow {
        let chip = self
            .state
            .store
            .insert_chip(
                self.user.id(),
                &self.workspace,
                name,
                kind,
                &config.to_string(),
            )
            .await
            .unwrap();
        self.state
            .store
            .attach_chip_to_workspace(&self.workspace, &chip.id)
            .await
            .unwrap();
        chip
    }

    async fn extract(&self, name: &str, sql: &str) -> ChipRow {
        self.chip(name, "extract", self.extract_config(sql)).await
    }

    async fn transform(&self, name: &str) -> ChipRow {
        let spec = json!({"version": 2, "steps": [], "sink": "parquet"});
        let chip = self.chip(name, "transform", json!({"spec": spec})).await;
        self.state
            .store
            .insert_transform(name, "", &spec.to_string(), Some(&chip.id))
            .await
            .unwrap();
        self.state.store.get_chip(&chip.id).await.unwrap().unwrap()
    }

    async fn connect(&self, edges: Vec<WorkspaceSaveEdge>) {
        let chips = self.state.store.list_chips(&self.workspace).await.unwrap();
        self.state
            .store
            .save_workspace(
                &self.workspace,
                r#"{"nodes":{}}"#,
                &chips.iter().map(|chip| chip.id.clone()).collect::<Vec<_>>(),
                &edges,
                None,
            )
            .await
            .unwrap();
    }

    fn worker(&self) -> JoinHandle<()> {
        let store = self.state.store.clone();
        let dispatch = self.state.dispatch.clone();
        let permits = Arc::new(Semaphore::new(1));
        tokio::spawn(crate::dispatch::run_loop(store, dispatch, permits))
    }

    async fn run(&self) -> Result<Vec<String>, AppError> {
        tokio::time::timeout(
            Duration::from_secs(30),
            run_workspace_internal(&self.state, &self.user, &self.workspace),
        )
        .await
        .expect("workspace must terminate")
    }

    async fn runs(&self) -> HashMap<String, ChipRunRow> {
        let execution = self
            .state
            .store
            .list_workspace_executions(&self.workspace)
            .await
            .unwrap()[0]
            .id
            .clone();
        self.state
            .store
            .list_chip_runs(&self.workspace)
            .await
            .unwrap()
            .into_iter()
            .filter(|run| run.execution_id == execution)
            .map(|run| (run.chip_id.clone(), run))
            .collect()
    }

    async fn close(self, worker: Option<JoinHandle<()>>) {
        if let Some(worker) = worker {
            worker.abort();
            let _ = worker.await;
        }
        self.state.store.pool.close().await;
        std::fs::remove_dir_all(&self.state.config.data_dir).unwrap();
    }

    async fn sqlite_file(&self, name: &str) -> String {
        let path = self.state.config.data_dir.join(format!("{name}.sqlite"));
        std::fs::File::create(&path).unwrap();
        self.state
            .store
            .insert_connection(NewConnection {
                http_auth: None,
                name: name.into(),
                driver: "sqlite".into(),
                host: String::new(),
                port: 0,
                database: path.to_string_lossy().into(),
                username: String::new(),
                password: String::new(),
                ssl: false,
            })
            .await
            .unwrap()
            .id
    }

    async fn load_db(
        &self,
        name: &str,
        connection_id: &str,
        table: &str,
        write_mode: &str,
    ) -> ChipRow {
        let chip = self.chip(name, "load", json!({})).await;
        let spec = json!({
            "destination": {
                "type": "database",
                "connection_id": connection_id,
                "table": table
            },
            "write_mode": write_mode
        });
        let load = self
            .state
            .store
            .insert_load_definition(self.user.id(), name, "database", &spec.to_string())
            .await
            .unwrap();
        self.state
            .store
            .bind_chip_to_load(&chip.id, &load.id)
            .await
            .unwrap();
        self.state.store.get_chip(&chip.id).await.unwrap().unwrap()
    }

    async fn exec_sql(&self, connection_id: &str, sql: &str) {
        let live = self
            .state
            .store
            .live_connection(connection_id)
            .await
            .unwrap();
        connectors::run_sql(&live, sql, 1000, None, None)
            .await
            .unwrap();
    }
}

fn edge(from: &ChipRow, to: &ChipRow, kind: &str, port: &str) -> WorkspaceSaveEdge {
    WorkspaceSaveEdge {
        id: uuid::Uuid::new_v4().to_string(),
        from_chip_id: from.id.clone(),
        to_chip_id: to.id.clone(),
        kind: kind.into(),
        from_port: "out".into(),
        to_port: port.into(),
    }
}

#[tokio::test]
async fn preflight_fails_invalid_chips_but_runs_valid_ones() {
    let f = Fixture::new().await;
    let good = f.extract("Good", "SELECT 1 AS id").await;
    let bad = f
        .chip(
            "Missing extract",
            "extract",
            json!({"connection_id": "", "source": {"type": "table", "table": ""}}),
        )
        .await;
    let missing = f.transform("Missing input").await;
    let worker = f.worker();
    let error = f.run().await.unwrap_err();
    assert!(error.message().contains("Missing extract"));
    assert!(error.message().contains("Missing input"));
    let runs = f.runs().await;
    assert_eq!(runs[&good.id].status, "succeeded");
    assert!(runs[&good.id].output_dataset_id.is_some());
    assert_eq!(
        runs[&bad.id].error_code.as_deref(),
        Some("WORKSPACE_PREFLIGHT_FAILED")
    );
    assert_eq!(runs[&missing.id].status, "failed");
    assert!(runs[&missing.id].started_at.is_none());
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn extract_runs_when_downstream_recipes_are_missing() {
    let f = Fixture::new().await;
    let extract = f.extract("추출-01", "SELECT 1 AS id").await;
    let transform = f
        .chip(
            "변환-01",
            "transform",
            json!({"spec": {"version": 2, "steps": [], "sink": "parquet"}}),
        )
        .await;
    let load = f.chip("적재-01", "load", json!({})).await;
    f.connect(vec![
        edge(&extract, &transform, "data", "in"),
        edge(&transform, &load, "data", "in"),
    ])
    .await;
    let worker = f.worker();
    let error = f.run().await.unwrap_err();
    assert!(error.message().contains("변환-01"));
    assert!(error.message().contains("적재-01"));
    let runs = f.runs().await;
    assert_eq!(runs[&extract.id].status, "succeeded");
    assert!(runs[&extract.id].output_dataset_id.is_some());
    assert_eq!(
        runs[&transform.id].error_code.as_deref(),
        Some("WORKSPACE_PREFLIGHT_FAILED")
    );
    assert_eq!(
        runs[&load.id].error_code.as_deref(),
        Some("WORKSPACE_PREFLIGHT_FAILED")
    );
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn connected_chain_and_independent_chip_use_current_outputs() {
    let f = Fixture::new().await;
    let a = f.extract("Extract", "SELECT 1 AS id").await;
    let b = f.transform("Transform").await;
    let c = f.chip("Load", "load", json!({})).await;
    let load = f.state.store.insert_load_definition(f.user.id(), "File load", "file",
        &json!({"destination": {"type": "file", "format": "csv", "filename": "test.csv"}, "write_mode": "replace"}).to_string()).await.unwrap();
    f.state
        .store
        .bind_chip_to_load(&c.id, &load.id)
        .await
        .unwrap();
    let d = f.extract("Independent", "SELECT 2 AS id").await;
    f.connect(vec![edge(&a, &b, "data", "in"), edge(&b, &c, "data", "in")])
        .await;
    let worker = f.worker();
    f.run().await.unwrap();
    let runs = f.runs().await;
    assert_eq!(runs.len(), 4);
    assert!(runs.values().all(|run| run.status == "succeeded"));
    assert_eq!(runs[&b.id].input_dataset_id, runs[&a.id].output_dataset_id);
    assert_eq!(runs[&c.id].input_dataset_id, runs[&b.id].output_dataset_id);
    assert!(runs[&d.id].output_dataset_id.is_some());
    assert!(runs[&b.id].started_at >= runs[&a.id].finished_at);
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn failure_skips_data_descendants_but_runs_error_and_independent_branches() {
    let f = Fixture::new().await;
    let a = f.extract("Failing", "SELECT * FROM missing_table").await;
    let b = f.transform("Blocked transform").await;
    let c = f.transform("Blocked descendant").await;
    let d = f.extract("Independent", "SELECT 1 AS id").await;
    let error = f.extract("Error handler", "SELECT 1 AS id").await;
    let success = f.extract("Success handler", "SELECT 1 AS id").await;
    let always = f.extract("Always", "SELECT 1 AS id").await;
    f.connect(vec![
        edge(&a, &b, "data", "in"),
        edge(&b, &c, "data", "in"),
        edge(&a, &error, "on_error", "in"),
        edge(&a, &success, "on_success", "in"),
        edge(&success, &always, "always", "in"),
    ])
    .await;
    let worker = f.worker();
    assert!(f.run().await.is_err());
    let runs = f.runs().await;
    assert_eq!(runs[&a.id].status, "failed");
    for chip in [&b, &c, &success] {
        assert_eq!(chip_run_json(&runs[&chip.id]).unwrap()["status"], "skipped");
        assert!(runs[&chip.id].started_at.is_none());
        assert!(!f
            .state
            .store
            .list_logs(&runs[&chip.id].id)
            .await
            .unwrap()
            .is_empty());
    }
    for chip in [&d, &error, &always] {
        assert_eq!(runs[&chip.id].status, "succeeded");
    }
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn validation_binds_both_current_outputs_and_never_falls_back_after_failure() {
    let f = Fixture::new().await;
    let a = f.extract("Source", "SELECT 1 AS id").await;
    let b = f.extract("Target", "SELECT 1 AS id").await;
    let v = f
        .chip(
            "Compare",
            "validation",
            json!({"source_data_file_id": "", "keys": ["id"]}),
        )
        .await;
    // Reversed edge order must still bind the explicit source and target ports.
    f.connect(vec![
        edge(&b, &v, "data", "target"),
        edge(&a, &v, "data", "source"),
    ])
    .await;
    let worker = f.worker();
    f.run().await.unwrap();
    let first = f.runs().await;
    assert_eq!(
        first[&v.id].input_dataset_id,
        first[&b.id].output_dataset_id
    );
    let snapshot: Value = serde_json::from_str(&first[&v.id].config_snapshot_json).unwrap();
    assert_eq!(
        snapshot["source_data_file_id"].as_str(),
        first[&a.id].output_dataset_id.as_deref()
    );
    f.state
        .store
        .update_chip(
            &a.id,
            None,
            None,
            Some(&f.extract_config("SELECT * FROM missing_table").to_string()),
            None,
        )
        .await
        .unwrap();
    assert!(f.run().await.is_err());
    let second = f.runs().await;
    assert_eq!(chip_run_json(&second[&v.id]).unwrap()["status"], "skipped");
    assert!(second[&v.id].input_dataset_id.is_none());
    assert!(second[&v.id].started_at.is_none());
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn recipes_are_frozen_before_first_dispatch() {
    let f = Fixture::new().await;
    let a = f.extract("A", "SELECT 1 AS id").await;
    let b = f.extract("B", "SELECT 1 AS id").await;
    let worker = f.worker();
    let changed = f.extract_config("SELECT * FROM missing_table").to_string();
    let ids = [a.id.clone(), b.id.clone()];
    let running = tokio::spawn({
        let state = f.state.clone();
        let user = f.user.clone();
        let workspace = f.workspace.clone();
        async move { run_workspace_internal(&state, &user, &workspace).await }
    });
    loop {
        tokio::time::sleep(Duration::from_millis(10)).await;
        if f.state
            .store
            .list_chip_runs(&f.workspace)
            .await
            .unwrap()
            .len()
            >= 2
        {
            break;
        }
    }
    for chip_id in &ids {
        f.state
            .store
            .update_chip(chip_id, None, None, Some(&changed), None)
            .await
            .unwrap();
    }
    running.await.unwrap().unwrap();
    assert!(f.runs().await.values().all(|run| run.status == "succeeded"));
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn disabled_upstream_is_rejected_before_any_work() {
    let f = Fixture::new().await;
    let a = f.extract("Disabled source", "SELECT 1 AS id").await;
    let b = f.transform("Consumer").await;
    f.connect(vec![edge(&a, &b, "data", "in")]).await;
    f.state
        .store
        .update_chip(&a.id, None, None, None, Some(false))
        .await
        .unwrap();
    assert!(f.run().await.unwrap_err().message().contains("inactive"));
    assert!(f
        .state
        .store
        .list_dispatchable_steps(8)
        .await
        .unwrap()
        .is_empty());
    let runs = f.runs().await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[&b.id].status, "failed");
    f.close(None).await;
}

#[tokio::test]
async fn conditional_skip_is_successful_and_does_not_trigger_error_handler() {
    let f = Fixture::new().await;
    let a = f.extract("Success", "SELECT 1 AS id").await;
    let b = f.extract("Error handler", "SELECT 1 AS id").await;
    let c = f.extract("Error of skipped", "SELECT 1 AS id").await;
    f.connect(vec![
        edge(&a, &b, "on_error", "in"),
        edge(&b, &c, "on_error", "in"),
    ])
    .await;
    let worker = f.worker();
    f.run().await.unwrap();
    let runs = f.runs().await;
    assert_eq!(runs[&a.id].status, "succeeded");
    for chip in [&b, &c] {
        assert_eq!(chip_run_json(&runs[&chip.id]).unwrap()["status"], "skipped");
    }
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn sql_chip_runs_without_output_and_rejects_data_edges() {
    let f = Fixture::new().await;
    let sql = f
        .chip(
            "DoSql",
            "sql",
            json!({"connection_id": f.connection, "sql_text": "SELECT 1"}),
        )
        .await;
    let extract = f.extract("Src", "SELECT 1 AS id").await;
    let rejected = f
        .state
        .store
        .save_workspace(
            &f.workspace,
            r#"{"nodes":{}}"#,
            &[sql.id.clone(), extract.id.clone()],
            &[edge(&extract, &sql, "data", "in")],
            None,
        )
        .await;
    assert!(rejected.is_err());
    f.connect(vec![edge(&extract, &sql, "on_success", "in")])
        .await;
    let worker = f.worker();
    f.run().await.unwrap();
    let runs = f.runs().await;
    assert_eq!(runs[&sql.id].status, "succeeded");
    assert!(runs[&sql.id].output_dataset_id.is_none());
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn standalone_chip_still_uses_existing_queue_and_history_path() {
    let f = Fixture::new().await;
    let a = f.extract("Standalone", "SELECT 1 AS id").await;
    let worker = f.worker();
    let run = queue_chip_run(&f.state, &f.user, &a, &f.workspace, None, None)
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(30),
        wait_for_chip_run(&f.state, &run.id),
    )
    .await
    .unwrap()
    .unwrap();
    let run = f.state.store.get_chip_run(&run.id).await.unwrap().unwrap();
    assert_eq!(run.execution_source, "chip");
    assert_eq!(run.status, "succeeded");
    assert!(f
        .state
        .store
        .list_workspace_executions(&f.workspace)
        .await
        .unwrap()
        .is_empty());
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn cancel_aborts_workspace_and_skips_remaining() {
    let f = Fixture::new().await;
    f.extract("A", "SELECT 1 AS id").await;
    f.extract("B", "SELECT 1 AS id").await;
    let run = tokio::spawn({
        let state = f.state.clone();
        let user = f.user.clone();
        let workspace = f.workspace.clone();
        async move { run_workspace_internal(&state, &user, &workspace).await }
    });
    let execution = loop {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if let Some(row) = f
            .state
            .store
            .list_workspace_executions(&f.workspace)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            if row.status == "running" {
                break row.id;
            }
        }
    };
    assert!(f
        .state
        .store
        .cancel_workspace_execution(&execution)
        .await
        .unwrap());
    let result = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .expect("canceled workspace must finish")
        .unwrap();
    assert_eq!(result.unwrap_err().message(), "canceled");
    assert_eq!(
        f.state
            .store
            .get_execution(&execution)
            .await
            .unwrap()
            .unwrap()
            .status,
        "canceled"
    );
    assert!(f.runs().await.values().all(|run| run.status == "canceled"));
    f.close(None).await;
}

#[tokio::test]
async fn load_cannot_feed_transform() {
    let f = Fixture::new().await;
    let src = f.extract("Source", "SELECT 1 AS id").await;
    let load = f.load_db("Load", &f.connection, "dest", "replace").await;
    let transform = f.transform("Consumer").await;
    let chips = f.state.store.list_chips(&f.workspace).await.unwrap();
    let error = f
        .state
        .store
        .save_workspace(
            &f.workspace,
            r#"{"nodes":{}}"#,
            &chips.iter().map(|chip| chip.id.clone()).collect::<Vec<_>>(),
            &[
                edge(&src, &load, "data", "in"),
                edge(&load, &transform, "data", "in"),
            ],
            None,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("validation TARGET"));
    f.close(None).await;
}

#[tokio::test]
async fn failed_load_skips_validation() {
    let f = Fixture::new().await;
    let expected = f.extract("Expected", "SELECT 1 AS id").await;
    let bad = f.extract("Broken", "SELECT * FROM missing_table").await;
    let dest = f.sqlite_file("dest").await;
    let load = f.load_db("Load", &dest, "dest", "replace").await;
    let v = f
        .chip(
            "Compare",
            "validation",
            json!({"source_data_file_id": "", "keys": ["id"]}),
        )
        .await;
    f.connect(vec![
        edge(&bad, &load, "data", "in"),
        edge(&expected, &v, "data", "source"),
        edge(&load, &v, "data", "target"),
    ])
    .await;
    let worker = f.worker();
    assert!(f.run().await.is_err());
    let runs = f.runs().await;
    assert_eq!(runs[&bad.id].status, "failed");
    assert_eq!(chip_run_json(&runs[&load.id]).unwrap()["status"], "skipped");
    assert_eq!(chip_run_json(&runs[&v.id]).unwrap()["status"], "skipped");
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn validation_against_append_load_ignores_extra_keys() {
    let f = Fixture::new().await;
    let dest = f.sqlite_file("dest").await;
    f.exec_sql(&dest, "CREATE TABLE dest (id TEXT, name TEXT)")
        .await;
    f.exec_sql(&dest, "INSERT INTO dest (id, name) VALUES ('99', 'old')")
        .await;
    let expected = f.extract("Expected", "SELECT 1 AS id, 'new' AS name").await;
    let load = f.load_db("Load", &dest, "dest", "append").await;
    let v = f
        .chip(
            "Compare",
            "validation",
            json!({"source_data_file_id": "", "keys": ["id"], "columns": ["name"]}),
        )
        .await;
    f.connect(vec![
        edge(&expected, &load, "data", "in"),
        edge(&expected, &v, "data", "source"),
        edge(&load, &v, "data", "target"),
    ])
    .await;
    let worker = f.worker();
    f.run().await.unwrap();
    let runs = f.runs().await;
    assert_eq!(runs[&load.id].status, "succeeded");
    assert_eq!(runs[&v.id].status, "succeeded");
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn validation_against_load_table_fails_on_value_mismatch() {
    let f = Fixture::new().await;
    let dest = f.sqlite_file("dest").await;
    let expected = f
        .extract("Expected", "SELECT 1 AS id, 'right' AS name")
        .await;
    let loaded = f.extract("Loaded", "SELECT 1 AS id, 'wrong' AS name").await;
    let load = f.load_db("Load", &dest, "dest", "replace").await;
    let v = f
        .chip(
            "Compare",
            "validation",
            json!({"source_data_file_id": "", "keys": ["id"], "columns": ["name"]}),
        )
        .await;
    f.connect(vec![
        edge(&loaded, &load, "data", "in"),
        edge(&expected, &v, "data", "source"),
        edge(&load, &v, "data", "target"),
    ])
    .await;
    let worker = f.worker();
    assert!(f.run().await.is_err());
    let runs = f.runs().await;
    assert_eq!(runs[&load.id].status, "succeeded");
    assert_eq!(runs[&v.id].status, "failed");
    f.close(Some(worker)).await;
}
