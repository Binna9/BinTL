# SQLite 스키마 (`data/etl.db`)

작성: 2026-08-27

SQLite는 `COMMENT ON`을 지원하지 않는다. 테이블·컬럼 의미는 이 문서가 기준이다.

마이그레이션은 `crates/storage/migrations/`에 있다. 아래는 **현재(0016까지 적용된)** 구조다. 시각 컬럼은 RFC3339 문자열이다. 불리언은 INTEGER `0`/`1`이다.

한 설치(SQLite 하나)는 회사 하나다. 커넥션은 조직 공유 자산이고, 일(파일·추출·변환·칩)은 작업 공간에 속한다. 사용자는 작업 공간을 여러 개 소유한다. 폴더는 디렉터리처럼 그룹만 잡는다.

```
users
  ├─ user_roles ──► roles ──► role_permissions ──► permissions
  └─ workspaces.owner_user_id          (1:N)
        ├─ folder_id ──► workspace_folders (중첩 parent_id)
        ├─ workspace_revisions
        ├─ chips / chip_runs / chip_edges
        └─ datasets / extracts / jobs / transforms
connections          (전역. 쓰기 권한 CONNECTION_WRITE)
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

반복 실행하는 Extract / Transform / Load 설정. 실행할 때마다 revision이 스냅샷으로 복사된다.


| 컬럼             | 한글명      | 설명                                        |
| -------------- | -------- | ----------------------------------------- |
| `id`           | ID       | UUID                                      |
| `workspace_id` | 작업 공간 ID | `workspaces.id`                           |
| `name`         | 이름       | 표시 이름                                     |
| `kind`         | 종류       | `extract` | `transform` | `load`          |
| `config_json`  | 설정       | 종류별 JSON. 비밀번호는 넣지 않고 `connection_id`만 참조 |
| `revision`     | 리비전      | 저장할 때마다 증가. 1 이상                          |
| `active`       | 활성       | `1` 활성, `0` 비활성                           |
| `created_at`   | 생성 시각    |                                           |
| `updated_at`   | 수정 시각    |                                           |


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
| `workspace_id`     | 작업 공간 ID | `workspaces.id`. 목록·접근은 소유 범위                 |


---



## transforms — 변환 정의 (호환)

기존 변환 화면의 저장 정의. 입력 데이터셋과 TransformSpec JSON.


| 컬럼             | 한글명        | 설명                    |
| -------------- | ---------- | --------------------- |
| `id`           | ID         | UUID                  |
| `name`         | 이름         |                       |
| `dataset_id`   | 입력 데이터셋 ID | `datasets.id`         |
| `spec_json`    | 스펙         | TransformSpec v2 JSON |
| `created_at`   | 생성 시각      |                       |
| `updated_at`   | 수정 시각      |                       |
| `workspace_id` | 작업 공간 ID   | 입력 데이터셋과 같은 작업 공간     |


---



## jobs — 변환·적재 작업 (호환)

기존 변환(및 예약된 적재) 실행. 새 Transform TaskRun도 이 테이블에 한 행을 남긴다.


| 컬럼              | 한글명      | 설명                                                         |
| --------------- | -------- | ---------------------------------------------------------- |
| `id`            | ID       | UUID                                                       |
| `status`        | 상태       | `queued` | `running` | `succeeded` | `failed` | `canceled` |
| `source_path`   | 입력 경로    | 입력 파일 상대 경로                                                |
| `output_path`   | 출력 경로    | 출력 파일 상대 경로                                                |
| `spec_json`     | 스펙       | 변환 스펙 JSON                                                 |
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


