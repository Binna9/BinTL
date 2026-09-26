# 대량 추출·적재

작성: 2026-09-14

이 문서는 Postgres `COPY`와 다른 DB bulk를 이어서 붙일 때 본다. 화면 계약은 [extract.md](extract.md), [load.md](load.md).

속도가 목표면 행마다 SQL을 돌리지 말고, DB가 제공하는 대량 경로로 빼고 넣는다. BinTL은 파일을 가운데 둔다. DB→DB 직접 복사는 하지 않는다.

## 지금 (Postgres만)

대상 드라이버는 `connections.driver = 'postgres'`다. redshift/cockroach는 같은 패밀리여도 이 길을 타지 않는다.

| 방향 | 모드 | 구현 |
| --- | --- | --- |
| 적재 | `append` `truncate` `replace` `recreate` | `COPY … FROM STDIN` (CSV). NULL 마커 + `FORCE_NULL`. 코드: `connectors` `copy_postgres_csv` |
| 적재 | `upsert` | 예전 배치 `INSERT … ON CONFLICT` |
| 추출 | 테이블, 또는 `SELECT`/`WITH`/`VALUES`/`TABLE` 쿼리 | `COPY … TO STDOUT` (CSV). 구분·따옴표·헤더는 extract 옵션. 코드: `copy_postgres_to_file` |
| 추출 | `add_sequence`, `SHOW`/`EXPLAIN` 등 | 예전 행 스트림 |

추출 COPY는 셀을 Rust에서 stringify하지 않는다. 날짜·bytea 포맷이 `stringify_pg`와 다를 수 있다. 헤더 있는 0행 테이블은 `HEADER true`로 헤더만 남긴다. 행 수는 CSV 레코드 카운터로 센다.

코드:

- 적재 COPY: `crates/connectors/src/lib.rs` `copy_postgres_csv`
- 추출 COPY: `crates/connectors/src/extract.rs` `copy_postgres_to_file`
- 쿼리 추출 분기: `crates/connectors/src/query.rs` `extract_query` (`postgres_copy_query_ok`)

## 이어서 할 일

한 드라이버씩. 호출부는 그대로 `extract_table` / `extract_query` / `load_table`. `driver == "postgres"`만 이 길을 탄다.

1. **Postgres upsert 적재** — COPY로 스테이징 테이블에 넣고 `INSERT … ON CONFLICT`.
2. **Postgres 추출 예외** — `add_sequence`는 COPY에 `#` 컬럼을 못 붙이니 행 스트림 유지. `SHOW`/`EXPLAIN`도 그대로. 필요하면 추출 중 취소.
3. **MySQL/MariaDB** — 적재 `LOAD DATA LOCAL INFILE`(또는 클라이언트 스트림). 추출은 fetch/버퍼. COPY 짝 없음.
4. **SQL Server** — 적재 `BULK INSERT` 또는 TVP. 추출은 fetch 크기.
5. **Oracle** — 적재 `SQL*Loader` / OCI Direct Path. 추출은 array fetch. 지금 ODBC INSERT/SELECT.
6. **Tibero** — DB는 `tbLoader` / Direct Path. BinTL은 ODBC라 COPY급 스트림이 없다.
7. **Redshift** — 적재는 S3 `COPY`. FROM STDIN이 아니다.
8. **Cockroach** — Postgres식 COPY 가능. 드라이버를 열어 검증한 뒤 postgres 길을 태운다.
9. parquet 추출, 파일 append, 적재 중 취소는 이 표와 별개다.

## 만지지 말 것

- HTTP 추출, 업로드 파일, 파일 destination 적재
- 변환 Polars
- 워크스페이스 칩 순서. bulk는 connectors I/O만 바꾼다
