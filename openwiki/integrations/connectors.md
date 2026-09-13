---
type: integration
title: 커넥터
description: connectors crate는 DB inspect/추출/적재, HTTP 추출, 스프레드시트 시트 변환만 담당한다. 워크스페이스 화면 상태를 알지 못하며 식별자와 SQL은 제한된 파서로만 받는다.
tags: [connectors, database, http, spreadsheet, extract, load]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-33e35d932a19926d3c58f1d4
    resource: repo://crates/connectors/src/extract.rs
  - id: openwiki-source-66eda266f18b8ccd4b886dd9
    resource: repo://crates/connectors/src/lib.rs
  - id: openwiki-source-7d50daea6b4c413b05953199
    resource: repo://crates/connectors/src/query.rs
  - id: openwiki-source-1a7cdaec9f81614f4d710117
    resource: repo://crates/server/src/api/connections.rs
  - id: openwiki-source-0fdc6753bf2731fa7b499ee0
    resource: repo://crates/storage/src/connection_repo.rs
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 커넥터

`crates/connectors`는 외부 I/O 어댑터다. 커넥션 자격 증명과 테이블/쿼리/HTTP spec을 받아 미리보기·파일 추출·적재를 수행한다. 칩 배치, 에지, 캔버스 좌표를 모른다. HTTP 라우트와 권한 검사는 `crates/server`가 소유한다.

관련 페이지: [런타임과 크레이트 경계](/openwiki/architecture/runtime.md), [추출](/openwiki/workflows/extract.md), [적재](/openwiki/workflows/load.md).

## 지원 드라이버

`driver_family`가 와이어 프로토콜을 묶는다. 컴파일된 드라이버 하나가 여러 서버 별칭을 커버한다.

| 입력 driver | family | 기본 포트 |
| --- | --- | --- |
| `postgres`, `redshift`, `cockroach` | postgres | 5432 |
| `mysql`, `mariadb` | mysql | 3306 |
| `mssql`, `sqlserver` | mssql | 1433 |
| `sqlite` | sqlite | 0 |
| `http` | http | 0 |

커넥션 생성·수정은 `CONNECTION_WRITE`가 있는 역할만 한다. 비밀번호는 `storage`가 `session_secret`으로 암호화해 `password_cipher`에 넣고, 실행 시 `LiveConnection`으로만 복호화한다. 칩 설정이나 실행 스냅샷에는 복사하지 않는다. 테스트는 family별 `SELECT 1` 또는 HTTP ping이다.

풀은 family마다 최대 1연결, acquire timeout 8초다. postgres/mysql은 rustls SSL 모드를 커넥션 `ssl` 플래그로 고른다. MSSQL은 tiberius다.

## 식별자와 SQL

테이블은 `name` 또는 `schema.name`만 받는다. 각 부분은 `[A-Za-z0-9_]`만 허용한다. 스키마 생략 시 postgres=`public`, mssql=`dbo`, mysql/sqlite는 테이블명만이다. 식별자 `parse_ident`는 128자 이하, 하이픈 추가 허용이다.

SQL은 `normalize_sql`이 앞뒤 공백과 한 문장만 허용한다. `;`로 이은 두 번째 문은 거절한다. `sql_kind`가 첫 키워드로 Rows(`SELECT`/`WITH`/`SHOW`/…)와 Exec를 나눈다. 추출 쿼리는 Rows만 받는다. 미리보기 `run_sql`은 Rows를 DB에서 `LIMIT`로 캡(1–1000)하고, Exec는 그대로 실행한다.

## 추출

`extract_table`은 `list_columns`로 헤더를 만든 뒤 `SELECT *`를 행 스트림으로 CSV에 쓴다. 테이블 전체를 `fetch_all`로 RAM에 올리지 않는다. 컬럼이 없으면 `no columns for table`로 실패한다. 0행이어도 헤더만 있는 파일을 남긴다.

`extract_query`는 같은 Writer로 Rows SQL을 스트림 기록한다. 구분자는 ASCII 한 글자 또는 `tab`이다. quote는 `"` 고정이다. 선택적으로 `#` 시퀀스 컬럼을 맨 앞에 붙인다.

HTTP 추출은 `HttpRequestSpec`(REST 또는 GraphQL, method/path/query/headers/body, `records_path`)이다. 미리보기는 JSON을 행으로 펼치고, 본 추출은 CSV로 떨어뜨린다. 커넥션의 `http_auth`가 인증 헤더를 붙인다.

스프레드시트는 `.xls`/`.xlsx`만 받는다. `list_sheets` 후 선택한 시트를 CSV로 보낸다. 업로드 스테이징 경로는 server `files` API가 소유한다.

## 적재

`load_table`은 CSV를 읽어 대상 테이블에 넣는다. 허용 모드: `append` | `truncate` | `upsert` | `recreate` | `replace`. 테이블 식별은 추출과 같은 `parse_table`이다.

빈 CSV 필드는 텍스트 컬럼에서는 빈 문자열로 남기고, 알려진 비텍스트 타입은 NULL로 보낸다. `recreate`는 TEXT 컬럼으로 새 테이블을 만들므로 빈 문자열을 유지한다. `upsert`는 충돌 키가 입력 컬럼에 있어야 하며, redshift와 mssql은 아직 거절한다.

## 불변

- connectors는 Workspace UI/칩 그래프를 의존하지 않는다.
- 테이블·스키마 문자열은 파서가 허용한 문자만 인용해 SQL에 넣는다.
- 추출은 스트림 기록이다. 전체 결과 셋을 한 번에 모으지 않는다.
- 자격 증명은 storage 암호문에서만 살아 나온다.

## 확장

새 DB는 `driver_family`와 pool/stream/load 분기를 같은 crate에 추가한다. 화면 상태나 칩 슬롯 경로는 여기 두지 않는다. Bulk COPY 어댑터는 후속 범위다.
