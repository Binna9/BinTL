---
type: workflow
title: 워크스페이스 전체 실행
description: 캔버스 전체 Run은 모든 레시피를 사전 검증한 뒤에만 순차 배치한다. 실행은 인프로세스 큐이고, 재시작은 queued/running 전체 실행을 오류로 닫으며 재개하지 않는다.
tags: [workspace-run, preflight, queue, schedule, recovery]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-a0afc150d920a4ed4781e371
    resource: repo://crates/server/src/chip.rs
  - id: openwiki-source-f9b65f66dd57a488aa1cfaca
    resource: repo://crates/server/src/chip/workspace_execution.rs
  - id: openwiki-source-6129b18b6bb83b25aa157b4b
    resource: repo://crates/server/src/chip/workspace_execution/tests.rs
  - id: openwiki-source-0536b45592a36b6945777f05
    resource: repo://crates/server/src/schedule.rs
  - id: openwiki-source-4152508785f2fc83b7715cbc
    resource: repo://crates/storage/migrations/0006_workspace_execution_history.sql
  - id: openwiki-source-cf96dafdf729371c5d3f9ac0
    resource: repo://crates/storage/src/chip_run_repo.rs
  - id: openwiki-source-a098fdc1c547ffb8079a0720
    resource: repo://docs/workspace.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 워크스페이스 전체 실행

전체 실행은 저장된 활성 칩을 연결 의존 순으로 한 번에 한 칩씩 돌린다. 내부 병렬은 없다. 칩 단독 실행은 기존 큐·이력 경로를 유지하고 `executions.source = 'chip'`이다. 전체 실행은 `source = 'workspace'` 한 건 아래 칩 단계가 `execution_id`를 공유한다.

관련 페이지: [워크스페이스 캔버스](/openwiki/workflows/workspace-canvas.md), [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [런타임과 크레이트 경계](/openwiki/architecture/runtime.md), [저장과 로깅](/openwiki/operations/storage-and-logging.md).

## 시작

`POST /api/workspaces/{id}/run`과 스케줄러가 `run_workspace_internal`을 호출한다. 서버는 `create_workspace_execution`으로 `running` 전체 실행을 만든 뒤 `workspace_execution::execute`를 돌리고, 끝나면 `finish_workspace_execution`이 성공/실패를 확정한다. 칩 상태 트리거는 workspace 실행을 갱신하지 않는다. 중간에도 전체 상태는 `running`이다.

스케줄은 interval 시각이 되면 같은 함수를 띄운다. 그 워크스페이스에 이미 활성 실행이 있으면 이번 스케줄을 `skipped`로 넘긴다.

## 사전 검증

활성 칩을 위상 순으로 나열한 뒤, **어떤 추출·변환·적재도 보내지 않고** 설정을 모두 검사한다. 오류가 있으면 전원에 대해 단계 레코드를 만든 다음, 오류 칩은 `WORKSPACE_PREFLIGHT_FAILED`로 실패하고 나머지는 건너뜀으로 표시한다. 큐에는 아무것도 넣지 않는다.

통과하면 첫 배치 전에 모든 칩의 설정과 연결, 검증 규칙 비교 옵션을 스냅샷에 고정한다. 이후 레시피·에지 편집은 이 실행에 반영되지 않는다. 커넥션 자격 증명과 외부 데이터 자체는 복사하지 않는다.

## 순차 배치와 조건

data 선은 **이번 전체 실행에서 만든 결과만** 전달한다. 과거 성공 슬롯으로 대체하지 않는다. 검증의 source/target도 같다.

| 에지 | 후속이 도는 때 |
| --- | --- |
| `on_success` | 앞 칩이 Succeeded |
| `on_error` | 앞 칩이 Failed |
| `always` | 앞 칩이 어떤 결과든 처리된 뒤 (아직 결과가 없으면 막힘) |
| `data` | 이번 실행 출력이 있어야 함. 없으면 건너뜀 |

실패한 상위가 필요한 후속은 건너뛰고, 독립 경로는 계속한다. 건너뜀은 실패가 아니므로 `on_error`를 켜지 않는다. 대상 중 실제 실패가 하나라도 있으면 전체 실행은 실패다. 조건 건너뜀만으로는 전체를 실패로 만들지 않는다.

각 칩은 `ExecutionTask::Chip`으로 같은 인프로세스 큐에 들어가고, 조정 루프가 끝날 때까지 기다린다. 큐가 가득 차면 그 단계는 실패다.

## 이력

`GET /api/workspaces/{id}/runs`는 칩 단계 `runs`와 전체 실행 `workspace_runs`를 같이 준다. `GET /api/workspaces/{id}/executions`는 전체 실행만 준다. 헤더의 최신 상태는 전체 실행이라 칩 단독 재실행의 영향을 받지 않는다.

## 재시작

기동 시 `recover_interrupted_workspace_executions`가 `source='workspace'`이면서 `queued`/`running`인 전체 실행과 그 단계를 `EXECUTION_INTERRUPTED`로 닫는다. 메모리 큐는 프로세스와 함께 사라지므로 자동 재개하지 않는다.

## 칩 단독 실행

`POST /api/chips/{id}/run`은 즉시 `queued` 단계를 만들고 큐에 넣는다. 입력 조회는 기존 슬롯 규칙이다. 연결 없는 변환은 설정에 지정한 실재 파일을 쓸 수 있다. 적재·검증 비교는 data 연결이 필요하다.

## 불변

- 사전 검증 실패 뒤 일부 칩만 큐에 넣지 않는다.
- 전체 실행 데이터 선은 이번 런 산출만 쓴다.
- 재시작은 미완료 전체 실행을 실패로 닫는다.
- 한 단계는 `queued`에서 `running`으로 한 번만 간다.
