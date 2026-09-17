# 추출

작성: 2026-09-13

추출은 DB에 바로 넣는 단계가 아니다. 커넥션의 테이블·SQL·HTTP 또는 업로드를 **서버 파일**로 남긴다. Polars를 쓰지 않는다. DB→DB로 파일을 건너뛰지 않는다.

제품 경로: `/db`에서 칩으로 저장하면 extract 칩을 만들고 실행한다. 같은 동작으로 두 번째 단독 추출 파일을 쓰지 않는다.

## 레시피

```json
{
  "connection_id": "…",
  "source": { "type": "table", "table": "public.users", "database": null },
  "delimiter": ",",
  "header": true
}
```

`source.type`: `table` | `query` | `http`. 자격 증명은 `connection_id`만 저장한다.

`connectors::extract_table` / `extract_query` / `extract_http`가 행을 스트림으로 CSV에 쓴다. 테이블 전체를 `fetch_all`로 올리지 않는다. **Postgres** 테이블 추출과 `SELECT`/`WITH` 쿼리는 `COPY TO STDOUT`이다. 시퀀스 컬럼을 붙이거나 `SHOW`류면 예전 행 스트림이다. 컬럼이 없으면 실패한다. 0행이어도 헤더만 남긴다. 구분자는 ASCII 한 글자 또는 `tab`. quote는 `"`.

다른 DB bulk는 [bulk.md](bulk.md).

테이블 식별은 `name` 또는 `schema.name`, `[A-Za-z0-9_]`만. 스키마 생략 시 postgres=`public`, mssql=`dbo`, oracle/tibero=접속 사용자(대문자).

## 출력 경로

| 실행 | 디스크 |
| --- | --- |
| 칩 | `chip_outputs/{workspace}/{chip}/current.{csv\|tsv\|txt}` |
| 단독 `/api/extracts` | `extract_runs/{database\|api}/{id}/{filename}` |
| 업로드 | `extract_runs/uploads/…` |

사용자에게 보이는 이름은 칩 이름이다. 재실행은 슬롯을 덮어쓴다.

다운스트림이 슬롯이 비어 있으면 `run_extract_chip_sync`가 최대 120초 업스트림 extract를 기다린다.

## API / 화면

커넥션 browse·컬럼·미리보기·SQL은 inspect/query. `POST /api/extracts`는 레거시 단독 실행이고 `workspace_id`가 필요하다. 파일은 그 워크스페이스 칸에 붙는다. `/extracts` 목록은 작업구분 트리로 본다. 반복 작업은 캔버스 칩.

`GET /api/extracts/:id/logs`와 칩 로그는 모두 `execution_logs`다.

## 하지 않는 것

EUC-KR 선택, quote UI, 서버 파일 에디터, parquet 추출, 추출 중 취소, 커넥션 삭제 시 추출 파일 cascade.

## ponytail 천장

- csv write는 워커에서 동기 I/O. 런타임을 잠그면 `spawn_blocking`. Postgres COPY는 async 청크 쓰기.
- inspect/preview/extract가 커넥션을 따로 연다.
- 셀 stringify는 일부 타입만. timestamp·bytea는 빈 칸이 될 수 있다. Postgres COPY 추출은 DB CSV 포맷이라 stringify와 날짜 표현이 다를 수 있다.
