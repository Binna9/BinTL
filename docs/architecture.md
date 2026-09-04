# BinTL architecture

이 문서는 코드의 현재 모듈 경계와 새 기능을 배치하는 기준을 정의한다.

## Runtime

운영 프로세스는 `bintl` 하나다. React 정적 산출물과 Axum API를 같은 바이너리에서 제공한다.

```text
React UI -> Axum API -> application workers -> engine/connectors
                         |                 -> storage -> SQLite + files
                         -> auth/access
```

의존 방향은 UI/API에서 실행 계층으로, 실행 계층에서 도메인 어댑터로만 흐른다.
`engine`은 HTTP, SQLite, UI 타입을 알지 않는다. `connectors`는 Workspace 화면 상태를 알지 않는다.

## Rust workspace

- `crates/server`: HTTP 전송 계층과 작업 실행 조정
- `crates/storage`: SQLite repository, 파일 경로, 영속 모델
- `crates/connectors`: 외부 DB/HTTP/스프레드시트 I/O
- `crates/engine`: 순수 변환 명세 검증과 Polars 실행
- `crates/jobs`: 변환/적재 작업 큐 실행기

### Server rules

- `api.rs`는 라우트 조립과 정말 공통인 핸들러만 둔다.
- 기능 핸들러는 `api/{domain}.rs` 또는 독립 도메인 모듈에 둔다.
- 요청 DTO는 해당 기능 모듈에 둔다. 여러 기능에서 공유될 때만 별도 계약 모듈로 승격한다.
- HTTP 핸들러에서 CPU 집약 변환이나 대량 파일 처리를 직접 수행하지 않는다.

### Storage rules

- `models.rs`는 영속 Row/입력 DTO와 SQL 컬럼 계약만 보유한다.
- DB 동작은 `{domain}_repo.rs`의 `impl Store`에 둔다.
- repository 내부 협력 메서드는 `pub(crate)`, 외부 crate 계약만 `pub`으로 둔다.
- 여러 도메인을 묶는 트랜잭션은 소유 도메인을 명확히 정하고 한 repository에서 시작한다.
- 파일 경로 생성과 삭제 안전성은 핸들러에서 복제하지 않고 storage helper를 사용한다.

현재 repository:

```text
storage/src/
├─ models.rs
├─ workspace_repo.rs
├─ chip_repo.rs
├─ file_repo.rs
├─ connection_repo.rs
├─ extract_repo.rs
├─ dataset_repo.rs
├─ transform_repo.rs
└─ job_repo.rs
```

## React application

- `pages/`: 라우트 진입점. 데이터 로딩과 화면 수준 오케스트레이션
- `features/{domain}/`: 화면과 독립적인 도메인 상태 변환, 정책, 훅
- `components/{domain}/`: 해당 도메인에서 재사용하는 표현 컴포넌트
- `services/{domain}/`: HTTP 계약과 호출
- `types/`: 서버와 공유하는 직렬화 계약
- `lib/`: 특정 도메인에 속하지 않는 작은 공통 유틸리티

페이지 파일에는 다음을 두지 않는다.

- 그래프 정렬, 좌표 계산, 명세 정규화 같은 순수 도메인 로직
- 다른 페이지에서도 사용할 수 있는 패널이나 에디터
- 원시 `fetch` 호출
- 서버 DTO를 화면 모델로 바꾸는 반복 매핑

Workspace 캔버스 계산은 `features/workspace/workspaceCanvasModel.ts`, Transform 편집 정책은
`features/transform/transformEditorModel.ts`가 담당한다. 대응 UI 조각은 각 도메인의
`components` 디렉터리에 둔다.

## Core domain flow

```text
Connection -> Extract definition -> Extract run -> Dataset
Dataset -> Transform definition -> Job -> Dataset
Workspace -> Chip -> Chip run -> output Dataset slot
Chip edge(data) -> planned/materialized input Dataset
```

기존 `extracts`/`jobs` 실행 모델과 `chip_runs` 모델은 아직 함께 사용한다. 이 구조를 수정할 때는
HTTP 응답 호환성을 먼저 유지하고, 실행 레코드 통합은 별도 마이그레이션으로 진행한다.

## Change checklist

1. 새 코드가 어느 도메인 소유인지 먼저 정한다.
2. 페이지/핸들러에 정책 로직이 생기면 feature 또는 실행 계층으로 이동한다.
3. 공개 타입과 메서드를 최소화한다.
4. DB 변경은 새 migration으로만 수행한다.
5. UI는 `npm run build`, Rust는 `cargo test --workspace`로 검증한다.
6. 장시간 실행, 재시작 복구, 파일 삭제 경로는 별도 실패 시나리오를 확인한다.
