# SQLite 스키마 (`data/etl.db`)

작성: 2026-08-31 (0016 → 0021 반영)

SQLite는 `COMMENT ON`을 지원하지 않는다. 테이블·컬럼 의미는 이 문서가 기준이다.

마이그레이션은 `crates/storage/migrations/`에 있다. 아래는 **현재(0021까지 적용된)** 구조다. 시각 컬럼은 RFC3339 문자열이다. 불리언은 INTEGER `0`/`1`이다.

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
extract_definitions  (칩 카탈로그용 추출 정의. workspace_id 선택)
```

접근은 역할 문자열이 아니라 `permissions.code`로 판단한다.
`USER_MANAGE`는 사용자 관리, `WORKSPACE_ALL`은 모든 작업 공간, `CONNECTION_WRITE`는 커넥션 쓰기.
작업 공간 멤버 공유(`workspace_members`)는 이후 범위다.

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

DB/API 추출 레시피. `extracts`는 실행 이력, 이 테이블은 재사용 정의.


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
| `kind`         | 종류       | `data` (산출 dataset 전달) | `then` (순서만) | `on_error` (실패 시) |
| `from_port`    | 출발 포트    | 기본 `out`                                                  |
| `to_port`      | 도착 포트    | 기본 `in`                                                   |
| `created_at`   | 생성 시각    |                                                           |


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

커넥션에서 서버 파일로 뽑은 추출 이력. 종류는 `database`(DB)와 `api`(HTTP)다.
디스크 경로는 `extracts/{databases|api}/{id}/…` 이고, 성공 시 `datasets.kind`에도 같은 값이 들어간다.
API 실행기는 아직 미구현이며, 생성 경로는 현재 DB만 연다.


| 컬럼                 | 한글명      | 설명                                            |
| ------------------ | -------- | --------------------------------------------- |
| `id`               | ID       | UUID                                          |
| `kind`             | 추출 종류    | `database` \| `api`                           |
| `connection_id`    | 커넥션 ID   | 소스 커넥션. DB는 `connections.id`, API는 이후 확장       |
| `table_name`       | 추출 대상    | DB: `schema.table` 또는 `query`. API: 리소스/표시명   |
| `delimiter`        | 구분자      | 출력 구분자. 쉼표, tab 등                             |
| `header`           | 헤더 여부    | `0`/`1`                                       |
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
| `output_filename`  | 출력 파일명   | DB 내보내기 시 사용자가 지정한 이름 (0021). 칩 실행과 무관      |
| `workspace_id`     | 작업 공간 ID | `workspaces.id`. 목록·접근은 소유 범위                 |


---



## transforms — 변환 정의 (호환)

기존 변환 화면의 저장 정의. 입력 데이터셋(기준/왼쪽)과 TransformSpec v2 JSON.


| 컬럼             | 한글명        | 설명                    |
| -------------- | ---------- | --------------------- |
| `id`           | ID         | UUID                  |
| `name`         | 이름         |                       |
| `dataset_id`   | 입력 데이터셋 ID | `datasets.id`. combine 시 기준 파일 |
| `spec_json`    | 스펙         | TransformSpec v2 JSON (아래) |
| `created_at`   | 생성 시각      |                       |
| `updated_at`   | 수정 시각      |                       |
| `workspace_id` | 작업 공간 ID   | 입력 데이터셋과 같은 작업 공간     |

### `spec_json` (TransformSpec v2)

엔진·UI 공통. SQLite 컬럼은 아니지만 이 테이블에 저장되는 JSON 형태다.

```json
{
  "version": 2,
  "read": { "delimiter": ",", "has_header": true },
  "steps": [
    { "op": "filter", "expr": "amount >= 1" },
    { "op": "select", "columns": ["id", "amount"] }
  ],
  "sink": "parquet",
  "combine": {
    "mode": "join",
    "right_dataset_id": "<datasets.id>",
    "on": ["id"],
    "how": "left"
  }
}
```

| 필드 | 설명 |
| --- | --- |
| `steps` | 정제 스텝. `select`, `drop`, `rename`, `filter`, `cast`, `fill_null`, `sort`, `unique` |
| `combine` | 선택. **붙이기** 화면용. `steps` 앞에 적용된다 |
| `combine.mode` | `join` (가로) \| `union` (세로 이어 붙이기) |
| `combine.right_dataset_id` | join 시 오른쪽 `datasets.id` |
| `combine.union_dataset_ids` | union 시 기준 파일 아래에 붙일 `datasets.id` 목록 |
| `combine.on` | join 키 컬럼 (양쪽 동일 이름) |
| `combine.how` | `left` \| `inner` (join만) |

미리보기·실행 시 서버가 `right_dataset_id` / `union_dataset_ids`를 파일 경로로 풀어 엔진에 넘긴다. DB에는 dataset ID만 남긴다.

정제(`/transform/clean`)는 `steps`만, 붙이기(`/transform/combine`)는 `combine`을 쓴다. 둘 다 같은 `transforms` 행에 저장 가능하다.


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
| `route`         | 이동 경로    | UI 라우트 (예: `/transform/clean/:id`) |
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

