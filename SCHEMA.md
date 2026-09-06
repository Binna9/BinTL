BinTL 데이터베이스 스키마 (현행화)

이 문서는 현재 코드베이스에 반영된 DB 스키마의 핵심 테이블, 주요 컬럼, 제약사항, 그리고 동작상의 주의점을 정리합니다. 주로 `crates/storage/migrations/0001_schema.sql`과 저장소 코드(`crates/storage/src/*`, `crates/server/src/*`)를 기준으로 작성했습니다.

목차
- 핵심 테이블 요약
- 데이터셋(Dataset) 관련
- Transform / Extract / Load 정의 모델
- 칩(Chip) 및 워크스페이스 배치
- 실행(Execution) 관련 테이블
- 동시성/업서트 관련 구현 노트
- 설계/주의사항 및 권장 동작

핵심 테이블 요약
- workspaces: 워크스페이스 메타데이터 (id, owner_user_id, viewport_json 등)
- users, roles, permissions 등: 인증/권한 관련
- connections: 데이터베이스/HTTP 연결 정보
- data_schemas: 스키마 캐시 (id, fingerprint, columns_json)
- data_files (주요 테이블):
  - id (PK)
  - workspace_id (FK -> workspaces)
  - schema_id (FK -> data_schemas)
  - kind (upload|database|api|transform|load)
  - format, filename
  - stored_path (UNIQUE)
  - size_bytes, row_count, delimiter, has_header, inspected_at
  - created_at, updated_at, deleted_at
- transforms: 변환 정의(전역 정의)
  - id (PK), owner_user_id, name, default_input_file_id (nullable), spec_json,
    output_format, output_filename_template, revision, active, timestamps
  - transforms 테이블 자체에 workspace_id 컬럼은 없음(전역 정의)
- loads: 적재 정의 (id, owner_user_id, default_input_file_id, destination_json, write_mode, ...)
- extracts: 추출 정의 (id, owner_user_id, connection_id, source_json, output_filename, ...)
- chips: UI 상의 칩(인스턴스 정의) — extract/transform/load/validation 레퍼런스(외래키) 포함
- workspace_chips: 칩의 워크스페이스 배치(placement) — workspace_id, chip_id, 위치(x,y)
- workspace_edges: 워크스페이스 내 칩 간 연결 (from_workspace_chip_id, to_workspace_chip_id, kind=data|on_success|...)
- workspace_chip_outputs: 칩 출력 슬롯의 현재 상태(워크스페이스-범위)
  - columns: workspace_chip_id, port_name, current_data_file_id, expected_filename, definition_revision, updated_at
- executions / execution_steps / execution_outputs / execution_inputs: 실행(큐잉/런) 및 입출력 추적

데이터셋(Dataset) 관련 상세
- data_files.stored_path는 UNIQUE 제약이 걸려 있음
  - 동일한 파일 경로(stored_path)가 여러 데이터파일 id로 중복 생성되면 안 됨
- Dataset의 상태 표현
  - 코드에서 DatasetRow.status 값으로 materialized / planned 를 구분
  - "planned" dataset은 실제 data_files row가 없거나(또는 가상 계약(contract:...)) 출력이 아직 materialize 되지 않은 경우의 스키마/미리보기 용 데이터
- Planned contract id
  - planned input을 표현하기 위해 `contract:{workspace_id}:{consumer_chip_id}` 형태의 가상 id를 사용
  - UI는 이 계약 id를 보고 스키마/미리보기를 보여주며, 서버는 이 케이스를 특별 처리해야 함
  - validate/require 경로에서는 이 가상 id를 직접 get_dataset()로 조회하면 "dataset not found"가 발생하므로 케이스 분기 필요

Transform / Extract / Load 정의 모델
- Definition(정의)은 전역으로 관리
  - transforms, extracts, loads 테이블은 일반적으로 전역 정의를 저장함
  - 같은 정의를 여러 워크스페이스에 놓을 수 있도록 설계됨
- 워크스페이스 컨텍스트 계산
  - transform의 "워크스페이스"는 직접 컬럼에 기록되어 있지 않음
  - 대신 get_transform(), get_transform_for_chip() 등의 조회에서 `COALESCE(d.workspace_id, (SELECT wc.workspace_id ...)) AS workspace_id` 형태로 결정
  - default_input_file_id가 채워져 있다면 그 data_files의 workspace_id를 우선 사용
  - transform이 워크스페이스에 배치된 경우(workspace_chips에 있으면) 해당 placement의 workspace_id를 사용
- 이유
  - 정의는 재사용되기 때문에, 정의 자체에 워크스페이스를 고정시키지 않음
  - 그러나 UI/작업 실행 시에는 '현재 문맥(workspace에 배치된 칩)'에 속한 것으로 취급해야 하므로 조회 시 동적으로 조합함

칩(Chip) 및 워크스페이스 배치
- chips: 칩의 기본 정보 및 바인딩(ref) (extract_id, transform_id, load_id)
- workspace_chips: 워크스페이스 상의 배치(placement)
  - placement에 의해 동일한 정의가 서로 다른 워크스페이스에서 서로 다르게 동작할 수 있음
- workspace_edges: 데이터 흐름(데이터 엣지) 정보는 여기 저장됨. planned input 생성은 이 테이블을 기준으로 upstream chip을 찾아 스키마를 추적

실행(Execution) 관련
- executions, execution_steps: 실행 단위와 단계
- execution_outputs: execution step의 출력(데이터파일 id 연결)
- execution_inputs: 실행의 입력 데이터파일 참조

동시성 / 업서트 구현 노트
- data_files.stored_path는 UNIQUE이므로, 복수 칩이 거의 동시에 같은 경로를 만들 때 UNIQUE constraint 오류가 발생할 수 있음
- 최근 코드 변경(저장소의 chip_run_repo.upsert_chip_output_slot_dataset)에서 이 상황을 방지하기 위해
  - INSERT ... ON CONFLICT(stored_path) DO UPDATE ... 를 사용
  - INSERT 후 canonical id를 SELECT로 재조회하여 이후 참조(execution_outputs, workspace_chip_outputs 등)에 사용
- 이로써 TOCTOU(race) 문제를 완화함

설계/주의사항 및 권장 동작
1. "정의(Transforms/Loads/Extracts)는 전역"이라는 현재 가정이 문서화되어야 합니다.
   - 만약 정의가 워크스페이스에 귀속되어야 한다면 스키마 변경(예: transforms.workspace_id 또는 workspace_transforms 매핑 테이블)을 고려해야 합니다.
2. Planned vs Materialized의 구분을 서버 API 스펙에 명확히 문서화하세요.
   - validate 함수는 planned contract id를 허용하거나, planned를 별도로 resolvable하게 해야 함
3. stored_path 유니크 정책
   - stored_path는 단일 소스(파일 경로)를 가리키는 canonical 키입니다. 파일을 덮어쓰는 상황이 아닌 이상 중복 금지입니다.
   - 동시성 환경에서의 업서트 처리는 필수입니다(현재 ON CONFLICT 처리 권장).
4. DB 뷰(또는 서버 레이어 헬퍼)를 도입해 COALESCE/서브쿼리의 중복을 줄이세요.
   - 예: transform_with_workspace 뷰를 만들어 `dataset_id`, `workspace_id`, `input_chip_id`등을 정리하면 코드가 훨씬 간단해집니다.

참고: 소스 위치
- 마이그레이션: crates/storage/migrations/0001_schema.sql
- 데이터셋/레포지토리 구현: crates/storage/src/dataset_repo.rs, chip_run_repo.rs, transform_repo.rs, load_repo.rs
- planned-input / slot 관련 서버 로직: crates/server/src/planned_input.rs
- load/validate 로직: crates/server/src/load.rs
- chip JSON / chip workspace view: crates/server/src/chip.rs

원하면 이 SCHEMA.md를 기반으로 다음 작업도 해드리겠습니다:
- DB 뷰(SQL) 초안 (예: transform_with_workspace 뷰)
- 스키마 다이어그램(간단한 ERD)
- transforms.workspace_id 추가 마이그레이션 초안 및 backfill 전략

(끝)