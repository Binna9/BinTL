use super::*;
use crate::config::{AuthConfig, Config};
use std::sync::Arc;
use storage::{NewConnection, WorkspaceSaveEdge};
use tokio::task::JoinHandle;

struct Fixture {
    state: AppState,
    user: CurrentUser,
    workspace: String,
    connection: String,
    receiver: Option<mpsc::Receiver<ExecutionTask>>,
}

impl Fixture {
    async fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("bintl-workspace-plan-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&root, "test-secret").await.unwrap();
        let user = CurrentUser(store.ensure_bootstrap("admin", "admin").await.unwrap());
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
        let (execution_tx, receiver) = mpsc::channel(64);
        let config = Arc::new(Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            data_dir: root,
            max_upload_mb: 1,
            max_concurrent_jobs: 1,
            session_secret: "test-secret".into(),
            skip_auth: false,
            auth: AuthConfig {
                username: "admin".into(),
                password: "admin".into(),
            },
            ui_dir: None,
        });
        Self {
            state: AppState {
                store,
                execution_tx,
                config,
            },
            user,
            workspace,
            connection,
            receiver: Some(receiver),
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
            )
            .await
            .unwrap();
    }

    fn worker(&mut self) -> JoinHandle<()> {
        let mut receiver = self.receiver.take().unwrap();
        let state = self.state.clone();
        tokio::spawn(async move {
            while let Some(task) = receiver.recv().await {
                match task {
                    ExecutionTask::Chip(id) => {
                        if let Err(error) = run_one(&state.store, &state.execution_tx, &id).await {
                            let run = state.store.get_chip_run(&id).await.unwrap().unwrap();
                            crate::execution_error::record_chip_failure(
                                &state.store,
                                &id,
                                &run.kind,
                                &error,
                            )
                            .await;
                        }
                    }
                    ExecutionTask::Job(id) => {
                        if let Err(error) = jobs::execute(&state.store, &id).await {
                            crate::execution_error::record_transform_job_failure(
                                &state.store,
                                &id,
                                &error,
                            )
                            .await;
                        }
                    }
                }
            }
        })
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
async fn preflight_reports_all_errors_without_dispatching_valid_chips() {
    let mut f = Fixture::new().await;
    let good = f.extract("Good", "SELECT 1 AS id").await;
    let bad = f
        .chip(
            "Missing extract",
            "extract",
            json!({"connection_id": "", "source": {"type": "table", "table": ""}}),
        )
        .await;
    let missing = f.transform("Missing input").await;
    let error = f.run().await.unwrap_err();
    assert!(error.message().contains("Missing extract"));
    assert!(error.message().contains("Missing input"));
    assert!(matches!(
        f.receiver.as_mut().unwrap().try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    let runs = f.runs().await;
    assert_eq!(
        runs[&bad.id].error_code.as_deref(),
        Some("WORKSPACE_PREFLIGHT_FAILED")
    );
    assert_eq!(runs[&missing.id].status, "failed");
    assert_eq!(chip_run_json(&runs[&good.id]).unwrap()["status"], "skipped");
    assert!(runs
        .values()
        .all(|run| run.started_at.is_none() && run.finished_at.is_some()));
    f.close(None).await;
}

#[tokio::test]
async fn connected_chain_and_independent_chip_use_current_outputs() {
    let mut f = Fixture::new().await;
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
    let mut f = Fixture::new().await;
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
    let mut f = Fixture::new().await;
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
    let mut f = Fixture::new().await;
    let a = f.extract("A", "SELECT 1 AS id").await;
    let b = f.extract("B", "SELECT 1 AS id").await;
    let mut receiver = f.receiver.take().unwrap();
    let state = f.state.clone();
    let workspace = f.workspace.clone();
    let changed = f.extract_config("SELECT * FROM missing_table").to_string();
    let ids = [a.id.clone(), b.id.clone()];
    let worker = tokio::spawn(async move {
        let mut first = true;
        while let Some(ExecutionTask::Chip(id)) = receiver.recv().await {
            if first {
                // Both snapshots exist before the worker sees the first task.
                assert_eq!(
                    state.store.list_chip_runs(&workspace).await.unwrap().len(),
                    2
                );
                for chip_id in &ids {
                    state
                        .store
                        .update_chip(chip_id, None, None, Some(&changed), None)
                        .await
                        .unwrap();
                }
                // Editing the saved graph must not suppress the remaining chip.
                let current = state.store.get_chip_run(&id).await.unwrap().unwrap();
                let other = ids
                    .iter()
                    .find(|chip_id| **chip_id != current.chip_id)
                    .unwrap();
                state
                    .store
                    .save_workspace(
                        &workspace,
                        r#"{"nodes":{}}"#,
                        &ids,
                        &[WorkspaceSaveEdge {
                            id: uuid::Uuid::new_v4().to_string(),
                            from_chip_id: current.chip_id,
                            to_chip_id: other.clone(),
                            kind: "on_error".into(),
                            from_port: "out".into(),
                            to_port: "in".into(),
                        }],
                    )
                    .await
                    .unwrap();
                first = false;
            }
            run_one(&state.store, &state.execution_tx, &id)
                .await
                .unwrap();
        }
    });
    f.run().await.unwrap();
    assert!(f.runs().await.values().all(|run| run.status == "succeeded"));
    f.close(Some(worker)).await;
}

#[tokio::test]
async fn full_queue_finishes_steps_without_leaving_waiters() {
    let mut f = Fixture::new().await;
    f.extract("A", "SELECT 1 AS id").await;
    f.extract("B", "SELECT 1 AS id").await;
    let (sender, receiver) = mpsc::channel(1);
    sender
        .try_send(ExecutionTask::Job("occupied".into()))
        .unwrap();
    f.state.execution_tx = sender;
    f.receiver = Some(receiver);
    assert!(f.run().await.is_err());
    assert!(f
        .runs()
        .await
        .values()
        .all(|run| run.status == "failed" && run.finished_at.is_some()));
    f.close(None).await;
}

#[tokio::test]
async fn disabled_upstream_is_rejected_before_any_work() {
    let mut f = Fixture::new().await;
    let a = f.extract("Disabled source", "SELECT 1 AS id").await;
    let b = f.transform("Consumer").await;
    f.connect(vec![edge(&a, &b, "data", "in")]).await;
    f.state
        .store
        .update_chip(&a.id, None, None, None, Some(false))
        .await
        .unwrap();
    assert!(f.run().await.unwrap_err().message().contains("inactive"));
    assert!(matches!(
        f.receiver.as_mut().unwrap().try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    let runs = f.runs().await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[&b.id].status, "failed");
    f.close(None).await;
}

#[tokio::test]
async fn conditional_skip_is_successful_and_does_not_trigger_error_handler() {
    let mut f = Fixture::new().await;
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
async fn standalone_chip_still_uses_existing_queue_and_history_path() {
    let mut f = Fixture::new().await;
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
