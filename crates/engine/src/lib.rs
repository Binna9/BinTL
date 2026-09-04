use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use polars::prelude::*;
use serde::{Deserialize, Serialize};

const PREVIEW_READ_CAP: usize = 50_000;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ReadHint {
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default)]
    pub has_header: Option<bool>,
}

/// Join or stack multiple datasets before pipeline steps. Dataset IDs live in JSON;
/// `resolved_paths` is filled in by the server at preview/run time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CombineSpec {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub union_dataset_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how: Option<String>,
}

/// Ordered recipe operation used by version 3 specs. Unlike the legacy
/// `combine` field, these operations run exactly in the order they are stored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecipeOperation {
    Clean { steps: Vec<Step> },
    Join {
        right_dataset_id: String,
        on: Vec<String>,
        #[serde(default)]
        how: Option<String>,
    },
    Union { dataset_ids: Vec<String> },
    Aggregate {
        #[serde(default)]
        group_by: Vec<String>,
        aggregations: Vec<AggregationSpec>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AggregationSpec {
    pub column: String,
    pub function: String,
    pub alias: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Step {
    Select {
        columns: Vec<String>,
    },
    Drop {
        columns: Vec<String>,
    },
    Rename {
        map: BTreeMap<String, String>,
    },
    Filter {
        expr: String,
    },
    Cast {
        columns: BTreeMap<String, String>,
    },
    FillNull {
        value: String,
        columns: Vec<String>,
    },
    Sort {
        by: Vec<SortBy>,
    },
    Unique {
        #[serde(default)]
        subset: Option<Vec<String>>,
        #[serde(default)]
        keep: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SortBy {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

/// ETL transform spec. UI/API produce this JSON; only the engine interprets it.
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
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default)]
    pub has_header: Option<bool>,
    #[serde(default)]
    pub read: Option<ReadHint>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combine: Option<CombineSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<RecipeOperation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resolved_paths: BTreeMap<String, String>,
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
            read: None,
            steps: Vec::new(),
            combine: None,
            operations: Vec::new(),
            resolved_paths: BTreeMap::new(),
        }
    }

    pub fn v2() -> Self {
        Self {
            version: 2,
            op: "pipeline".into(),
            select: Vec::new(),
            filter: None,
            rename: BTreeMap::new(),
            sink: "parquet".into(),
            dest: None,
            delimiter: None,
            has_header: None,
            read: None,
            steps: Vec::new(),
            combine: None,
            operations: Vec::new(),
            resolved_paths: BTreeMap::new(),
        }
    }

    pub fn v3() -> Self {
        let mut spec = Self::v2();
        spec.version = 3;
        spec
    }

    pub fn with_read(mut self, delimiter: Option<String>, has_header: Option<bool>) -> Self {
        self.read = Some(ReadHint {
            delimiter: delimiter.clone(),
            has_header,
        });
        self.delimiter = delimiter;
        self.has_header = has_header;
        self
    }

    pub fn delimiter(&self) -> Option<&str> {
        self.read
            .as_ref()
            .and_then(|r| r.delimiter.as_deref())
            .or(self.delimiter.as_deref())
    }

    pub fn has_header(&self) -> Option<bool> {
        self.read
            .as_ref()
            .and_then(|r| r.has_header)
            .or(self.has_header)
    }

    pub fn parse_json(json: &str) -> Result<Self, EngineError> {
        let spec: Self = serde_json::from_str(json).map_err(|e| EngineError::Spec(e.to_string()))?;
        spec.validate()?;
        Ok(spec)
    }

    fn validate(&self) -> Result<(), EngineError> {
        match self.version {
            1 => {
                if !matches!(self.op.as_str(), "identity" | "pipeline") {
                    return Err(EngineError::UnsupportedOp(self.op.clone()));
                }
            }
            2 => {
                if self.dest.is_some() {
                    return Err(EngineError::Spec(
                        "version 2 spec cannot include dest; load is a separate stage".into(),
                    ));
                }
                for step in &self.steps {
                    validate_step(step)?;
                }
                if let Some(combine) = &self.combine {
                    validate_combine(combine)?;
                }
            }
            3 => {
                if self.dest.is_some() {
                    return Err(EngineError::Spec(
                        "version 3 spec cannot include dest; load is a separate stage".into(),
                    ));
                }
                for operation in &self.operations {
                    validate_operation(operation)?;
                }
            }
            other => {
                return Err(EngineError::Spec(format!("unsupported version {other}")));
            }
        }
        if self.sink != "parquet" {
            return Err(EngineError::UnsupportedSink(self.sink.clone()));
        }
        if let Some(dest) = &self.dest {
            if dest.mode != "append" && dest.mode != "replace" {
                return Err(EngineError::Spec(
                    "dest.mode must be append or replace".into(),
                ));
            }
        }
        Ok(())
    }
}

fn validate_operation(operation: &RecipeOperation) -> Result<(), EngineError> {
    match operation {
        RecipeOperation::Clean { steps } => {
            for step in steps {
                validate_step(step)?;
            }
            Ok(())
        }
        RecipeOperation::Join { right_dataset_id, on, how } => {
            let combine = CombineSpec {
                mode: "join".into(),
                right_dataset_id: Some(right_dataset_id.clone()),
                on: on.clone(),
                how: how.clone(),
                ..Default::default()
            };
            validate_combine(&combine)
        }
        RecipeOperation::Union { dataset_ids } => {
            let combine = CombineSpec {
                mode: "union".into(),
                union_dataset_ids: dataset_ids.clone(),
                ..Default::default()
            };
            validate_combine(&combine)
        }
        RecipeOperation::Aggregate { aggregations, .. } => {
            if aggregations.is_empty() {
                return Err(EngineError::Spec("aggregate needs aggregations".into()));
            }
            for aggregation in aggregations {
                if aggregation.column.trim().is_empty() || aggregation.alias.trim().is_empty() {
                    return Err(EngineError::Spec(
                        "aggregate column and alias are required".into(),
                    ));
                }
                if !matches!(aggregation.function.as_str(), "sum" | "count" | "mean" | "min" | "max") {
                    return Err(EngineError::Spec(format!(
                        "unsupported aggregate function `{}`",
                        aggregation.function
                    )));
                }
            }
            Ok(())
        }
    }
}

fn validate_combine(combine: &CombineSpec) -> Result<(), EngineError> {
    match combine.mode.as_str() {
        "join" => {
            if combine
                .right_dataset_id
                .as_ref()
                .is_none_or(|id| id.trim().is_empty())
            {
                return Err(EngineError::Spec("join needs right_dataset_id".into()));
            }
            if combine.on.is_empty() {
                return Err(EngineError::Spec("join needs on columns".into()));
            }
            if let Some(how) = combine.how.as_deref() {
                if how != "left" && how != "inner" {
                    return Err(EngineError::Spec(
                        "join how must be left or inner".into(),
                    ));
                }
            }
        }
        "union" => {
            if combine.union_dataset_ids.is_empty() {
                return Err(EngineError::Spec("union needs union_dataset_ids".into()));
            }
        }
        other => return Err(EngineError::Spec(format!("unknown combine mode `{other}`"))),
    }
    Ok(())
}

fn validate_step(step: &Step) -> Result<(), EngineError> {
    match step {
        Step::Select { columns } if columns.is_empty() => {
            Err(EngineError::Spec("select needs columns".into()))
        }
        Step::Drop { columns } if columns.is_empty() => {
            Err(EngineError::Spec("drop needs columns".into()))
        }
        Step::Rename { map } if map.is_empty() => {
            Err(EngineError::Spec("rename needs a map".into()))
        }
        Step::Filter { expr } if expr.trim().is_empty() => {
            Err(EngineError::Spec("filter needs an expr".into()))
        }
        Step::Cast { columns } if columns.is_empty() => {
            Err(EngineError::Spec("cast needs columns".into()))
        }
        Step::FillNull { columns, .. } if columns.is_empty() => {
            Err(EngineError::Spec("fill_null needs columns".into()))
        }
        Step::Sort { by } if by.is_empty() => Err(EngineError::Spec("sort needs by".into())),
        Step::Unique { keep, .. } => {
            if let Some(keep) = keep {
                if !matches!(keep.as_str(), "first" | "last" | "none" | "any") {
                    return Err(EngineError::Spec(
                        "unique.keep must be first, last, none, or any".into(),
                    ));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewColumn {
    pub name: String,
    pub dtype: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FramePreview {
    pub columns: Vec<PreviewColumn>,
    pub rows: Vec<Vec<String>>,
    pub sampled_rows: usize,
    pub row_count: Option<u64>,
    pub truncated: bool,
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
        spec.validate()?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let df = execute_recipe(input, spec, None)?;
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
        CsvWriter::new(&mut file)
            .include_header(true)
            .finish(&mut df)?;
        Ok(())
    }

    /// Schema + sample rows. Does not apply transform steps.
    pub fn inspect(
        &self,
        input: &Path,
        spec: &TransformSpec,
        limit: usize,
    ) -> Result<FramePreview, EngineError> {
        let limit = limit.max(1);
        let infer = limit.max(128);
        let df = read_any(input, spec, Some(infer))?;
        let row_count = count_rows(input, spec);
        Ok(dataframe_to_preview(df, row_count, limit))
    }

    /// Apply spec to a capped scan and return the head. Does not write parquet.
    pub fn preview(
        &self,
        input: &Path,
        spec: &TransformSpec,
        limit: usize,
    ) -> Result<FramePreview, EngineError> {
        spec.validate()?;
        let limit = limit.max(1);
        let df = execute_recipe(input, spec, Some(PREVIEW_READ_CAP))?;
        let sampled = df.height();
        let truncated = sampled >= PREVIEW_READ_CAP || sampled > limit;
        Ok(dataframe_to_preview(df, None, limit).with_truncated(truncated))
    }
}

fn execute_recipe(
    input: &Path,
    spec: &TransformSpec,
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    if spec.version < 3 {
        return apply(load_combined(input, spec, n_rows)?, spec);
    }
    let mut frame = read_any(input, spec, n_rows)?;
    for operation in &spec.operations {
        frame = match operation {
            RecipeOperation::Clean { steps } => apply_steps(frame, steps)?,
            RecipeOperation::Join { right_dataset_id, on, how } => {
                join_frame(frame, spec, right_dataset_id, on, how.as_deref(), n_rows)?
            }
            RecipeOperation::Union { dataset_ids } => {
                union_frames(frame, spec, dataset_ids, n_rows)?
            }
            RecipeOperation::Aggregate { group_by, aggregations } => {
                aggregate_frame(frame, group_by, aggregations)?
            }
        };
    }
    Ok(frame)
}

fn aggregate_frame(
    frame: DataFrame,
    group_by: &[String],
    aggregations: &[AggregationSpec],
) -> Result<DataFrame, EngineError> {
    let expressions: Vec<Expr> = aggregations
        .iter()
        .map(|aggregation| {
            let expression = match aggregation.function.as_str() {
                "sum" => col(&aggregation.column).sum(),
                "count" => col(&aggregation.column).count(),
                "mean" => col(&aggregation.column).mean(),
                "min" => col(&aggregation.column).min(),
                "max" => col(&aggregation.column).max(),
                _ => unreachable!("validated aggregate function"),
            };
            expression.alias(&aggregation.alias)
        })
        .collect();
    let lazy = frame.lazy();
    if group_by.is_empty() {
        return Ok(lazy.select(expressions).collect()?);
    }
    let group_expressions: Vec<Expr> = group_by.iter().map(|column| col(column)).collect();
    Ok(lazy.group_by(group_expressions).agg(expressions).collect()?)
}

fn apply_steps(df: DataFrame, steps: &[Step]) -> Result<DataFrame, EngineError> {
    let mut lf = df.lazy();
    for step in steps {
        lf = apply_step(lf, step)?;
    }
    Ok(lf.collect()?)
}

fn join_frame(
    left: DataFrame,
    spec: &TransformSpec,
    right_id: &str,
    on: &[String],
    how: Option<&str>,
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    let path = spec.resolved_paths.get(right_id).ok_or_else(|| {
        EngineError::Spec(format!("missing path for join dataset `{right_id}`"))
    })?;
    let right = read_any(Path::new(path), spec, n_rows)?;
    let join_type = match how.unwrap_or("left") {
        "inner" => JoinType::Inner,
        "left" => JoinType::Left,
        other => return Err(EngineError::Spec(format!("unsupported join how `{other}`"))),
    };
    let on_cols: Vec<Expr> = on.iter().map(|column| col(column)).collect();
    Ok(left
        .lazy()
        .join(right.lazy(), on_cols.clone(), on_cols, JoinArgs::new(join_type))
        .collect()?)
}

fn union_frames(
    first: DataFrame,
    spec: &TransformSpec,
    dataset_ids: &[String],
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    let mut frames = vec![first];
    for id in dataset_ids {
        let path = spec.resolved_paths.get(id).ok_or_else(|| {
            EngineError::Spec(format!("missing path for union dataset `{id}`"))
        })?;
        frames.push(read_any(Path::new(path), spec, n_rows)?);
    }
    let lazy: Vec<LazyFrame> = frames.into_iter().map(|frame| frame.lazy()).collect();
    Ok(concat(
        &lazy,
        UnionArgs {
            rechunk: true,
            to_supertypes: true,
            diagonal: true,
            ..Default::default()
        },
    )?
    .collect()?)
}

impl FramePreview {
    fn with_truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated || self.truncated;
        self
    }
}

fn load_combined(
    input: &Path,
    spec: &TransformSpec,
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    let left = read_any(input, spec, n_rows)?;
    let Some(combine) = &spec.combine else {
        return Ok(left);
    };
    match combine.mode.as_str() {
        "union" => load_union(left, spec, n_rows),
        "join" => load_join(left, spec, n_rows),
        other => Err(EngineError::Spec(format!("unknown combine mode `{other}`"))),
    }
}

fn load_union(
    left: DataFrame,
    spec: &TransformSpec,
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    let combine = spec.combine.as_ref().expect("union");
    let mut dfs = vec![left];
    for id in &combine.union_dataset_ids {
        let path = spec.resolved_paths.get(id).ok_or_else(|| {
            EngineError::Spec(format!("missing path for union dataset `{id}`"))
        })?;
        dfs.push(read_any(Path::new(path), spec, n_rows)?);
    }
    if dfs.len() == 1 {
        return Ok(dfs.remove(0));
    }
    let lazy: Vec<LazyFrame> = dfs.into_iter().map(|df| df.lazy()).collect();
    let out = concat(
        &lazy,
        UnionArgs {
            rechunk: true,
            to_supertypes: true,
            diagonal: true,
            ..Default::default()
        },
    )?;
    Ok(out.collect()?)
}

fn load_join(
    left: DataFrame,
    spec: &TransformSpec,
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    let combine = spec.combine.as_ref().expect("join");
    let right_id = combine
        .right_dataset_id
        .as_deref()
        .ok_or_else(|| EngineError::Spec("join needs right_dataset_id".into()))?;
    if combine.on.is_empty() {
        return Err(EngineError::Spec("join needs on columns".into()));
    }
    let path = spec.resolved_paths.get(right_id).ok_or_else(|| {
        EngineError::Spec(format!("missing path for join dataset `{right_id}`"))
    })?;
    let right = read_any(Path::new(path), spec, n_rows)?;
    let join_type = match combine.how.as_deref().unwrap_or("left") {
        "inner" => JoinType::Inner,
        "left" => JoinType::Left,
        other => return Err(EngineError::Spec(format!("unsupported join how `{other}`"))),
    };
    let on_cols: Vec<Expr> = combine.on.iter().map(|c| col(c)).collect();
    Ok(left
        .lazy()
        .join(
            right.lazy(),
            on_cols.clone(),
            on_cols,
            JoinArgs::new(join_type),
        )
        .collect()?)
}

fn apply(df: DataFrame, spec: &TransformSpec) -> Result<DataFrame, EngineError> {
    let lf = apply_lazy(df.lazy(), spec)?;
    Ok(lf.collect()?)
}

fn apply_lazy(mut lf: LazyFrame, spec: &TransformSpec) -> Result<LazyFrame, EngineError> {
    if spec.version >= 2 {
        for step in &spec.steps {
            lf = apply_step(lf, step)?;
        }
        return Ok(lf);
    }
    if let Some(raw) = spec.filter.as_deref().filter(|s| !s.trim().is_empty()) {
        let schema = lf.clone().collect_schema()?;
        lf = lf.filter(parse_filter(schema.as_ref(), raw)?);
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
    Ok(lf)
}

fn apply_step(lf: LazyFrame, step: &Step) -> Result<LazyFrame, EngineError> {
    match step {
        Step::Select { columns } => {
            let cols: Vec<Expr> = columns.iter().map(|c| col(c)).collect();
            Ok(lf.select(cols))
        }
        Step::Drop { columns } => Ok(lf.drop(cols(columns.clone()))),
        Step::Rename { map } => {
            let old: Vec<String> = map.keys().cloned().collect();
            let new: Vec<String> = map.values().cloned().collect();
            Ok(lf.rename(&old, &new, true))
        }
        Step::Filter { expr } => {
            let schema = lf.clone().collect_schema()?;
            Ok(lf.filter(parse_filter(schema.as_ref(), expr)?))
        }
        Step::Cast { columns } => {
            let exprs: Result<Vec<Expr>, EngineError> = columns
                .iter()
                .map(|(name, dtype)| Ok(col(name).cast(parse_dtype(dtype)?)))
                .collect();
            Ok(lf.with_columns(exprs?))
        }
        Step::FillNull { value, columns } => {
            let fill = parse_lit(value)?;
            let exprs: Vec<Expr> = columns
                .iter()
                .map(|name| col(name).fill_null(fill.clone()))
                .collect();
            Ok(lf.with_columns(exprs))
        }
        Step::Sort { by } => {
            let names: Vec<String> = by.iter().map(|s| s.column.clone()).collect();
            let descending: Vec<bool> = by.iter().map(|s| s.descending).collect();
            Ok(lf.sort(
                names,
                SortMultipleOptions::default().with_order_descending_multi(descending),
            ))
        }
        Step::Unique { subset, keep } => {
            let strategy = match keep.as_deref().unwrap_or("first") {
                "last" => UniqueKeepStrategy::Last,
                "none" => UniqueKeepStrategy::None,
                "any" => UniqueKeepStrategy::Any,
                _ => UniqueKeepStrategy::First,
            };
            let subset = subset
                .as_ref()
                .filter(|s| !s.is_empty())
                .map(|s| cols(s.clone()));
            Ok(lf.unique(subset, strategy))
        }
    }
}

fn parse_dtype(raw: &str) -> Result<DataType, EngineError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "int64" | "i64" | "int" | "integer" => Ok(DataType::Int64),
        "int32" | "i32" => Ok(DataType::Int32),
        "float64" | "f64" | "float" | "double" => Ok(DataType::Float64),
        "float32" | "f32" => Ok(DataType::Float32),
        "string" | "utf8" | "str" | "text" => Ok(DataType::String),
        "bool" | "boolean" => Ok(DataType::Boolean),
        other => Err(EngineError::Spec(format!("unsupported dtype `{other}`"))),
    }
}

fn parse_filter(schema: &Schema, raw: &str) -> Result<Expr, EngineError> {
    let s = raw.trim();
    for op in [">=", "<=", "!=", "=", ">", "<"] {
        if let Some(at) = s.find(op) {
            let left = s[..at].trim();
            let right = s[at + op.len()..].trim();
            if !is_col_name(left) {
                return Err(EngineError::Spec(format!("bad filter column `{left}`")));
            }
            let dtype = schema.get(left).ok_or_else(|| {
                EngineError::Spec(format!("unknown filter column `{left}`"))
            })?;
            let lhs = col(left);
            let rhs = parse_lit_for_dtype(right, dtype)?;
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
        "filter must look like `컬럼 >= 1` or `컬럼 = ok`".into(),
    ))
}

fn is_string_dtype(dtype: &DataType) -> bool {
    matches!(
        dtype,
        DataType::String | DataType::Categorical(_, _) | DataType::Enum(_, _)
    )
}

fn is_integer_dtype(dtype: &DataType) -> bool {
    matches!(
        dtype,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
    )
}

fn is_float_dtype(dtype: &DataType) -> bool {
    matches!(dtype, DataType::Float32 | DataType::Float64)
}

fn parse_lit_for_dtype(raw: &str, dtype: &DataType) -> Result<Expr, EngineError> {
    let trimmed = raw.trim();
    let unquoted = trimmed.trim_matches('"').trim_matches('\'');
    if is_string_dtype(dtype) {
        return Ok(lit(unquoted.to_string()));
    }
    if matches!(dtype, DataType::Boolean) {
        return match unquoted.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(lit(true)),
            "false" | "0" | "no" => Ok(lit(false)),
            _ => Err(EngineError::Spec(format!("bad boolean `{trimmed}`"))),
        };
    }
    if is_integer_dtype(dtype) {
        let n: i64 = unquoted.parse().map_err(|_| {
            EngineError::Spec(format!("bad integer `{trimmed}` for {dtype}"))
        })?;
        return Ok(lit(n).cast(dtype.clone()));
    }
    if is_float_dtype(dtype) {
        let n: f64 = unquoted.parse().map_err(|_| {
            EngineError::Spec(format!("bad float `{trimmed}` for {dtype}"))
        })?;
        return Ok(lit(n).cast(dtype.clone()));
    }
    Ok(lit(unquoted.to_string()))
}

fn is_col_name(s: &str) -> bool {
    !s.trim().is_empty()
}

fn parse_lit(raw: &str) -> Result<Expr, EngineError> {
    if let Ok(n) = raw.parse::<i64>() {
        return Ok(lit(n));
    }
    if let Ok(n) = raw.parse::<f64>() {
        return Ok(lit(n));
    }
    let t = raw.trim().trim_matches('"').trim_matches('\'').to_string();
    Ok(lit(t))
}

fn write_parquet(mut df: DataFrame, output: &Path) -> Result<(), EngineError> {
    let mut file = fs::File::create(output)?;
    ParquetWriter::new(&mut file).finish(&mut df)?;
    Ok(())
}

fn read_any(
    path: &Path,
    spec: &TransformSpec,
    n_rows: Option<usize>,
) -> Result<DataFrame, EngineError> {
    let ext = extension(path);
    let df = match ext.as_str() {
        "parquet" => {
            let file = fs::File::open(path)?;
            let mut reader = ParquetReader::new(file);
            if let Some(n) = n_rows {
                reader = reader.with_slice(Some((0, n)));
            }
            reader.finish()?
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
            let separator = match spec.delimiter() {
                Some(raw) => parse_separator(raw)?,
                None if ext == "tsv" => b'\t',
                None => b',',
            };
            let has_header = spec.has_header().unwrap_or(true);
            let mut opts = CsvReadOptions::default()
                .with_has_header(has_header)
                .map_parse_options(|o| o.with_separator(separator));
            if let Some(n) = n_rows {
                opts = opts.with_n_rows(Some(n));
            }
            opts.try_into_reader_with_file_path(Some(path.to_path_buf()))?
                .finish()?
        }
    };
    Ok(df)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn count_rows(path: &Path, spec: &TransformSpec) -> Option<u64> {
    match extension(path).as_str() {
        "parquet" => parquet_row_count(path),
        "json" | "jsonl" | "ndjson" => None,
        _ => count_delimited_rows(path, spec.has_header().unwrap_or(true)).ok(),
    }
}

fn parquet_row_count(path: &Path) -> Option<u64> {
    let file = fs::File::open(path).ok()?;
    let mut reader = ParquetReader::new(file);
    reader.num_rows().ok().map(|n| n as u64)
}

fn count_delimited_rows(path: &Path, has_header: bool) -> Result<u64, EngineError> {
    let file = fs::File::open(path)?;
    let mut n = 0u64;
    for line in BufReader::new(file).lines() {
        line?;
        n += 1;
    }
    if has_header && n > 0 {
        n -= 1;
    }
    Ok(n)
}

fn dataframe_to_preview(df: DataFrame, row_count: Option<u64>, limit: usize) -> FramePreview {
    let height = df.height();
    let truncated = height > limit;
    let df = if truncated {
        df.slice(0, limit)
    } else {
        df
    };
    let columns: Vec<PreviewColumn> = df
        .get_columns()
        .iter()
        .map(|c| PreviewColumn {
            name: c.name().to_string(),
            dtype: c.dtype().to_string(),
        })
        .collect();
    let shown = df.height();
    let mut rows = Vec::with_capacity(shown);
    for i in 0..shown {
        let mut row = Vec::with_capacity(columns.len());
        for col in df.get_columns() {
            let value = match col.get(i) {
                Ok(v) => v,
                Err(_) => AnyValue::Null,
            };
            row.push(any_to_string(value));
        }
        rows.push(row);
    }
    let sampled_rows = rows.len();
    let truncated = truncated
        || row_count
            .map(|n| n as usize > sampled_rows)
            .unwrap_or(false);
    FramePreview {
        columns,
        rows,
        sampled_rows,
        row_count,
        truncated,
    }
}

fn any_to_string(value: AnyValue<'_>) -> String {
    match value {
        AnyValue::Null => String::new(),
        AnyValue::String(s) => s.to_string(),
        AnyValue::StringOwned(s) => s.to_string(),
        other => other.to_string(),
    }
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

    #[test]
    fn inspect_counts_csv_rows() {
        let dir = tmp("inspect");
        let csv = dir.join("in.csv");
        fs::write(&csv, "a,b\n1,2\n3,4\n5,6\n").unwrap();
        let preview = PolarsEngine
            .inspect(&csv, &TransformSpec::identity(), 2)
            .unwrap();
        assert_eq!(preview.columns.len(), 2);
        assert_eq!(preview.rows.len(), 2);
        assert_eq!(preview.row_count, Some(3));
        assert!(preview.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn v2_steps_filter_select_rename() {
        let dir = tmp("v2");
        let csv = dir.join("in.csv");
        fs::write(&csv, "a,b,flag\n1,2,y\n3,4,n\n5,6,y\n").unwrap();
        let spec = TransformSpec::parse_json(
            r#"{
                "version": 2,
                "sink": "parquet",
                "steps": [
                    {"op": "filter", "expr": "a >= 3"},
                    {"op": "select", "columns": ["a", "b"]},
                    {"op": "rename", "map": {"a": "id"}}
                ]
            }"#,
        )
        .unwrap();
        let preview = PolarsEngine.preview(&csv, &spec, 10).unwrap();
        assert_eq!(
            preview
                .columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["id", "b"]
        );
        assert_eq!(preview.rows.len(), 2);
        let out = dir.join("out.parquet");
        PolarsEngine.transform(&csv, &out, &spec).unwrap();
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn v2_rejects_dest() {
        let err = TransformSpec::parse_json(
            r#"{"version":2,"sink":"parquet","dest":{"connection_id":"x","table":"t"}}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("dest"));
    }

    #[test]
    fn filter_string_column_with_unquoted_numeric_value() {
        let dir = tmp("filter-str");
        let csv = dir.join("in.csv");
        fs::write(&csv, "code,flag\n루다,1\n이루다,2\n").unwrap();
        let spec = TransformSpec::parse_json(
            r#"{
                "version": 2,
                "sink": "parquet",
                "steps": [
                    {"op": "filter", "expr": "code = 루다"}
                ]
            }"#,
        )
        .unwrap();
        let preview = PolarsEngine.preview(&csv, &spec, 10).unwrap();
        assert_eq!(preview.rows.len(), 1);
        assert_eq!(preview.rows[0][0], "루다");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filter_int32_column_with_numeric_value() {
        let dir = tmp("filter-i32");
        let csv = dir.join("in.csv");
        fs::write(&csv, "score\n1\n3\n5\n").unwrap();
        let spec = TransformSpec::parse_json(
            r#"{
                "version": 2,
                "sink": "parquet",
                "steps": [
                    {"op": "filter", "expr": "score >= 3"}
                ]
            }"#,
        )
        .unwrap();
        let preview = PolarsEngine.preview(&csv, &spec, 10).unwrap();
        assert_eq!(preview.rows.len(), 2);
        assert_eq!(preview.rows[0][0], "3");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn combine_join_left() {
        let dir = tmp("join");
        let left = dir.join("left.csv");
        let right = dir.join("right.csv");
        fs::write(&left, "id,name\n1,alpha\n2,beta\n").unwrap();
        fs::write(&right, "id,score\n1,10\n3,30\n").unwrap();
        let out = dir.join("out.parquet");
        let mut spec = TransformSpec::parse_json(
            r#"{
              "version": 2,
              "sink": "parquet",
              "steps": [],
              "combine": {
                "mode": "join",
                "right_dataset_id": "right",
                "on": ["id"],
                "how": "left"
              }
            }"#,
        )
        .unwrap();
        spec.resolved_paths.insert(
            "right".into(),
            right.to_string_lossy().into_owned(),
        );
        PolarsEngine.transform(&left, &out, &spec).unwrap();
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn combine_union_vertical() {
        let dir = tmp("union");
        let a = dir.join("a.csv");
        let b = dir.join("b.csv");
        fs::write(&a, "id,name\n1,alpha\n").unwrap();
        fs::write(&b, "id,name\n2,beta\n").unwrap();
        let out = dir.join("out.parquet");
        let mut spec = TransformSpec::parse_json(
            r#"{
              "version": 2,
              "sink": "parquet",
              "steps": [],
              "combine": {
                "mode": "union",
                "union_dataset_ids": ["b"]
              }
            }"#,
        )
        .unwrap();
        spec.resolved_paths.insert("b".into(), b.to_string_lossy().into_owned());
        PolarsEngine.transform(&a, &out, &spec).unwrap();
        let back = ParquetReader::new(fs::File::open(&out).unwrap())
            .finish()
            .unwrap();
        assert_eq!(back.height(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn v3_runs_clean_before_join_in_recipe_order() {
        let dir = tmp("v3-clean-join");
        let left = dir.join("left.csv");
        let right = dir.join("right.csv");
        fs::write(&left, "id,name\n1,alpha\n2,beta\n").unwrap();
        fs::write(&right, "key,score\n1,10\n2,20\n").unwrap();
        let mut spec = TransformSpec::parse_json(
            r#"{
              "version": 3,
              "sink": "parquet",
              "operations": [
                {"type": "clean", "steps": [
                  {"op": "rename", "map": {"id": "key"}}
                ]},
                {
                  "type": "join",
                  "right_dataset_id": "right",
                  "on": ["key"],
                  "how": "left"
                }
              ]
            }"#,
        )
        .unwrap();
        spec.resolved_paths.insert(
            "right".into(),
            right.to_string_lossy().into_owned(),
        );
        let preview = PolarsEngine.preview(&left, &spec, 10).unwrap();
        assert_eq!(
            preview
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            vec!["key", "name", "score"]
        );
        assert_eq!(preview.rows.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn v3_aggregates_recipe_result() {
        let dir = tmp("v3-aggregate");
        let input = dir.join("input.csv");
        fs::write(&input, "team,amount\na,10\na,20\nb,7\n").unwrap();
        let spec = TransformSpec::parse_json(
            r#"{
              "version": 3,
              "sink": "parquet",
              "operations": [{
                "type": "aggregate",
                "group_by": ["team"],
                "aggregations": [
                  {"column": "amount", "function": "sum", "alias": "total"}
                ]
              }]
            }"#,
        )
        .unwrap();
        let preview = PolarsEngine.preview(&input, &spec, 10).unwrap();
        assert_eq!(preview.rows.len(), 2);
        assert_eq!(
            preview.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
            vec!["team", "total"]
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
