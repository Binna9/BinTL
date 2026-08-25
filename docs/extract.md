# 추출 (Extract)

작성: 2026-08-22

이 문서는 제품에서 추출이 의미하는 것, 이번에 짠 회로, 구현한 API/화면, 의도적으로 안 한 것을 한곳에 둔다.

## 제품에서 추출이 의미하는 것

추출은 DB에서 타깃으로 바로 넣는 단계가 아니다.
**커넥션으로 테이블을 보고, 구분자를 정한 뒤, 서버에 파일을 남기는 단계**다.

```
커넥션
  → 테이블 / 컬럼 / 미리보기 (클라이언트처럼)
  → 구분자·헤더 선택
  → 서버 파일 생성  (data/extracts/databases/{id}/…)
  → 그 파일을 변환(Polars) · 적재의 입력으로 사용
```

파일은 중간 찌꺼기가 아니라 작업 공간이다. 서버에서 열어보고 나중에 고칠 수 있다.

하지 않는 방향:

- DB → DB 스트림으로 파일을 건너뛰지 않는다.
- “변환 없음”이어도 추출 파일은 남긴다. 변환 없음은 변환 UI를 아직 안 쓴 상태일 뿐이다.
- Polars는 추출에 쓰지 않는다. 추출은 connectors + sqlx/tiberius + csv.

## 이번에 한 일

### 1. 코어 `crates/connectors`

새 모듈:

- `inspect.rs` — 스키마/미리보기
- `extract.rs` — 구분자 파일 기록

| 심볼 | 역할 |
| --- | --- |
| `ExtractOptions` | `delimiter: u8`, `header: bool`, `quote: u8` (`"` 고정) |
| `parse_delimiter` | `,` `\|` `;` `^` `tab`/`\t` 또는 ASCII 문자 하나 |
| `list_columns(conn, table)` | 이름, 타입, nullable. 순서는 `ordinal_position` / `PRAGMA cid` |
| `preview_table(conn, table, limit)` | 샘플 행. 기본 50, 최대 200. MSSQL은 `TOP` |
| `extract_table(..., options)` | `SELECT *`를 지정 구분자 파일로 스트림 기록 |

추출 동작 디테일:

- 헤더는 `information_schema` / `PRAGMA`에서 가져온다. 0행 테이블도 헤더만 있는 파일을 남긴다.
- 행은 `fetch` / `into_row_stream`으로 쓴다. 예전처럼 `fetch_all`로 테이블 전체를 RAM에 올리지 않는다.
- 테이블/스키마 식별자는 기존 `parse_table`과 같다 (`name` 또는 `schema.name`, `[A-Za-z0-9_]`만).
- 스키마 생략 시 postgres=`public`, mssql=`dbo`, mysql=`DATABASE()`, sqlite는 테이블명만.

스키마가 없는 테이블을 가리키면 `no columns for table …`로 실패한다.

### 2. 저장 `crates/storage`

- 마이그레이션 `0003_extracts.sql`
- 테이블 `extracts`는 접속정보와 같이 `data/etl.db`에 영구 보관
- 파일 위치: `{data_dir}/extracts/{kind}/{id}/{filename}`
  - `uploads/` — 브라우저에서 올린 파일
  - `databases/` — DB 테이블/쿼리 추출
  - `api/` — HTTP 소스 (아직 비어 있음, 기동 시 디렉터리만 생성)
- 파일 내용 자체는 DB BLOB에 넣지 않는다
- `Store::open`이 `extracts/{uploads,databases,api}` 와 `outputs/` 를 만든다
- 예전 `data/uploads/` · `data/extracts/{id}/` 는 기동 시 새 경로로 옮긴다
- connections 삭제와 FK를 걸지 않았다. 커넥션을 지워도 추출 파일은 남는다. 목록의 `connection_name`만 빈 문자열이 된다

상태: `queued` → `running` → `succeeded` | `failed`

진행 로그: `data/logs/extracts/{id}.log`. 1행, 이후 1만 행마다 기록. `running` 중 `row_count`를 2초마다 갱신해 `/extracts` 목록에서 쓰는 중 행 수를 보여준다. `GET /api/extracts/:id/logs`로 파일 내용을 읽을 수 있다.

파일 이름:

| delimiter | 확장자 |
| --- | --- |
| `,` | `.csv` |
| `tab` | `.tsv` |
| 그 외 | `.txt` |

테이블 `public.users` → `public_users.csv`

### 3. API (`crates/server`)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/connections/:id/tables` | 테이블 목록 (기존) |
| GET | `/api/connections/:id/columns?table=` | 컬럼 |
| GET | `/api/connections/:id/preview?table=&limit=` | 미리보기 |
| POST | `/api/extracts` | 추출 시작. 201 즉시, 백그라운드 실행 |
| GET | `/api/extracts` | 목록 (`?limit=`, 기본 50, 최대 200) |
| GET | `/api/extracts/:id` | 상세·상태 |
| GET | `/api/extracts/:id/file` | 파일 다운로드 (`succeeded`만) |

`POST /api/extracts` 본문:

```json
{
  "connection_id": "…",
  "table": "public.users",
  "delimiter": "|",
  "header": true
}
```

`delimiter` 예: `,` `|` `;` `^` `tab`. 생략 시 `,`. `header` 생략 시 `true`.

인코딩은 이번엔 UTF-8만. quote는 `"` 고정.

잡 소스에 추출 파일을 쓸 때:

```json
POST /api/jobs
{ "extract_id": "…", "select": ["id"], "dest_connection_id": "…", "dest_table": "dw.fact" }
```

우선순위: `file_id` > `extract_id` > `connection_id`+`table` > `source_path`.

`extract_id`로 잡을 만들면 spec에 `delimiter` / `has_header`를 넣는다. 엔진이 파이프·탭 파일을 콤마로 오독하지 않게 하기 위함이다.

파이프라인 잡이 `db:{uuid}/{table}` 소스를 쓸 때는 같은 `extract_table` + `ExtractOptions::default()`(콤마, 헤더 있음)를 쓴다. 산출은 `extracts/databases/{job_id}/extract.csv`. 추출 전용 화면의 파일과는 별개다.

### 4. 엔진

`TransformSpec`에 `delimiter`, `has_header`를 추가했다. 추출 산출물을 변환 입력으로 쓸 때만 의미가 있다.

확장자만으로도 `.tsv`는 탭으로 읽는다. spec이 있으면 spec이 이긴다.

### 5. 화면

- `/connections`: 저장/테스트 + **browse** → 테이블 클릭 → 컬럼 + 미리보기 + 추출 폼
- `/extracts`: 서버 파일 목록, queued/running이면 2초 폴링, 성공 시 다운로드
- `/jobs`: 소스에 완료된 extract 선택 가능

## 레이어

```
UI
  → Axum
      → storage.extracts + 디스크
      → connectors.inspect / extract   (sqlx, tiberius)
jobs (변환 잡)
  → 같은 extract_table (콤마 기본)  또는  extract 파일 경로
  → engine (Polars)   ← 추출이 아님
      spec.delimiter / has_header 로 그 파일을 읽음
```

Polars는 추출에 쓰지 않는다.

## 하지 않은 것 (다음)

- EUC-KR 등 인코딩 선택
- quote/escape UI
- 추출 파일 서버에서 직접 편집하는 에디터
- 변환 빌더 UI — [docs/transform.md](transform.md)
- Parquet로 추출. 지금은 사람이 볼 구분자 텍스트가 산출물
- 추출 스케줄
- 대용량 다운로드 스트리밍. 지금 `GET …/file`은 job result와 같이 파일을 메모리에 올린다
- 추출 중 취소
- connections 삭제 시 extracts 정리

## 알려진 천장 (ponytail)

- csv 기록은 async 워커에서 동기 write. 대량 추출이 런타임을 잠그면 writer를 `spawn_blocking`으로 빼면 된다.
- inspect/preview/extract가 각각 커넥션을 연다. 풀 재사용은 다음.
- 셀 stringify는 string/i64/i32/f64/bool만. timestamp·bytea는 빈 칸이 될 수 있다.
- 새 테이블 적재는 여전히 TEXT 컬럼 + 배치 INSERT.

## 로컬에서 확인

빌드/실행은 이 작업에서 돌리지 않았다. 기동 후:

1. `/connections`에 커넥션 저장, test
2. browse → 테이블 클릭 → 컬럼/미리보기 확인
3. delimiter 고르고 extract → `/extracts`에서 succeeded 후 다운로드
4. `/jobs`에서 그 extract를 소스로 create + run
