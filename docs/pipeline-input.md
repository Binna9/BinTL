# 캔버스 데이터 입력 계약

캔버스의 data 연결선은 실제 파일과 실행 전 스키마 계약을 같은 ID로 위조하지 않는다.

## 설계 상태

- `workspace_edges(kind='data')`가 upstream과 downstream을 연결한다.
- `workspace_chip_outputs.expected_filename`과 `schema_id`가 실행 전 출력 계약이다.
- `data_schemas.columns_json`은 0행 결과도 컬럼을 보존한다.
- 이 단계에는 `data_files` 행이나 `__planned__` 가짜 경로를 만들지 않는다.

## 실행 상태

1. downstream 실행 시 data 연결선의 upstream 배치를 찾는다.
2. `workspace_chip_outputs.current_data_file_id`가 있으면 실제 입력으로 사용한다.
3. 없으면 upstream을 먼저 실행하거나 입력 미생성 상태를 명확히 반환한다.
4. 성공 출력은 `data_files`에 등록하고 `execution_outputs`와 출력 슬롯을 같은 트랜잭션에서 갱신한다.
5. 연결선을 끊으면 downstream은 더 이상 해당 슬롯을 입력으로 해석하지 않는다. 실제 과거 파일과 실행 이력은 보존한다.

단독 변환·적재 페이지에서는 각각 `transforms.default_input_file_id`, `loads.default_input_file_id`를 사용한다. 캔버스 data 연결은 이 기본값보다 우선한다.
