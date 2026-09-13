---
type: architecture
title: 런타임과 크레이트 경계
description: 운영은 bintl 한 프로세스가 embed UI와 Axum API를 함께 서빙하고, 변환은 인프로세스 워커에서만 돌며 engine/connectors는 HTTP와 화면 상태를 모른다.
tags: [runtime, crates, axum, workers, engine, connectors]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-66eda266f18b8ccd4b886dd9
    resource: repo://crates/connectors/src/lib.rs
  - id: openwiki-source-e018dd24856c85ec1a6b15f0
    resource: repo://crates/engine/Cargo.toml
  - id: openwiki-source-7490f1ad71907142c28ac29d
    resource: repo://crates/jobs/src/lib.rs
  - id: openwiki-source-95ba561382c9212da1c21d83
    resource: repo://crates/server/src/api/jobs.rs
  - id: openwiki-source-a13fe4db1eee073d0a7e2c4d
    resource: repo://crates/server/src/main.rs
  - id: openwiki-source-34b9e5889fc561bbea229a5b
    resource: repo://crates/server/src/state.rs
  - id: openwiki-source-c93b0c1ee2108d653f8d35be
    resource: repo://crates/server/src/ui.rs
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 런타임과 크레이트 경계

BinTL의 운영 단위는 **`bintl` 프로세스 하나**다. 브라우저는 클라이언트이고, 같은 바이너리가 API와 React 정적 산출물을 제공한다. 서버에 Node, 외부 SQLite 패키지, JVM을 두지 않는다. SQLite는 bundled, TLS는 rustls다.

개발만 Vite(`5173`)와 API(`8080`)를 나눌 수 있다. CORS는 그 두 origin만 허용한다. 운영 배포는 한 프로세스가 기준이다. 자세한 기동·타깃은 [배포와 설정](/openwiki/operations/deploy-and-config.md)을 본다.

관련 페이지: [Quickstart](/openwiki/quickstart.md), [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md), [저장과 로깅](/openwiki/operations/storage-and-logging.md), [커넥터](/openwiki/integrations/connectors.md).

## 책임

`crates/server`(`bintl`)는 HTTP 전송과 실행 조정을 소유한다. 실제 I/O와 변환은 아래 어댑터로만 내려간다.

```text
React UI → Axum (bintl)
            ├─ storage  → SQLite(etl.db) + data_dir 파일
            ├─ connectors → DB / HTTP / 스프레드시트
            └─ jobs / chip 워커
                 └─ engine (Polars, 파일+spec만)
```

의존은 UI/API → 실행 계층 → 도메인 어댑터 방향으로만 흐른다.

- `engine`은 axum, sqlx, UI 타입을 의존하지 않는다. 파일과 `TransformSpec`만 받는다.
- `connectors`는 Workspace 화면 상태나 칩 배치를 모른다. 커넥션 자격 증명과 테이블/쿼리/HTTP spec만 다룬다.
- `storage`는 영속 Row와 파일 경로 계약을 소유한다. HTTP 핸들러가 경로를 직접 조립하지 않는다.
- `jobs`는 단독 변환 작업(`ExecutionTask::Job`)을 큐에서 받아 engine/connectors를 호출한다.

## 기동

엔트리포인트는 `crates/server/src/main.rs`의 `bintl` 바이너리다. `--config`가 필수다.

1. `Config::load`가 `config.toml`을 읽고 `ETL_*` 환경변수로 덮는다.
2. `Store::open`이 `data_dir` 레이아웃과 `etl.db` 마이그레이션을 연다.
3. `ensure_bootstrap`이 설정 파일의 초기 사용자를 만든다.
4. `recover_interrupted_workspace_executions`가 재시작 전에 끊긴 워크스페이스 실행을 오류로 닫는다. 메모리 큐는 재개하지 않는다.
5. `max_concurrent_jobs` 세마포어와 `mpsc` 채널(용량 64)을 만들고 워커 태스크를 띄운다.
6. `schedule::scheduler_loop`를 별도 태스크로 띄운다.
7. 공개 라우트(`/api/health`, `/api/login`, `/api/logout`)와 인증 미들웨어가 붙은 보호 라우트를 합친 뒤, 나머지는 `ui::fallback`이다.

보호 라우트는 `api.rs`가 파일·커넥션·추출·레거시 jobs를 조립하고, workspace/chip/transform/load/validation/users/search/schedule 모듈을 merge한다. `/api`로 시작하는 미매칭 경로는 404 JSON이다. 그 외 경로는 embed된 `ui/dist`이거나 `ETL_UI_DIR` 디스크다. `index.html`은 no-store, 해시 에셋은 immutable이다.

musl 타깃만 전역 allocator를 `mimalloc`으로 바꾼다.

## 실행 큐

HTTP 핸들러는 변환·칩 본문을 직접 돌리지 않는다. 요청은 `queued` 레코드를 만든 뒤 `ExecutionTask`를 보낸다.

| 태스크 | 누가 넣나 | 워커가 호출 |
| --- | --- | --- |
| `ExecutionTask::Job(id)` | 단독 변환 `/api/jobs`, transform 실행, 일부 칩 경로 | `jobs::execute` |
| `ExecutionTask::Chip(id)` | 칩 단독 실행, 워크스페이스 전체 실행 | `chip::run_one` |

워커는 채널에서 하나씩 꺼내 세마포어를 얻은 뒤 중첩 `tokio::spawn`으로 돌린다. 동시 실행 상한은 `max_concurrent_jobs`다. 실패한 변환은 `execution_error::record_transform_job_failure`, 실패한 칩은 `record_chip_failure`로 기록한다.

`jobs::execute` 안에서 Polars 변환은 `tokio::task::spawn_blocking`으로만 돈다. HTTP 핸들러에서 `collect`하지 않는다. 칩이 연결되면 결과는 `chip_output_slots` 상대 경로에 덮어쓰고, 레거시 단독 잡은 `outputs/{job_id}/result.parquet`에 쓴다.

워크스페이스 전체 실행의 사전 검증·순차 배치·조건 에지는 [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md)이 소유한다. 이 페이지가 보장하는 것은 **모든 실행이 같은 인프로세스 큐를 통과한다**는 점이다.

## 불변과 실패

- 운영에서 UI 서버와 API 서버를 나누지 않는다. 정적 파일은 embed 또는 `ETL_UI_DIR`이다.
- `engine` crate 의존 목록에 axum/sqlx가 없다. 변환 순수 로직을 서버 타입에 묶지 않는다.
- 재시작은 끊긴 워크스페이스 실행을 복구 시도하지 않고 오류 종료한다. 큐는 메모리라 프로세스와 함께 사라진다.
- 채널 `try_send`가 가득 차면 해당 실행은 시작하지 못한다. 용량은 64다.
- 워커 실패는 프로세스 전체를 내리지 않고 해당 실행만 실패로 남긴다.

## 확장

새 HTTP 기능은 `api.rs`에 모으지 않고 `api/{domain}.rs` 또는 독립 모듈에 둔다. CPU 집약 작업은 핸들러가 아니라 jobs/chip 워커 또는 `spawn_blocking`으로 내린다. 외부 I/O는 `connectors`, 영속은 `storage` repository다. 새 변환 op는 `engine`의 spec 컴파일에만 추가한다.
