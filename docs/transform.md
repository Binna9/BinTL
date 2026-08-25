# 변환 (Transform)

작성: 2026-08-25

이 문서는 제품에서 변환이 의미하는 것, 이번에 짠 회로, 구현한 API/화면, 의도적으로 안 한 것을 한곳에 둔다.

## 제품에서 변환이 의미하는 것

변환은 DB에 다시 넣는 단계가 아니다.
**이미 `data/extracts`에 떨어진 파일을 고르고, Polars로 내용을 확인한 뒤, 순서 있는 스텝으로 parquet를 만드는 단계**다.

```
data/extracts/{uploads,databases,api}
  → 카탈로그에서 파일 선택
  → 스키마 + 샘플 (Polars inspect)
  → 스텝 설계 (select / filter / rename / …)
  → transforms 에 레시피 저장
  → jobs 스냅샷 실행
  → data/outputs/{job_id}/result.parquet
```

추출은 connectors가 파일을 남긴다. 변환은 그 파일만 읽는다. 새 변환은 `db:connection/table`을 쓰지 않는다.

하지 않는 방향:

- Polars API를 화면에 그대로 노출하지 않는다. 스텝 리스트만 컴파일한다.
- 변환 spec에 dest(적재)를 넣지 않는다. 적재는 `/load`.
- 임의 코드 map/apply, group by, join, ML은 아직 없다.
- 브라우저에서 Polars를 돌리지 않는다. 미리보기도 서버 엔진이다.

## 역할 분리

- **디스크**: 원본은 `extracts/`, 결과는 `outputs/{job_id}/`.
- **SQLite**: 어떤 파일이 변환 입력인지(`datasets`), 어떻게 바꿀지(`transforms`), 언제 돌렸는지(`jobs`).
- **엔진**: 파일 + spec만. HTTP/SQLite를 모른다. 미리보기도 같은 apply다.

## SQLite

마이그레이션 `0006_transforms.sql`.

### `datasets`

`data/extracts`의 변환 가능 파일 인덱스. 업로드는 예전엔 DB에 없고 디스크만 스캔했다. 추출은 `extracts` 테이블에만 있었다.

| 컬럼 | 의미 |
| --- | --- |
| `id` | 업로드 폴더 UUID / `extracts.id`와 같음 |
| `kind` | `upload` \| `database` \| `api` |
| `extract_id` | DB 추출일 때만 |
| `filename`, `stored_path` | 파일. `stored_path` unique |
| `delimiter`, `has_header` | 읽을 때 힌트 |
| `columns_json`, `row_count`, `inspected_at` | Polars inspect 캐시 |

`extracts`는 추출 실행 이력으로 남긴다. 변환이 고르는 것은 `datasets`다.

업로드 성공·추출 성공·기동 백필에서 upsert한다.

### `transforms`

저장되는 변환 정의. `dataset_id` + `spec_json` (version 2, 스텝만).

### `jobs`

실행 스냅샷. `kind`, `transform_id`, `dataset_id`를 추가했다. `source_path`와 `spec_json`은 실행 시점 복사본이라 레시피를 고쳐도 과거 실행은 그대로다.

기존 v1 잡은 dest를 포함한 채 동작한다.

## Spec v2

```json
{
  "version": 2,
  "read": { "delimiter": ",", "has_header": true },
  "steps": [
    { "op": "filter", "expr": "amount > 0" },
    { "op": "select", "columns": ["id", "amount"] },
    { "op": "rename", "map": { "amount": "amt" } },
    { "op": "cast", "columns": { "id": "Int64" } },
    { "op": "fill_null", "value": "0", "columns": ["amt"] },
    { "op": "sort", "by": [{ "column": "id", "descending": false }] },
    { "op": "unique", "subset": ["id"], "keep": "first" }
  ],
  "sink": "parquet"
}
```

1차 op: `select`, `drop`, `rename`, `filter` (`col >= 1`), `cast`, `fill_null`, `sort`, `unique`.

엔진은 v1 JSON도 읽는다. v2에 `dest`가 있으면 거절한다.

미리보기: parquet를 쓰지 않는다. 원본 inspect는 `n_rows`, 변환 미리보기는 최대 5만 행을 읽은 뒤 head.

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/datasets` | 카탈로그 |
| GET | `/api/datasets/:id` | 상세 |
| POST | `/api/datasets/:id/inspect` | 스키마/행수 캐시 + 샘플 |
| POST | `/api/datasets/:id/preview` | body `{ spec, limit }` 미저장 스텝 미리보기 |
| GET/POST | `/api/transforms` | 목록 / 저장 |
| GET/PATCH | `/api/transforms/:id` | 상세 / 수정 |
| POST | `/api/transforms/:id/run` | job 스냅샷 insert + 큐 |

`POST /api/jobs` v1은 호환용으로 남긴다. 새 UI는 transforms run만 쓴다.

## 화면

- `/transform`: 왼쪽 카탈로그(업로드 / DB 추출 / API) + 저장된 레시피, 가운데 원본 스키마·샘플, 오른쪽 스텝 + 변환 미리보기
- `/transform/:id`: 저장한 레시피 열기
- `/history`: 실행 목록
- `/load`: 적재는 다음. 지금은 안내만
- `/jobs/:id`: 실행 상세 (결과 다운로드)
- `/workspace`: Dataset과 v2 spec을 재사용 가능한 Transform 작업으로 저장하고 반복 실행.
  작업 실행 결과 parquet도 Dataset으로 등록되어 후속 작업의 입력이 된다

## 레이어

```
UI /transform
  → Axum
      → storage.datasets / transforms / jobs
      → engine (Polars) inspect · preview · transform
jobs worker
  → engine.transform → outputs/{job_id}/result.parquet
  → v1 dest가 있을 때만 connectors.load
```

## 하지 않은 것 (다음)

- `/load`에서 parquet → 대상 테이블
- group by, join, 복수 소스
- 스텝 UI를 컬럼 체크박스·식 빌더로 올리기
- 변환 스케줄
- 대용량 lazy scan을 미리보기 경로에 완전히 태우기 (지금은 읽기 상한 후 collect)
- 변환 중 취소
- 여러 작업을 잇는 Flow. 작업 단위와 Workspace 설계는 [workspace.md](workspace.md)

## 로컬에서 확인

1. `/files`에 CSV를 올리거나 `/db`에서 추출해 `/extracts`가 succeeded인지 본다
2. `/transform`에서 그 파일을 고르고 원본 그리드가 뜨는지 확인한다
3. 필터/컬럼 선택 스텝을 넣고 미리보기
4. 저장 후 실행 → `/jobs/:id`에서 parquet 다운로드
