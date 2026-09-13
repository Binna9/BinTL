# 칩 실행 로그 저장 및 관리 구조

## 1. 기본 원칙

BinTL의 추출·변환·적재·검증 칩 실행 로그는 SQLite `execution_logs`를 단일 원본으로 사용한다. 신규 칩 실행은 `data/logs/extract_runs`나 `data/logs/transform_runs`에 로그 파일을 만들지 않는다.

`data/logs/query`, `files`, `connections`는 칩 실행 이력이 아니라 쿼리 및 연결 확인을 위한 운영 진단 로그다.

```text
workspaces
└─ executions                 워크스페이스 실행
   └─ execution_steps         칩 실행 단위
      ├─ execution_logs       실행 로그
      ├─ execution_inputs     입력 dataset
      ├─ execution_outputs    출력 dataset
      ├─ load_results         적재 결과
      └─ validation_results   검증 결과

chips 1 ── N execution_steps 1 ── N execution_logs
```

같은 칩을 다시 실행해도 과거 로그를 즉시 덮어쓰지 않는다. 실행마다 UUID를 새로 만들고, 워크스페이스의 “최신 로그” 화면이 해당 칩의 가장 최근 실행을 선택한다. 칩 단독 실행 이력은 칩당 최근 완료 실행 50개를 기준으로 정리한다. 워크스페이스 전체 실행과 그 소속 칩은 이 정리에서 제외하여 실행 그룹과 로그를 보존한다. 로그는 실행 단계당 500개, 메시지당 8,192자로 제한한다.

## 2. 서버의 실행 생성 과정

칩 실행 요청을 받으면 서버는 다음 순서로 저장한다.

1. 칩, 워크스페이스 소속, 칩 revision을 검증한다.
2. UUID로 `executions.id`와 `execution_steps.id`를 생성한다.
3. `executions`에 `workspace_id`, 실행 출처, `queued` 상태를 INSERT한다.
4. `execution_steps`에 칩 ID, 종류, 정의 ID, revision, 설정 snapshot을 INSERT한다.
5. 입력 dataset이 확정돼 있으면 `execution_inputs`에 dataset ID를 INSERT한다.
6. 워커가 작업을 가져가면 상태를 `running`으로 변경한다.
7. 종료 시 `succeeded`, `failed`, `canceled` 중 하나와 종료 시각을 저장한다.

`definition_snapshot_json`은 실행 시점의 칩 설정 복사본이다. 이후 칩 설정이 변경되어도 과거 실행 조건을 재확인할 수 있다.

## 3. DB 로그 INSERT

모든 칩은 `Store::append_execution_log`를 사용한다.

```sql
INSERT INTO execution_logs
  (execution_step_id, sequence, level, event_type,
   message, context_json, created_at)
SELECT
  :step_id,
  COALESCE(MAX(sequence), 0) + 1,
  :level,
  :event_type,
  :message,
  :context_json,
  :created_at
FROM execution_logs
WHERE execution_step_id = :step_id;
```

- `execution_step_id`: 로그가 속한 실행 ID
- `sequence`: 실행 내부 로그 순서
- `level`: `info`, `warn`, `error`
- `event_type`: `started`, `load_completed` 같은 이벤트 종류
- `message`: 로그 화면에 표시할 메시지
- `context_json`: 구조화된 부가정보 JSON
- `created_at`: UTC RFC3339 발생 시각

서버는 메시지를 8,192자로 제한한다. INSERT와 오래된 로그 삭제는 같은 DB transaction에서 처리한다.

모든 칩은 공통으로 다음 이벤트를 남긴다.

```text
info  started    {chip_kind} chip started
info  completed  {chip_kind} chip completed
error failed     {실제 오류 메시지}
```

## 4. 추출 프로세스

1. `execution_steps`의 snapshot에서 커넥션, 테이블·SQL·HTTP 설정을 읽는다.
2. 실행 상태를 `running`으로 변경한다.
3. `extract_started` 이벤트를 INSERT한다.
4. DB 또는 HTTP API에서 데이터를 읽어 워크스페이스 출력 파일로 저장한다.
5. `data_files`에 파일명, 경로, 크기, 행 수 등의 dataset 메타데이터를 저장한다.
6. `execution_outputs`에 이 실행의 출력 dataset을 연결한다.
7. `workspace_chip_outputs`의 최신 출력 dataset을 갱신한다.
8. 성공하면 `extract_succeeded`, 실패하면 `extract_failed` 이벤트를 INSERT한다.
9. 실행 상태를 `succeeded` 또는 `failed`로 변경한다.

CSV·TSV 결과는 실제 데이터이므로 파일 시스템에 저장하지만 실행 로그는 `.log` 파일로 저장하지 않는다.

## 5. 변환 프로세스

변환은 부모 칩 실행과 실제 Polars child job으로 구성된다.

1. 부모 칩 실행을 `execution_steps`에 생성한다.
2. 연결선 또는 고정 입력에서 materialized dataset을 결정한다.
3. Polars 변환 child job을 만들고 부모의 `result_json.child_step_id`에 ID를 기록한다.
4. child job의 진행 로그를 child 실행과 부모 칩 실행 양쪽 `execution_logs`에 저장한다.
5. 변환 결과 parquet와 필요한 CSV를 파일 시스템에 저장한다.
6. 결과를 `data_files`, `execution_outputs`, `workspace_chip_outputs`에 연결한다.
7. 부모 실행을 `succeeded` 또는 `failed`로 종료한다.

부모 실행에도 로그를 기록하므로 UI는 다른 칩과 동일하게 부모 실행 ID 하나로 전체 변환 로그를 조회할 수 있다. 기존 DB·파일 이중 기록은 하지 않는다.

## 6. 적재 프로세스

1. 입력 dataset과 적재 설정을 검증한다.
2. `load_started` 이벤트에 입력 파일명을 기록한다.
3. DB 대상이면 CSV를 준비해 지정 테이블에 적재한다. 파일 대상이면 CSV 또는 parquet를 지정 경로에 저장한다.
4. `load_results`에 대상, 모드, 입력·적재·거부 행 수, 바이트 수, 소요 시간, 결과 경로를 저장한다.
5. `load_completed` 이벤트에 적재 행 수, 대상, 소요 시간을 기록한다.
6. 실행을 `succeeded`로 변경한다. 오류 시 공통 `failed` 이벤트와 오류 메시지를 저장한다.

`load_results`는 결과 수치의 원본이고 `execution_logs`는 사람이 읽는 진행 과정과 오류의 원본이다.

## 7. 검증 프로세스

1. 기준 dataset과 연결선으로 전달된 대상 dataset을 조회한다.
2. validation rule 또는 snapshot에서 key와 비교 column을 읽는다.
3. 행 수, key, 중복, column 값, schema를 비교한다.
4. `validation_completed` 이벤트에 통과 여부, source/target 행 수, 불일치 행 수를 저장한다.
5. 전체 report JSON을 `execution_steps.result_json`에 저장한다.
6. `validation_results`에도 source/target dataset 관계와 전체 결과를 저장한다.
7. 차이가 없으면 `succeeded`, 차이가 있으면 `failed`로 종료한다.

대용량 상세 결과는 구조화된 결과 테이블에 두고 일반 로그에는 요약만 넣어 로그 증가를 억제한다.

## 8. 로그 조회

```http
GET /api/chip-runs/{execution_step_id}/logs
```

서버는 사용자의 워크스페이스 접근 권한을 확인하고 `execution_logs`를 `sequence ASC`로 조회한다. 각 행을 `시각 level message` 형태로 만들어 반환한다.

배포 전 적재·검증 실행처럼 DB 로그가 없는 레코드는 호환을 위해 `load_results`, `result_json`, `error_message`에서 내용을 조립한다. 추출 화면의 `GET /api/extracts/{id}/logs`도 동일하게 `execution_logs`를 조회한다.

## 9. 보존 및 자동 정리

로그 INSERT 직후 다음 조건으로 오래된 행을 삭제하여 실행당 최근 500개만 남긴다.

```sql
DELETE FROM execution_logs
WHERE execution_step_id = :step_id
  AND sequence <= COALESCE((
    SELECT MAX(sequence) FROM execution_logs
    WHERE execution_step_id = :step_id
  ), 0) - 500;
```

새 칩 실행을 생성할 때 같은 칩의 완료 실행을 최신순으로 정렬하고 최근 50개를 초과한 `executions`를 삭제한다. `queued`, `running` 실행은 삭제하지 않는다. 대상 완료 상태는 `succeeded`, `failed`, `canceled`다.

`executions` 삭제 시 외래키 `ON DELETE CASCADE`로 `execution_steps`, `execution_logs`, `execution_inputs`, `execution_outputs`, 해당 `validation_results`가 함께 정리된다. 실제 출력 파일과 `data_files`는 최신 workspace 출력을 보호하기 위해 로그 보존 정책과 별도로 관리한다.

## 10. 기존 파일 로그

기존 `data/logs/extract_runs/*.log`, `transform_runs/*.log`는 복구를 위해 자동 삭제하지 않는다. 신규 실행은 해당 파일에 추가 기록하지 않는다. 백업 보존 기간이 지난 뒤 운영자가 기존 파일을 삭제할 수 있다.

새 칩 실행 기능은 로그 파일을 직접 만들거나 `execution_logs`에 직접 INSERT하면 안 된다. 반드시 `Store::append_execution_log`를 사용해야 메시지 크기, 순서, 500개 보존 제한이 동일하게 적용된다.

## 11. 오류 로그 공통 형식

오류는 자유 형식 문자열 하나로만 남기지 않는다. 사용자 화면용 `message`와 서버가 판별하는 `error_code`, 실패 단계, 재시도 가능 여부를 분리한다.

```json
{
  "level": "error",
  "event_type": "execution_failed",
  "message": "대상 데이터베이스에 연결할 수 없습니다.",
  "context": {
    "error_code": "LOAD_CONNECTION_FAILED",
    "process": "load",
    "stage": "connect_destination",
    "retryable": true,
    "connection_id": "9dcf...",
    "dataset_id": "8b51...",
    "attempt": 1
  }
}
```

동일한 값은 다음 위치에 저장한다.

- `execution_logs.level`: `error`
- `execution_logs.event_type`: 구체적인 실패 이벤트
- `execution_logs.message`: 사용자가 읽을 수 있는 한글 메시지
- `execution_logs.context_json`: 오류 코드, 프로세스, 단계, 재시도 여부 및 안전한 식별자
- `execution_steps.error_code`: 실행의 최종 대표 오류 코드
- `execution_steps.error_message`: 실행 목록에 표시할 최종 사용자 메시지
- `executions.error_message`: 워크스페이스 실행 전체의 대표 오류 메시지

한 실행에서 여러 오류가 발생하면 모든 이벤트는 `execution_logs`에 남기고, 실행을 실제로 종료시킨 마지막 오류를 `execution_steps.error_code`와 `error_message`에 저장한다.

## 12. 오류 코드 명명 규칙

오류 코드는 `{프로세스}_{대상}_{원인}` 형태의 대문자 snake case를 사용한다.

```text
EXTRACT_CONNECTION_TIMEOUT
TRANSFORM_INPUT_FILE_MISSING
LOAD_CONSTRAINT_VIOLATION
VALIDATION_SCHEMA_MISMATCH
STORAGE_TRANSACTION_COMMIT_FAILED
```

오류 코드를 화면 문구로 사용하면 안 된다. 코드는 검색·집계·알림 조건으로 사용하고, `message`는 사용자가 해결 방법을 판단할 수 있는 한글 문장으로 작성한다. 기존 코드의 오류 문구를 바꾸더라도 `error_code`는 변경하지 않는다.

## 13. 추출 오류

추출은 실패 단계별로 다음과 같이 분류한다.

### 연결 단계

- `EXTRACT_CONNECTION_NOT_FOUND`: 설정한 커넥션이 삭제됐거나 존재하지 않음
- `EXTRACT_CONNECTION_AUTH_FAILED`: 사용자명, 비밀번호, 토큰 인증 실패
- `EXTRACT_CONNECTION_TIMEOUT`: 대상 서버 연결 또는 응답 시간 초과
- `EXTRACT_CONNECTION_REFUSED`: 호스트 또는 포트에서 연결 거부
- `EXTRACT_DATABASE_NOT_FOUND`: 지정 database 또는 schema가 없음

`stage`는 `connect_source`, `retryable`은 timeout·일시적 연결 거부일 때만 `true`다. 인증 실패와 설정 누락은 사용자가 설정을 수정해야 하므로 `false`다.

### 데이터 조회 단계

- `EXTRACT_TABLE_NOT_FOUND`: 대상 테이블 또는 view가 없음
- `EXTRACT_QUERY_INVALID`: SQL 문법 또는 허용되지 않은 쿼리
- `EXTRACT_QUERY_PERMISSION_DENIED`: SELECT 권한 부족
- `EXTRACT_HTTP_STATUS_ERROR`: HTTP API가 4xx 또는 5xx 반환
- `EXTRACT_HTTP_RESPONSE_INVALID`: JSON 형식 또는 `records_path`가 예상과 다름
- `EXTRACT_SOURCE_READ_FAILED`: 드라이버가 원본 데이터를 읽지 못함

`stage`는 DB 조회면 `read_source`, HTTP 호출이면 `request_source`다. HTTP status, database vendor code 등은 `context_json`에 기록하되 응답 body 전체는 저장하지 않는다.

### 결과 저장 단계

- `EXTRACT_OUTPUT_DIRECTORY_FAILED`: 출력 디렉터리를 만들 수 없음
- `EXTRACT_OUTPUT_WRITE_FAILED`: CSV·TSV 파일 쓰기 실패
- `EXTRACT_OUTPUT_DISK_FULL`: 저장 공간 부족
- `EXTRACT_OUTPUT_METADATA_FAILED`: 파일은 생성됐지만 `data_files` 또는 출력 lineage 저장 실패

파일 저장 실패는 `stage=write_output`, DB metadata 실패는 `stage=register_output`으로 구분한다. 파일 생성 후 metadata transaction이 실패하면 불완전 파일 경로를 정리 대상으로 기록해야 한다.

## 14. 변환 오류

### 입력 및 설정 단계

- `TRANSFORM_INPUT_NOT_CONNECTED`: 입력 데이터 연결선과 고정 입력이 모두 없음
- `TRANSFORM_INPUT_DATASET_NOT_FOUND`: dataset 레코드가 없음
- `TRANSFORM_INPUT_FILE_MISSING`: DB에는 있지만 실제 파일이 없음
- `TRANSFORM_SPEC_INVALID`: 변환 spec JSON 또는 version이 잘못됨
- `TRANSFORM_COLUMN_NOT_FOUND`: select·drop·cast 등에 지정한 column이 없음
- `TRANSFORM_TYPE_CAST_FAILED`: 지정 자료형으로 변환할 수 없음
- `TRANSFORM_EXPRESSION_INVALID`: filter 또는 계산식이 잘못됨

입력 확인은 `stage=resolve_input`, spec 검증은 `stage=validate_spec`으로 기록한다. 사용자가 설정을 고쳐야 하므로 기본적으로 재시도 불가능하다.

### 엔진 및 출력 단계

- `TRANSFORM_ENGINE_FAILED`: Polars 실행 중 일반 오류
- `TRANSFORM_MEMORY_LIMIT`: 변환 중 메모리 부족
- `TRANSFORM_OUTPUT_WRITE_FAILED`: parquet 또는 CSV 쓰기 실패
- `TRANSFORM_CHILD_JOB_FAILED`: child job은 생성됐지만 실행 실패
- `TRANSFORM_OUTPUT_METADATA_FAILED`: 결과 lineage 또는 dataset 등록 실패

메모리·디스크 부족은 동일 요청을 즉시 재시도해도 실패할 가능성이 높으므로 `retryable=false`로 둔다. 일시적인 child worker 중단만 `retryable=true`로 분류한다.

## 15. 적재 오류

### 입력 준비 단계

- `LOAD_INPUT_DATASET_NOT_FOUND`: 입력 dataset이 없음
- `LOAD_INPUT_FILE_MISSING`: 입력 파일이 없음
- `LOAD_INPUT_CONVERSION_FAILED`: 적재용 CSV 변환 실패
- `LOAD_DESTINATION_INVALID`: 대상 connection, table, filename 설정이 잘못됨

### DB 적재 단계

- `LOAD_CONNECTION_FAILED`: 대상 DB 연결 실패
- `LOAD_AUTH_FAILED`: 대상 DB 인증 또는 쓰기 권한 실패
- `LOAD_TABLE_NOT_FOUND`: append·truncate 대상 테이블이 없음
- `LOAD_CONSTRAINT_VIOLATION`: NOT NULL, UNIQUE, FK, CHECK 제약 위반
- `LOAD_SCHEMA_MISMATCH`: 입력 column과 대상 table schema 불일치
- `LOAD_UPSERT_KEY_INVALID`: upsert key가 없거나 대상 unique key와 불일치
- `LOAD_TRANSACTION_BEGIN_FAILED`: 적재 transaction 시작 실패
- `LOAD_TRANSACTION_COMMIT_FAILED`: 데이터 전송 후 commit 실패
- `LOAD_TRANSACTION_ROLLBACK_FAILED`: 실패 후 rollback도 실패
- `LOAD_BATCH_FAILED`: 특정 batch INSERT 또는 COPY 실패
- `LOAD_DEADLOCK`: DB deadlock 감지
- `LOAD_TIMEOUT`: query 또는 transaction 시간 초과

commit 실패는 성공으로 처리하면 안 된다. `loaded_rows`가 존재하더라도 상태는 반드시 `failed`로 저장하고, DB에서 commit 성공을 확인한 후에만 `load_results`와 `succeeded` 상태를 기록한다. deadlock과 일시적 timeout만 제한적인 자동 재시도 대상으로 둔다.

DB 적재를 위해 Parquet을 임시 CSV로 변환할 때는 NULL 전용 내부 마커를 사용한다. 적재기는 이 마커를 대상 column type과 무관하게 SQL `NULL`로 변환하므로 문자형 column에서도 원래 NULL과 빈 문자열(`''`)이 구분된다. 일반 CSV 입력에는 별도 NULL 메타데이터가 없으므로, 빈 필드는 기존처럼 문자형 column에서 빈 문자열로 유지하고 정수·실수·날짜·시간·boolean·UUID 등 비문자형 column에서 SQL `NULL`로 처리한다. NULL 또는 빈 필드를 `NOT NULL` column에 넣으려 하면 DB 전송 전에 실패시키며 로그 원문에 CSV 행 번호, column 이름, 대상 자료형을 남긴다.

### 파일 적재 단계

- `LOAD_OUTPUT_DIRECTORY_FAILED`: 파일 대상 디렉터리 생성 실패
- `LOAD_OUTPUT_WRITE_FAILED`: 대상 파일 복사 또는 변환 실패
- `LOAD_OUTPUT_ALREADY_EXISTS`: replace가 아닌데 같은 파일이 존재함
- `LOAD_OUTPUT_DISK_FULL`: 저장 공간 부족
- `LOAD_RESULT_SAVE_FAILED`: 적재 성공 후 `load_results` 저장 실패

## 16. 검증 오류와 검증 실패

검증에서는 시스템 오류와 정상적인 검증 불일치를 반드시 구분한다.

- `VALIDATION_INPUT_NOT_FOUND`: source 또는 target dataset이 없음
- `VALIDATION_FILE_MISSING`: 실제 비교 파일이 없음
- `VALIDATION_RULE_NOT_FOUND`: validation rule이 삭제됨
- `VALIDATION_RULE_INACTIVE`: 비활성 rule 실행 시도
- `VALIDATION_KEY_NOT_FOUND`: 비교 key column이 없음
- `VALIDATION_ENGINE_FAILED`: 파일 읽기 또는 비교 엔진 오류
- `VALIDATION_RESULT_SAVE_FAILED`: 결과 JSON 또는 `validation_results` 저장 실패
- `VALIDATION_DIFFERENCE_FOUND`: 엔진은 정상 실행됐지만 데이터 차이가 발견됨
- `VALIDATION_SCHEMA_MISMATCH`: schema 차이가 발견됨

`VALIDATION_DIFFERENCE_FOUND`와 `VALIDATION_SCHEMA_MISMATCH`는 시스템 장애가 아니다. 실행 결과는 정책상 `failed`일 수 있지만 로그 level은 `warn`, `retryable=false`로 기록한다. 파일 읽기나 DB 저장 실패는 `error`다.

## 17. 저장소 및 트랜잭션 오류

프로세스 종류와 무관하게 서버 내부 저장 실패는 다음 코드로 통일한다.

- `STORAGE_TRANSACTION_BEGIN_FAILED`: SQLite 또는 대상 DB transaction 시작 실패
- `STORAGE_TRANSACTION_COMMIT_FAILED`: commit 실패
- `STORAGE_TRANSACTION_ROLLBACK_FAILED`: rollback 실패
- `STORAGE_CONSTRAINT_VIOLATION`: 내부 DB FK·UNIQUE·CHECK 위반
- `STORAGE_BUSY`: SQLite lock 또는 busy timeout
- `STORAGE_WRITE_FAILED`: 실행 상태·로그·결과 저장 실패
- `STORAGE_CORRUPTED`: DB 또는 저장된 JSON이 손상됨
- `INTERNAL_WORKER_INTERRUPTED`: 워커 panic, channel 종료 또는 서버 중단
- `INTERNAL_UNCLASSIFIED`: 어느 분류에도 속하지 않는 마지막 방어 오류

로그 INSERT 자체가 실패한 경우 동일 DB에 실패 로그를 다시 INSERT하려고 반복하면 안 된다. 서버의 `tracing::error!` 운영 로그에 실행 ID와 오류를 남기고 실행 상태 저장을 한 번 시도한다. 상태 저장도 실패하면 모니터링 시스템이 운영 로그를 기준으로 경고해야 한다.

## 18. 재시도 정책

자동 재시도는 `retryable=true`인 오류만 대상으로 한다.

- 재시도 가능: 연결 timeout, 일시적 connection refused, HTTP 429·일부 5xx, deadlock, DB busy, 일시적 worker 중단
- 재시도 불가: 인증 실패, SQL·spec 오류, column 누락, schema 불일치, constraint 위반, 파일 없음, disk full, 검증 차이

권장 기본값은 최대 3회, 지수 backoff `1초 → 5초 → 20초`다. 적재 commit 결과를 확인할 수 없는 오류는 중복 적재 위험 때문에 자동 재시도하지 않는다. 적재 재시도를 허용하려면 upsert key 또는 실행별 idempotency key가 있어야 한다.

각 재시도는 별도 실행을 만들지 않고 같은 `execution_step_id`에 다음 이벤트를 남긴다.

```text
warn  retry_scheduled  attempt=2 delay_ms=5000 error_code=LOAD_DEADLOCK
info  retry_started    attempt=2
```

## 19. 민감정보와 메시지 규칙

다음 값은 로그에 저장하지 않는다.

- DB·API 비밀번호, access token, Authorization/Cookie header
- 전체 connection string
- HTTP request/response body 전체
- 개인정보가 포함될 수 있는 원본 행
- SQL parameter 실제 값
- 검증 불일치 행 전체

허용하는 정보는 마스킹된 connection ID, dataset ID, table 이름, HTTP status, vendor error code, batch 번호, 행 수, 소요 시간이다. SQL은 원문 대신 query hash 또는 앞부분을 비식별화해 저장한다.

사용자 메시지는 “무엇이 실패했는지 + 사용자가 확인할 대상”을 포함한다. 내부 stack trace와 라이브러리 오류는 `message`에 그대로 노출하지 않고 서버 운영 로그에만 기록한다.

```text
나쁜 예: error occurred: Io(Os { code: 3 })
좋은 예: 변환 입력 파일을 찾을 수 없습니다. 입력 dataset을 다시 실행해 주세요.
```

## 20. 행·컬럼 단위 데이터 진단

칩 실행 중 데이터 자체에서 문제가 발견되면 다음 필드를 `context_json`에 기록한다.

- `row_number`: 헤더를 제외한 1부터 시작하는 데이터 행 번호
- `column`: 원본 column 이름. 헤더가 없으면 `column_1` 형식
- `batch_number`, `row_start`, `row_end`: DB가 batch 전체만 거부해 단일 행을 확정할 수 없을 때의 범위
- `diagnostic`: 비밀번호·token·본문을 제거하고 1,024자로 제한한 connector/engine 진단 첫 줄

적재 전 CSV·TSV 입력은 전체 행을 검사한다. 빈 셀은 허용 가능한 데이터일 수 있으므로 실행을 임의로 실패시키지 않고 `load_input_empty_value` 경고로 남긴다. 정확한 행과 column은 최대 100건까지 남기고, `load_input_validated`에 전체 검사 행 수, 빈 셀 수, 상세 로그 제한 여부를 요약한다. CSV 구조가 깨진 경우에는 해당 행 번호와 함께 `LOAD_INPUT_CONVERSION_FAILED`로 실패한다.

DB batch 적재 실패에서 드라이버가 단일 행을 제공하지 않으면 존재하지 않는 행 번호를 추측하지 않는다. 대신 실패 batch와 행 범위를 기록한다. MSSQL처럼 행별 INSERT를 수행하는 경로는 정확한 실패 행을 기록한다.

## 21. 추출 실행 이력과 최신 파일

추출 실행 이력과 파일 목록의 수명 주기는 분리한다. 추출 페이지와 캔버스 모두 실행할 때마다 새로운 `execution`을 생성하여 과거 상태와 로그를 보존하지만, 파일 목록에는 같은 논리적 추출의 최신 dataset만 노출한다.

- 캔버스 추출: 워크스페이스 칩 ID를 출력 slot의 식별자로 사용한다.
- 추출 페이지: workspace, connection, source(table/query/API), database, 출력 파일명, delimiter, header, sequence 설정의 조합을 식별자로 사용한다.
- 동일 식별자의 재실행이 성공하면 이전 dataset은 `deleted_at` 처리하고 이전 실제 파일도 정리한다.
- source나 출력 설정이 다르면 파일명이 같더라도 별도의 dataset으로 유지한다.
- 실패한 새 실행은 이전 성공 파일을 제거하지 않는다.

추출 파일 화면은 실행 테이블을 기반으로 조회하지만, 성공한 실행 중 `data_files.deleted_at`이 설정된 과거 출력은 표시하지 않는다. `queued`, `running`, `failed` 실행은 진행 상태와 오류 확인을 위해 표시한다. 전체 실행 이력과 로그는 DB에 계속 보존되며 파일 화면과 별도로 조회할 수 있다.

## 워크스페이스 실행과 칩 단독 실행 구분

전체 실행은 `executions.source='workspace'`인 한 실행 아래 칩 단계를 연결한다. 개별 실행은 `source='chip'`이다. 로그는 두 경우 모두 `execution_logs.execution_step_id`로 저장하며, 전체 실행 상세에서는 선택한 `execution_id`에 속한 칩만 표시한다. 전체 실행은 모든 대상 처리가 종료된 뒤 성공/실패를 확정한다. 실행 중 페이지를 떠나도 서버 작업은 계속되며 서버 재시작으로 중단된 전체 실행은 실패로 복구한다.

전체 실행은 첫 칩을 큐에 보내기 전에 모든 대상의 설정 스냅샷을 저장한다. 첫 단계의 `workspace_plan` 로그 context에는 고정된 연결과 칩 식별 정보가 들어간다. 사전 검증 오류는 `WORKSPACE_PREFLIGHT_FAILED`로 기록하며 실제 작업은 시작하지 않는다.

건너뜀은 기존 DB 상태 제약을 유지하기 위해 `status='canceled'`, `error_code='WORKSPACE_STEP_SKIPPED'`로 저장한다. 칩 실행 API와 화면에서는 이를 `skipped` / 건너뜀으로 표시한다. `started_at`은 비어 있고 `finished_at`, 사유, `skipped` 로그를 남긴다. 일반 취소는 계속 `canceled`로 표시한다. 검증의 두 데이터 입력은 대상 `in`(ordinal 0), 원본 `source`(ordinal 1)로 기록한다.
