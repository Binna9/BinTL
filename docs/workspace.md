# 작업 공간과 작업 단위

작성: 2026-08-27

## 목적

작업 공간은 ETL 설정, 실행 이력, 파일 산출물을 묶는 프로젝트 경계다.
칩 정의와 실행 기록을 분리하므로 같은 설정을 반복 실행해도 정의는 하나,
실행과 산출물은 매번 새로 남는다.

한 설치는 회사 하나다. 사용자는 작업 공간을 소유하고, 커넥션만 조직 전역이다.

```
user
  ├─ workspace_folders (중첩)
  └─ workspaces (여러 개, folder_id 선택)
        ├─ chip (extract | transform | load)
        │    ├─ chip run
        │    └─ chip edges
        └─ datasets / extracts / jobs / transforms
```

커넥션은 여러 작업 공간에서 재사용하는 전역 자원이다. 비밀번호는 작업 설정이나
실행 스냅샷에 복사하지 않고 `connection_id`로만 참조한다. 조회는 전원, 등록·수정은
`CONNECTION_WRITE` 권한이 있는 역할만 한다.

## 사용자와 소유

- `users`: `userid`(로그인 아이디), `username`(사용자명), `password`(해시). 역할·홈 워크스페이스 컬럼은 없다.
- `roles`, `permissions`, `user_roles`, `role_permissions`: 사용자·역할·권한 매핑.
- `workspace_folders`: 소유자별 디렉터리. `parent_id`로 중첩.
- `workspaces.owner_user_id`: 사용자가 프로젝트를 여러 개 소유. `folder_id`로 폴더에 넣는다.
- 사용자 생성 시 시작용 워크스페이스 하나를 만들 수 있지만, 특별 홈 타입이 아니다.
- `/workspace`는 최근 수정 순으로 보이는 첫 워크스페이스를 연다.
- 세션 쿠키는 `users.id` HMAC이다.
- 작업 공간 멤버 공유는 이번 범위 밖이다.

## 저장 모델

- `workspace_folders`: 이름, `parent_id`, `owner_user_id`.
- `workspaces`: 이름, 설명, 캔버스 배치, **version**, `owner_user_id`, `folder_id`.
- `workspace_revisions`: 저장할 때마다 layout+chips+edges 스냅샷. 초기화는 마지막 저장본으로 되돌린다.
- `chips`: 재사용할 최소 작업 단위. `kind`, `config_json`, `revision`을 가진다.
- `chip_edges`: 칩과 칩을 잇는 선. `data`는 산출 dataset을 넘기고, `then`은 순서만, `on_error`는 실패 경로다.
- `chip_runs`: 한 번의 실행. 실행 당시 설정을 `config_snapshot_json`으로 고정한다.
- `datasets`: 업로드, DB 추출, 변환 결과 파일의 카탈로그. 작업 공간과 생산한
  `task_run`을 추적한다.
- `extracts`, `jobs`, `transforms`: 기존 화면과 API 호환을 위해 유지하는 실행/정의
  레코드다. 새 작업 실행은 이 구현을 재사용한다.

기존 데이터는 마이그레이션 시 기본 Workspace에 배정되고, 부트스트랩 admin의 홈이 된다.

## 작업 종류

### Extract

테이블 또는 SQL 쿼리를 서버 파일로 추출한다.

```json
{
  "connection_id": "connection-id",
  "source": {
    "type": "table",
    "table": "public.users",
    "database": null
  },
  "delimiter": ",",
  "header": true
}
```

쿼리 작업은 `source.type`을 `query`로 두고 `source.sql`을 저장한다. 실행이
성공하면 기존 `extracts` 이력과 함께 새 `dataset`이 등록된다.

### Transform

Dataset 파일과 TransformSpec v2를 입력으로 받아 parquet를 만든다.

```json
{
  "input_dataset_id": "dataset-id",
  "spec": {
    "version": 2,
    "steps": [],
    "sink": "parquet"
  }
}
```

실행 요청의 `input_dataset_id`로 정의의 입력을 덮어쓸 수 있다. 결과 parquet도
Dataset으로 등록되므로 다음 작업의 입력으로 사용할 수 있다.

### Load

종류는 예약되어 있지만 이번 MVP에서는 생성과 실행을 지원하지 않는다. 기존 v1
job의 적재 경로는 호환용으로만 남는다.

## API

- `GET /api/me`
- `GET/POST /api/users`, `PATCH /api/users/:id` — admin. 비밀번호를 비우면 유지
- `GET/POST /api/workspaces` — 목록은 소유 범위. 생성 시 `folder_id` 선택
- `GET/PATCH /api/workspaces/:id` — `folder_id`로 폴더 이동(null이면 루트)
- `GET/POST /api/workspace-folders`, `PATCH/DELETE /api/workspace-folders/:id`
- `PUT /api/workspaces/:id/save` — 캔버스 칩+배치+연결선을 커밋하고 version을 1 올린다
- `GET/POST /api/workspaces/:id/chips`
- `GET/PATCH /api/chips/:id`
- `POST /api/chips/:id/run`
- `GET /api/workspaces/:id/runs`
- `GET /api/chip-runs/:id`
- `GET /api/chip-runs/:id/logs`

실행 API는 즉시 `queued` run을 반환한다. UI는 실행 중인 run이 있을 때만 목록을
주기적으로 다시 읽는다.

## 화면

- `/workspace`: 왼쪽에서 폴더·워크스페이스 트리를 고른다. 툴을 흰 캔버스에 끌어 칩을 배치한다. 연결선으로 잇고, 칩을 누르면 설정한다. 우측 하단 **저장** 전까지는 SQLite에 쓰지 않는다.

기존 `/db`, `/extracts`, `/transform`, `/history`, `/jobs/:id` 경로는 유지한다.

## Flow

저장된 칩을 연결선으로 잇는다. `data` 선이 있으면 Transform 입력은 config의 `input_dataset_id`보다 앞 칩의 최신 성공 산출을 쓴다. 첫 실행은 칩 단위다. 그래프 전체 순차 실행은 이후 범위다.

후속 범위:

- 독립 Load 작업과 E→T→L
- 재시도와 취소
- 수동/주기 스케줄
- 분기와 병합 DAG
- Dataset 보존 및 정리 정책

현재 ChipRun 큐는 단일 서버 프로세스의 메모리 큐다. 동시 실행 수는
`max_concurrent_jobs`를 따르지만, 서버가 재시작되면 남아 있는 `queued`/`running`
실행을 자동 재개하지 않는다.

## 상태와 불변 조건

- 한 run은 `queued`에서 한 번만 `running`으로 전이한다.
- 성공한 run은 output dataset을 가리키고, 실패한 run은 오류를 남긴다.
- 칩 정의를 수정해도 과거 run의 설정 snapshot은 바뀌지 않는다.
- 작업 설정에는 자격 증명과 실행 결과 경로를 저장하지 않는다.
- Dataset 파일이 없으면 Transform 실행은 시작하지 않고 실패 처리한다.

## 로컬 확인

1. 설정에서 사용자를 추가하고 새 계정으로 로그인한다.
2. 그 계정은 자기 홈 작업 공간과 파일만 보이고, 커넥션은 공유된다.
3. analyst는 커넥션 추가·수정 버튼이 없다.
4. `/workspace`에서 작업 공간을 만든다.
5. DB 테이블 또는 SQL Extract 작업을 저장하고 두 번 실행한다.
6. 각 실행과 output dataset이 별도로 생기는지 확인한다.
