---
type: workflow
title: 추출
description: 추출은 커넥션의 테이블·SQL·HTTP 또는 업로드를 서버 파일로 남기는 단계다. 칩 실행은 최신 출력 슬롯에 쓰고, Polars와 DB→DB 스트림은 쓰지 않는다.
tags: [extract, chip, connectors, files]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-3a9e14836453a58467b063e9
    resource: repo://.cursor/rules/workspace-pipeline.mdc
  - id: openwiki-source-33e35d932a19926d3c58f1d4
    resource: repo://crates/connectors/src/extract.rs
  - id: openwiki-source-a0afc150d920a4ed4781e371
    resource: repo://crates/server/src/chip.rs
  - id: openwiki-source-6553e078d267996237f1adb8
    resource: repo://crates/server/src/extract.rs
  - id: openwiki-source-481b53588b3111905d3bf1e7
    resource: repo://docs/extract.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 추출

추출은 타깃 DB에 바로 넣는 단계가 아니다. 커넥션으로 소스를 보고 구분자를 정한 뒤 **서버에 파일을 남긴다**. 그 파일이 변환·적재의 입력이다. “변환 없음”이어도 추출 파일은 남긴다.

관련 페이지: [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [커넥터](/openwiki/integrations/connectors.md), [변환](/openwiki/workflows/transform.md), [저장과 로깅](/openwiki/operations/storage-and-logging.md).

## 제품 경로

`/db`에서 칩으로 저장하면 extract 칩을 만들거나 갱신하고 실행한다. 같은 동작으로 두 번째 단독 추출 파일을 쓰지 않는다. 업로드(`/files`)와 API 추출도 결국 서버 파일이고, 캔버스에 올리려면 칩이 된다.

레시피는 대략 이 모양이다.

```json
{
  "connection_id": "…",
  "source": { "type": "table", "table": "public.users", "database": null },
  "delimiter": ",",
  "header": true
}
```

`source.type`은 `table` | `query` | `http`다. 쿼리는 `source.sql`, HTTP는 메서드·path·`records_path` 등이다. 자격 증명은 `connection_id`만 저장한다.

## 실행

칩 워커의 `run_extract`는 스냅샷을 `prepare_extract_chip_run`에 고정한 뒤 `extract::run`을 같은 단계 id로 호출한다. `extract::run`은 connectors로 파일을 스트림 기록한다. Polars를 쓰지 않는다. DB→DB로 파일을 건너뛰지 않는다.

목적지는 연결 여부로 갈린다.

- **칩 실행**: `chip_outputs/{workspace}/{chip}/current.{csv|tsv|txt}`. 사용자에게 보이는 이름은 칩 이름이다.
- **단독 `/api/extracts`**: `extract_runs/{kind}/{extract_id}/{filename}`. kind는 `database` | `api`. 업로드는 `extract_runs/uploads`.

헤더는 information_schema / PRAGMA / HTTP 펼침에서 온다. 0행이어도 헤더만 있는 파일을 남긴다. 진행 행 수는 약 2초마다 `execution_logs`에 남긴다.

다운스트림 변환이 슬롯을 읽었는데 파일이 없으면 `run_extract_chip_sync`가 최대 120초 동안 업스트림 extract를 동기 실행한다.

## 미리보기와 도구 페이지

커넥션 browse·컬럼·미리보기·SQL은 connectors inspect/query다. `/api/http/preview`는 HTTP spec을 행으로 펼친다. 이 경로들은 칩을 만들기 위한 도구다. 카탈로그 UUID를 다음 단계의 정체로 키우지 않는다.

단독 extracts 목록·다운로드는 레거시 호환이다. 새 반복 작업은 캔버스 칩이다.

## 불변

- 추출은 connectors + csv다. engine을 호출하지 않는다.
- 커넥션을 지워도 이미 떨어진 파일은 남는다. 목록의 연결 이름만 비울 수 있다.
- 칩 재실행은 슬롯을 덮어쓴다. 실행 이력은 추가된다.
- 변환 입력으로 쓸 파일이 없으면 가짜 dataset을 만들지 않는다.
