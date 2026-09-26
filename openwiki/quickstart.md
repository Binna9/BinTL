---
type: guide
title: Quickstart
description: BinTL은 설치형 단일 바이너리 ETL 콘솔이다. 제품은 워크스페이스 캔버스의 칩이고, 운영은 bintl 한 프로세스다.
tags: [quickstart, workspace, bintl, agent-routing]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-3a9e14836453a58467b063e9
    resource: repo://.cursor/rules/workspace-pipeline.mdc
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-a098fdc1c547ffb8079a0720
    resource: repo://docs/workspace.md
  - id: openwiki-source-c59fe4336a371ea1052a01dd
    resource: repo://justfile
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# Quickstart

BinTL은 리눅스 서버에 올리는 설치형 ETL 콘솔이다. `./bintl --config config.toml`이면 된다. 브라우저는 클라이언트, 이 바이너리가 서버다. **운영 프로세스는 `bintl` 하나**다. React는 빌드 후 embed되고, 서버에 Node를 띄우지 않는다.

제품의 중심은 `/workspace` 캔버스다. 사용자는 이름 있는 **칩**을 놓고 data 에지로 잇는다. `/db`, `/files`, `/transform/*`는 칩을 만들거나 고치는 도구이지, UUID 경로로 파일을 고르는 두 번째 파이프라인이 아니다.

관련 페이지: [런타임과 크레이트 경계](/openwiki/architecture/runtime.md), [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [워크스페이스 캔버스](/openwiki/workflows/workspace-canvas.md), [배포와 설정](/openwiki/operations/deploy-and-config.md).

## 로컬에서 돌리기

```bash
just run
# 또는
cargo run -p bintl -- --config config.example.toml
curl -s localhost:8080/api/health
```

예제 설정 기본 계정은 `admin` / `admin`이다. `data/`가 없으면 기동 시 만든다.

개발만 Vite 핫 리로드를 위해 프로세스를 둘로 나눌 수 있다. API `8080` + `cd ui && npm run dev`(`5173`). 운영 배포는 한 프로세스가 기준이다. 타깃 빌드는 `just dist x86_64-unknown-linux-musl`.

## 세 개념

| 개념 | 의미 |
| --- | --- |
| Chip | `extract` / `transform` / `load` / `validation` 레시피. 사용자가 보는 이름은 칩 이름 |
| Run | 추가 전용 실행 이력 |
| Current output | 워크스페이스+칩당 파일 하나. 재실행이 덮어씀. 다음 칩은 이 슬롯을 읽음 |

파일이 없으면 컬럼은 업스트림 extract 레시피에서 온다. 가짜 dataset을 만들지 않는다.

## 이 위키에서 찾을 곳

| 하고 싶은 일 | 페이지 |
| --- | --- |
| 크레이트·큐·핸들러 경계 | [런타임](/openwiki/architecture/runtime.md) |
| 칩/슬롯 계약 | [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md) |
| 캔버스 저장·에지 | [워크스페이스 캔버스](/openwiki/workflows/workspace-canvas.md) |
| 전체 Run·스케줄·재시작 | [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md) |
| 파일 남기기 | [추출](/openwiki/workflows/extract.md) |
| parquet 만들기 | [변환](/openwiki/workflows/transform.md) |
| DB/파일로 넣기 | [적재](/openwiki/workflows/load.md) |
| 두 파일 비교 | [검증](/openwiki/workflows/validation.md) |
| 세션·RBAC | [인증과 접근제어](/openwiki/operations/auth-and-access.md) |
| SQLite·로그 | [저장과 로깅](/openwiki/operations/storage-and-logging.md) |
| config·musl 배포 | [배포와 설정](/openwiki/operations/deploy-and-config.md) |
| DB/HTTP 드라이버 | [커넥터](/openwiki/integrations/connectors.md) |
| 테스트 명령 | [로컬 검증](/openwiki/testing/local-verification.md) |

## 레이어

```text
React UI → Axum (bintl) → jobs / chip 워커
                       ↘ storage (SQLite + 디스크)
                       ↘ connectors (extract / load)
                       ↘ engine (Polars, 파일+spec만)
```

engine은 HTTP/SQLite/UI를 모른다. 변환은 워커의 `spawn_blocking` 안에서만 돈다.

## 에이전트 주의

- 사용자 정체는 칩 이름과 최신 출력이다. `extracts/…/{uuid}`를 UI 정체로 쓰지 않는다.
- `/db`에서 칩으로 저장하면 extract 칩을 만들고 실행한다. 같은 동작의 두 번째 단독 추출 파일을 쓰지 않는다.
- 자격 증명은 칩 설정에 복사하지 않는다.
- 코드 변경은 `cargo test --workspace`와 `cd ui && npm run build`로 확인한다.
