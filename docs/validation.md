# 검증

작성: 2026-09-13

검증은 두 materialized 파일을 비교하고 **새 파일을 만들지 않는다**. `execution_outputs`와 `workspace_chip_outputs`를 만들지 않는다.

독립 실행과 캔버스 칩이 같은 `validation_rules`와 `PolarsEngine.validate_files`를 쓴다.

## 비교

행 수, 스키마, 복합 키 누락·추가·중복, 지정 컬럼 값 불일치를 한 결과로 남긴다. source와 target 파일 id는 달라야 하고 둘 다 디스크에 있어야 한다.

규칙: 이름, 키, 비교 컬럼, 행 수·스키마 검사, 활성, revision. 칩은 `config_json.validation_rule_id`를 쓰고 예전 수동 `keys`/`columns`도 받는다.

## 캔버스 포트

- **target**: 업스트림 추출·변환의 최신 출력
- **source**: 편집 화면에서 고른 비교 기준. data 에지가 둘이면 `source` 포트로 맞춘다

전체 실행의 두 입력 모두 **이번 런 산출**만 쓴다. 과거 성공으로 대체하지 않는다. 첫 배치 전에 규칙 옵션을 스냅샷에 복사한다.

## 결과

요약을 `execution_steps.result_json`과 `validation_results`에 넣는다. `passed=false`면 단계는 `failed`가 되어 `on_error`를 탈 수 있다. 조건 건너뜀은 실패가 아니다.

`POST /api/validations/run`은 두 파일 id를 즉시 비교한다. 비활성 규칙이나 남의 규칙은 거절한다.

## 하지 않는 것

대량 불일치를 별도 산출 파일로 빼기, `validation_rule_id` 물리 FK.
