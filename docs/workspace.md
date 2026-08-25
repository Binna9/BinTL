# 작업 공간과 작업 단위

작성: 2026-08-25

## 목적

작업 공간은 ETL 설정, 실행 이력, 파일 산출물을 묶는 프로젝트 경계다.
작업 정의와 실행 기록을 분리하므로 같은 설정을 반복 실행해도 정의는 하나,
실행과 산출물은 매번 새로 남는다.

```
workspace
  ├─ task definition (extract | transform)
  │    └─ task run (queued → running → succeeded | failed)
  │         └─ output dataset
  └─ datasets
```

커넥션은 여러 작업 공간에서 재사용하는 전역 자원이다. 비밀번호는 작업 설정이나
실행 스냅샷에 복사하지 않고 `connection_id`로만 참조한다.

## 저장 모델

- `workspaces`: 이름, 설명, 캔버스 배치, **version**. 생성 시 version=1.
- `workspace_revisions`: 저장할 때마다 layout+tasks 스냅샷. 초기화는 마지막 저장본으로 되돌린다.
- `task_definitions`: 재사용할 행위의 정의. `kind`, `config_json`, `revision`을 가진다.
- `task_runs`: 한 번의 실행. 실행 당시 설정을 `config_snapshot_json`으로 고정한다.
- `datasets`: 업로드, DB 추출, 변환 결과 파일의 카탈로그. 작업 공간과 생산한
  `task_run`을 추적한다.
- `extracts`, `jobs`, `transforms`: 기존 화면과 API 호환을 위해 유지하는 실행/정의
  레코드다. 새 작업 실행은 이 구현을 재사용한다.

기존 데이터는 마이그레이션 시 `기본 Workspace`에 배정된다.

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

- `GET/POST /api/workspaces`
- `GET/PATCH /api/workspaces/:id`
- `PUT /api/workspaces/:id/save` — 캔버스 작업+배치를 커밋하고 version을 1 올린다
- `GET/POST /api/workspaces/:id/tasks`
- `GET/PATCH /api/tasks/:id`
- `POST /api/tasks/:id/run`
- `GET /api/workspaces/:id/runs`
- `GET /api/task-runs/:id`
- `GET /api/task-runs/:id/logs`

실행 API는 즉시 `queued` run을 반환한다. UI는 실행 중인 run이 있을 때만 목록을
주기적으로 다시 읽는다.

## 화면

- `/workspace`: 왼쪽 툴을 흰 캔버스에 끌어 작업을 배치한다. 노드를 누르면 왼쪽에서
  설정을 고친다. 우측 하단 **저장** 전까지는 SQLite에 쓰지 않는다. **초기화**는
  마지막 저장 버전으로 되돌린다. 실행은 저장한 작업만 가능하다.

기존 `/db`, `/extracts`, `/transform`, `/history`, `/jobs/:id` 경로는 유지한다.

## 이후 Flow

Flow는 저장된 작업 정의를 노드로 연결한다. 첫 버전은 각 노드가 입력과 출력
Dataset을 하나씩 갖는 선형 E→T 실행만 허용한다. 실행 시 Flow 그래프와 각 작업
revision을 snapshot하고, 앞 노드의 output dataset을 다음 노드의 input으로 넘긴다.

후속 범위:

- 독립 Load 작업과 E→T→L
- 재시도와 취소
- 수동/주기 스케줄
- 분기와 병합 DAG
- Dataset 보존 및 정리 정책

현재 TaskRun 큐는 단일 서버 프로세스의 메모리 큐다. 동시 실행 수는
`max_concurrent_jobs`를 따르지만, 서버가 재시작되면 남아 있는 `queued`/`running`
실행을 자동 재개하지 않는다.

## 상태와 불변 조건

- 한 run은 `queued`에서 한 번만 `running`으로 전이한다.
- 성공한 run은 output dataset을 가리키고, 실패한 run은 오류를 남긴다.
- Task 정의를 수정해도 과거 run의 설정 snapshot은 바뀌지 않는다.
- 작업 설정에는 자격 증명과 실행 결과 경로를 저장하지 않는다.
- Dataset 파일이 없으면 Transform 실행은 시작하지 않고 실패 처리한다.

## 로컬 확인

이 구현 작업에서는 저장소 규칙에 따라 빌드와 테스트를 실행하지 않았다.

1. `/workspace`에서 작업 공간을 만든다.
2. DB 테이블 또는 SQL Extract 작업을 저장하고 두 번 실행한다.
3. 각 실행과 output dataset이 별도로 생기는지 확인한다.
4. output dataset을 입력으로 Transform 작업을 실행한다.
5. parquet 결과가 새 dataset으로 등록되는지 확인한다.
