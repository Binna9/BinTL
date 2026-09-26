# 파일

- [추출](extract.md) - 추출은 커넥션의 테이블·SQL·HTTP 또는 업로드를 서버 파일로 남기는 단계다. 칩 실행은 최신 출력 슬롯에 쓰고, Polars와 DB→DB 스트림은 쓰지 않는다.
- [적재](load.md) - 적재는 변환 dest가 아니라 독립 load 정의다. 업스트림 최신 출력을 DB 또는 서버 파일로 넣고, 캔버스에서는 data 에지가 필수다.
- [변환](transform.md) - 변환은 업스트림 최신 출력 또는 실재 파일을 TransformSpec으로 읽어 parquet를 만든다. engine은 파일+spec만 알고 dest를 넣지 않으며, 워크스페이스 모드는 파일 카탈로그를 보여 주지 않는다.
- [검증](validation.md) - 검증은 두 실재 파일을 비교하고 새 파일을 만들지 않는다. 차이가 있으면 단계가 failed가 되어 on_error 제어선을 탈 수 있다.
- [워크스페이스 캔버스](workspace-canvas.md) - 캔버스는 칩을 배치하고 data/제어 에지로 잇는 제품 화면이다. 초안은 로컬이고, 저장이 배치·연결을 커밋하며 version과 revision 스냅샷을 올린다.
- [워크스페이스 전체 실행](workspace-execution.md) - 캔버스 전체 Run은 모든 레시피를 사전 검증한 뒤에만 순차 배치한다. 실행은 인프로세스 큐이고, 재시작은 queued/running 전체 실행을 오류로 닫으며 재개하지 않는다.
