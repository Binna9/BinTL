---
type: concept
title: 칩, 실행, 최신 출력
description: BinTL 제품 모델은 이름 있는 칩 레시피, 추가 전용 실행 이력, 워크스페이스+칩당 하나인 최신 출력 슬롯이다. 다음 칩은 카탈로그 UUID가 아니라 이 슬롯을 읽는다.
tags: [chip, run, current-output, workspace, data-edge]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-3a9e14836453a58467b063e9
    resource: repo://.cursor/rules/workspace-pipeline.mdc
  - id: openwiki-source-f7db3943f1a5eb342cc3e264
    resource: repo://crates/server/src/planned_input.rs
  - id: openwiki-source-5fb98e50287bf5c277a5d3ff
    resource: repo://crates/storage/migrations/0001_schema.sql
  - id: openwiki-source-cf96dafdf729371c5d3f9ac0
    resource: repo://crates/storage/src/chip_run_repo.rs
  - id: openwiki-source-189c6759c996de79980fb5cc
    resource: repo://crates/storage/src/chip_slot.rs
  - id: openwiki-source-812ad5ec0eab85f4bc2ffb70
    resource: repo://crates/storage/src/models.rs
  - id: openwiki-source-57291caf28bfcf2ec46b220f
    resource: repo://docs/schema.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 칩, 실행, 최신 출력

BinTL의 제품은 워크스페이스 캔버스다. `/db`, `/files`, `/transform/*`는 칩을 만들거나 고치는 도구이지, UUID 경로로 파일을 고르는 두 번째 파이프라인이 아니다.

사용자에게 보이는 정체는 **칩 이름**과 **그 칩의 최신 출력**이다. 내부 UUID와 `extracts/…/{uuid}`, `outputs/{job_id}` 경로는 레거시 단독 작업 또는 저장 키일 뿐 UI 정체가 아니다.

관련 페이지: [워크스페이스 캔버스](/openwiki/workflows/workspace-canvas.md), [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md), [추출](/openwiki/workflows/extract.md), [변환](/openwiki/workflows/transform.md).

## 세 개념

### Chip

칩은 이름 있는 레시피다. `kind`는 `extract` | `transform` | `load` | `validation`이다. `chips`는 해당 ETL 정의(`extracts` / `transforms` / `loads`)를 참조하고, 초안은 참조가 비어 `config_json`만 가질 수 있다. 소유자+이름은 대소문자 무시 유일하다.

사용자가 보는 것은 칩 이름이다. 다운로드도 칩/데이터 파일 id로 하며 `stored_path`를 화면에 노출하지 않는다.

### Run

실행은 추가 전용 이력이다. 모든 실행은 `executions` 아래 `execution_steps`로 남는다. 칩 단독 실행은 `source = 'chip'`, 캔버스 전체 실행은 `source = 'workspace'`다.

레시피를 고쳐도 과거 단계의 `definition_snapshot_json` / `revision_snapshot`은 바뀌지 않는다. 성공한 단계는 출력 파일을 가리키고, 실패한 단계는 오류를 남긴다. 한 단계는 `queued`에서 `running`으로 한 번만 간다.

### Current output

워크스페이스+칩(+포트)당 최신 파일은 하나다. 테이블은 `workspace_chip_outputs`다. 재실행은 슬롯을 덮어쓴다. 디스크 경로는 `chip_outputs/{workspace_id}/{chip_id}/{slot_file}`이다.

| kind | 슬롯 파일 | 사용자에게 보이는 이름 |
| --- | --- | --- |
| extract | `current.csv` / `current.tsv` / `current.txt` | `{칩이름}.csv` 등 |
| transform | `current.parquet` | `{칩이름}.parquet` |

다음 칩은 카탈로그에서 파일을 고르지 않는다. **data 에지**의 업스트림 슬롯(`current_data_file_id`)을 읽는다. 변환 입력은 업스트림 칩의 최신 출력이지 `dataset_id`나 사용자가 고른 경로가 아니다. 한 칩으로 들어오는 data 에지는 둘 이상이면 거절한다. 검증만 source/target 두 입력을 허용한다.

레거시 `extracts/`·`outputs/{job_id}`는 예전 단독 작업용이다. 새 칩 실행은 슬롯에 쓴다.

## 설계 대 실행

파일이 아직 없어도 캔버스에서 체인을 짤 수 있다.

- **파일 없음**: 컬럼은 업스트림 extract 레시피에서 온다. DB inspect 또는 SQL 미리보기다. 이 계약은 `workspace_chip_outputs`의 `schema_id`와 `expected_filename`으로만 남긴다. `data_files`에 가짜 행을 넣지 않는다. 미리보기 API가 돌려주는 planned dataset은 `status = "planned"`, 빈 `stored_path`, 합성 id `contract:{workspace}:{consumer}`인 메모리 뷰다.
- **파일 있음**: 미리보기와 실행은 슬롯이 가리키는 실재 파일을 읽는다.
- **실행인데 파일 없음**: 업스트림이 extract면 동기 실행을 한 번 시도한다. 그래도 슬롯이 비면 `"upstream extract did not produce a dataset"`으로 실패한다. 연결이 없으면 `"transform input is not connected"`다. 사용자 대신 가짜 dataset을 만들지 않는다.

검증 칩은 새 데이터를 생산하지 않으므로 `execution_outputs`와 `workspace_chip_outputs`를 만들지 않는다. 차이는 단계 실패로만 남는다.

## 불변

- 사용자 정체 = 칩 이름 + 최신 출력. UUID는 내부 키다.
- data 에지가 입력 계약이다. 워크스페이스 모드 변환은 파일 카탈로그를 보여 주지 않는다.
- 실재 파일만 `data_files`에 등록한다. 예상 스키마는 슬롯 계약이다.
- `/db`에서 칩으로 저장하면 extract 칩을 만들고 실행한다. 같은 동작으로 두 번째 단독 추출 파일을 쓰지 않는다.
- 자격 증명은 칩 설정이나 실행 스냅샷에 복사하지 않고 `connection_id`로만 참조한다.

## 확장

combine / aggregate / load도 같은 칩 → 에지 → 최신 출력 규칙을 따른다. 파일 카탈로그를 키우는 단독 페이지를 새로 만들지 않는다.
