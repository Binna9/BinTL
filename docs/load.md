# 적재

작성: 2026-09-13

적재는 변환 dest가 아니라 독립 `loads` 정의와 load 칩이다. 업스트림 최신 출력(또는 단독 페이지의 materialized 파일)을 DB 또는 서버 파일로 넣는다. 캔버스에서는 data 에지가 필요하다.

## 정의

| destination | 필드 | 쓰기 모드 |
| --- | --- | --- |
| `database` | `connection_id`, `table`, 선택 `database` | `append` \| `truncate` \| `upsert` \| `recreate` \| `replace` |
| `file` | `format`=`csv`\|`parquet`, `filename` | `replace` 또는 `recreate`만 |

기본 모드는 `append`다. `upsert`는 충돌 키가 입력 컬럼에 있어야 한다. redshift와 mssql upsert는 아직 거절한다. HTTP 커넥션은 DB 타깃이 될 수 없다. 파일 이름에 `/` `\\` `.` `..`를 넣지 않는다.

`contract:` planned id는 `default_input_file_id` FK로 묶지 않는다.

## 실행

칩 워커가 실재 파일을 확인한 뒤 `execute_load_config`를 호출한다.

- DB: parquet/CSV를 적재용 CSV로 만들고 `connectors::load_table`에 넘긴다. 빈 필드는 비텍스트 컬럼에서 NULL 마커로 보낸다.
- 파일: `loads/{workspace}/{scope}/{filename}`에 복사하거나 parquet로 바꾼다. 칩 최신 출력 슬롯을 덮어쓰지 않는다.

수치와 대상은 `execution_steps.result_json`에 남긴다. 별도 `load_results` 테이블은 없다. 구분자 입력은 적재 전 빈 셀을 검사하고 최대 100개를 warn으로 남긴다. parquet 입력은 이 검사를 건너뛴다.

`POST /api/loads/run`은 같은 실행 함수를 즉시 호출한다.

## 하지 않는 것

COPY/Bulk, 파일 append, 적재 중 취소.
