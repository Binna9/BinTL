use std::collections::BTreeMap;
use std::time::Duration;

use boa_engine::{Context, Source};
use engine::PolarsEngine;
use serde::Deserialize;
use serde_json::{json, Value};
use storage::{chip_slot, ChipRunRow, Store};
use uuid::Uuid;

use crate::error::AppError;

pub const DEFAULT_MAIN: &str = "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n";
const MAX_FILES: usize = 16;
const MAX_BYTES: usize = 256 * 1024;
const MAX_ROWS: usize = 50_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
struct ScriptFileMap {
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    input_dataset_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ScriptConfig {
    pub entry: String,
    pub files: BTreeMap<String, String>,
    pub input_dataset_id: Option<String>,
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
    let input_dataset_id = parsed
        .input_dataset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|id| {
            Uuid::parse_str(id)
                .map(|_| id.to_string())
                .map_err(|_| AppError::bad("input_dataset_id must be a dataset id"))
        })
        .transpose()?;
    Ok(ScriptConfig {
        entry,
        files,
        input_dataset_id,
    })
}

pub fn normalize_script_config(config: ScriptConfig) -> Value {
    json!({
        "entry": config.entry,
        "files": config.files,
        "input_dataset_id": config.input_dataset_id,
    })
}

pub async fn validate_script_config(_store: &Store, config: Value) -> Result<Value, AppError> {
    Ok(normalize_script_config(parse_script_config(&config)?))
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
    let raw: Value = serde_json::from_str(&run.config_snapshot_json).map_err(|error| error.to_string())?;
    let config = parse_script_config(&raw).map_err(|error| error.message().to_string())?;
    let mut input = None;
    if let Some(dataset_id) = run.input_dataset_id.as_deref() {
        let dataset = store
            .get_dataset(dataset_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "input dataset not found".to_string())?;
        let path = store.resolve(&dataset.stored_path);
        if !path.is_file() {
            return Err("input dataset file missing".into());
        }
        input = Some(
            tokio::task::spawn_blocking(move || PolarsEngine::records_from_file(&path, MAX_ROWS))
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?,
        );
    }
    let files = config.files.clone();
    let entry = config.entry.clone();
    let input_rows = input.clone();
    let js = tokio::task::spawn_blocking(move || run_js(&entry, &files, input_rows.as_deref()));
    let outcome = tokio::time::timeout(RUN_TIMEOUT, js)
        .await
        .map_err(|_| "script timed out".to_string())?
        .map_err(|error| error.to_string())??;
    for line in &outcome.logs {
        store
            .append_execution_log(&run.id, "info", "script", line, None)
            .await
            .map_err(|error| error.to_string())?;
    }
    if outcome.rows.len() > MAX_ROWS {
        return Err(format!("script wrote more than {MAX_ROWS} rows"));
    }
    let chip = store
        .get_chip(&run.chip_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "chip not found".to_string())?;
    let filename = chip_slot::display_filename(&chip.name, "script", ",");
    let slot_name = chip_slot::slot_file_name("script", ",");
    let output_rel = chip_slot::stored_rel(&run.workspace_id, &run.chip_id, &slot_name)
        .map_err(|error| error.to_string())?;
    let output_path = store.resolve(&output_rel);
    let rows = outcome.rows;
    let count = tokio::task::spawn_blocking(move || PolarsEngine::write_records(&rows, &output_path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    store
        .complete_chip_run_with_file(&run.id, &output_rel, &filename, Some(count as i64))
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn run_js(
    entry: &str,
    files: &BTreeMap<String, String>,
    input: Option<&[Value]>,
) -> Result<ScriptOutcome, String> {
    let files_json = serde_json::to_string(files).map_err(|error| error.to_string())?;
    let input_json = match input {
        Some(rows) => serde_json::to_string(rows).map_err(|error| error.to_string())?,
        None => "null".into(),
    };
    let entry_json = serde_json::to_string(entry).map_err(|error| error.to_string())?;
    let program = format!(
        r#"(function () {{
  var files = {files_json};
  var input = {input_json};
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
  var ctx = {{
    input: function () {{ return input; }},
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
        let outcome = run_js("main.js", &files, Some(&[json!({"id": 1, "name": "a"})])).unwrap();
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
        let outcome = run_js("main.js", &files, Some(&[json!({"n": 2})])).unwrap();
        assert_eq!(outcome.rows, vec![json!({"n": 3})]);
        assert_eq!(outcome.logs, vec!["ok"]);
    }

    #[test]
    fn rejects_path_escape() {
        let err = parse_script_config(&json!({"files": {"../x.js": "1"}})).unwrap_err();
        assert!(err.message().contains("invalid script file name"));
    }
}
