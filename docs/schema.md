# BinTL SQLite 스키마

기준일은 2026-09-06이며 `0001_schema.sql` 하나가 새 DB의 기준선이다. 현재 데이터는 마이그레이션하지 않고 새 DB를 생성한다. SQLite는 WAL과 Foreign Key 검사를 사용한다.

## 원칙

- `extracts`, `transforms`, `loads`는 단독 페이지에서도 저장·실행할 수 있는 서로 다른 ETL 정의다. 컬럼을 억지로 통일하지 않는다.
- `chips`는 ETL 정의를 참조하는 작업 관리 객체이고, `workspaces`는 칩 배치와 연결을 묶는 그룹이다.
- 모든 실행은 `executions` 아래 `execution_steps`로 기록한다. 입력·출력·로그는 `execution_*` 테이블만 사용한다.
- 실재 파일만 `data_files`에 저장한다. 실행 전 예상 파일을 가짜 경로로 만들지 않고 `workspace_chip_outputs`의 파일명·스키마 계약으로 표현한다.
- 0행 결과도 `data_schemas`에 컬럼 스키마를 보존할 수 있다.
- 폴더 최상위는 `parent_id IS NULL`이며 `root` 레코드는 만들지 않는다.

## 전체 25개 테이블

| 영역 | 테이블 | 역할 |
| --- | --- | --- |
| 인증 | `users`, `roles`, `permissions`, `user_roles`, `role_permissions` | 계정과 RBAC |
| 연결 | `connections` | DB/API 접속 정의 |
| 워크스페이스 | `workspace_folders`, `workspaces`, `workspace_chips`, `workspace_edges`, `workspace_revisions`, `workspace_chip_outputs` | 폴더, 캔버스, 연결, 이력, 출력 계약 |
| ETL 정의 | `extracts`, `transforms`, `loads` | 독립 정의와 revision |
| 작업 | `chips` | 종류별 ETL 정의를 참조하는 칩 |
| 실행 | `executions`, `execution_steps`, `execution_inputs`, `execution_outputs`, `execution_logs` | 통합 실행과 데이터 계보 |
| 데이터 | `data_files`, `data_schemas` | 실제 파일과 컬럼 스키마 |
| 검색 | `search_documents`, `search_recent_queries` | 검색 인덱스와 최근 검색어 |

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
```

`transforms.default_input_file_id`와 `loads.default_input_file_id`는 단독 페이지의 기본 입력이다. 캔버스에서는 data 연결로 받은 upstream의 최신 출력이 이를 우선한다.

`chips`는 종류에 따라 `extract_id`, `transform_id`, `load_id` 중 해당 참조만 사용한다. 확정 전 초안은 참조가 비어 있을 수 있고 임시 설정은 `config_json`에 둔다.

`execution_steps.definition_snapshot_json`과 `definition_revision`은 실행 당시 정의를 고정한다. 외부 UI API의 `/api/datasets`, `/api/jobs` 명칭은 전환 기간 동안 유지할 수 있지만 물리 DB에는 구형 `datasets`, `jobs`, `*_runs`, `*_recipes`, `data_resources` 테이블을 만들지 않는다.

## 데이터 검증 확장 방향

현재 1차 구현은 `POST /api/validations/run`으로 두 `data_files`를 즉시 비교한다. 행 수, 컬럼 구성, 복합 키 누락·추가·중복, 지정 컬럼 값 불일치를 하나의 결과로 반환한다. 캔버스의 `validation` 칩도 같은 엔진을 사용하며, 초기 단계에서는 비교 설정을 `chips.config_json`에 저장한다.

검증 칩의 data 입력은 upstream 추출·변환 칩의 최신 출력(target)이고, 편집 화면에서 고른 데이터 파일은 비교 기준(source)이다. 실행 시 target은 `execution_inputs`에 기록되며, 검증 결과 요약은 `execution_steps.result_json`에 저장된다. 검증은 새 데이터를 생산하지 않으므로 `execution_outputs`와 `workspace_chip_outputs`를 만들지 않는다. 차이가 발견되면 검증 단계는 `failed`가 되어 `on_error` 제어선으로 분기할 수 있다.

재사용 가능한 검증 규칙 관리 기능을 추가할 때는 다음 정규화를 한 묶음으로 진행한다.

- `validations`: 비교 기준 파일 또는 추출 정의, 복합 키, 비교 컬럼, 행 수·스키마 검사 옵션과 revision을 저장한다.
- `validation_results`: 실행 단계별 검증 요약과 샘플 차이를 저장한다. 대량 불일치 전체를 JSON에 넣지 않고 별도 산출 파일로 연결할 수 있게 한다.
- `chips.validation_id`와 `execution_steps.validation_id`를 추가하고 현재 `config_json` 설정을 `validations`로 승격한다.
- data 연결로 받은 upstream 최신 출력은 검증 대상(target)이 되고, 검증 페이지에서 고른 데이터 파일 또는 추출 칩 결과는 비교 기준(source)이 된다.
- 실행 당시 두 입력은 모두 `execution_inputs`에 `source`, `target` 포트로 기록하여 현재 target 중심 계보를 보강한다.
- 검증은 데이터를 생산하지 않으므로 `execution_outputs`나 `workspace_chip_outputs`를 만들지 않는다. 이후 제어 연결은 검증 단계의 성공/실패 상태를 사용한다.

독립 검증과 캔버스 검증 칩은 현재 동작하지만, 규칙 카탈로그·revision·대량 불일치 산출 파일은 위 정규화 단계에서 추가한다.
