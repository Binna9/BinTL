---
type: workflow
title: 적재
description: 적재는 변환 dest가 아니라 독립 load 정의다. 업스트림 최신 출력을 DB 또는 서버 파일로 넣고, 캔버스에서는 data 에지가 필수다.
tags: [load, chip, connectors, destination]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-a0afc150d920a4ed4781e371
    resource: repo://crates/server/src/chip.rs
  - id: openwiki-source-2552fdd4edb37a263048ceaf
    resource: repo://crates/server/src/load.rs
  - id: openwiki-source-49dccd66886417b086c49ebd
    resource: repo://crates/storage/src/load_repo.rs
  - id: openwiki-source-a098fdc1c547ffb8079a0720
    resource: repo://docs/workspace.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 적재

적재는 이미 떨어진 파일을 목적지로 넣는 단계다. TransformSpec의 dest는 호환용으로만 남고, 새 작업은 `loads` 정의와 load 칩을 쓴다.

관련 페이지: [변환](/openwiki/workflows/transform.md), [커넥터](/openwiki/integrations/connectors.md), [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [저장과 로깅](/openwiki/operations/storage-and-logging.md).

## 정의

목적지는 두 종류다.

| type | 필드 | 쓰기 모드 |
| --- | --- | --- |
| `database` | `connection_id`, `table`, 선택 `database` | `append` \| `truncate` \| `upsert` \| `recreate` \| `replace` |
| `file` | `format`=`csv`\|`parquet`, `filename` | `replace` 또는 `recreate`만 |

기본 모드는 `append`다. `upsert`는 충돌 키가 하나 이상 있어야 하고 키는 `parse_ident`를 통과한다. HTTP 커넥션은 DB 타깃이 될 수 없다. 파일 이름은 `/` `\\` `.` `..`를 거절한다.

단독 페이지의 `input_dataset_id`는 기본 입력이다. `contract:` planned id나 없는 id는 FK로 묶지 않는다. 캔버스에서는 data 에지의 업스트림 최신 출력이 이를 우선한다. 연결 없는 적재는 데이터 연결이 필요하다.

## 실행

칩 워커 `run_load`는 스냅샷의 입력이 실재 파일인지 확인한 뒤 `execute_load_config`를 호출한다.

- **DB**: parquet/CSV를 적재용 CSV로 준비하고 `connectors::load_table`에 넘긴다. 빈 필드는 텍스트가 아니면 전용 NULL 마커로 보낸다.
- **파일**: `loads/{workspace_id}/{scope_id}/{filename}`에 복사하거나 parquet로 변환한다. 칩 최신 출력 슬롯을 덮어쓰지 않는다.

결과는 `load_results`에 행 수, 바이트, 처리 시간, 검증 상태를 남긴다. 구분자 입력은 적재 전에 빈 셀을 검사하고 최대 100개를 warn 로그로 남긴다. parquet 입력은 이 검사를 건너뛴다.

단독 `POST /api/loads/run`은 즉시 `running`으로 두고 같은 `execute_load_config`를 호출한다. 칩 경로는 실행 큐를 탄다.

## 불변

- 변환 spec에 dest를 넣어 적재를 확장하지 않는다.
- 캔버스 입력은 data 에지다. 카탈로그 UUID를 키우지 않는다.
- 자격 증명은 `connection_id`로만 읽는다.
- 파일 적재는 replace 계열만 허용한다. append로 서버 파일을 이어 쓰지 않는다.
