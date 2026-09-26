# 파일

- [인증과 접근제어](auth-and-access.md) - 세션은 users.id HMAC 쿠키다. 저장된 비밀번호는 Argon2 해시이고 config.toml의 평문 비밀번호는 부트스트랩과 skip_auth에만 쓰인다. 워크스페이스는 소유자 경계, 커넥션은 조직 전역이다.
- [배포와 설정](deploy-and-config.md) - 운영은 bintl 한 바이너리와 config.toml이다. 서버에 Rust/Node/SQLite 패키지를 설치하지 않으며, 환경변수가 설정 파일보다 우선한다.
- [저장과 로깅](storage-and-logging.md) - SQLite etl.db가 메타와 실행 이력을 소유하고, 실재 파일만 data_files에 등록한다. 칩 실행 로그 원본은 execution_logs이며 data/logs는 운영 진단용이다.
