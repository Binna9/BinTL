# 작업 공간

작성: 2026-09-13

작업 공간은 ETL 설정, 실행 이력, 파일 산출물을 묶는 프로젝트 경계다. 제품 화면은 `/workspace` 캔버스다. `/db`, `/files`, `/transform/*`, `/script`는 칩을 만들거나 고치는 도구다.

한 설치는 회사 하나다. 사용자는 워크스페이스를 소유하고, 커넥션만 조직 전역이다.

업로드·단독 결과 내보내기 파일은 작업구분 트리에서 고른 워크스페이스에 붙는다. 칩 실행 산출은 그 칩이 놓인 워크스페이스를 따른다. `/files`, `/extracts`, `/transforms` 목록은 같은 작업구분 트리로 본다. 브라우저 다운로드는 워크스페이스를 고르지 않는다.

## 세 개념

- **Chip**: 이름 있는 레시피 (`extract` | `transform` | `load` | `validation` | `sql` | `serve` | `script`). 사용자가 보는 정체는 칩 이름이다. `extracts/…/{uuid}` 경로가 아니다.
- **Run**: 추가 전용 이력. 모든 실행은 `executions` → `execution_steps`다. 칩 단독은 `source='chip'`, 캔버스 전체는 `source='workspace'`.
- **Current output**: 워크스페이스+칩당 파일 하나. `workspace_chip_outputs`와 디스크 `chip_outputs/{workspace}/{chip}/current.*`. 성공한 재실행만 슬롯을 덮어쓴다. 실패·취소·중단은 tmp에만 쓰고 `current.*`는 직전 성공본을 유지한다. 다음 칩은 카탈로그 UUID가 아니라 이 슬롯을 읽는다.

배선은 **data 에지**다. 변환 입력은 업스트림 칩의 최신 출력이다.

### 설계 대 실행

- 파일 없음: 컬럼은 업스트림 extract 레시피(DB inspect / SQL 미리보기). `workspace_chip_outputs`의 `schema_id`와 `expected_filename`만 남긴다. `data_files`에 가짜 행을 넣지 않는다. API가 주는 planned 뷰는 `status=planned`, 합성 id `contract:{workspace}:{consumer}`인 메모리 값이다.
- 파일 있음: 미리보기와 실행은 슬롯 파일을 읽는다.
- 실행인데 파일 없음: 업스트림 extract를 동기 실행하거나 `"extract has not run"` / `"upstream extract did not produce a dataset"`으로 실패한다. 사용자 대신 가짜 dataset을 만들지 않는다.

연결선을 끊으면 downstream은 그 슬롯을 입력으로 보지 않는다. 과거 파일과 실행 이력은 남는다.

단독 페이지의 `transforms.default_input_file_id` / `loads.default_input_file_id`는 기본 입력이다. 캔버스 data 에지가 우선한다. planned `contract:` id는 입력 FK로 묶지 않는다.

## 소유

- `users`: `userid`, `username`, `password_hash`. 빈 DB를 열면 `admin`/`admin`을 넣는다. 홈 워크스페이스 타입 컬럼은 없다.
- `workspace_folders`: 소유자별, `parent_id`로 중첩. 최상위는 `parent_id IS NULL`.
- `workspaces.owner_user_id`. `/workspace`는 최근 수정 순 첫 공간을 연다.
- 세션 쿠키는 `users.id` HMAC.
- 멤버 공유는 없다. `WORKSPACE_ALL`만 전부 본다.
- 커넥션 비밀번호는 칩 설정이나 실행 스냅샷에 복사하지 않고 `connection_id`로만 참조한다.

## 캔버스 저장

새로 놓은 칩은 로컬 `draft:` 초안이다. 우측 하단 **저장**이 초안을 `POST …/chips`로 만든 뒤 `PUT /api/workspaces/:id/save`로 배치·에지를 커밋하고 `version`을 1 올린다. 요청에 현재 `version`이 필요하고, 다른 저장이 먼저면 409다. `workspace_revisions`에 스냅샷을 남긴다. 초기화는 마지막 저장본이다. 배치하는 칩은 워크스페이스 소유자 것이어야 하고, 같은 칩을 한 캔버스에 두 번 놓지 않는다.

에지 `kind`: `data` | `on_success` | `on_error` | `always`. 한 칩으로 들어오는 data 에지는 검증(source/target) 말고는 둘 이상이면 거절한다.

`/db`에서 칩으로 저장하면 extract 칩을 만들고 실행한다. 같은 동작으로 두 번째 단독 추출 파일을 쓰지 않는다.

## 전체 실행

저장된 활성 칩을 연결 의존 순으로 한 번에 하나씩 돈다. 내부 병렬은 없다.

1. 레시피·연결을 모두 사전 검증하고 설정을 스냅샷에 고정한다. 오류 칩은 실패로 남기고 큐에 넣지 않는다. 검증을 통과한 칩은 이어서 순차 실행한다.
2. 통과하면 설정·연결·검증 비교 옵션을 스냅샷에 고정한다.
3. data 선은 **이번 실행에서 만든 결과만** 전달한다. 과거 성공 슬롯으로 대체하지 않는다.
4. `on_success`는 성공, `on_error`는 실제 실패, `always`는 앞 칩이 처리된 뒤. 건너뜀은 실패가 아니다.
5. 실제 실패가 하나면 전체는 실패다. 조건 건너뜀만으로는 전체를 실패로 만들지 않는다.

`POST /api/workspaces/:id/run`은 `execution_id`와 `running`을 바로 돌려 주고, 스케줄러는 같은 `run_workspace_internal`로 끝날 때까지 기다린다. 이미 활성 전체 실행이 있으면 생성은 409, 스케줄은 `skipped`다.

실행 중 취소는 현재 칩을 `canceled`로 닫고 남은 queued 칩을 건너뛴다. 전체 실행도 `canceled`다. 캔버스 실행 버튼이 중단으로 바뀌고, 돌고 있는 칩을 우클릭해도 중단할 수 있다. 추출 스트림은 연결을 끊는다. Polars 변환과 Oracle 동기 fetch는 취소 표시 후에도 백그라운드에서 끝날 수 있다.

기동 시 미완료 워크스페이스 실행(`queued`/`running`)과 그 leftover 칩, 그리고 돌고 있던 단독 `running`은 `EXECUTION_INTERRUPTED`로 닫는다. 워크스페이스 중간부터 자동 재개하지 않는다. 아직 `queued`인 단독 칩·추출·변환·적재는 그대로 두고 디스패처가 다시 집는다.

칩 단독 `POST /api/chips/:id/run`은 `source='chip'`이다. 같은 워크스페이스에서 그 칩이 이미 `queued`/`running`이면 409다. 이력 화면은 둘을 분리한다. `GET /api/workspaces/:id/runs`는 `runs`와 `workspace_runs`를 같이 준다.

## API

- `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/:id`
- `GET/POST /api/workspace-folders`, `PATCH/DELETE /api/workspace-folders/:id`
- `PUT /api/workspaces/:id/save`
- `GET/POST /api/workspaces/:id/chips`, `GET/PATCH/DELETE /api/chips/:id`
- `POST /api/chips/:id/run`, `POST /api/workspaces/:id/run`
- `POST /api/chip-runs/:id/cancel`, `POST /api/workspaces/:id/executions/:execution_id/cancel`
- `GET /api/workspaces/:id/runs`, `GET /api/workspaces/:id/executions`
- `GET /api/chip-runs/:id`, `GET /api/chip-runs/:id/logs`
- `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id`

## 불변

- 사용자 정체 = 칩 이름 + 최신 출력. `stored_path`를 화면에 노출하지 않는다.
- 한 단계는 `queued`에서 `running`으로 한 번만 간다.
- 레시피를 고쳐도 과거 단계의 snapshot은 안 바뀐다.
- 자격 증명과 결과 경로를 칩 설정에 넣지 않는다.
- 파일이 없으면 transform/load는 시작하지 않고 실패한다.

워크스페이스를 삭제하면 그 공간의 파일, 실행 이력, 캔버스 배치·연결선이 같이 사라진다. 칩 정의는 작업 단위라서 남고, 다른 캔버스에 다시 놓을 수 있다.

## 아직 없는 것

재시도, 워크스페이스 멤버 공유, Postgres 외 Bulk(upsert COPY 포함), 대량 검증 리포트 파일.

## 로컬 확인

1. 사용자를 추가하고 그 계정으로 로그인한다. 자기 워크스페이스만 보이고 커넥션은 공유된다. analyst는 커넥션 쓰기 버튼이 없다.
2. `/workspace`에서 extract를 저장하고 두 번 실행한다. 정의는 하나, 이력은 두 줄, 슬롯은 덮어쓴다.
3. 그 출력을 입력으로 transform을 잇고 실행한다.
