use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use boa_engine::{Context, Source};
use engine::{PolarsEngine, RecordWriter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use storage::{chip_slot, ChipRunRow, DatasetRow, Store};
use uuid::Uuid;

use crate::error::AppError;

pub const DEFAULT_MAIN: &str = "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n";
pub const MAX_SCRIPT_INPUTS: usize = 8;
const MAX_FILES: usize = 16;
const MAX_BYTES: usize = 256 * 1024;
const MAX_ROWS: usize = 50_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(30);
const RUN_TIMEOUT_MAX: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Deserialize)]
struct ScriptFileMap {
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    input_dataset_id: Option<String>,
    #[serde(default)]
    inputs: Vec<ScriptInput>,
    #[serde(default)]
    output_filename: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScriptInput {
    #[serde(default)]
    pub name: String,
    pub dataset_id: String,
}

#[derive(Debug, Clone)]
pub struct ScriptConfig {
    pub entry: String,
    pub files: BTreeMap<String, String>,
    pub input_dataset_id: Option<String>,
    pub inputs: Vec<ScriptInput>,
    pub output_filename: Option<String>,
}

pub fn parse_script_config(config: &Value) -> Result<ScriptConfig, AppError> {
    let parsed: ScriptFileMap =
        serde_json::from_value(config.clone()).map_err(|error| AppError::bad(error.to_string()))?;
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    for (name, source) in parsed.files {
        let name = normalize_filename(&name)?;
        total = total.saturating_add(source.len());
        if total > MAX_BYTES {
            return Err(AppError::bad("script files are too large"));
        }
        files.insert(name, source);
    }
    if files.len() > MAX_FILES {
        return Err(AppError::bad("too many script files"));
    }
    let entry = parsed
        .entry
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_filename)
        .transpose()?
        .unwrap_or_else(|| "main.js".into());
    if !files.contains_key(&entry) {
        if entry == "main.js" && files.is_empty() {
            files.insert("main.js".into(), DEFAULT_MAIN.into());
        } else {
            return Err(AppError::bad("script entry file is missing"));
        }
    }
    let mut inputs = Vec::new();
    let mut used_names = HashSet::new();
    let mut used_ids = HashSet::new();
    for item in parsed.inputs {
        let input = parse_script_input(item, &mut used_names)?;
        if !used_ids.insert(input.dataset_id.clone()) {
            continue;
        }
        inputs.push(input);
    }
    if inputs.is_empty() {
        if let Some(id) = parse_dataset_id(parsed.input_dataset_id.as_deref())? {
            inputs.push(ScriptInput {
                name: unique_input_name("input", &mut used_names),
                dataset_id: id,
            });
        }
    }
    if inputs.len() > MAX_SCRIPT_INPUTS {
        return Err(AppError::bad("too many script inputs"));
    }
    let input_dataset_id = inputs.first().map(|item| item.dataset_id.clone());
    let output_filename = parsed
        .output_filename
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| chip_slot::display_filename(value, "script", ","));
    Ok(ScriptConfig {
        entry,
        files,
        input_dataset_id,
        inputs,
        output_filename,
    })
}

pub fn normalize_script_config(config: ScriptConfig) -> Value {
    json!({
        "entry": config.entry,
        "files": config.files,
        "input_dataset_id": config.input_dataset_id,
        "inputs": config.inputs,
        "output_filename": config.output_filename,
    })
}

fn parse_dataset_id(raw: Option<&str>) -> Result<Option<String>, AppError> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|id| {
            Uuid::parse_str(id)
                .map(|_| id.to_string())
                .map_err(|_| AppError::bad("input_dataset_id must be a dataset id"))
        })
        .transpose()
}

fn parse_script_input(
    item: ScriptInput,
    used_names: &mut HashSet<String>,
) -> Result<ScriptInput, AppError> {
    let dataset_id = parse_dataset_id(Some(&item.dataset_id))?
        .ok_or_else(|| AppError::bad("script input dataset_id required"))?;
    let name = unique_input_name(&item.name, used_names);
    if name.len() > 80 || name.contains('/') || name.contains('\\') {
        return Err(AppError::bad("invalid script input name"));
    }
    Ok(ScriptInput { name, dataset_id })
}

pub fn input_name_from_label(raw: &str) -> String {
    let trimmed = raw.trim();
    let stem = ["parquet", "csv", "json", "tsv"]
        .iter()
        .find_map(|ext| {
            trimmed
                .strip_suffix(&format!(".{ext}"))
                .or_else(|| trimmed.strip_suffix(&format!(".{}", ext.to_ascii_uppercase())))
        })
        .unwrap_or(trimmed)
        .trim();
    if stem.is_empty() {
        "input".into()
    } else {
        stem.to_string()
    }
}

pub fn unique_input_name(raw: &str, used: &mut HashSet<String>) -> String {
    let base = input_name_from_label(raw);
    if used.insert(base.clone()) {
        return base;
    }
    let mut n = 2usize;
    loop {
        let next = format!("{base}_{n}");
        if used.insert(next.clone()) {
            return next;
        }
        n += 1;
    }
}

pub fn merge_script_inputs(
    edge: Vec<ScriptInput>,
    extra: Vec<ScriptInput>,
) -> Result<Vec<ScriptInput>, AppError> {
    let mut used_names = HashSet::new();
    let mut used_ids = HashSet::new();
    let mut inputs = Vec::new();
    for item in edge.into_iter().chain(extra) {
        if !used_ids.insert(item.dataset_id.clone()) {
            continue;
        }
        inputs.push(ScriptInput {
            name: unique_input_name(&item.name, &mut used_names),
            dataset_id: item.dataset_id,
        });
    }
    if inputs.len() > MAX_SCRIPT_INPUTS {
        return Err(AppError::bad("too many script inputs"));
    }
    Ok(inputs)
}

pub async fn validate_script_config(_store: &Store, config: Value) -> Result<Value, AppError> {
    Ok(normalize_script_config(parse_script_config(&config)?))
}

pub async fn preview_script(
    store: &Store,
    tables: &[(String, DatasetRow)],
    config: &ScriptConfig,
    limit: usize,
) -> Result<Value, AppError> {
    let limit = limit.clamp(1, 200);
    let mut loaded = Vec::new();
    for (name, dataset) in tables {
        if dataset.status == "planned" || dataset.status == "connected" {
            loaded.push((name.clone(), Vec::new()));
            continue;
        }
        let path = store.resolve(&dataset.stored_path);
        if !path.is_file() {
            return Err(AppError::not_found("dataset file missing"));
        }
        let rows =
            tokio::task::spawn_blocking(move || PolarsEngine::records_from_file(&path, MAX_ROWS))
                .await
                .map_err(|error| {
                    AppError::new(
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        error.to_string(),
                    )
                })?
                .map_err(|error| AppError::bad(error.to_string()))?;
        loaded.push((name.clone(), rows));
    }
    let files = config.files.clone();
    let entry = config.entry.clone();
    let js = tokio::task::spawn_blocking(move || run_js(&entry, &files, &loaded));
    let outcome = tokio::time::timeout(RUN_TIMEOUT, js)
        .await
        .map_err(|_| AppError::bad("script timed out"))?
        .map_err(|error| {
            AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            )
        })?
        .map_err(AppError::bad)?;
    Ok(records_to_preview(&outcome.rows, limit))
}

fn json_preview_dtype(name: &str, rows: &[Value]) -> &'static str {
    let mut saw_int = false;
    let mut saw_float = false;
    let mut saw_bool = false;
    for row in rows {
        match row.get(name) {
            Some(Value::Null) | None => {}
            Some(Value::Number(n)) if n.is_i64() || n.is_u64() => saw_int = true,
            Some(Value::Number(_)) => saw_float = true,
            Some(Value::Bool(_)) => saw_bool = true,
            _ => return "String",
        }
    }
    if saw_bool && !saw_int && !saw_float {
        "Boolean"
    } else if saw_float || saw_int {
        if saw_float || saw_bool {
            "Float64"
        } else {
            "Int64"
        }
    } else {
        "String"
    }
}

fn records_to_preview(rows: &[Value], limit: usize) -> Value {
    let sample = if rows.len() > limit {
        &rows[..limit]
    } else {
        rows
    };
    let mut names: Vec<String> = Vec::new();
    for row in sample {
        let Some(object) = row.as_object() else {
            continue;
        };
        for key in object.keys() {
            if !names.iter().any(|name| name == key) {
                names.push(key.clone());
            }
        }
    }
    let columns: Vec<Value> = names
        .iter()
        .map(|name| json!({ "name": name, "dtype": json_preview_dtype(name, sample) }))
        .collect();
    let grid: Vec<Vec<String>> = sample
        .iter()
        .map(|row| {
            names
                .iter()
                .map(|name| match row.get(name) {
                    Some(Value::Null) | None => String::new(),
                    Some(Value::String(text)) => text.clone(),
                    Some(value) => value.to_string(),
                })
                .collect()
        })
        .collect();
    json!({
        "columns": columns,
        "rows": grid,
        "sampled_rows": sample.len(),
        "row_count": rows.len(),
        "truncated": rows.len() > sample.len(),
    })
}

fn normalize_filename(raw: &str) -> Result<String, AppError> {
    let name = raw.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || !name.ends_with(".js")
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
    {
        return Err(AppError::bad("invalid script file name"));
    }
    Ok(name.to_string())
}

pub async fn run_script_chip(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let raw: Value =
        serde_json::from_str(&run.config_snapshot_json).map_err(|error| error.to_string())?;
    let config = parse_script_config(&raw).map_err(|error| error.message().to_string())?;
    let mut tables = Vec::new();
    for input in &config.inputs {
        tables.push((
            input.name.clone(),
            dataset_path(store, &input.dataset_id).await?,
        ));
    }
    if tables.is_empty() {
        if let Some(dataset_id) = run.input_dataset_id.as_deref() {
            tables.push(("input".into(), dataset_path(store, dataset_id).await?));
        }
    }
    let files = config.files.clone();
    let entry = config.entry.clone();
    let chip = store
        .get_chip(&run.chip_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "chip not found".to_string())?;
    let filename = config
        .output_filename
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| chip_slot::display_filename(&chip.name, "script", ","));
    let slot_name = chip_slot::slot_file_name("script", ",");
    let output_rel = chip_slot::stored_rel(&run.workspace_id, &run.chip_id, &slot_name)
        .map_err(|error| error.to_string())?;
    let staging_rel =
        chip_slot::staging_rel(&output_rel, &run.id).map_err(|error| error.to_string())?;
    let staging_path = store.resolve(&staging_rel);
    if let Some(parent) = staging_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut staging = chip_slot::StagingFile::new(staging_path.clone());
    let js = tokio::task::spawn_blocking(move || {
        run_script_tables(&entry, &files, &tables, &staging_path)
    });
    let (count, logs) = tokio::time::timeout(RUN_TIMEOUT_MAX, js)
        .await
        .map_err(|_| "script timed out".to_string())?
        .map_err(|error| error.to_string())??;
    chip_slot::publish(staging.path(), &store.resolve(&output_rel))
        .map_err(|error| error.to_string())?;
    staging.keep();
    for line in &logs {
        store
            .append_execution_log(&run.id, "info", "script", line, None)
            .await
            .map_err(|error| error.to_string())?;
    }
    store
        .complete_chip_run_with_file(&run.id, &output_rel, &filename, Some(count as i64))
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn dataset_path(store: &Store, dataset_id: &str) -> Result<std::path::PathBuf, String> {
    let dataset = store
        .get_dataset(dataset_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "input dataset not found".to_string())?;
    let path = store.resolve(&dataset.stored_path);
    if !path.is_file() {
        return Err("input dataset file missing".into());
    }
    Ok(path)
}

fn run_script_tables(
    entry: &str,
    files: &BTreeMap<String, String>,
    tables: &[(String, std::path::PathBuf)],
    output: &std::path::Path,
) -> Result<(u64, Vec<String>), String> {
    if tables.is_empty() {
        let outcome = run_js(entry, files, &[])?;
        let count = PolarsEngine::write_records(&outcome.rows, output)
            .map_err(|error| error.to_string())?;
        return Ok((count, outcome.logs));
    }
    // ponytail: only the first table is chunked. Other tables stay in memory up to MAX_ROWS
    // (code lookups). Whole-table aggregates are per-batch; use transform for a global group-by.
    let primary = PolarsEngine::open_records(&tables[0].1).map_err(|error| error.to_string())?;
    let mut lookups = Vec::new();
    for (name, path) in &tables[1..] {
        lookups.push((
            name.clone(),
            PolarsEngine::records_from_file(path, MAX_ROWS).map_err(|error| error.to_string())?,
        ));
    }
    let height = primary.height();
    let batches = height.div_ceil(MAX_ROWS).max(1);
    let mut writer = RecordWriter::new();
    let mut logs = Vec::new();
    if height == 0 {
        let mut batch = vec![(tables[0].0.clone(), Vec::new())];
        batch.extend(lookups);
        let outcome = run_js(entry, files, &batch)?;
        writer
            .push(&outcome.rows)
            .map_err(|error| error.to_string())?;
        logs.extend(outcome.logs);
    } else {
        let mut offset = 0usize;
        let mut index = 0usize;
        while offset < height {
            index += 1;
            let chunk = primary
                .slice(offset, MAX_ROWS)
                .map_err(|error| error.to_string())?;
            let mut batch = vec![(tables[0].0.clone(), chunk)];
            batch.extend(lookups.iter().cloned());
            let outcome = run_js(entry, files, &batch)?;
            writer
                .push(&outcome.rows)
                .map_err(|error| error.to_string())?;
            logs.extend(outcome.logs);
            if logs.len() > 500 {
                logs.truncate(500);
            }
            offset = offset.saturating_add(MAX_ROWS);
        }
        logs.insert(0, format!("batches={index}/{batches} rows={height}"));
    }
    let count = writer
        .finish_like(&primary, output)
        .map_err(|error| error.to_string())?;
    Ok((count, logs))
}

fn run_js(
    entry: &str,
    files: &BTreeMap<String, String>,
    tables: &[(String, Vec<Value>)],
) -> Result<ScriptOutcome, String> {
    let files_json = serde_json::to_string(files).map_err(|error| error.to_string())?;
    let order: Vec<&str> = tables.iter().map(|(name, _)| name.as_str()).collect();
    let mut map = serde_json::Map::new();
    for (name, rows) in tables {
        map.insert(name.clone(), Value::Array(rows.clone()));
    }
    let tables_json = serde_json::to_string(&map).map_err(|error| error.to_string())?;
    let order_json = serde_json::to_string(&order).map_err(|error| error.to_string())?;
    let entry_json = serde_json::to_string(entry).map_err(|error| error.to_string())?;
    let program = format!(
        r#"(function () {{
  var files = {files_json};
  var tables = {tables_json};
  var order = {order_json};
  var logs = [];
  var written = null;
  var cache = Object.create(null);
  function require(name) {{
    var key = String(name).replace(/^\.\//, "");
    if (cache[key]) return cache[key].exports;
    var src = files[key];
    if (typeof src !== "string") throw new Error("module not found: " + name);
    var module = {{ exports: {{}} }};
    cache[key] = module;
    var fn = new Function("require", "module", "exports", src + "\n;if (typeof main === 'function' && module.exports.main == null) module.exports.main = main;");
    fn(require, module, module.exports);
    return module.exports;
  }}
  function input(name) {{
    if (arguments.length === 0) {{
      if (order.length === 0) return null;
      return tables[order[0]];
    }}
    var rows = tables[String(name)];
    return rows == null ? null : rows;
  }}
  var ctx = {{
    input: input,
    inputs: function () {{ return tables; }},
    write: function (rows) {{
      if (rows == null) {{ written = []; return; }}
      if (!Array.isArray(rows)) throw new Error("ctx.write expects an array of objects");
      written = rows;
    }},
    log: function () {{
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
      logs.push(parts.join(" "));
    }}
  }};
  var entry = require({entry_json});
  var main = entry && typeof entry.main === "function" ? entry.main : null;
  if (!main) throw new Error("main(ctx) is required");
  var returned = main(ctx);
  if (written == null && Array.isArray(returned)) written = returned;
  if (written == null) throw new Error("ctx.write(rows) is required");
  return JSON.stringify({{ rows: written, logs: logs }});
}})()"#
    );
    let mut context = Context::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(2_000_000);
    context.runtime_limits_mut().set_recursion_limit(64);
    let value = context
        .eval(Source::from_bytes(program.as_bytes()))
        .map_err(|error| error.to_string())?;
    let raw = value
        .to_string(&mut context)
        .map_err(|error| error.to_string())?
        .to_std_string_escaped();
    let parsed = serde_json::from_str::<ScriptJsResult>(&raw).map_err(|error| error.to_string())?;
    Ok(ScriptOutcome {
        rows: parsed.rows,
        logs: parsed.logs,
    })
}

struct ScriptOutcome {
    rows: Vec<Value>,
    logs: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ScriptJsResult {
    #[serde(default)]
    rows: Vec<Value>,
    #[serde(default)]
    logs: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_main_echoes_input() {
        let mut files = BTreeMap::new();
        files.insert("main.js".into(), DEFAULT_MAIN.into());
        let outcome = run_js(
            "main.js",
            &files,
            &[("input".into(), vec![json!({"id": 1, "name": "a"})])],
        )
        .unwrap();
        assert_eq!(outcome.rows, vec![json!({"id": 1, "name": "a"})]);
    }

    #[test]
    fn helper_module_and_write() {
        let mut files = BTreeMap::new();
        files.insert(
            "lib.js".into(),
            "function bump(row) { row.n = (row.n || 0) + 1; return row; }\nmodule.exports = { bump };\n"
                .into(),
        );
        files.insert(
            "main.js".into(),
            "function main(ctx) {\n  var bump = require('./lib.js').bump;\n  ctx.write((ctx.input() || []).map(bump));\n  ctx.log('ok');\n}\n"
                .into(),
        );
        let outcome = run_js(
            "main.js",
            &files,
            &[("input".into(), vec![json!({"n": 2})])],
        )
        .unwrap();
        assert_eq!(outcome.rows, vec![json!({"n": 3})]);
        assert_eq!(outcome.logs, vec!["ok"]);
    }

    #[test]
    fn named_inputs_and_first_table() {
        let mut files = BTreeMap::new();
        files.insert(
            "main.js".into(),
            "function main(ctx) {\n  var codes = ctx.input('codes') || [];\n  var name = codes[0] && codes[0].name;\n  ctx.write((ctx.input() || []).map(function (row) { row.label = name; return row; }));\n}\n"
                .into(),
        );
        let outcome = run_js(
            "main.js",
            &files,
            &[
                ("orders".into(), vec![json!({"id": 1})]),
                ("codes".into(), vec![json!({"name": "ok"})]),
            ],
        )
        .unwrap();
        assert_eq!(outcome.rows, vec![json!({"id": 1, "label": "ok"})]);
    }

    #[test]
    fn parse_keeps_named_inputs() {
        let a = "11111111-1111-1111-1111-111111111111";
        let b = "22222222-2222-2222-2222-222222222222";
        let config = parse_script_config(&json!({
            "files": {"main.js": DEFAULT_MAIN},
            "inputs": [
                {"name": "orders.parquet", "dataset_id": a},
                {"name": "codes", "dataset_id": b}
            ]
        }))
        .unwrap();
        assert_eq!(config.inputs[0].name, "orders");
        assert_eq!(config.inputs[1].name, "codes");
        assert_eq!(config.input_dataset_id.as_deref(), Some(a));
    }

    #[test]
    fn batches_cover_every_input_row() {
        let mut files = BTreeMap::new();
        files.insert("main.js".into(), DEFAULT_MAIN.into());
        let primary: Vec<Value> = (0..5).map(|id| json!({ "id": id })).collect();
        let mut written = Vec::new();
        for chunk in primary.chunks(2) {
            let outcome = run_js("main.js", &files, &[("input".into(), chunk.to_vec())]).unwrap();
            written.extend(outcome.rows);
        }
        assert_eq!(written.len(), 5);
        assert_eq!(written[4]["id"], 4);
    }

    #[test]
    fn rejects_path_escape() {
        let err = parse_script_config(&json!({"files": {"../x.js": "1"}})).unwrap_err();
        assert!(err.message().contains("invalid script file name"));
    }

    #[test]
    fn output_filename_keeps_user_label() {
        let config = parse_script_config(&json!({
            "output_filename": "script-sales"
        }))
        .unwrap();
        assert_eq!(
            config.output_filename.as_deref(),
            Some("script-sales.parquet")
        );
        let named = parse_script_config(&json!({
            "output_filename": "script-sales.csv"
        }))
        .unwrap();
        assert_eq!(named.output_filename.as_deref(), Some("script-sales.csv"));
    }

    #[test]
    fn preview_grid_keeps_column_order() {
        let preview =
            records_to_preview(&[json!({"id": 1, "name": "a"}), json!({"name": "b"})], 200);
        assert_eq!(preview["sampled_rows"], 2);
        assert_eq!(preview["columns"][0]["name"], "id");
        assert_eq!(preview["columns"][0]["dtype"], "Int64");
        assert_eq!(preview["columns"][1]["dtype"], "String");
        assert_eq!(preview["rows"][0][0], "1");
        assert_eq!(preview["rows"][1][1], "b");
    }
}
