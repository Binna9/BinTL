use serde_json::json;
use storage::Store;

const MAX_DIAGNOSTIC_CHARS: usize = 8 * 1_024;

pub fn display_timestamp(raw: &str) -> String {
    let Some(kst) = chrono::FixedOffset::east_opt(9 * 60 * 60) else {
        return raw.to_string();
    };
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|timestamp| {
            timestamp
                .with_timezone(&kst)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
        })
        .unwrap_or_else(|_| raw.to_string())
}

pub struct FailureInfo {
    pub code: &'static str,
    pub stage: &'static str,
    pub retryable: bool,
    pub message: &'static str,
}

pub fn classify(process: &str, raw: &str) -> FailureInfo {
    let text = raw.to_ascii_lowercase();
    let has = |values: &[&str]| values.iter().any(|value| text.contains(value));

    if has(&["database is locked", "database busy", "sqlite_busy"]) {
        return failure(
            "STORAGE_BUSY",
            "persist_result",
            true,
            "저장소가 사용 중입니다. 잠시 후 다시 시도해 주세요.",
        );
    }
    if has(&["commit", "transaction commit"]) {
        return failure(
            if process == "load" {
                "LOAD_TRANSACTION_COMMIT_FAILED"
            } else {
                "STORAGE_TRANSACTION_COMMIT_FAILED"
            },
            "commit",
            false,
            "트랜잭션을 확정하지 못했습니다. 중복 처리 여부를 확인해 주세요.",
        );
    }
    if has(&["disk full", "no space left", "공간이 부족"]) {
        return failure(
            "STORAGE_DISK_FULL",
            "write_output",
            false,
            "서버 저장 공간이 부족합니다.",
        );
    }

    match process {
        "extract" if has(&["authentication", "access denied", "unauthorized"]) => failure(
            "EXTRACT_CONNECTION_AUTH_FAILED",
            "connect_source",
            false,
            "원본 커넥션 인증에 실패했습니다. 인증 정보를 확인해 주세요.",
        ),
        "extract" if has(&["timeout", "timed out"]) => failure(
            "EXTRACT_CONNECTION_TIMEOUT",
            "connect_source",
            true,
            "원본 데이터 연결 시간이 초과되었습니다.",
        ),
        "extract" if has(&["connection refused", "connect error"]) => failure(
            "EXTRACT_CONNECTION_REFUSED",
            "connect_source",
            true,
            "원본 데이터 서버가 연결을 거부했습니다.",
        ),
        "extract" if has(&["table", "relation", "does not exist"]) => failure(
            "EXTRACT_TABLE_NOT_FOUND",
            "read_source",
            false,
            "추출할 테이블을 찾을 수 없습니다.",
        ),
        "extract" if has(&["sql", "query", "syntax"]) => failure(
            "EXTRACT_QUERY_INVALID",
            "read_source",
            false,
            "추출 SQL을 실행할 수 없습니다. 쿼리를 확인해 주세요.",
        ),
        "extract" if has(&["http", "status"]) => failure(
            "EXTRACT_HTTP_STATUS_ERROR",
            "request_source",
            true,
            "원본 API가 오류 응답을 반환했습니다.",
        ),
        "extract" if has(&["write", "file", "directory"]) => failure(
            "EXTRACT_OUTPUT_WRITE_FAILED",
            "write_output",
            false,
            "추출 결과 파일을 저장하지 못했습니다.",
        ),

        "transform" if has(&["not connected", "input_dataset_id missing"]) => failure(
            "TRANSFORM_INPUT_NOT_CONNECTED",
            "resolve_input",
            false,
            "변환 입력 데이터가 연결되지 않았습니다.",
        ),
        "transform" if has(&["dataset not found"]) => failure(
            "TRANSFORM_INPUT_DATASET_NOT_FOUND",
            "resolve_input",
            false,
            "변환 입력 dataset을 찾을 수 없습니다.",
        ),
        "transform" if has(&["input dataset file missing", "file missing"]) => failure(
            "TRANSFORM_INPUT_FILE_MISSING",
            "resolve_input",
            false,
            "변환 입력 파일을 찾을 수 없습니다. 상위 칩을 다시 실행해 주세요.",
        ),
        "transform" if has(&["cast", "data type", "dtype"]) => failure(
            "TRANSFORM_TYPE_CAST_FAILED",
            "execute_transform",
            false,
            "데이터 형식을 변환할 수 없습니다.",
        ),
        "transform" if has(&["column", "field not found"]) => failure(
            "TRANSFORM_COLUMN_NOT_FOUND",
            "validate_spec",
            false,
            "변환에 지정한 column을 찾을 수 없습니다.",
        ),
        "transform" if has(&["spec", "expression", "parse"]) => failure(
            "TRANSFORM_SPEC_INVALID",
            "validate_spec",
            false,
            "변환 설정 또는 표현식이 올바르지 않습니다.",
        ),
        "transform" if has(&["memory", "allocation"]) => failure(
            "TRANSFORM_MEMORY_LIMIT",
            "execute_transform",
            false,
            "변환에 필요한 메모리가 부족합니다.",
        ),
        "transform" if has(&["write", "parquet", "output"]) => failure(
            "TRANSFORM_OUTPUT_WRITE_FAILED",
            "write_output",
            false,
            "변환 결과 파일을 저장하지 못했습니다.",
        ),

        "load"
            if has(&[
                "적재 설정이 적용되지 않았습니다",
                "load chip has no load definition",
                "chip has no binding or config",
            ]) =>
        {
            failure(
                "LOAD_DESTINATION_INVALID",
                "validate_destination",
                false,
                "적재 설정이 적용되지 않았습니다. 적재 칩을 편집하고 저장해 주세요.",
            )
        }
        "load" if has(&["input_dataset_id missing", "dataset not found"]) => failure(
            "LOAD_INPUT_DATASET_NOT_FOUND",
            "resolve_input",
            false,
            "적재 입력 dataset을 찾을 수 없습니다.",
        ),
        "load" if has(&["input dataset file missing", "file missing"]) => failure(
            "LOAD_INPUT_FILE_MISSING",
            "prepare_input",
            false,
            "적재 입력 파일을 찾을 수 없습니다.",
        ),
        "load" if has(&["csv parse", "csv header", "csv open"]) => failure(
            "LOAD_INPUT_CONVERSION_FAILED",
            "validate_input",
            false,
            "적재 입력 파일을 해석할 수 없습니다. 오류 행과 파일 형식을 확인해 주세요.",
        ),
        "load" if has(&["deadlock"]) => failure(
            "LOAD_DEADLOCK",
            "write_destination",
            true,
            "대상 DB에서 deadlock이 발생했습니다.",
        ),
        "load" if has(&["timeout", "timed out"]) => failure(
            "LOAD_TIMEOUT",
            "write_destination",
            true,
            "적재 작업 시간이 초과되었습니다.",
        ),
        "load"
            if has(&[
                "unique",
                "foreign key",
                "not null",
                "constraint",
                "duplicate key",
                "중복된 키",
                "고유 제약 조건",
                "외래 키",
                "null이 아님",
                "제약 조건",
            ]) =>
        {
            failure(
                "LOAD_CONSTRAINT_VIOLATION",
                "write_destination",
                false,
                "대상 테이블의 제약조건을 만족하지 못했습니다.",
            )
        }
        "load" if has(&["schema", "column"]) => failure(
            "LOAD_SCHEMA_MISMATCH",
            "validate_destination",
            false,
            "입력 데이터와 대상 테이블의 schema가 일치하지 않습니다.",
        ),
        "load" if has(&["authentication", "access denied", "permission denied"]) => failure(
            "LOAD_AUTH_FAILED",
            "connect_destination",
            false,
            "대상 DB 인증 또는 쓰기 권한을 확인해 주세요.",
        ),
        "load" if has(&["connection", "connect"]) => failure(
            "LOAD_CONNECTION_FAILED",
            "connect_destination",
            true,
            "대상 DB에 연결할 수 없습니다.",
        ),
        "load" if has(&["write", "copy", "file", "directory"]) => failure(
            "LOAD_OUTPUT_WRITE_FAILED",
            "write_destination",
            false,
            "적재 결과를 대상에 저장하지 못했습니다.",
        ),

        "validation" if has(&["rule not found"]) => failure(
            "VALIDATION_RULE_NOT_FOUND",
            "resolve_rule",
            false,
            "검증 rule을 찾을 수 없습니다.",
        ),
        "validation" if has(&["rule is inactive"]) => failure(
            "VALIDATION_RULE_INACTIVE",
            "resolve_rule",
            false,
            "비활성화된 검증 rule입니다.",
        ),
        "validation" if has(&["dataset", "target input", "source data file"]) => failure(
            "VALIDATION_INPUT_NOT_FOUND",
            "resolve_input",
            false,
            "검증할 입력 dataset을 찾을 수 없습니다.",
        ),
        "validation" if has(&["key", "column"]) => failure(
            "VALIDATION_KEY_NOT_FOUND",
            "validate_rule",
            false,
            "검증 key column을 찾을 수 없습니다.",
        ),
        _ => failure(
            match process {
                "extract" => "EXTRACT_SOURCE_READ_FAILED",
                "transform" => "TRANSFORM_ENGINE_FAILED",
                "load" => "LOAD_BATCH_FAILED",
                "validation" => "VALIDATION_ENGINE_FAILED",
                _ => "INTERNAL_UNCLASSIFIED",
            },
            "execute",
            false,
            "실행 중 처리하지 못한 오류가 발생했습니다. 실행 로그를 확인해 주세요.",
        ),
    }
}

/// Build the safe, structured part of an execution failure. Driver/engine errors
/// frequently contain the only useful row or column hint; keep that hint without
/// exposing credentials, SQL values, or an unbounded stack trace.
pub fn failure_context(process: &str, raw: &str) -> serde_json::Value {
    let failure = classify(process, raw);
    let mut context = json!({
        "error_code": failure.code,
        "process": process,
        "stage": failure.stage,
        "retryable": failure.retryable,
        "diagnostic": sanitize_diagnostic(raw),
    });
    if let Some(row) = numeric_hint(raw, &["row ", "row=", "record ", "record="]) {
        context["row_number"] = json!(row);
    }
    if let Some(batch) = numeric_hint(raw, &["batch ", "batch="]) {
        context["batch_number"] = json!(batch);
    }
    if let Some(row_start) = numeric_hint(raw, &["row_start="]) {
        context["row_start"] = json!(row_start);
    }
    if let Some(row_end) = numeric_hint(raw, &["row_end="]) {
        context["row_end"] = json!(row_end);
    }
    if let Some(column) = quoted_hint(raw, &["column", "field"]) {
        context["column"] = json!(column);
    }
    context
}

fn sanitize_diagnostic(raw: &str) -> String {
    let first = raw.lines().next().unwrap_or(raw).trim();
    let lower = first.to_ascii_lowercase();
    if ["password", "authorization", "bearer ", "cookie", "token="]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return "민감정보가 포함될 수 있어 원본 진단 메시지를 숨겼습니다.".into();
    }
    first.chars().take(MAX_DIAGNOSTIC_CHARS).collect()
}

fn failure_log_message(process: &str, raw: &str) -> String {
    let failure = classify(process, raw);
    let diagnostic = sanitize_diagnostic(raw);
    if diagnostic.is_empty() || diagnostic == failure.message {
        failure.message.to_string()
    } else {
        format!("{} 원인: {}", failure.message, diagnostic)
    }
}

fn numeric_hint(raw: &str, labels: &[&str]) -> Option<u64> {
    let lower = raw.to_ascii_lowercase();
    for label in labels {
        if let Some(at) = lower.find(label) {
            let digits = lower[at + label.len()..]
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>();
            if let Ok(value) = digits.parse() {
                return Some(value);
            }
        }
    }
    None
}

fn quoted_hint(raw: &str, labels: &[&str]) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    for label in labels {
        let Some(at) = lower.find(label) else {
            continue;
        };
        let tail = &raw[at + label.len()..];
        for quote in ['`', '\'', '"'] {
            if let Some(start) = tail.find(quote) {
                let value = &tail[start + quote.len_utf8()..];
                if let Some(end) = value.find(quote) {
                    let value = value[..end].trim();
                    if !value.is_empty() && value.len() <= 128 {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }
    None
}

fn failure(
    code: &'static str,
    stage: &'static str,
    retryable: bool,
    message: &'static str,
) -> FailureInfo {
    FailureInfo {
        code,
        stage,
        retryable,
        message,
    }
}

pub async fn record_chip_failure(store: &Store, run_id: &str, process: &str, raw: &str) {
    let failure = classify(process, raw);
    let context = failure_context(process, raw).to_string();
    let log_message = failure_log_message(process, raw);
    let _ = store
        .append_execution_log(
            run_id,
            "error",
            "execution_failed",
            &log_message,
            Some(&context),
        )
        .await;
    let _ = store
        .set_chip_run_failed_with_code(run_id, failure.code, failure.message)
        .await;
}

pub async fn record_transform_job_failure(store: &Store, job_id: &str, raw: &str) {
    let failure = classify("transform", raw);
    let context = failure_context("transform", raw).to_string();
    let log_message = failure_log_message("transform", raw);
    let _ = store
        .append_execution_log(
            job_id,
            "error",
            "execution_failed",
            &log_message,
            Some(&context),
        )
        .await;
    if let Ok(Some(link)) = store.linked_chip_run_for_job(job_id).await {
        let _ = store
            .append_execution_log(
                &link.run_id,
                "error",
                "execution_failed",
                &log_message,
                Some(&context),
            )
            .await;
    }
    let _ = store
        .fail_chip_run_for_job_with_code(job_id, failure.code, failure.message)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_process_specific_failures() {
        let extract = classify("extract", "connection timed out");
        assert_eq!(extract.code, "EXTRACT_CONNECTION_TIMEOUT");
        assert!(extract.retryable);

        let load = classify("load", "UNIQUE constraint failed");
        assert_eq!(load.code, "LOAD_CONSTRAINT_VIOLATION");
        assert!(!load.retryable);

        let localized_load = classify("load", "중복된 키 값이 고유 제약 조건을 위반함");
        assert_eq!(localized_load.code, "LOAD_CONSTRAINT_VIOLATION");

        let unapplied_load = classify(
            "load",
            "적재 설정이 적용되지 않았습니다. 적재 칩을 편집하고 저장해 주세요.",
        );
        assert_eq!(unapplied_load.code, "LOAD_DESTINATION_INVALID");
        assert_eq!(unapplied_load.stage, "validate_destination");

        let transform = classify("transform", "input dataset file missing");
        assert_eq!(transform.code, "TRANSFORM_INPUT_FILE_MISSING");
    }

    #[test]
    fn treats_load_commit_as_non_retryable() {
        let failure = classify("load", "transaction commit failed");
        assert_eq!(failure.code, "LOAD_TRANSACTION_COMMIT_FAILED");
        assert!(!failure.retryable);
    }

    #[test]
    fn extracts_row_and_column_without_losing_engine_diagnostic() {
        let context = failure_context(
            "transform",
            "cast failed for column `amount` at row 37: invalid digit",
        );
        assert_eq!(context["row_number"], 37);
        assert_eq!(context["column"], "amount");
        assert!(context["diagnostic"]
            .as_str()
            .unwrap()
            .contains("invalid digit"));
    }

    #[test]
    fn redacts_sensitive_diagnostics() {
        let context = failure_context("extract", "Authorization: Bearer secret-token");
        assert!(!context["diagnostic"]
            .as_str()
            .unwrap()
            .contains("secret-token"));
    }

    #[test]
    fn includes_the_driver_diagnostic_in_the_visible_log_message() {
        let message = failure_log_message(
            "load",
            "load batch 1 failed (row_start=1, row_end=1): 중복된 키 값이 code_group_pkey 고유 제약 조건을 위반함",
        );
        assert!(message.contains("대상 테이블의 제약조건"));
        assert!(message.contains("code_group_pkey"));
        assert!(message.contains("row_start=1"));
    }
}
