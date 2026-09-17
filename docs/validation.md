# 검증

작성: 2026-09-16

검증은 두 materialized 파일을 비교하고 **새 파일을 만들지 않는다**. `execution_outputs`와 `workspace_chip_outputs`를 만들지 않는다.

독립 실행과 캔버스 칩이 같은 `PolarsEngine.validate_files`를 쓴다. 비교 키·컬럼은 **그 칩 또는 이번 실행**에 붙는다. 전역 규칙 목록은 쓰지 않는다.

## 프로세스

- 검증 실행: 기준·비교 파일을 고르고 그 컬럼으로 키·비교 컬럼을 정한다. 행 수·스키마는 상세 설정 팝업에서 저장한다. 그다음 실행하거나 칩으로 등록한다.
- 캔버스 칩 편집: 연결한 파일 컬럼으로 키를 정하고, 상세 설정을 저장한 뒤 칩에 적용한다. 실행은 워크스페이스가 한다.

## 비교

행 수, 스키마, 복합 키 누락·추가·중복, 지정 컬럼 값 불일치를 한 결과로 남긴다. source와 target 파일 id는 달라야 하고 둘 다 디스크에 있어야 한다.

칩은 `config_json`의 `keys`/`columns`/`compare_row_count`/`compare_schema`를 실행한다. `validation_rule_id`가 있고 키가 비어 있을 때만 예전 규칙을 채운다.

## 캔버스 포트

- **target**: 업스트림 추출·변환의 최신 출력, 또는 **적재 칩**. 적재면 적재가 끝난 뒤 그 테이블(또는 파일)을 다시 읽어 비교한다. 적재 칩은 출력 슬롯을 만들지 않는다.
- **source**: 기대 파일. 추출·변환만. data 에지가 둘이면 `source` 포트로 맞춘다.

적재 모드 `append`/`upsert`에서는 테이블에 원래 있던 extra 키와 행 수 차이를 실패로 보지 않는다. `replace`/`truncate`/`recreate`는 행 수와 extra 키도 검사한다.

전체 실행의 두 입력 모두 **이번 런 산출**만 쓴다. 과거 성공으로 대체하지 않는다. 적재 TARGET은 이번 런에서 적재가 성공해야 한다.

## 결과

요약을 `execution_steps.result_json`과 `validation_results`에 넣는다. `passed=false`면 단계는 `failed`가 되어 `on_error`를 탈 수 있다. 조건 건너뜀은 실패가 아니다.

`POST /api/validations/run`은 두 파일 id를 즉시 비교한다. 요청에 키가 있으면 그 값을 쓴다.

## 하지 않는 것

대량 불일치를 별도 산출 파일로 빼기, `validation_rule_id` 물리 FK.
