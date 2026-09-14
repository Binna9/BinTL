# BinTL 문서

사람이 고치는 문서는 여기 `docs/`만 쓴다. `README.md`는 기동·배포 입구다.

`openwiki/`는 에이전트가 생성한 인덱스다. 제품 계약을 바꿀 때는 이 폴더를 직접 고치지 말고 아래 문서를 고친 뒤 코드를 맞춘다.

| 문서 | 내용 |
| --- | --- |
| [architecture.md](architecture.md) | 프로세스, 크레이트, UI 모듈, 변경 체크리스트 |
| [workspace.md](workspace.md) | 칩·에지·최신 출력, 캔버스 저장, 전체 실행 |
| [extract.md](extract.md) | 커넥션 → 서버 파일 |
| [transform.md](transform.md) | 파일 → parquet |
| [load.md](load.md) | 파일 → DB 또는 서버 파일 |
| [bulk.md](bulk.md) | Postgres COPY와 다른 DB 대량 추출·적재 |
| [validation.md](validation.md) | 두 파일 비교 |
| [schema.md](schema.md) | SQLite 테이블과 파일 레이아웃 |
| [logging.md](logging.md) | execution_logs 정책 |
| [deploy.md](deploy.md) | config, 빌드, 서버 설치 |
| [ponytail.md](ponytail.md) | 코드 작성 규칙 |

Cursor 로컬 룰(`.cursor/`)은 gitignore라 레포에 없다. 팀과 공유하는 규칙은 이 문서다.
