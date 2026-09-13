---
type: operations
title: 저장과 로깅
description: SQLite etl.db가 메타와 실행 이력을 소유하고, 실재 파일만 data_files에 등록한다. 칩 실행 로그 원본은 execution_logs이며 data/logs는 운영 진단용이다.
tags: [sqlite, schema, data-files, logging, migrations]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-4152508785f2fc83b7715cbc
    resource: repo://crates/storage/migrations/0006_workspace_execution_history.sql
  - id: openwiki-source-189c6759c996de79980fb5cc
    resource: repo://crates/storage/src/chip_slot.rs
  - id: openwiki-source-77d1b289bf3648f6ae4dfc3d
    resource: repo://crates/storage/src/execution_repo.rs
  - id: openwiki-source-cc96dfbea8fbfef7a98bfad0
    resource: repo://crates/storage/src/lib.rs
  - id: openwiki-source-c13e2780d9e945bee1408ec1
    resource: repo://docs/logging.md
  - id: openwiki-source-57291caf28bfcf2ec46b220f
    resource: repo://docs/schema.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 저장과 로깅

`crates/storage`는 SQLite repository와 `data_dir` 파일 경로를 소유한다. HTTP 핸들러가 경로를 직접 조립하거나 여러 도메인 트랜잭션을 흩뿌리지 않는다. 여러 테이블을 묶는 작업은 소유 도메인 repository에서 시작한다.

관련 페이지: [런타임과 크레이트 경계](/openwiki/architecture/runtime.md), [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md).

## 열기

`Store::open`은 레이아웃을 만들고 `data_dir/etl.db`를 연다. WAL과 Foreign Key 검사를 켠다. 풀은 최대 5연결이다. `sqlx::migrate!("./migrations")`가 기준선 `0001_schema.sql`과 이후 마이그레이션을 적용한다. 새 스키마 변경은 새 파일로만 한다.

`session_secret`에서 커넥션 암호 키를 만든다. 검색 인덱스 복구가 실패해도 권위 데이터 오픈은 막지 않는다.

## 파일 레이아웃

상대 경로는 `data_dir` 아래다.

| 상수 | 경로 | 용도 |
| --- | --- | --- |
| `REL_UPLOADS` | `extract_runs/uploads` | 브라우저 업로드 |
| `REL_DATABASES` | `extract_runs/databases` | DB 추출 |
| `REL_API` | `extract_runs/api` | HTTP 추출 |
| `REL_OUTPUTS` | `outputs` | 레거시 단독 변환 결과 |
| `REL_CHIP_OUTPUTS` | `chip_outputs` | 칩 최신 출력 슬롯 |
| `REL_LOGS` | `logs` | 쿼리·연결 등 운영 진단 |
| `REL_STAGING` | `staging` | 스프레드시트 커밋 전 |

`resolve`는 상대 경로를 `data_dir`에 붙인다. 절대 경로는 그대로 쓴다. 예전 문서의 `extracts/` 이름은 코드 상수와 다를 수 있다.

## 스키마 원칙

- `extracts`, `transforms`, `loads`는 서로 다른 ETL 정의다. 컬럼을 억지로 통일하지 않는다.
- `chips`는 그 정의를 참조하는 작업 관리 객체다. `workspaces`는 배치와 연결을 묶는다.
- 모든 실행은 `executions` → `execution_steps` → `execution_inputs` / `execution_outputs` / `execution_logs`다.
- 실재 파일만 `data_files`에 넣는다. 실행 전 예상 파일은 `workspace_chip_outputs`의 파일명·스키마 계약이다. 0행 결과도 `data_schemas`에 컬럼을 남길 수 있다.
- 폴더 최상위는 `parent_id IS NULL`이다. `root` 레코드를 만들지 않는다.
- 외부 API의 `/api/datasets`, `/api/jobs` 이름은 호환용이다. 물리 테이블에 구형 `datasets`/`jobs`를 만들지 않는다.

`0006_workspace_execution_history.sql`부터 칩 상태 트리거는 `source != 'workspace'`인 실행만 갱신한다. 워크스페이스 전체 실행 상태는 서버 조정 로직이 확정한다.

## 로깅

칩 실행 로그의 단일 원본은 `execution_logs`다. 신규 칩 실행은 `data/logs/extract_runs` 같은 파일 로그를 만들지 않는다. `logs/query`, `files`, `connections`는 칩 이력이 아니라 운영 진단이다.

`Store::append_execution_log`가 sequence를 증가시키며 INSERT한다. 같은 트랜잭션에서 단계당 최근 500개를 넘는 오래된 행을 지운다. 메시지 상한은 8,192자다. 같은 칩을 다시 돌려도 과거 로그를 즉시 덮지 않는다. 실행마다 새 UUID다.

문서 정책은 칩 단독 완료 실행을 칩당 최근 50개로 정리하고, 워크스페이스 전체 실행과 그 소속 칩은 그 정리에서 빼 그룹과 로그를 보존한다.

공통 이벤트는 `started` / `completed` / `failed`다. 화면의 최신 로그는 해당 칩의 가장 최근 단계를 고른다.

## 불변

- 가짜 planned 파일을 `data_files`에 넣지 않는다.
- 마이그레이션만 스키마를 바꾼다.
- 검색 인덱스 실패는 기동을 막지 않는다.
- 워크스페이스 실행의 중간 성공·실패가 트리거로 전체 상태를 확정하지 않는다.
