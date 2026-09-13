# 변환

작성: 2026-09-13

변환은 DB에 다시 넣는 단계가 아니다. 이미 떨어진 파일을 읽고 순서 있는 스텝으로 **parquet**를 만든다. 적재는 [load.md](load.md).

워크스페이스에서 변환 칩을 누르면 `workspace`와 `chip` 쿼리로 편집기에 들어간다. 입력은 **업스트림 칩 이름**이다. 파일 카탈로그와 `stored_path`를 보여 주지 않는다.

## 입력

실행 시 data 에지의 최신 출력을 고른다. 슬롯이 비면 업스트림 extract를 동기 실행한다. 연결이 없고 단독 `input_dataset_id`도 없으면 실패한다. 한 칩으로 data 에지가 둘이면 거절한다.

파일이 없으면 미리보기는 planned 스키마만 준다. 스텝을 얹은 planned preview는 거절한다. 파일이 있으면 같은 engine을 `spawn_blocking`으로 돌린다.

## Spec

`engine`은 파일 경로와 `TransformSpec`만 받는다. sink는 parquet가 아니면 거절한다.

| version | 내용 |
| --- | --- |
| 1 | `identity` / `pipeline`. dest를 포함한 옛 잡이 아직 돈다 |
| 2 | `steps` + 선택 `combine`. **dest 금지** |
| 3 | `operations`. dest 금지 |

v2 스텝: `select`, `drop`, `rename`, `filter`, `derive`, `trim`, `replace`, `split`, `cast`, `fill_null`, `sort`, `unique`. `derive`는 `컬럼 + 1` 또는 `컬럼 * 컬럼`이다. `filter`는 비교·`contains`·`is null`이다. AND는 필터를 이어 붙인다. 빈 스텝 `{ "version": 2, "steps": [], "sink": "parquet" }`는 identity다. `combine`은 join/stack 후 스텝을 적용한다. 데이터셋 id는 JSON에 있고 서버가 경로를 채운다.

브라우저 Polars와 임의 코드 map/apply는 없다.

## 출력

칩이 연결된 잡: `chip_outputs/{workspace}/{chip}/current.parquet`. 레거시 단독 잡: `outputs/{job_id}/result.parquet`. 재실행은 슬롯을 덮어쓴다.

`POST /api/transforms/:id/run`과 칩 변환은 `ExecutionTask::Job`으로 `jobs::execute`에 들어간다. v1 dest가 있으면 jobs가 CSV를 내보낸 뒤 connectors 적재를 이어서 호출할 수 있다. 새 레시피에 dest를 넣지 않는다.

`/api/datasets`, `/api/jobs`는 호환 경로다. 물리 `datasets`/`jobs` 테이블은 없다.

## 화면

- 워크스페이스 모드: 업스트림 칩, 스텝, 미리보기, 저장
- 단독 `/transform`: 업로드·추출 파일을 고를 수 있다. 새 반복 작업은 칩으로 저장한다
- `/history`, `/jobs/:id`: 레거시 실행 상세

## 하지 않는 것

변환 중 취소, 미리보기 전체 lazy scan(읽기 상한 후 collect).
