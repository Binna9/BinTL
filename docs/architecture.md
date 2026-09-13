# BinTL architecture

코드의 현재 모듈 경계와 새 기능을 두는 곳.

코딩 습관은 [ponytail.md](ponytail.md). 제품 흐름은 [workspace.md](workspace.md).

## Runtime

운영 프로세스는 `bintl` 하나다. React 정적 산출물과 Axum API를 같은 바이너리가 제공한다.

```text
React UI -> Axum API -> 인프로세스 실행 큐 -> jobs / chip 워커
                         |                 -> engine / connectors
                         |                 -> storage -> SQLite + files
                         -> auth/access
```

- `engine`은 HTTP, SQLite, UI 타입을 모른다. 파일과 spec만 받는다.
- `connectors`는 Workspace 화면 상태를 모른다.
- HTTP 핸들러에서 Polars collect나 대량 파일 CPU 작업을 직접 하지 않는다. `spawn_blocking` 또는 워커로 내린다.

기동: `Config::load` → `Store::open`(빈 `users`면 `admin`/`admin`) → `recover_interrupted_executions` → `max_concurrent_jobs` 세마포어와 `mpsc` 큐(용량 64) → 스케줄러 루프.

큐 태스크는 `ExecutionTask::Job`(단독 변환)과 `ExecutionTask::Chip`(칩/전체 실행)이다. 재시작 시 메모리 큐는 사라지고, 미완료 실행(워크스페이스·칩·단독 페이지)은 오류로 닫는다. 자동 재개하지 않는다. 스케줄은 `source='workspace'`인 미완료 실행만 활성으로 본다.

## Rust workspace

| crate | 역할 |
| --- | --- |
| `crates/server` (`bintl`) | HTTP, 인증, 칩/워크스페이스 실행 조정 |
| `crates/storage` | SQLite repository, 파일 경로, 영속 모델 |
| `crates/connectors` | DB / HTTP / 스프레드시트 I/O |
| `crates/engine` | TransformSpec 검증과 Polars |
| `crates/jobs` | 변환 Job 워커 |

`api.rs`는 라우트 조립과 공통 핸들러만. 기능은 `api/{domain}.rs` 또는 독립 모듈. DTO는 그 모듈에 둔다.

`storage`: `models.rs`는 Row/컬럼 계약. DB 동작은 `{domain}_repo.rs`의 `impl Store`. 여러 도메인 트랜잭션은 소유 repository에서 시작한다. 경로 생성은 storage helper. 캔버스 저장은 `workspaces.version`을 검사하고, 칩은 워크스페이스 소유자 것만 배치한다.

## React

- `pages/`: 라우트와 화면 오케스트레이션
- `features/{domain}/`: 화면과 독립인 도메인 정책
- `components/{domain}/`: 재사용 표현
- `services/{domain}/`: HTTP
- `types/`, `lib/`: 계약과 공통 유틸

페이지에 그래프 정렬, 명세 정규화, 원시 `fetch`, 반복 DTO 매핑을 두지 않는다. 캔버스 계산은 `features/workspace/workspaceCanvasModel.ts`, 변환 편집은 `features/transform/transformEditorModel.ts`.

## 도메인 흐름

```text
Connection -> extract 칩 -> chip_outputs 슬롯 -> data_files
슬롯 -> transform 칩 -> parquet 슬롯
슬롯 -> load 칩 -> DB 또는 loads/ 파일
두 파일 -> validation 칩 (출력 파일 없음)
Workspace -> workspace_chips / workspace_edges / workspace_chip_outputs
```

`/api/datasets`, `/api/jobs`는 UI 호환 이름이다. 물리 테이블이 아니다.

## 인증 한 줄

세션은 `users.id` HMAC 쿠키(7일). 권한은 `USER_MANAGE`, `CONNECTION_WRITE`, `WORKSPACE_ALL`, `EXTRACT_RUN`, `TRANSFORM_RUN`. 커넥션 조회·실행은 `CONNECTION_WRITE` 또는 실행 권한. 워크스페이스는 소유자 경계, 커넥션은 조직 전역. 커넥션 암호 키는 `encryption_secret`(없으면 `session_secret`). 빈 DB의 첫 계정은 `admin`/`admin`이고 `users.password_hash`는 Argon2다. 이후 비밀번호는 UI에서 바꾼다. `skip_auth`는 개발만.

## 변경 체크리스트

1. 어느 도메인 소유인지 먼저 정한다.
2. 페이지/핸들러에 정책이 생기면 feature 또는 실행 계층으로 옮긴다.
3. 공개 타입을 최소화한다.
4. DB 변경은 새 migration만.
5. UI `npm run build`, Rust `cargo test --workspace`.
6. 장시간 실행, 재시작 복구, 파일 삭제는 실패 시나리오를 본다.
