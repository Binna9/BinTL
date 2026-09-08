# 저장소 트랜잭션 및 잔여 데이터 감사

## 1. 목적

이 문서는 BinTL의 칩, 레시피, 실행 이력, 로그, dataset 메타데이터 및 실제 파일의 수명 주기를 점검한 결과를 정리한다. 핵심 목표는 다음과 같다.

- DB 트랜잭션 실패 시 불완전한 행이 남지 않도록 한다.
- 서버 중단 후 `queued`, `running` 상태가 영구적으로 남지 않도록 한다.
- DB에서 삭제된 파일이 디스크에 남거나, 디스크 파일이 있지만 DB에서 조회되지 않는 상태를 방지한다.
- 운영 기간이 길어져도 실행 이력, 로그, soft-delete 데이터와 스키마가 무제한 증가하지 않도록 한다.

## 2. 현재 데이터 구조

칩 실행의 기본 관계는 다음과 같다.

```text
workspaces
└─ executions
   └─ execution_steps
      ├─ execution_logs
      ├─ execution_inputs ── data_files
      ├─ execution_outputs ─ data_files
      ├─ load_results
      └─ validation_results

chips
├─ extracts
├─ transforms
└─ loads

workspace_chips
├─ workspace_edges
└─ workspace_chip_outputs ─ data_files
```

`execution_steps.definition_snapshot_json`은 실행 당시 설정을 보존한다. 따라서 칩 또는 레시피가 삭제되어도 과거 실행 조건과 로그는 유지할 수 있다.

## 3. 현재 정상적으로 보호되는 부분

- `executions` 삭제 시 `execution_steps`와 `execution_logs`는 외래키 cascade로 함께 삭제된다.
- 실행 입력과 출력은 `data_files`를 `ON DELETE RESTRICT`로 참조하여 이력이 남아 있는 파일 메타데이터의 임의 삭제를 막는다.
- 워크스페이스 저장은 배치, 연결선, 위치와 revision snapshot을 하나의 SQLite 트랜잭션으로 저장한다.
- 칩 자체 삭제 시 다른 칩이 참조하지 않는 추출·변환·적재 레시피를 같은 트랜잭션에서 삭제한다.
- 캔버스에서 배치만 제거하면 재사용 가능한 칩과 레시피는 삭제하지 않는다.
- 칩 실행 로그는 실행당 최대 500개, 메시지는 최대 8,192자로 제한한다.
- 칩 실행 이력은 새 실행 생성 시 완료 이력을 최근 50개로 제한한다.

## 4. 발견된 문제

### 4.1 추출 페이지 삭제 후 고아 `extracts` 정의

독립 추출 실행은 `extracts`, `executions`, `execution_steps`를 함께 생성한다. 현재 추출 결과 삭제는 실행을 삭제하지만 독립 추출 정의를 함께 삭제하지 않는 경로가 있어 `extracts`에 참조되지 않는 행이 남을 수 있다.

권장 처리:

1. 삭제 대상 실행의 `extract_id`를 트랜잭션 안에서 조회한다.
2. 실행을 삭제한다.
3. 다른 칩이나 실행이 참조하지 않는 경우에만 `extracts` 정의를 삭제한다.
4. 과거 실행을 보존해야 한다면 snapshot 보존 여부를 먼저 확인한다.

### 4.2 서버 중단 후 종료되지 않는 실행

서버 시작 시 이전 프로세스가 남긴 `queued`, `running` 실행을 복구하는 절차가 없다. 서버 종료, panic 또는 강제 재시작이 발생하면 실행 상태가 영구적으로 진행 중으로 남을 수 있다.

권장 처리:

- 서버 시작 시 일정 시간 이전의 `queued`, `running` 실행을 조회한다.
- `INTERNAL_WORKER_INTERRUPTED` 코드로 `failed` 처리한다.
- 실행 로그에 서버 재시작으로 중단됐다는 복구 이벤트를 남긴다.
- 임시 출력 경로가 있으면 파일 정리 대기열에 넣는다.

### 4.3 DB와 파일시스템 작업의 비원자성

SQLite 트랜잭션은 실제 파일 생성, rename, 삭제를 rollback할 수 없다. 현재 일부 경로는 파일을 먼저 생성한 뒤 DB 메타데이터를 저장하며, 삭제 시에는 DB를 먼저 변경한 뒤 파일을 삭제한다.

발생 가능한 상태:

- 파일 생성 성공 후 DB commit 실패: 디스크 고아 파일
- DB soft delete 성공 후 파일 삭제 실패: 화면에서는 사라졌지만 디스크에는 파일 존재
- canonical 파일 덮어쓰기 중 서버 종료: 이전 정상 파일까지 부분 파일로 변경

권장 처리:

1. 동일 파일시스템의 staging 디렉터리에 임시 파일을 생성한다.
2. 쓰기와 flush를 완료한다.
3. DB 메타데이터 트랜잭션을 준비한다.
4. 임시 파일을 canonical 경로로 atomic rename한다.
5. commit 실패 또는 rename 실패 시 보상 작업 대기열에 기록한다.

### 4.4 삭제된 칩의 실행 이력 무기한 보존

칩 삭제 시 실행 이력의 `chip_id`와 정의 ID는 `ON DELETE SET NULL`로 변경되고 snapshot과 로그는 유지된다. 칩당 50개 정리는 새로운 칩 실행을 생성할 때만 실행되므로 삭제된 칩의 이력은 더 이상 자동 정리되지 않는다.

권장 처리:

- 삭제된 칩 실행에는 원래 칩 ID와 이름을 별도 snapshot 필드로 유지한다.
- 보존 기간과 최대 개수를 기준으로 전역 실행 정리 작업을 수행한다.
- 감사 보존 대상은 일반 실행과 다른 기간을 적용할 수 있게 한다.

### 4.5 독립 실행 이력의 무제한 증가

추출·변환·적재 페이지에서 직접 만든 실행과 스케줄 실행에는 칩당 50개 정책이 동일하게 적용되지 않는다. 실행 수가 증가하면 `executions`, `execution_steps`, `execution_logs`가 계속 증가할 수 있다.

권장 기본 정책:

- 칩별 완료 실행: 최근 50개
- 독립 실행: 유형과 사용자별 최근 50개 또는 30일
- 실패 실행: 정상 실행보다 긴 보존 기간
- 진행 중 실행: 자동 삭제 금지, 중단 복구 절차 적용

### 4.6 soft-delete `data_files` 누적

이전 출력은 `deleted_at`을 설정하여 목록에서 숨긴다. 실행 입출력 이력이 해당 파일을 참조하는 동안 실제 DB 행은 삭제할 수 없으므로 실행 이력과 함께 정리하지 않으면 계속 누적된다.

권장 처리:

- 실행 이력 정리 후 참조가 없는 soft-delete 파일을 hard delete한다.
- 실제 파일 존재 여부를 확인하고 삭제한다.
- 실제 파일 삭제 실패 시 DB 행을 바로 제거하지 않고 정리 실패 상태와 재시도 횟수를 기록한다.

### 4.7 미사용 `data_schemas` 누적

`data_files`와 `workspace_chip_outputs`가 더 이상 참조하지 않는 `data_schemas` 행을 정리하는 작업이 없다.

권장 처리:

```sql
DELETE FROM data_schemas
WHERE NOT EXISTS (SELECT 1 FROM data_files WHERE data_files.schema_id = data_schemas.id)
  AND NOT EXISTS (
    SELECT 1 FROM workspace_chip_outputs
    WHERE workspace_chip_outputs.schema_id = data_schemas.id
  );
```

이 쿼리는 정기 reconciliation 트랜잭션 안에서 실행한다.

### 4.8 검색 인덱스 불일치

`search_documents` 갱신과 삭제는 주 데이터 트랜잭션 이후 best-effort로 실행된다. 실패해도 본 작업은 성공하므로 삭제된 칩이나 파일이 검색 결과에 남거나, 신규 데이터가 검색되지 않을 수 있다.

권장 처리:

- 검색 문서를 파생 데이터로 정의한다.
- 서버 시작 또는 주기 작업에서 원본 테이블을 기준으로 재생성한다.
- 존재하지 않는 원본을 가리키는 검색 문서를 삭제한다.

### 4.9 워크스페이스 삭제 시 기본 워크스페이스 누적

워크스페이스를 삭제하면 관련 실행과 파일은 삭제하지 않고 기본 워크스페이스로 이동한다. 이력 보존에는 유리하지만 원래 소속 정보가 사라지고 기본 워크스페이스에 데이터가 누적된다. 실제 경로에는 삭제된 workspace ID가 계속 남을 수 있다.

권장 처리:

- `archived_workspace_id`, `original_workspace_id`처럼 원래 소속을 보존한다.
- 삭제된 워크스페이스 이력은 일반 기본 워크스페이스 데이터와 분리한다.
- 보존 기간 이후 실행 이력과 파일을 함께 정리한다.

### 4.10 불완전한 칩 실행

캔버스에는 편집 전 임시 변환·적재·검증 칩을 저장할 수 있다. 이러한 칩을 실행 큐에 넣은 뒤 워커에서 정의 누락을 발견하면 불필요한 실행 레코드와 내부 오류 로그가 생성된다.

권장 처리:

- 큐 생성 전에 칩 종류별 필수 바인딩과 설정을 검증한다.
- 미설정 칩은 `설정을 완료해 주세요` 오류로 요청 단계에서 차단한다.
- 전체 실행에서는 미설정 칩에 구조화된 실패 또는 skipped 로그를 남기되 워커에는 전달하지 않는다.

## 5. 정리 작업 설계

정리 작업은 직접 여러 테이블을 개별 삭제하지 않고 한 번의 reconciliation 실행으로 관리한다.

```text
1. 중단 실행 복구
2. 보존 기간이 지난 실행과 cascade 로그 삭제
3. 참조 없는 soft-delete data_files 조회
4. 실제 파일 삭제
5. 파일 삭제 성공 행 hard delete
6. 참조 없는 data_schemas 삭제
7. 고아 레시피 삭제
8. search_documents 재조정
9. 처리 결과를 운영 로그에 기록
```

파일 삭제는 DB 트랜잭션에 포함할 수 없으므로 `pending_file_deletions` 같은 정리 대기열을 두는 것이 안전하다. 대기열에는 경로, 원인, 생성 시각, 시도 횟수, 최근 오류를 저장한다.

## 6. 우선순위

### 즉시 적용

- 실행 전 칩 바인딩 검증
- 서버 시작 시 중단 실행 복구
- 독립 추출 삭제 시 고아 정의 정리
- 임시 파일 작성 후 atomic rename

### 단기 적용

- 모든 실행 유형에 보존 기간 적용
- 파일 삭제 재시도 대기열
- soft-delete 파일 및 미사용 schema 정리

### 운영 안정화 단계

- 검색 인덱스 정기 재조정
- 삭제 워크스페이스 이력 분리
- 정리 작업의 처리 건수, 실패 건수 및 확보 용량 모니터링

## 7. 안전 원칙

- `queued`, `running` 실행은 복구 판단 없이 삭제하지 않는다.
- 현재 `workspace_chip_outputs.current_data_file_id`가 가리키는 파일은 삭제하지 않는다.
- 실행 이력을 삭제하기 전에 감사 및 장애 분석 보존 기간을 확인한다.
- 실제 파일 경로가 데이터 루트 내부인지 검증한 후 삭제한다.
- DB 삭제와 파일 삭제 사이의 실패는 반드시 재시도 가능한 상태로 기록한다.
- 비밀번호, token, Authorization 및 원본 데이터 행은 정리 로그에도 기록하지 않는다.
