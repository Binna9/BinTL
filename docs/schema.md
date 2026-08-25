# SQLite 스키마 (`data/etl.db`)

작성: 2026-08-25

SQLite는 `COMMENT ON`을 지원하지 않는다. 테이블·컬럼 의미는 이 문서가 기준이다.

마이그레이션은 `crates/storage/migrations/`에 있다. 아래는 **현재(0010까지 적용된)** 구조다. 시각 컬럼은 RFC3339 문자열이다. 불리언은 INTEGER `0`/`1`이다.

```
workspaces
  ├─ workspace_revisions
  ├─ task_definitions
  │    └─ task_runs ──► datasets (산출물)
  └─ datasets
connections          (전역. 작업 공간에 속하지 않음)
extracts / jobs      (기존 추출·변환 실행 이력. 새 TaskRun이 재사용)
transforms           (기존 변환 정의)
job_logs             (jobs 실행 로그)
```

---

## workspaces — 작업 공간

ETL 설정, 실행, 파일을 묶는 프로젝트.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID. 기본 작업 공간은 `00000000-0000-0000-0000-000000000001` |
| `name` | 이름 | 표시 이름 |
| `description` | 설명 | 선택 |
| `layout_json` | 캔버스 배치 | `{ "nodes": { "<task_id>": { "x", "y" } } }` |
| `version` | 버전 | 생성 시 `1`. 캔버스 저장마다 1 증가 |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

---

## workspace_revisions — 작업 공간 스냅샷

저장 시점의 캔버스와 작업 정의. `(workspace_id, version)`이 키다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `workspace_id` | 작업 공간 ID | `workspaces.id` |
| `version` | 버전 | `workspaces.version`과 대응 |
| `snapshot_json` | 스냅샷 | 당시 레이아웃과 작업 정의 JSON |
| `created_at` | 생성 시각 | |

---

## task_definitions — 작업 정의

반복 실행하는 Extract / Transform / Load 설정. 실행할 때마다 revision이 스냅샷으로 복사된다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `workspace_id` | 작업 공간 ID | `workspaces.id` |
| `name` | 이름 | 표시 이름 |
| `kind` | 종류 | `extract` \| `transform` \| `load` |
| `config_json` | 설정 | 종류별 JSON. 비밀번호는 넣지 않고 `connection_id`만 참조 |
| `revision` | 리비전 | 저장할 때마다 증가. 1 이상 |
| `active` | 활성 | `1` 활성, `0` 비활성 |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

---

## task_runs — 작업 실행

한 번의 실행 기록. 정의가 바뀌어도 당시 설정은 그대로 남는다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `task_id` | 작업 정의 ID | `task_definitions.id` |
| `workspace_id` | 작업 공간 ID | `workspaces.id` |
| `kind` | 종류 | 실행 당시 `extract` \| `transform` \| `load` |
| `status` | 상태 | `queued` \| `running` \| `succeeded` \| `failed` |
| `config_snapshot_json` | 설정 스냅샷 | 실행 당시 `config_json` 복사본 |
| `revision_snapshot` | 리비전 스냅샷 | 실행 당시 revision |
| `input_dataset_id` | 입력 데이터셋 ID | Transform 입력. Extract는 보통 비움 |
| `output_dataset_id` | 출력 데이터셋 ID | 성공 시 산출 `datasets.id` |
| `legacy_extract_id` | 기존 추출 ID | 호환용 `extracts.id`. 있으면 유일 |
| `legacy_job_id` | 기존 작업 ID | 호환용 `jobs.id`. 있으면 유일 |
| `error_message` | 오류 메시지 | 실패 시 |
| `created_at` | 생성 시각 | |
| `started_at` | 시작 시각 | |
| `finished_at` | 종료 시각 | |

---

## datasets — 데이터셋

서버에 있는 파일 카탈로그. 업로드, DB 추출, 변환 결과.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID. 업로드는 파일 ID와 같음 |
| `kind` | 출처 | `upload` \| `database` \| `api` \| `transform` |
| `extract_id` | 추출 ID | DB 추출이면 `extracts.id`. 업로드는 비움 |
| `filename` | 파일명 | 표시용 |
| `stored_path` | 저장 경로 | 상대 경로. 유일 |
| `size_bytes` | 크기 | 바이트 |
| `delimiter` | 구분자 | CSV 구분자 |
| `has_header` | 헤더 여부 | `0`/`1` |
| `columns_json` | 컬럼 목록 | inspect 결과 JSON |
| `row_count` | 행 수 | |
| `inspected_at` | 검사 시각 | 마지막 inspect |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |
| `workspace_id` | 작업 공간 ID | `workspaces.id` |
| `producer_task_run_id` | 생산 실행 ID | 이 파일을 만든 `task_runs.id` |

---

## connections — 데이터베이스 커넥션

작업 공간에 속하지 않는 전역 접속 정보.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `name` | 이름 | 표시 이름 |
| `driver` | 드라이버 | `postgres` \| `mysql` \| `mariadb` \| `mssql` \| `sqlite` 등 |
| `host` | 호스트 | 호스트. sqlite는 경로 보조값 |
| `port` | 포트 | sqlite는 `0` |
| `database_name` | 데이터베이스 | DB 이름. sqlite는 파일 경로 |
| `username` | 사용자 | 접속 계정 |
| `password_cipher` | 암호문 | 암호화된 비밀번호 |
| `ssl` | SSL | `0`/`1` |
| `created_at` | 생성 시각 | |

---

## extracts — 추출 실행 (호환)

DB에서 파일로 뽑은 기존 추출 이력. 새 Extract TaskRun도 이 테이블에 한 행을 남긴다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `connection_id` | 커넥션 ID | `connections.id` |
| `table_name` | 테이블명 | `schema.table` 또는 SQL 추출 표시명 |
| `delimiter` | 구분자 | 출력 구분자. 쉼표, tab 등 |
| `header` | 헤더 여부 | `0`/`1` |
| `status` | 상태 | `queued` \| `running` \| `succeeded` \| `failed` |
| `stored_path` | 저장 경로 | 파일 상대 경로 |
| `filename` | 파일명 | |
| `row_count` | 행 수 | |
| `error_message` | 오류 메시지 | |
| `created_at` | 생성 시각 | |
| `started_at` | 시작 시각 | |
| `finished_at` | 종료 시각 | |
| `sql_text` | SQL | 실행한 쿼리. 테이블 추출이면 비울 수 있음 |
| `catalog_database` | 카탈로그 DB | 카탈로그에서 고른 데이터베이스 |

---

## transforms — 변환 정의 (호환)

기존 변환 화면의 저장 정의. 입력 데이터셋과 TransformSpec JSON.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `name` | 이름 | |
| `dataset_id` | 입력 데이터셋 ID | `datasets.id` |
| `spec_json` | 스펙 | TransformSpec v2 JSON |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

---

## jobs — 변환·적재 작업 (호환)

기존 변환(및 예약된 적재) 실행. 새 Transform TaskRun도 이 테이블에 한 행을 남긴다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `status` | 상태 | `queued` \| `running` \| `succeeded` \| `failed` \| `canceled` |
| `source_path` | 입력 경로 | 입력 파일 상대 경로 |
| `output_path` | 출력 경로 | 출력 파일 상대 경로 |
| `spec_json` | 스펙 | 변환 스펙 JSON |
| `error_message` | 오류 메시지 | |
| `created_at` | 생성 시각 | |
| `started_at` | 시작 시각 | |
| `finished_at` | 종료 시각 | |
| `kind` | 종류 | 현재 `transform` |
| `transform_id` | 변환 정의 ID | `transforms.id` |
| `dataset_id` | 데이터셋 ID | 입력 `datasets.id` |

---

## job_logs — 작업 로그

`jobs` 실행 중 남긴 로그. TaskRun 로그 API도 연결된 job의 이 행을 읽는다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | 자동 증가 |
| `job_id` | 작업 ID | `jobs.id` |
| `ts` | 시각 | RFC3339 |
| `level` | 레벨 | `info` \| `error` 등 |
| `message` | 내용 | |
