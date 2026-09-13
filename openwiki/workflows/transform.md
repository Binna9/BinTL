---
type: workflow
title: 변환
description: 변환은 업스트림 최신 출력 또는 실재 파일을 TransformSpec으로 읽어 parquet를 만든다. engine은 파일+spec만 알고 dest를 넣지 않으며, 워크스페이스 모드는 파일 카탈로그를 보여 주지 않는다.
tags: [transform, polars, engine, jobs, chip]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-d16ae9a6f9ffe8f484b3231a
    resource: repo://crates/engine/src/lib.rs
  - id: openwiki-source-7490f1ad71907142c28ac29d
    resource: repo://crates/jobs/src/lib.rs
  - id: openwiki-source-f7db3943f1a5eb342cc3e264
    resource: repo://crates/server/src/planned_input.rs
  - id: openwiki-source-cbead755a9031344799d327d
    resource: repo://crates/server/src/transform.rs
  - id: openwiki-source-561063ef054dd7a59e22e27f
    resource: repo://ui/src/pages/TransformPage.tsx
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 변환

변환은 DB에 다시 넣는 단계가 아니다. 이미 떨어진 파일을 읽고, 순서 있는 스텝으로 **parquet**를 만든다. 적재는 `/load`와 load 칩이다.

관련 페이지: [추출](/openwiki/workflows/extract.md), [적재](/openwiki/workflows/load.md), [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [런타임과 크레이트 경계](/openwiki/architecture/runtime.md).

## 입력 계약

워크스페이스에서 변환 칩을 누르면 `/transform/…?workspace=&chip=`로 들어간다. 이 모드의 입력은 **업스트림 칩 이름**이다. 파일 카탈로그와 `stored_path`를 보여 주지 않는다.

실행 시 `resolve_materialized_transform_input`이 data 에지의 최신 출력을 고른다. 슬롯이 비면 업스트림 extract를 동기 실행한다. 연결이 없고 단독 `input_dataset_id`도 없으면 실패한다. 한 칩으로 들어오는 data 에지는 둘 이상이면 거절한다. combine의 추가 데이터셋은 spec 안에서 해석한다.

파일이 없으면 미리보기는 planned 스키마(업스트림 레시피 inspect)만 돌려준다. 스텝을 얹은 planned preview는 거절한다. 파일이 있으면 같은 engine apply를 `spawn_blocking`으로 돌린다.

## Spec과 engine

`engine`은 HTTP/SQLite를 모른다. 파일 경로와 `TransformSpec`만 받는다. sink는 parquet가 아니면 거절한다.

| version | 내용 |
| --- | --- |
| 1 | `identity` / `pipeline`. dest를 포함한 옛 잡이 아직 돈다 |
| 2 | `steps` + 선택 `combine`. **dest 금지** |
| 3 | `operations`. dest 금지 |

v2 스텝: `select`, `drop`, `rename`, `filter`, `cast`, `fill_null`, `sort`, `unique`. 빈 스텝 `{ "version": 2, "steps": [], "sink": "parquet" }`는 identity다. 임의 코드 map/apply와 브라우저 Polars는 없다. 미리보기도 서버 engine이다.

`combine`은 여러 데이터셋을 join/stack한 뒤 스텝을 적용한다. 데이터셋 id는 JSON에 있고, 서버가 실행 시 경로를 채운다.

## 실행과 출력

칩 변환은 입력 파일이 있는지 확인한 뒤 `ExecutionTask::Job`을 큐에 넣는다. `jobs::execute`가 spec을 파싱하고 Polars를 `spawn_blocking`으로 돌린다.

- 칩이 연결된 잡: `chip_outputs/{workspace}/{chip}/current.parquet`
- 레거시 단독 잡: `outputs/{job_id}/result.parquet`

재실행은 슬롯을 덮어쓴다. 이력의 spec 스냅샷은 그대로다. v1 dest가 있으면 jobs가 CSV를 내보낸 뒤 connectors 적재를 이어서 호출할 수 있다. 새 레시피에 dest를 넣지 않는다.

## 불변

- 워크스페이스 변환은 카탈로그 UUID를 입력 정체로 쓰지 않는다.
- engine crate에 적재·HTTP를 넣지 않는다.
- 파일이 없으면 가짜 dataset을 만들지 않는다.
- 핸들러에서 Polars collect를 돌리지 않는다.
