use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use polars::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("invalid spec: {0}")]
    Spec(String),
    #[error("unsupported op `{0}`")]
    UnsupportedOp(String),
    #[error("unsupported sink `{0}` (engine writes parquet)")]
    UnsupportedSink(String),
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Destination table load. Engine ignores this; jobs + connectors apply it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoadDest {
    pub connection_id: String,
    pub table: String,
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "append".into()
}

/// ETL transform spec. UI/API produce this JSON; only the engine interprets it.
///
/// ```json
/// {
///   "version": 1,
///   "op": "pipeline",
///   "select": ["id", "amount"],
///   "filter": "amount > 0",
///   "rename": {"amount": "amt"},
///   "sink": "parquet",
///   "dest": {"connection_id": "...", "table": "dw.fact", "mode": "replace"}
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformSpec {
    pub version: u32,
    #[serde(default = "default_op")]
    pub op: String,
    #[serde(default)]
    pub select: Vec<String>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub rename: BTreeMap<String, String>,
    #[serde(default = "default_sink")]
    pub sink: String,
    #[serde(default)]
    pub dest: Option<LoadDest>,
    /// Delimited-text read hint. Same tokens as extract (`","`, `"|"`, `"tab"`).
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default)]
    pub has_header: Option<bool>,
}

fn default_op() -> String {
    "identity".into()
}

fn default_sink() -> String {
    "parquet".into()
}

impl TransformSpec {
    pub fn identity() -> Self {
        Self {
            version: 1,
            op: "identity".into(),
            select: Vec::new(),
            filter: None,
            rename: BTreeMap::new(),
            sink: "parquet".into(),
            dest: None,
            delimiter: None,
            has_header: None,
        }
    }

    pub fn parse_json(json: &str) -> Result<Self, EngineError> {
        let spec: Self = serde_json::from_str(json).map_err(|e| EngineError::Spec(e.to_string()))?;
        if spec.version != 1 {
            return Err(EngineError::Spec(format!(
                "unsupported version {}",
                spec.version
            )));
        }
        if !matches!(spec.op.as_str(), "identity" | "pipeline") {
            return Err(EngineError::UnsupportedOp(spec.op.clone()));
        }
        if let Some(dest) = &spec.dest {
            if dest.mode != "append" && dest.mode != "replace" {
                return Err(EngineError::Spec(
                    "dest.mode must be append or replace".into(),
                ));
            }
        }
        Ok(spec)
    }
}

/// Engine knows files and a spec. It does not know HTTP, SQLite, or the UI.
pub trait Engine: Send + Sync {
    fn transform(
        &self,
        input: &Path,
        output: &Path,
        spec: &TransformSpec,
    ) -> Result<(), EngineError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PolarsEngine;

impl Engine for PolarsEngine {
    fn transform(
        &self,
        input: &Path,
        output: &Path,
        spec: &TransformSpec,
    ) -> Result<(), EngineError> {
        if spec.sink != "parquet" {
            return Err(EngineError::UnsupportedSink(spec.sink.clone()));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let df = apply(read_any(input, spec)?, spec)?;
        write_parquet(df, output)
    }
}

impl PolarsEngine {
    pub fn export_csv(parquet: &Path, csv: &Path) -> Result<(), EngineError> {
        let mut df = {
            let file = fs::File::open(parquet)?;
            ParquetReader::new(file).finish()?
        };
        if let Some(parent) = csv.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::File::create(csv)?;
        CsvWriter::new(&mut file).include_header(true).finish(&mut df)?;
        Ok(())
    }
}

fn apply(df: DataFrame, spec: &TransformSpec) -> Result<DataFrame, EngineError> {
    let mut lf = df.lazy();
    if let Some(raw) = spec.filter.as_deref().filter(|s| !s.trim().is_empty()) {
        lf = lf.filter(parse_filter(raw)?);
    }
    if !spec.select.is_empty() {
        let cols: Vec<Expr> = spec.select.iter().map(|c| col(c)).collect();
        lf = lf.select(cols);
    }
    if !spec.rename.is_empty() {
        let old: Vec<String> = spec.rename.keys().cloned().collect();
        let new: Vec<String> = spec.rename.values().cloned().collect();
        lf = lf.rename(&old, &new, true);
    }
    Ok(lf.collect()?)
}

fn parse_filter(raw: &str) -> Result<Expr, EngineError> {
    let s = raw.trim();
    for op in [">=", "<=", "!=", "=", ">", "<"] {
        if let Some(at) = s.find(op) {
            let left = s[..at].trim();
            let right = s[at + op.len()..].trim();
            if !is_ident(left) {
                return Err(EngineError::Spec(format!("bad filter column `{left}`")));
            }
            let lhs = col(left);
            let rhs = parse_lit(right)?;
            return Ok(match op {
                "=" => lhs.eq(rhs),
                "!=" => lhs.neq(rhs),
                ">" => lhs.gt(rhs),
                "<" => lhs.lt(rhs),
                ">=" => lhs.gt_eq(rhs),
                "<=" => lhs.lt_eq(rhs),
                _ => unreachable!(),
            });
        }
    }
    Err(EngineError::Spec(
        "filter must look like `col >= 1` or `status = ok`".into(),
    ))
}

fn parse_lit(raw: &str) -> Result<Expr, EngineError> {
    if let Ok(n) = raw.parse::<i64>() {
        return Ok(lit(n));
    }
    if let Ok(n) = raw.parse::<f64>() {
        return Ok(lit(n));
    }
    let t = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();
    Ok(lit(t))
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

fn write_parquet(mut df: DataFrame, output: &Path) -> Result<(), EngineError> {
    let mut file = fs::File::create(output)?;
    ParquetWriter::new(&mut file).finish(&mut df)?;
    Ok(())
}

fn read_any(path: &Path, spec: &TransformSpec) -> Result<DataFrame, EngineError> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let df = match ext.as_str() {
        "parquet" => {
            let file = fs::File::open(path)?;
            ParquetReader::new(file).finish()?
        }
        "json" => {
            let file = fs::File::open(path)?;
            JsonReader::new(file).finish()?
        }
        "jsonl" | "ndjson" => {
            let file = fs::File::open(path)?;
            JsonReader::new(file)
                .with_json_format(JsonFormat::JsonLines)
                .finish()?
        }
        _ => {
            let separator = match spec.delimiter.as_deref() {
                Some(raw) => parse_separator(raw)?,
                None if ext == "tsv" => b'\t',
                None => b',',
            };
            let has_header = spec.has_header.unwrap_or(true);
            CsvReadOptions::default()
                .with_has_header(has_header)
                .map_parse_options(|o| o.with_separator(separator))
                .try_into_reader_with_file_path(Some(path.to_path_buf()))?
                .finish()?
        }
    };
    Ok(df)
}

/// Same tokens as `connectors::parse_delimiter`. Duplicated so engine stays
/// free of sqlx / connectors.
fn parse_separator(raw: &str) -> Result<u8, EngineError> {
    if raw.chars().count() == 1 {
        let c = raw.chars().next().unwrap();
        return if c.is_ascii() {
            Ok(c as u8)
        } else {
            Err(EngineError::Spec("delimiter must be ascii".into()))
        };
    }
    match raw.trim() {
        "tab" | "\\t" => Ok(b'\t'),
        s if s.chars().count() == 1 => {
            let c = s.chars().next().unwrap();
            if c.is_ascii() {
                Ok(c as u8)
            } else {
                Err(EngineError::Spec("delimiter must be ascii".into()))
            }
        }
        _ => Err(EngineError::Spec(format!("bad delimiter `{raw}`"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bintl-engine-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identity_csv_to_parquet() {
        let dir = tmp("id");
        let csv = dir.join("in.csv");
        fs::write(&csv, "a,b\n1,2\n3,4\n").unwrap();
        let out = dir.join("out.parquet");
        PolarsEngine
            .transform(&csv, &out, &TransformSpec::identity())
            .unwrap();
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn select_filter_rename() {
        let dir = tmp("xf");
        let csv = dir.join("in.csv");
        fs::write(&csv, "a,b,flag\n1,2,y\n3,4,n\n5,6,y\n").unwrap();
        let out = dir.join("out.parquet");
        let mut spec = TransformSpec::identity();
        spec.op = "pipeline".into();
        spec.select = vec!["a".into(), "b".into()];
        spec.filter = Some("a >= 3".into());
        spec.rename.insert("a".into(), "id".into());
        PolarsEngine.transform(&csv, &out, &spec).unwrap();
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        assert_eq!(back.get_column_names(), &["id", "b"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pipe_delimited_read() {
        let dir = tmp("pipe");
        let csv = dir.join("in.txt");
        fs::write(&csv, "a|b\n1|2\n3|4\n").unwrap();
        let out = dir.join("out.parquet");
        let mut spec = TransformSpec::identity();
        spec.delimiter = Some("|".into());
        PolarsEngine.transform(&csv, &out, &spec).unwrap();
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        assert_eq!(back.get_column_names(), &["a", "b"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
