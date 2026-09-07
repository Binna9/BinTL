use serde_json::json;
use storage::Store;

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
        "transform" if has(&["column", "field not found"]) => failure(
            "TRANSFORM_COLUMN_NOT_FOUND",
            "validate_spec",
            false,
            "변환에 지정한 column을 찾을 수 없습니다.",
        ),
        "transform" if has(&["cast", "data type", "dtype"]) => failure(
            "TRANSFORM_TYPE_CAST_FAILED",
            "execute_transform",
            false,
            "데이터 형식을 변환할 수 없습니다.",
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
        "load" if has(&["unique", "foreign key", "not null", "constraint"]) => failure(
            "LOAD_CONSTRAINT_VIOLATION",
            "write_destination",
            false,
            "대상 테이블의 제약조건을 만족하지 못했습니다.",
        ),
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
    let context = json!({
        "error_code": failure.code,
        "process": process,
        "stage": failure.stage,
        "retryable": failure.retryable,
    })
    .to_string();
    let _ = store
        .append_execution_log(
            run_id,
            "error",
            "execution_failed",
            failure.message,
            Some(&context),
        )
        .await;
    let _ = store
        .set_chip_run_failed_with_code(run_id, failure.code, failure.message)
        .await;
}

pub async fn record_transform_job_failure(store: &Store, job_id: &str, raw: &str) {
    let failure = classify("transform", raw);
    let context = json!({
        "error_code": failure.code,
        "process": "transform",
        "stage": failure.stage,
        "retryable": failure.retryable,
    })
    .to_string();
    let _ = store
        .append_execution_log(
            job_id,
            "error",
            "execution_failed",
            failure.message,
            Some(&context),
        )
        .await;
    if let Ok(Some(link)) = store.linked_chip_run_for_job(job_id).await {
        let _ = store
            .append_execution_log(
                &link.run_id,
                "error",
                "execution_failed",
                failure.message,
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

        let transform = classify("transform", "input dataset file missing");
        assert_eq!(transform.code, "TRANSFORM_INPUT_FILE_MISSING");
    }

    #[test]
    fn treats_load_commit_as_non_retryable() {
        let failure = classify("load", "transaction commit failed");
        assert_eq!(failure.code, "LOAD_TRANSACTION_COMMIT_FAILED");
        assert!(!failure.retryable);
    }
}
