# BinTL SQLite 스키마

기준일은 2026-09-13이다. 새 DB의 기준선은 `0001_schema.sql`이고, 스케줄은 `0002`/`0003`, 워크스페이스 실행 이력은 `0006`, 배치·스케줄 이름 유니크는 `0007`이다. SQLite는 WAL과 Foreign Key 검사를 사용한다.

## 원칙

- `extracts`, `transforms`, `loads`는 단독 페이지에서도 저장·실행할 수 있는 서로 다른 ETL 정의다. 컬럼을 억지로 통일하지 않는다.
- `chips`는 ETL 정의를 참조하는 작업 관리 객체이고, `workspaces`는 칩 배치와 연결을 묶는 그룹이다.
- 모든 실행은 `executions` 아래 `execution_steps`로 기록한다. 입력·출력·로그는 `execution_*` 테이블만 사용한다.
- 실재 파일만 `data_files`에 저장한다. 실행 전 예상 파일을 가짜 경로로 만들지 않고 `workspace_chip_outputs`의 파일명·스키마 계약으로 표현한다.
- 0행 결과도 `data_schemas`에 컬럼 스키마를 보존할 수 있다.
- 폴더 최상위는 `parent_id IS NULL`이며 `root` 레코드는 만들지 않는다.
- 워크스페이스 삭제는 해당 실행·검증 결과·파일을 함께 지운다. 기본 워크스페이스로 이관하지 않는다.
- `workspace_chips`는 `(workspace_id, chip_id)`가 유일이다. 캔버스 저장은 `workspaces.version`을 검사한다.

## 테이블

| 영역 | 테이블 | 역할 |
| --- | --- | --- |
| 인증 | `users`, `roles`, `permissions`, `user_roles`, `role_permissions` | 계정과 RBAC |
| 연결 | `connections` | DB/API 접속. 비밀번호는 `password_cipher` |
| 워크스페이스 | `workspace_folders`, `workspaces`, `workspace_chips`, `workspace_edges`, `workspace_revisions`, `workspace_chip_outputs` | 폴더, 캔버스, 연결, 스냅샷, 출력 계약 |
| 스케줄 | `workspace_schedules` | 워크스페이스 주기 실행 |
| ETL 정의 | `extracts`, `transforms`, `loads` | 재사용 정의. 정의 테이블에 workspace_id를 고정하지 않는다. 문맥은 배치·기본 입력으로 계산 |
| 검증 | `validation_rules`, `validation_results` | 재사용 규칙과 실행 결과 |
| 작업 | `chips` | 종류별 정의를 참조 |
| 실행 | `executions`, `execution_steps`, `execution_inputs`, `execution_outputs`, `execution_logs` | 통합 실행과 계보 |
| 데이터 | `data_files`, `data_schemas` | 실재 파일과 컬럼. `stored_path` UNIQUE |
| 검색 | `search_documents`, `search_recent_queries` | 파생 인덱스 |

칩 실행 로그 원본은 `execution_logs`다. 단계당 최근 500개. `source='chip'` 완료 실행은 칩당 50개로 정리하고 워크스페이스 전체 실행은 그 정리에서 뺀다. [logging.md](logging.md).

적재 수치는 `execution_steps.result_json`이다. `load_results` 테이블은 없다.

### 파일 레이아웃 (`data_dir`)

| 경로 | 용도 |
| --- | --- |
| `etl.db` | SQLite |
| `extract_runs/{uploads,databases,api}/` | 단독 추출·업로드 |
| `chip_outputs/{workspace}/{chip}/` | 칩 최신 출력 슬롯 |
| `outputs/{job_id}/` | 레거시 단독 변환 |
| `loads/{workspace}/{scope}/` | 파일 적재 산출 |
| `logs/` | 쿼리·연결 운영 진단. 칩 로그가 아님 |
| `staging/` | 스프레드시트 커밋 전 |
| `user_images/default-image` | 프로필 기본 이미지 |
| `user_images/{user_id}/` | 계정별 프로필 사진 |

## 주요 관계

```text
workspace_folders -> workspaces
workspaces -> workspace_chips -> chips -> extracts | transforms | loads
workspace_chips -> workspace_edges
workspace_chips -> workspace_chip_outputs -> data_files -> data_schemas

executions -> execution_steps
execution_steps -> execution_inputs  -> data_files
execution_steps -> execution_outputs -> data_files
execution_steps -> execution_logs
validation_rules -> validation_results -> data_files(source, target)
```

`transforms.default_input_file_id`와 `loads.default_input_file_id`는 단독 페이지의 기본 입력이다. 캔버스에서는 data 연결로 받은 upstream의 최신 출력이 이를 우선한다.

`chips`는 종류에 따라 `extract_id`, `transform_id`, `load_id` 중 해당 참조만 사용한다. 확정 전 초안은 참조가 비어 있을 수 있고 임시 설정은 `config_json`에 둔다.

`execution_steps.definition_snapshot_json`과 `definition_revision`은 실행 당시 정의를 고정한다. 외부 UI API의 `/api/datasets`, `/api/jobs` 명칭은 전환 기간 동안 유지할 수 있지만 물리 DB에는 구형 `datasets`, `jobs`, `*_runs`, `*_recipes`, `data_resources` 테이블을 만들지 않는다.

## 데이터 검증

`POST /api/validations/run`은 두 `data_files`를 즉시 비교한다. 행 수, 컬럼 구성, 복합 키 누락·추가·중복, 지정 컬럼 값 불일치를 하나의 결과로 반환한다. `validation_rules`는 이름, 설명, 복합 키, 비교 컬럼, 행 수·스키마 검사 여부, 활성 상태와 revision을 저장하고 독립 실행과 캔버스 칩에서 재사용한다.

검증 칩의 data 입력은 upstream 추출·변환 칩의 최신 출력(target)이고, 편집 화면에서 고른 데이터 파일은 비교 기준(source)이다. 칩은 `config_json.validation_rule_id`로 저장 규칙을 참조하며 기존 수동 `keys`, `columns` 설정도 호환한다. 실행 시 target은 `execution_inputs`에 기록되고 결과 요약은 `execution_steps.result_json`과 `validation_results`에 함께 저장된다. 검증은 새 데이터를 생산하지 않으므로 `execution_outputs`와 `workspace_chip_outputs`를 만들지 않는다. 차이가 발견되면 검증 단계는 `failed`가 되어 `on_error` 제어선으로 분기할 수 있다.

자세한 포트·실패 의미는 [validation.md](validation.md).

## Planned 계약과 동시성

- planned 입력은 `data_files` 행이 아니다. 합성 id `contract:{workspace}:{consumer}`를 `get_dataset`에 넣으면 없다.
- 칩 슬롯 upsert는 `data_files.stored_path` UNIQUE에 `ON CONFLICT DO UPDATE` 후 id를 다시 읽는다.
- 정의(`extracts`/`transforms`/`loads`)는 전역이다. 워크스페이스 문맥은 배치와 기본 입력으로 계산한다.

## 워크스페이스 전체 실행 이력

`0006_workspace_execution_history.sql`부터 전체 실행은 `executions.source = 'workspace'` 한 건으로 기록하고, 실행한 칩의 `execution_steps.execution_id`를 공유한다. 칩 단독 실행은 `source = 'chip'`으로 구분한다. 전체 실행 상태와 종료 시각은 서버 조정 로직이 확정한다. 칩 상태 트리거는 `source != 'workspace'`인 실행만 갱신한다. 사전 검증·조건 생략도 단계는 만든 뒤 `failed`/`skipped`로 표시한다. 큐에는 넣지 않는다.

`GET /api/workspaces/{id}/runs`는 칩 단계 `runs`와 전체 실행 `workspace_runs`를 반환하며, 각 칩 단계에 `execution_id`, `execution_source`가 포함된다. `GET /api/workspaces/{id}/executions`는 전체 실행만 반환한다. 헤더는 최신 전체 실행 상태를 표시하므로 칩 단독 재실행의 영향을 받지 않는다. 실행 이력 화면은 칩 단독 실행과 워크스페이스 실행을 분리하고, 전체 실행 선택 시 해당 실행의 칩 및 로그를 조회한다.

서버 재시작 시 미완료 전체 실행과 미완료 소속 칩은 중단 오류로 종료한다. 기존 기록은 전체 실행의 그룹 식별자가 없으므로 임의로 묶지 않고 기존 칩 실행 이력으로 유지한다.
