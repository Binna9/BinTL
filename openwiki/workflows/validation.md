---
type: workflow
title: 검증
description: 검증은 두 실재 파일을 비교하고 새 파일을 만들지 않는다. 차이가 있으면 단계가 failed가 되어 on_error 제어선을 탈 수 있다.
tags: [validation, compare, chip, engine]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-a0afc150d920a4ed4781e371
    resource: repo://crates/server/src/chip.rs
  - id: openwiki-source-f9b65f66dd57a488aa1cfaca
    resource: repo://crates/server/src/chip/workspace_execution.rs
  - id: openwiki-source-017442c3b9bddd5b5e356314
    resource: repo://crates/server/src/validation.rs
  - id: openwiki-source-57291caf28bfcf2ec46b220f
    resource: repo://docs/schema.md
  - id: openwiki-source-a098fdc1c547ffb8079a0720
    resource: repo://docs/workspace.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 검증

검증은 데이터를 생산하지 않는다. 두 `data_files`를 비교해 행 수, 스키마, 복합 키 누락·추가·중복, 지정 컬럼 값 불일치를 한 결과로 남긴다. `execution_outputs`와 `workspace_chip_outputs`를 만들지 않는다.

관련 페이지: [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md), [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [변환](/openwiki/workflows/transform.md).

## 규칙과 엔진

`validation_rules`는 이름, 복합 키, 비교 컬럼, 행 수·스키마 검사 여부, 활성, revision을 저장한다. 독립 실행과 캔버스 칩이 같은 규칙을 재사용한다. 칩은 `config_json.validation_rule_id`를 쓰고, 예전 수동 `keys`/`columns`도 호환한다.

비교 본체는 `PolarsEngine.validate_files`다. 미리보기와 같이 `spawn_blocking`에서 돈다. 소스와 타깃 파일 id는 달라야 하고, 둘 다 디스크에 있는 materialized 파일이어야 한다.

## 입력 포트

캔버스에서 data 입력의 관례는 이렇다.

- **target**: 업스트림 추출·변환 칩의 최신 출력. `execution_inputs`에 기록된다.
- **source**: 편집 화면에서 고른 비교 기준 파일. 두 data 에지가 있으면 `source` 포트(또는 레거시 순서)로 맞춘다.

전체 실행은 이번 런에서 만든 결과만 전달한다. 검증의 두 입력 모두 과거 성공 슬롯으로 대체하지 않는다. 업스트림이 실패하면 검증은 건너뛴다.

워크스페이스 실행은 첫 배치 전에 규칙 비교 옵션을 스냅샷(`workspace_rule_snapshot`)에 복사한다. 이후 규칙 편집은 진행 중인 실행에 반영하지 않는다.

## 결과와 제어선

요약을 `execution_steps.result_json`과 `validation_results`에 같이 넣는다. `passed=false`면 단계는 실패로 끝나 `on_error`를 탈 수 있다. 정상 건너뜀은 실패가 아니므로 `on_error`를 켜지 않는다.

독립 `POST /api/validations/run`은 두 파일 id를 받아 즉시 비교한다. 비활성 규칙이나 남의 규칙은 거절한다.

## 불변

- 검증 칩은 최신 출력 슬롯을 만들지 않는다.
- source와 target은 다른 파일이어야 한다.
- 차이는 새 데이터셋이 아니라 실패 상태다.
- 대량 불일치 전체를 report에 넣는 운영 파일 산출은 아직 없다.
