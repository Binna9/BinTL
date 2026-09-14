# 적재

작성: 2026-09-13

적재는 변환 dest가 아니라 독립 `loads` 정의와 load 칩이다. 업스트림 최신 출력(또는 단독 페이지의 materialized 파일)을 DB 또는 서버 파일로 넣는다. 캔버스에서는 data 에지가 필요하다.

## 정의

| destination | 필드 | 쓰기 모드 |
| --- | --- | --- |
| `database` | `connection_id`, `table`, 선택 `database` | `append` \| `truncate` \| `upsert` \| `recreate` \| `replace` |
| `file` | `format`=`csv`\|`parquet`, `filename` | `replace` 또는 `recreate`만 |

기본 모드는 `append`다. `upsert`는 충돌 키가 입력 컬럼에 있어야 한다. redshift와 mssql upsert는 아직 거절한다. oracle/tibero upsert는 `MERGE`다. HTTP 커넥션은 DB 타깃이 될 수 없다. 테이블은 카탈로그에서 고르거나 `name` / `schema.table`로 직접 입력한다. 없는 테이블은 입력 컬럼으로 만든다. 파일 이름에 `/` `\\` `.` `..`를 넣지 않는다.

`contract:` planned id는 `default_input_file_id` FK로 묶지 않는다.

## 실행

칩 워커가 실재 파일을 확인한 뒤 `execute_load_config`를 호출한다.

- DB: parquet/CSV를 적재용 CSV로 만들고 `connectors::load_table`에 넘긴다. 빈 필드는 비텍스트 컬럼에서 NULL 마커로 보낸다. Postgres는 아래 대량 적재를 탄다. 그 외 DB는 배치 INSERT/MERGE다.
- 파일: `loads/{workspace}/{scope}/{filename}`에 복사하거나 parquet로 바꾼다. 칩 최신 출력 슬롯을 덮어쓰지 않는다.

수치와 대상은 `execution_steps.result_json`에 남긴다. 별도 `load_results` 테이블은 없다. 구분자 입력은 적재 전 빈 셀을 검사하고 최대 100개를 warn으로 남긴다. parquet 입력은 이 검사를 건너뛴다. 적재 중에는 `load_progress`로 적재 행 수를 남기고 `output_rows`를 갱신한다. 적재 페이지는 실행 전 입력/대상 컬럼을 비교하고, 마지막 적재 수치를 보여 준다.

`POST /api/loads/run`은 같은 실행 함수를 즉시 호출한다.

## 대량 적재

DB마다 대량 넣기 API가 다르다. Postgres `COPY`처럼 클라이언트 스트림 하나로 끝나는 길이 있고, 로더 프로세스·서버 파일·ODBC 확장처럼 BinTL이 지금 안 쓰는 길이 있다.

| 드라이버 | 지금 BinTL | DB가 주는 대량 경로 | 다음 |
| --- | --- | --- | --- |
| **Postgres** | `append` / `truncate` / `replace` / `recreate` → `COPY FROM STDIN` | `COPY` | `upsert`만 COPY로 스테이징 테이블에 넣은 뒤 `INSERT … ON CONFLICT` |
| Redshift / Cockroach | Postgres 패밀리지만 COPY 안 탐. 배치 INSERT | Redshift는 S3 `COPY`, Cockroach는 Postgres식 `COPY` | 필요하면 드라이버별로 따로 |
| MySQL / MariaDB | 배치 INSERT, upsert는 `ON DUPLICATE KEY` | `LOAD DATA [LOCAL] INFILE` | 클라이언트 스트림 적재 |
| SQL Server | 행 단위 INSERT | `BULK INSERT` / TVP | 드라이버 대량 API |
| SQLite | 배치 INSERT | 해당 없음. 트랜잭션+배치가 최선 | 유지 |
| **Oracle / Tibero** | 80행 INSERT, upsert는 `MERGE`. ODBC | Oracle `SQL*Loader` / Direct Path. Tibero `tbLoader` / Direct Path | ODBC로는 COPY급 스트림이 없다. 로더 연동 또는 Direct Path 클라이언트가 따로 필요 |

Tibero도 DB 안에는 대량 적재가 있다. 다만 BinTL은 Tibero에 **ODBC로 INSERT**를 보내고 있어서, 지금 켜진 연결만으로는 Postgres `COPY`처럼 밀어 넣을 수 없다.

이어서 할 드라이버·모드는 [bulk.md](bulk.md).

## 하지 않는 것

Postgres 외 Bulk, Postgres upsert COPY, 파일 append, 적재 중 취소.
