use std::fs;
use std::path::Path;

use polars::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("invalid spec: {0}")]
    Spec(String),
    #[error("unsupported op `{0}` (skeleton implements identity only)")]
    UnsupportedOp(String),
    #[error("unsupported sink `{0}` (skeleton writes parquet only)")]
    UnsupportedSink(String),
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformSpec {
    pub version: u32,
    pub op: String,
    #[serde(default = "default_sink")]
    pub sink: String,
}

fn default_sink() -> String {
    "parquet".into()
}

impl TransformSpec {
    pub fn identity() -> Self {
        Self {
            version: 1,
            op: "identity".into(),
            sink: "parquet".into(),
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
        if spec.op != "identity" {
            return Err(EngineError::UnsupportedOp(spec.op.clone()));
        }
        if spec.sink != "parquet" {
            return Err(EngineError::UnsupportedSink(spec.sink.clone()));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut df = read_any(input)?;
        let mut file = fs::File::create(output)?;
        ParquetWriter::new(&mut file).finish(&mut df)?;
        Ok(())
    }
}

fn read_any(path: &Path) -> Result<DataFrame, EngineError> {
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
        _ => CsvReadOptions::default()
            .with_has_header(true)
            .try_into_reader_with_file_path(Some(path.to_path_buf()))?
            .finish()?,
    };
    Ok(df)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_csv_to_parquet() {
        let dir = std::env::temp_dir().join(format!("bintl-engine-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("in.csv");
        fs::write(&csv, "a,b\n1,2\n3,4\n").unwrap();
        let out = dir.join("out.parquet");
        PolarsEngine
            .transform(&csv, &out, &TransformSpec::identity())
            .unwrap();
        assert!(out.is_file(), "parquet output missing");
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
