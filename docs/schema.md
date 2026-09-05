# SQLite 스키마 (`data/etl.db`)

현행화: 2026-09-05 (실DB·코드 `_sqlx_migrations` = **1…23**, 전부 적용)

SQLite는 `COMMENT ON`을 지원하지 않는다. 테이블·컬럼 의미는 이 문서가 기준이다.

마이그레이션은 `crates/storage/migrations/`에 있다. 시각 컬럼은 RFC3339 문자열이다. 불리언은 INTEGER `0`/`1`이다.

한 설치(SQLite 하나)는 회사 하나다. 커넥션은 조직 공유 자산이고, 일(파일·추출·변환·칩)은 작업 공간에 속한다. 사용자는 작업 공간을 여러 개 소유한다. 폴더는 디렉터리처럼 그룹만 잡는다.

```
users
  ├─ user_roles ──► roles ──► role_permissions ──► permissions
  ├─ search_recent_queries
  └─ workspaces.owner_user_id          (1:N)
        ├─ folder_id ──► workspace_folders (중첩 parent_id)
        ├─ workspace_revisions
        ├─ workspace_chips ──► chips ──► chip_bindings
        ├─ chip_edges / chip_runs / chip_output_slots
        └─ datasets / extracts / jobs / transforms
connections          (전역. 쓰기 권한 CONNECTION_WRITE)
search_documents     (통합검색 인덱스. 엔티티별 upsert)
extract_definitions  (칩·추출 화면 카탈로그용 레시피. workspace_id 선택)
```

접근은 역할 문자열이 아니라 `permissions.code`로 판단한다.
`USER_MANAGE`는 사용자 관리, `WORKSPACE_ALL`은 모든 작업 공간, `CONNECTION_WRITE`는 커넥션 쓰기.
작업 공간 멤버 공유(`workspace_members`)는 이후 범위다.

### 추출·변환: 정의 vs 실행 (헷갈리기 쉬운 쌍)

| 역할 | 추출 | 변환 |
| --- | --- | --- |
| **재사용 레시피 (화면 목록 ≈ 이 행 수)** | `extract_definitions` | `transforms` (+ `chip_bindings`) |
| **한 번 실행·파일 산출** | `extracts` → `datasets` | `jobs` → `datasets` |
| **캔버스 칩 실행** | `chip_runs` (`legacy_extract_id` → `extracts`) | `chip_runs` (`legacy_job_id` → `jobs`) |

- UI 추출 카탈로그에 5개가 보이면 **`extract_definitions`가 5행**인 것이 정상이다.
- `extracts`는 “DB에서 파일로 뽑은 **실행 이력**”이다. 한 번만보내기/실행했다면 **1행**이 맞다. 정의 5개 ≠ 실행 5개.
- 칩 경로도 결국 실행 시 `extracts`(+`datasets`)를 만들고 `chip_runs.legacy_extract_id`로 묶는다. 정의 테이블에 row가 늘지 않는다.

```
extract_definitions ──chip_bindings──► chips ──workspace_chips──► canvas
        │                                    │
        │ (실행)                             ▼
        └──────────────► extracts ──► datasets ◄── chip_runs / chip_output_slots
```

---



## users — 사용자

로그인 계정. `id`는 내부 UUID이고, `userid`가 로그인 아이디, `username`이 화면 이름이다.
`password` 컬럼에는 평문이 아니라 argon2 해시만 넣는다. 역할은 이 테이블에 두지 않고 `user_roles`로 붙인다.
삭제는 없고 비활성만 한다. `USER_MANAGE` 권한을 가진 마지막 사용자는 강등·비활성할 수 없다.

최초 기동 시 사용자가 없으면 설정 파일 `[auth]` 계정으로 만들고 admin 역할을 붙인 뒤, 기존 기본 작업 공간을 그 사용자 소유로 귀속한다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | 내부 ID | UUID. FK·세션에 사용 |
| `userid` | 사용자 아이디 | 로그인 ID. 대소문자 무시 유일 |
| `username` | 사용자명 | 화면 표시 이름 |
| `password` | 비밀번호 | argon2 해시 |
| `active` | 활성 | `1` 활성, `0` 비활성 |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

## roles — 역할

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `code` | 코드 | `admin` \| `operator` \| `analyst` \| `viewer` |
| `name` | 이름 | 표시 이름 |
| `description` | 설명 | |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

## permissions — 권한

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `code` | 코드 | `USER_MANAGE`, `CONNECTION_WRITE`, `WORKSPACE_ALL` 등 |
| `name` | 이름 | 표시 이름 |
| `description` | 설명 | |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

## user_roles — 사용자별 역할

`(user_id, role_id)`가 키다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `user_id` | 사용자 | `users.id` |
| `role_id` | 역할 | `roles.id` |
| `created_at` | 부여 시각 | |

## role_permissions — 역할별 권한

`(role_id, permission_id)`가 키다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `role_id` | 역할 | `roles.id` |
| `permission_id` | 권한 | `permissions.id` |
| `created_at` | 부여 시각 | |


---



## workspace_folders — 작업 공간 폴더

서버 디렉터리처럼 중첩 그룹. 폴더만 담을 수 있고, 실제 작업은 `workspaces`에 둔다.

예: `프로젝트이름` → `국가사업관련` → 그 아래 워크스페이스 1, 2, 3

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID |
| `owner_user_id` | 소유자 | `users.id` |
| `parent_id` | 상위 폴더 | `workspace_folders.id`. 루트면 비움 |
| `name` | 이름 | 표시 이름 |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |

## workspaces — 작업 공간

ETL 설정, 실행, 파일을 묶는 프로젝트. 사용자는 여러 개를 소유한다. 소유자만 보이며, `WORKSPACE_ALL`은 전체를 본다.

| 컬럼 | 한글명 | 설명 |
| --- | --- | --- |
| `id` | ID | UUID. 첫 설치 기본 작업 공간은 `00000000-0000-0000-0000-000000000001` |
| `name` | 이름 | 표시 이름 |
| `description` | 설명 | 선택 |
| `layout_json` | 캔버스 배치 | `{ "nodes": { "<chip_id>": { "x", "y" } } }` |
| `version` | 버전 | 생성 시 `1`. 캔버스 저장마다 1 증가 |
| `created_at` | 생성 시각 | |
| `updated_at` | 수정 시각 | |
| `owner_user_id` | 소유자 | `users.id` |
| `folder_id` | 폴더 | `workspace_folders.id`. 루트면 비움 |


---



## workspace_revisions — 작업 공간 스냅샷

저장 시점의 캔버스와 작업 정의. `(workspace_id, version)`이 키다.


| 컬럼              | 한글명      | 설명                       |
| --------------- | -------- | ------------------------ |
| `workspace_id`  | 작업 공간 ID | `workspaces.id`          |
| `version`       | 버전       | `workspaces.version`과 대응 |
| `snapshot_json` | 스냅샷      | 당시 레이아웃·칩·연결선 JSON       |
| `created_at`    | 생성 시각    |                          |


---



## chips — 칩 (최소 작업 단위)

재사용 가능한 Extract / Transform / Load 칩 카탈로그. 워크스페이스와 **M:N** (`workspace_chips`).
실행 시 `chip_bindings`로 정의 테이블을 조회하고, `chip_runs.config_snapshot_json`에 스냅샷을 남긴다.


| 컬럼             | 한글명      | 설명                                        |
| -------------- | -------- | ----------------------------------------- |
| `id`           | ID       | UUID                                      |
| `owner_user_id` | 소유자 ID | `users.id`                                |
| `name`         | 이름       | 표시 이름                                     |
| `kind`         | 종류       | `extract` \| `transform` \| `load`          |
| `config_json`  | 설정 (레거시) | 등록 칩은 NULL. 초안 칩만 임시 저장                  |
| `revision`     | 리비전      | 정의 변경 시 증가                                 |
| `active`       | 활성       | `1` 활성, `0` 비활성                           |
| `created_at`   | 생성 시각    |                                           |
| `updated_at`   | 수정 시각    |                                           |


## chip_bindings — 칩 ↔ 정의 매핑

칩 1개당 정의 1개 (`extract_definitions` 또는 `transforms`).


| 컬럼         | 한글명   | 설명                                              |
| ---------- | ----- | ----------------------------------------------- |
| `chip_id`  | 칩 ID  | PK, `chips.id`                                  |
| `ref_kind` | 참조 종류 | `extract_definition` \| `transform`             |
| `ref_id`   | 참조 ID | `extract_definitions.id` 또는 `transforms.id` |


## workspace_chips — 워크스페이스 ↔ 칩 (M:N)

캔버스에 올린 칩. 같은 칩을 여러 워크스페이스에 배치할 수 있다.


| 컬럼             | 한글명      | 설명              |
| -------------- | -------- | --------------- |
| `workspace_id` | 작업 공간 ID | `workspaces.id` |
| `chip_id`      | 칩 ID     | `chips.id`      |
| `created_at`   | 배치 시각    |                 |


## extract_definitions — 추출 정의

DB/API 추출 **레시피**(카탈로그·칩 바인딩 대상). 화면 “추출” 목록 개수는 여기 행 수에 대응한다.
실행·파일 산출은 `extracts` / `datasets`이고, 이 테이블에는 실행 상태가 없다.


| 컬럼              | 한글명      | 설명                          |
| --------------- | -------- | --------------------------- |
| `id`            | ID       | UUID                        |
| `name`          | 이름       |                             |
| `kind`          | 종류       | `database` \| `api`         |
| `connection_id` | 커넥션 ID   | `connections.id`            |
| `source_json`   | 소스       | `{ type, table/sql, ... }`  |
| `delimiter`     | 구분자      |                             |
| `header`        | 헤더 여부    |                             |
| `add_sequence`  | 순번 추가    |                             |
| `workspace_id`  | 작업 공간 ID | 배치 전에는 비울 수 있음 (0018). 캔버스에 올릴 때와 무관하게 카탈로그에만 둘 수 있다 |
| `created_at`    | 생성 시각    |                             |
| `updated_at`    | 수정 시각    |                             |


---



## chip_edges — 칩 연결선

칩과 칩을 잇는 선. 좌표는 `layout_json`에 두고, 연결 정보는 이 테이블에 둔다.


| 컬럼             | 한글명      | 설명                                                        |
| -------------- | -------- | --------------------------------------------------------- |
| `id`           | ID       | UUID                                                      |
| `workspace_id` | 작업 공간 ID | `workspaces.id`                                           |
| `from_chip_id` | 출발 칩     | `chips.id`                                                |
| `to_chip_id`   | 도착 칩     | `chips.id`                                                |
| `kind`         | 종류       | `data` \| `on_success` \| `on_error` \| `always`                      |
| `from_port`    | 출발 포트    | 기본 `out`                                                  |
| `to_port`      | 도착 포트    | 기본 `in`                                                   |
| `created_at`   | 생성 시각    |                                                           |

`kind`는 `data` \| `on_success` \| `on_error` \| `always`다. 0023에서 기존 `then`을 `always`로 이전했고 DB CHECK와 UI·서버 값이 일치한다.

같은 워크스페이스에서 `(from_chip_id, to_chip_id, kind)`는 유일하다. 사이클은 저장 시 거부한다. `data` 선은 추출·변환에서 시작해 변환·적재로만 갈 수 있다.

## chip_output_slots — 칩 산출 슬롯

워크스페이스에 배치된 칩마다 **최신 성공 산출 dataset**을 한 칸에 고정한다. 같은 `(workspace_id, chip_id)`에서 재실행하면 dataset 행을 덮어쓴다.

| 컬럼             | 한글명      | 설명                          |
| -------------- | -------- | --------------------------- |
| `workspace_id` | 작업 공간 ID | PK 일부, `workspaces.id`      |
| `chip_id`      | 칩 ID     | PK 일부, `chips.id`           |
| `dataset_id`   | 데이터셋 ID  | `datasets.id`. 유일 (한 파일은 슬롯 하나) |
| `created_at`   | 생성 시각    |                             |
| `updated_at`   | 수정 시각    |                             |

슬롯이 없으면 `chip_runs`에서 마지막 succeeded 출력을 fallback으로 본다.

---



## chip_runs — 칩 실행

한 번의 실행 기록. 정의가 바뀌어도 당시 설정은 그대로 남는다.


| 컬럼                     | 한글명        | 설명                                                                    |
| ---------------------- | ---------- | --------------------------------------------------------------------- |
| `id`                   | ID         | UUID                                                                  |
| `chip_id`              | 칩 ID       | `chips.id`                                                            |
| `workspace_id`         | 작업 공간 ID   | `workspaces.id`                                                       |
| `kind`                 | 종류         | 실행 당시 `extract` | `transform` | `load`                                |
| `status`               | 상태         | `queued` | `running` | `succeeded` | `failed`                         |
| `config_snapshot_json` | 설정 스냅샷     | 실행 당시 `config_json` 복사본                                               |
| `revision_snapshot`    | 리비전 스냅샷    | 실행 당시 revision                                                        |
| `input_dataset_id`     | 입력 데이터셋 ID | Transform 입력. Extract는 보통 비움. incoming `data` 선이 있으면 그 선이 config보다 우선 |
| `output_dataset_id`    | 출력 데이터셋 ID | 성공 시 산출 `datasets.id`                                                 |
| `legacy_extract_id`    | 기존 추출 ID   | 호환용 `extracts.id`. 있으면 유일                                             |
| `legacy_job_id`        | 기존 작업 ID   | 호환용 `jobs.id`. 있으면 유일                                                 |
| `error_message`        | 오류 메시지     | 실패 시                                                                  |
| `created_at`           | 생성 시각      |                                                                       |
| `started_at`           | 시작 시각      |                                                                       |
| `finished_at`          | 종료 시각      |                                                                       |


---



## datasets — 데이터셋

서버에 있는 파일 카탈로그. 업로드, DB 추출, 변환 결과.


| 컬럼                     | 한글명      | 설명                                          |
| ---------------------- | -------- | ------------------------------------------- |
| `id`                   | ID       | UUID. 업로드는 파일 ID와 같음                        |
| `kind`                 | 출처       | `upload` | `database` | `api` | `transform` |
| `extract_id`           | 추출 ID    | DB 추출이면 `extracts.id`. 업로드는 비움              |
| `filename`             | 파일명      | 표시용                                         |
| `stored_path`          | 저장 경로    | 상대 경로. 유일                                   |
| `size_bytes`           | 크기       | 바이트                                         |
| `delimiter`            | 구분자      | CSV 구분자                                     |
| `has_header`           | 헤더 여부    | `0`/`1`                                     |
| `columns_json`         | 컬럼 목록    | inspect 결과 JSON                             |
| `row_count`            | 행 수      |                                             |
| `inspected_at`         | 검사 시각    | 마지막 inspect                                 |
| `created_at`           | 생성 시각    |                                             |
| `updated_at`           | 수정 시각    |                                             |
| `workspace_id`         | 작업 공간 ID | `workspaces.id`                             |
| `producer_chip_run_id` | 생산 실행 ID | 이 파일을 만든 `chip_runs.id`                     |
| `status`               | 상태       | `materialized`(실파일) | `planned`(스키마만) |
| `source_chip_id`       | 원본 칩 ID  | planned일 때 upstream extract 칩              |
| `consumer_chip_id`     | 소비 칩 ID  | planned일 때 이 입력을 쓰는 transform 칩         |
| `source_extract_definition_id` | 추출 정의 ID | planned 스키마 출처 `extract_definitions.id` |


`status=planned` 행은 `stored_path`가 `__planned__/{id}` placeholder이며 실파일이 없다. 워크스페이스 저장 시 data 엣지마다 sync된다. upstream은 extract뿐 아니라 transform도 가능하며, 아직 실행 결과가 없으면 데이터 선을 역추적한 뒤 각 TransformSpec v2/v3를 순서대로 적용해 예상 출력 스키마를 다음 transform에 전달한다. 따라서 `Extract → Transform 1 → Transform 2 → …` 체인을 실행 전에 설계·편집할 수 있다.

---



## connections — 데이터베이스 커넥션

작업 공간에 속하지 않는 전역 접속 정보. 전원 사용, 쓰기는 `admin`과 `operator`만.


| 컬럼                | 한글명    | 설명                                                      |
| ----------------- | ------ | ------------------------------------------------------- |
| `id`              | ID     | UUID                                                    |
| `name`            | 이름     | 표시 이름                                                   |
| `driver`          | 드라이버   | `postgres` | `mysql` | `mariadb` | `mssql` | `sqlite` 등 |
| `host`            | 호스트    | 호스트. sqlite는 경로 보조값                                     |
| `port`            | 포트     | sqlite는 `0`                                             |
| `database_name`   | 데이터베이스 | DB 이름. sqlite는 파일 경로                                    |
| `username`        | 사용자    | 접속 계정                                                   |
| `password_cipher` | 암호문    | 암호화된 비밀번호                                               |
| `ssl`             | SSL    | `0`/`1`                                                 |
| `created_at`      | 생성 시각  |                                                         |


---



## extracts — 추출 실행 (호환)

커넥션에서 서버 파일로 뽑은 **실행 이력**(레시피 아님). UI 추출 목록의 N개와 행 수가 같을 필요 없다 — 그건 `extract_definitions`다.
종류는 `database`(DB)와 `api`(HTTP)다. 디스크 경로는 `extracts/{databases|api}/{id}/…` 이고, 성공 시 같은 id로 `datasets` 행이 생기거나 연결된다.
DB와 HTTP API 추출 모두 실행된다. HTTP 설정은 `sql_text`에 직렬화한 요청 스펙을 보관하는 호환 구조를 사용한다.
칩 실행도 내부적으로 이 테이블에 한 행을 남기고 `chip_runs.legacy_extract_id`로 가리킨다.


| 컬럼                 | 한글명      | 설명                                            |
| ------------------ | -------- | --------------------------------------------- |
| `id`               | ID       | UUID. 성공 시 `datasets.id`와 같게 쓰는 경로가 있음          |
| `kind`             | 추출 종류    | `database` \| `api`                           |
| `connection_id`    | 커넥션 ID   | 소스 커넥션. DB는 `connections.id`, API는 이후 확장       |
| `table_name`       | 추출 대상    | DB: `schema.table` 또는 `query`. API: 리소스/표시명   |
| `delimiter`        | 구분자      | 출력 구분자. 쉼표, tab 등                             |
| `header`           | 헤더 여부    | `0`/`1`                                       |
| `add_sequence`     | 순번 추가    | `0`/`1` (0010)                                |
| `status`           | 상태       | `queued` \| `running` \| `succeeded` \| `failed` |
| `stored_path`      | 저장 경로    | 파일 상대 경로                                      |
| `filename`         | 파일명      |                                               |
| `row_count`        | 행 수      |                                               |
| `error_message`    | 오류 메시지   |                                               |
| `created_at`       | 생성 시각    |                                               |
| `started_at`       | 시작 시각    |                                               |
| `finished_at`      | 종료 시각    |                                               |
| `sql_text`         | SQL      | DB 쿼리 추출 시 실행한 SQL. 테이블/API면 비울 수 있음          |
| `catalog_database` | 카탈로그 DB  | 카탈로그에서 고른 데이터베이스                              |
| `output_filename`  | 출력 파일명   | DB 내보내기 시 사용자가 지정한 이름. 칩 실행과 무관할 수 있음         |
| `workspace_id`     | 작업 공간 ID | `workspaces.id`. 목록·접근은 소유 범위                 |


---



## transforms — 변환 정의

변환 레시피의 저장 정의. 입력 데이터셋(기준/왼쪽)과 TransformSpec JSON을 보관한다. 현재 UI는 순서가 명시된 v3를 저장하며 엔진은 기존 v2도 읽는다.


| 컬럼             | 한글명        | 설명                    |
| -------------- | ---------- | --------------------- |
| `id`           | ID         | UUID                  |
| `name`         | 이름         |                       |
| `dataset_id`   | 입력 데이터셋 ID | `datasets.id`. combine 시 기준 파일 |
| `input_chip_id`| 입력 칩 ID    | 워크스페이스 transform 칩과 연결 (planned 입력) |
| `spec_json`    | 스펙         | TransformSpec v3 JSON (아래). 기존 v2도 호환 |
| `created_at`   | 생성 시각      |                       |
| `updated_at`   | 수정 시각      |                       |
| `workspace_id` | 작업 공간 ID   | 입력 데이터셋과 같은 작업 공간     |

### `spec_json` (TransformSpec v3)

엔진·UI 공통. SQLite 컬럼은 아니지만 이 테이블에 저장되는 JSON 형태다. `operations` 배열 순서대로 정제·붙이기·집계를 실행한다.

```json
{
  "version": 3,
  "read": { "delimiter": ",", "has_header": true },
  "sink": "parquet",
  "operations": [
    {
      "type": "clean",
      "steps": [
        { "op": "filter", "expr": "amount >= 1" },
        { "op": "select", "columns": ["id", "amount"] }
      ]
    },
    {
      "type": "join",
      "right_dataset_id": "<datasets.id>",
      "on": ["id"],
      "how": "left"
    },
    {
      "type": "aggregate",
      "group_by": ["department"],
      "aggregations": [
        { "column": "amount", "function": "sum", "alias": "amount_sum" }
      ]
    }
  ]
}
```

| 필드 | 설명 |
| --- | --- |
| `version` | 현재 `3`. v3는 `operations`가 필수이며 `dest`를 허용하지 않는다 |
| `operations` | 실행 순서가 보존되는 작업 배열 |
| `operations[].type=clean` | 정제 스텝 묶음. `select`, `drop`, `rename`, `filter`, `cast`, `fill_null`, `sort`, `unique` |
| `operations[].type=join` | 가로 조인. `right_dataset_id`, `on`, `how(left/inner)` 사용 |
| `operations[].type=union` | 세로 이어 붙이기. `dataset_ids` 사용 |
| `operations[].type=aggregate` | 그룹 집계. `group_by`와 `aggregations` 사용. 함수는 `sum`, `count`, `mean`, `min`, `max` |

미리보기·실행 시 서버가 `right_dataset_id` / `dataset_ids`를 파일 경로로 풀어 엔진에 넘긴다. DB에는 dataset ID만 남긴다. 기존 v2의 최상위 `steps`와 `combine`은 읽기 호환용으로 유지한다.

UI 정식 경로는 `/transform`과 `/transform/:id`이며 `?section=clean|combine|aggregate`로 편집 섹션을 고른다. 캔버스 칩 편집은 `/workspace/:workspaceId/chips/:chipId/transform/:id` 형태다.


---



## jobs — 변환·적재 작업 (호환)

기존 변환(및 예약된 적재) 실행. 새 Transform TaskRun도 이 테이블에 한 행을 남긴다.


| 컬럼              | 한글명      | 설명                                                         |
| --------------- | -------- | ---------------------------------------------------------- |
| `id`            | ID       | UUID                                                       |
| `status`        | 상태       | `queued` | `running` | `succeeded` | `failed` | `canceled` |
| `source_path`   | 입력 경로    | 입력 파일 상대 경로                                                |
| `output_path`   | 출력 경로    | 출력 파일 상대 경로                                                |
| `spec_json`     | 스펙       | 실행 시점 TransformSpec JSON. combine 실행 시 경로가 풀린 스냅샷이 들어갈 수 있다 |
| `error_message` | 오류 메시지   |                                                            |
| `created_at`    | 생성 시각    |                                                            |
| `started_at`    | 시작 시각    |                                                            |
| `finished_at`   | 종료 시각    |                                                            |
| `kind`          | 종류       | 현재 `transform`                                             |
| `transform_id`  | 변환 정의 ID | `transforms.id`                                            |
| `dataset_id`    | 데이터셋 ID  | 입력 `datasets.id`                                           |
| `workspace_id`  | 작업 공간 ID | `workspaces.id`                                            |


---



## job_logs — 작업 로그

`jobs` 실행 중 남긴 로그. TaskRun 로그 API도 연결된 job의 이 행을 읽는다.


| 컬럼        | 한글명   | 설명                 |
| --------- | ----- | ------------------ |
| `id`      | ID    | 자동 증가              |
| `job_id`  | 작업 ID | `jobs.id`          |
| `ts`      | 시각    | RFC3339            |
| `level`   | 레벨    | `info` | `error` 등 |
| `message` | 내용    |                    |


---



## search_documents — 통합검색 인덱스

헤더 통합검색용 **비정규화 인덱스**. 원본 테이블 변경 시 storage가 upsert한다. `(entity_type, entity_id)`가 유일하다.


| 컬럼              | 한글명      | 설명 |
| --------------- | -------- | --- |
| `id`            | ID       | `{entity_type}:{entity_id}` 형태 |
| `entity_type`   | 엔티티 종류  | `workspace_folder` \| `workspace` \| `chip` \| `dataset` \| `connection` \| `extract` \| `transform` |
| `entity_id`     | 엔티티 ID   | 원본 PK |
| `title`         | 제목       | 검색 결과 한 줄 제목 |
| `subtitle`      | 부제       | 종류·출처 라벨 |
| `keywords`      | 키워드      | LIKE 검색용. 이름·경로·SQL 등을 소문자로 이어 붙임 |
| `route`         | 이동 경로    | UI 라우트 (예: `/transform/:id`) |
| `scope`         | 노출 범위    | `global` (전원) \| `user` (소유자) \| `workspace` (작업 공간 소유) |
| `workspace_id`  | 작업 공간 ID | `scope = workspace`일 때 |
| `owner_user_id` | 소유자 ID   | `scope = user`일 때 |
| `updated_at`    | 갱신 시각    | 정렬·표시용 |


쿼리가 비어 있으면 최근 갱신 순 browse, 있으면 `title` / `subtitle` / `keywords` LIKE 매칭 후 `updated_at` 내림차순.


---



## search_recent_queries — 최근 검색어

사용자별 최근 검색어. 저장 시 `(user_id, query)` 중복은 갱신, 사용자당 최대 8건 유지.


| 컬럼            | 한글명   | 설명 |
| ------------- | ----- | --- |
| `id`          | ID    | UUID |
| `user_id`     | 사용자  | `users.id`. CASCADE 삭제 |
| `query`       | 검색어  | 대소문자 무시 유일 (user_id와 쌍) |
| `searched_at` | 검색 시각 | RFC3339 |


---



## 설계 메모 · 고쳐야 할 점

적재 정의는 `load_definitions`, 실행별 적재량·처리 시간·기본 검증 상태는 `load_results`에 저장한다.
`chip_bindings.ref_kind = load_definition`으로 재사용 가능한 적재 칩과 연결한다. 마이그레이션은 **24까지 적용**한다.

1. **정의/실행 이중 구조가 이름만으로 안 드러남**  
   `extracts` ↔ `extract_definitions`, `jobs` ↔ `transforms`, 그리고 또 `chip_runs`가 실행을 감싼다. 신규 개발자가 extracts를 “추출 목록”으로 오해하기 쉽다. 장기적으로는 실행을 `chip_runs`(또는 run 테이블)로 단일화하고 `extracts`/`jobs`는 폐기·뷰화하는 편이 낫다.

2. **`legacy_*`가 아직 본경로**  
   칩 실행이 `legacy_extract_id` / `legacy_job_id`에 의존한다. “호환”이 아니라 현재 구현의 중심축이다. 이름을 `extract_id`/`job_id`로 바꾸거나, 산출은 `output_dataset_id`만으로 추적하도록 정리할 여지가 있다.

3. **`extract_definitions.workspace_id`가 사실상 항상 NULL**  
   0018로 카탈로그 전역화가 됐는데, 컬럼 의미가 “소속 WS / 생성 당시 WS / 미사용”인지 코드·UI가 애매하다. 전역 카탈로그면 컬럼 제거 또는 `owner_user_id`로 소유만 두는 쪽이 명확하다.

4. **빈 변환 칩 = `chip_bindings` 없음**  
   캔버스에 올린 초안 transform은 binding 없이 `config_json`/별도 생성 흐름을 탄다. extract는 정의 없이 칩만 두기 어렵다. 종류별 불일치.

5. **`datasets`에 planned 가상 행**  
   실파일 카탈로그와 설계용 placeholder가 한 테이블에 섞인다(`stored_path = __planned__/…`). 조회·검색·삭제 시 실수로 planned를 노출하기 쉽다. 별도 `planned_inputs` 또는 명확한 필터 규약이 필요하다.

6. **extract id = dataset id 관례**  
   성공 추출에서 두 PK를 같게 쓰는 경로가 있어 `datasets.extract_id`가 자기 자신을 가리키는 형태가 된다. 편하긴 하나 FK 의미·삭제 순서가 헷갈린다.

7. **검색 엔티티 `extract`**
   `search_documents.entity_type`에 `extract`가 있는데 UI 카탈로그의 축은 `extract_definitions`다. 인덱스가 실행 이력만 잡으면 카탈로그 검색과 어긋난다.

## 후속 구조 개선안 · 정의/실행 모델 통일

현재 추출·변환·적재는 서로 다른 시기에 추가되어 정의와 실행을 저장하는 기준이 일관되지 않다.

| 처리 종류 | 현재 정의 | 현재 실행 | 실행 상세/결과 |
| -------- | -------- | -------- | ------------ |
| 추출 | `extract_definitions` | `extracts` + `chip_runs` | `extracts`에 상태가 섞이고 산출은 `datasets` |
| 변환 | `transforms` | `jobs` + `chip_runs` | `jobs`, 산출은 `datasets` |
| 적재 | `load_definitions` | `chip_runs` | `load_results` |

`loads` 실행 테이블을 새로 추가하여 대칭을 맞추지 않는다. 적재의 `chip_runs + load_results` 방식이 목표 구조에 더 가깝고, 추출과 변환에 남은 구형 실행 계층을 공통 실행 모델로 흡수하는 방향으로 정리한다.

### 목표 구조

| 역할 | 목표 테이블 |
| ---- | ---------- |
| 재사용 가능한 설정 | `extract_definitions`, `transform_definitions`, `load_definitions` |
| 캔버스 칩과 정의 연결 | `chip_bindings` |
| 모든 종류의 공통 실행 상태·시간·오류 | `chip_runs` |
| 추출·변환의 실제 산출 파일과 스키마 | `datasets` |
| 종류별 실행 부가 정보 | 필요할 때만 `extract_run_details`, `transform_run_details`, `load_run_details` |
| 실행 전 연결선 기반 예상 입력 | `planned_inputs` |

목표 관계는 다음과 같다.

```text
chips
  ├─ chip_bindings ──► *_definitions
  └─ chip_runs
       ├─ input_dataset_id
       ├─ output_dataset_id
       └─ *_run_details (종류별 부가 정보가 있을 때만)

datasets       실제 추출·변환 결과
planned_inputs 실행 전 예상 입력 스키마
```

### 명명 및 저장 원칙

1. 재사용 설정은 모두 `*_definitions`에 저장한다. 현재 `transforms`는 최종적으로 `transform_definitions`로 바꾼다.
2. 큐 상태, 시작·완료 시각, 오류, 입력·출력 참조는 모두 `chip_runs`가 소유한다.
3. 추출·변환 산출물은 `datasets`에 저장하고 `chip_runs.output_dataset_id`로 참조한다.
4. 적재 건수, 거부 건수, 대상, 검증 결과처럼 공통 실행 컬럼이 아닌 값만 상세 테이블에 둔다. 현재 `load_results`는 `load_run_details`로 바꾸는 것을 검토한다.
5. 스키마만 존재하는 예정 입력은 실제 파일 카탈로그인 `datasets`에 섞지 않고 `planned_inputs`로 분리한다.
6. `legacy_extract_id`, `legacy_job_id`는 제거하고 실행과 산출 추적을 `chip_runs` 기준으로 통일한다.
7. `extracts`와 `jobs`는 신규 쓰기를 먼저 중단한 뒤 호환 뷰 또는 읽기 전용 계층을 거쳐 제거한다.

### 권장 마이그레이션 순서

1. `transform_definitions`, `planned_inputs`, 필요한 `*_run_details` 테이블을 추가한다.
2. 기존 데이터를 새 구조로 백필하고 구·신 구조 간 행 수와 참조 무결성을 검증한다.
3. 서버 쓰기를 새 구조에 이중 기록하여 실행·이력·파일 삭제 동작을 비교한다.
4. 조회 API와 검색 인덱스를 `*_definitions`, `chip_runs`, `datasets` 기준으로 전환한다.
5. 이중 기록을 종료하고 `extracts`, `jobs`, `legacy_*` 참조를 읽기 전용으로 만든다.
6. 충분한 호환 기간과 복구 검증 후 구형 테이블을 뷰로 대체하거나 제거한다.

이 개선은 테이블 이름만 바꾸는 작업이 아니다. 실행 큐, 실행 이력, 결과 파일 생명주기, 삭제 가드, 검색 인덱스와 API 응답을 함께 이전해야 하므로 별도 구조개선 작업으로 진행한다.
