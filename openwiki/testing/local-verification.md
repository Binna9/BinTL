---
type: testing
title: 로컬 검증
description: 코드 변경은 cargo test --workspace와 UI npm run build로 확인하고, 워크스페이스 실행 불변은 서버 단위 테스트가 잠그며, README 수락 테스트로 화면 흐름을 본다.
tags: [testing, just, cargo, acceptance, workspace-execution]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-6129b18b6bb83b25aa157b4b
    resource: repo://crates/server/src/chip/workspace_execution/tests.rs
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-c59fe4336a371ea1052a01dd
    resource: repo://justfile
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-436f4179fe22abf615d2f7d0
    resource: repo://ui/package.json
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 로컬 검증

새 기능은 도메인 소유를 정한 뒤, UI는 `npm run build`, Rust는 `cargo test --workspace`로 검증한다. DB 변경은 새 마이그레이션으로만 한다. 장시간 실행, 재시작 복구, 파일 삭제 경로는 별도 실패 시나리오를 확인한다.

관련 페이지: [Quickstart](/openwiki/quickstart.md), [런타임과 크레이트 경계](/openwiki/architecture/runtime.md), [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md).

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `just test` | `cargo test --workspace` |
| `just ui` / `cd ui && npm run build` | `tsc --noEmit` 후 Vite 프로덕션 빌드 |
| `just run` | UI 빌드 후 예제 설정으로 기동 |
| `curl -s localhost:8080/api/health` | `{"ok":true,"version":"0.1.0"}` |

UI `package.json`의 `build`는 타입체크를 포함하고, 별도 프론트 테스트 러너는 없다. 화면 계약은 수락 테스트와 수동 확인이다.

## 워크스페이스 실행 테스트

`crates/server/src/chip/workspace_execution/tests.rs`가 캔버스 전체 실행 불변을 잠근다. 임시 `data_dir`과 인메모리 sqlite 커넥션, 용량 64 실행 채널을 쓴다.

잠그는 행동:

- 사전 검증은 모든 오류를 모으고, 유효한 칩도 큐에 넣지 않는다.
- 연결 체인과 독립 칩은 최신 출력 슬롯을 쓴다.
- 실패는 data 후손을 건너뛰고, `on_error`와 독립 분기는 계속한다.
- 검증 칩은 두 최신 출력을 묶고, 실패 후 과거 성공으로 대체하지 않는다.
- 첫 배치 전에 레시피를 얼린다.
- 큐가 가득 차도 waiter를 남기지 않고 단계를 끝낸다.
- 비활성 업스트림은 어떤 작업도 시작하기 전에 거절한다.
- 조건 건너뜀은 성공으로 취급하고 `on_error`를 켜지 않는다.
- 칩 단독 실행은 기존 큐와 이력 경로를 유지한다.

변환 엔진·SQL 정규화·슬롯 파일명·업로드 CSV 검증은 각 crate 모듈 테스트에 흩어져 있다.

## 수락 테스트

README의 수동 시나리오다. 제품 중심은 작업 공간이다.

**A — 기동.** `just run` 또는 `cargo run -p bintl -- --config config.example.toml` 후 health와 브라우저 접속. 기본 계정 `admin` / `admin` (`skip_auth = false`).

**D — 작업 공간 반복 실행.** `/workspace`에서 공간을 만들고 extract를 두 번 실행한다. 정의는 하나, 실행 이력은 매번 새로 남는다. 최신 출력 슬롯은 덮어쓴다. 그 출력을 입력으로 transform을 저장·실행하고 상태·오류·입출력을 확인한다.

**B / C**는 도구 페이지 경로다. `/connections` → `/db` → 추출, `/files` 업로드 → `/transform`. 새 작업은 여기서 고른 파일을 두 번째 파이프라인으로 키우지 말고 칩으로 저장한다.

로그인 후 다른 계정은 자기 워크스페이스와 파일만 보고 커넥션은 공유된다. analyst는 커넥션 추가·수정 버튼이 없다.

## 불변

- 핸들러에 생긴 정책은 feature 또는 실행 계층 테스트로 내린다.
- 재시작 후 `queued`/`running` 워크스페이스 실행이 자동 재개되면 실패다.
- 사전 검증 실패 뒤 일부 칩만 큐에 들어가면 실패다.
