# 파이프라인 입력 모델 (Planned Input)

## 문제

워크스페이스 캔버스는 Extract → Transform → Load **의도**를 그리지만, 변환 등록·실행은 **실제 파일(`datasets`)** 이 있어야만 가능했다.

## 방향

**의도와 실행을 분리**한다.

| 단계 | 입력 | 산출 |
|------|------|------|
| 설계 | `chip_edges` (data), `extract_definitions` | `datasets.status = planned` (스키마만) |
| 실행 | upstream 성공 산출 또는 lazy extract | `datasets.status = materialized` |

### 핵심 엔티티

- **`datasets` (planned)** — `stored_path = __planned__/{id}`, `columns_json`은 추출 정의 introspect
- **`consumer_chip_id`** — 이 슬롯을 쓰는 변환 칩
- **`source_chip_id`** — upstream 추출 칩
- **`transforms.input_chip_id`** — 논리 입력 (선택, planned dataset과 함께 저장)

### 동기화 시점

1. 워크스페이스 **저장** 시 `data` 엣지(추출→변환)마다 planned dataset upsert
2. `GET /api/workspaces/:id/chips/:chip_id/input-slot` — 변환 칩의 예정 입력 조회
3. 변환 페이지는 planned dataset으로 **컬럼 기반 spec 작성** (파일 없이)

### 실행 시

Transform 칩 Run:

1. upstream `chip_output_slots` / succeeded run 있으면 그 dataset 사용
2. 없으면 upstream Extract를 **동기 실행** 후 산출 materialize
3. Transform job 실행

## 왜 이 방향인가

- **카탈로그 등록 UX** 유지: `transforms.dataset_id` FK 그대로 (planned dataset이 대상)
- **캔버스 edge**가 단일 진실 공급원 — 별도 예약 테이블 최소화
- **Polars 엔진**은 변경 최소 — preview만 planned일 때 columns_json 기반
