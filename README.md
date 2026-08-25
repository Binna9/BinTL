# BinTL

설치형 ETL 콘솔. 리눅스 서버에 실행 파일 하나를 올리고 `./bintl --config config.toml` 하면 끝이다.

브라우저는 클라이언트, 이 바이너리가 서버다. **운영 시 프로세스는 `bintl` 하나**다. UI 서버와 API 서버를 나누지 않는다. React는 빌드 후 바이너리에 embed되며, 운영에서 Node를 띄우지 않는다.

접속: `http://서버IP:포트` (기본 `0.0.0.0:8080`)

서버에 Rust / Python / JVM / Node / SQLite 패키지를 설치하지 않는다. SQLite는 bundled, TLS는 rustls.

> 뼈대 인증은 `config.toml`의 평문 `auth.password`다. 이후 `password_hash`로 교체할 예정이다.

## 실행 (운영 / 수락 테스트 A)

```bash
just ui
cargo run -p bintl -- --config config.example.toml
# 또는 릴리스 바이너리
just build
./target/release/bintl --config config.example.toml
```

```bash
curl -s localhost:8080/api/health
# {"ok":true,"version":"0.1.0"}
```

브라우저: `http://localhost:8080`

`data/`가 없으면 기동 시 만든다 (`etl.db`, `extracts/uploads|databases|api`, `outputs/`, `logs/{extracts,jobs,query,files,connections}`).

추출(커넥션 → 서버 파일)의 회로·API·화면은 [docs/extract.md](docs/extract.md)에 있다.
변환(파일 → parquet)의 회로·API·화면은 [docs/transform.md](docs/transform.md)에 있다.

기본 계정: `admin` / `admin` (`skip_auth = false`). 개발 편의를 위해 `skip_auth = true` 또는 `ETL_SKIP_AUTH=true`를 허용한다.

## 개발 (vite + API, 프로세스 2개 허용)

운영 산출물은 한 프로세스다. 개발만 프론트 핫 리로드를 위해 둘로 나눠도 된다.

터미널 1:

```bash
cargo run -p bintl -- --config config.example.toml
```

터미널 2:

```bash
cd ui && npm install && npm run dev
```

- UI: `http://127.0.0.1:5173` — Vite가 `/api`를 `http://127.0.0.1:8080`으로 프록시한다.
- 또는 `ETL_UI_DIR=./ui/dist`를 주면 embed 대신 그 폴더를 서빙한다 (프론트를 `just ui`로 다시 빌드한 뒤).

## 수락 테스트 B — 추출 → 서버 파일

1. `/connections`에서 커넥션 저장 후 `browse`
2. 테이블을 눌러 컬럼·미리보기를 확인
3. 구분자를 고르고 `extract` → `/extracts`에서 `succeeded` 후 다운로드
4. `/transform`에서 그 파일을 소스로 고른 뒤 스텝을 저장하고 실행한다

## 수락 테스트 C — 업로드 → 변환 → parquet

1. `/files`에서 CSV 하나 업로드
2. `/transform`에서 해당 파일을 선택해 내용을 확인한다
3. (선택) 컬럼 선택·필터 스텝을 넣고 미리보기
4. 저장 후 실행. 상태가 `succeeded`가 되면 상세에서 result 다운로드

identity에 해당하는 빈 스텝 spec: `{ "version": 2, "steps": [], "sink": "parquet" }`

## 배포

서버에 올리는 것:

```
bintl
config.toml
data/          # 없으면 기동 시 생성
  etl.db
  extracts/
    uploads/     # 올린 파일
    databases/   # DB 추출
    api/         # API 추출 (예약)
  outputs/       # 변환 결과
  logs/          # 작업 진행 로그 (화면/상황별)
    extracts/    # 파일 생성
    jobs/        # 변환·적재
    query/       # 긴 조회 (예약)
    files/       # 업로드 (예약)
    connections/ # 커넥션 테스트 (예약)
```

```bash
just dist x86_64-unknown-linux-musl
# dist/x86_64-unknown-linux-musl/bintl
```

기본 배포 타깃은 `x86_64-unknown-linux-musl`. OS가 바뀌면 소스가 아니라 타깃만 바꿔 빌드한다.

| TARGET | 용도 |
| --- | --- |
| `x86_64-unknown-linux-musl` | 기본 배포 (정적 musl) |
| `aarch64-unknown-linux-musl` | ARM64 musl |
| `x86_64-unknown-linux-gnu` | glibc x86_64 |
| `aarch64-unknown-linux-gnu` | glibc ARM64 |
| `aarch64-apple-darwin` | macOS 개발 |
| `x86_64-pc-windows-gnu` | 가능하면. 실패하면 미지원 |

```bash
just build-target x86_64-unknown-linux-musl
just dist aarch64-apple-darwin
```

크로스 툴은 [cross](https://github.com/cross-rs/cross)를 우선한다.

```bash
cargo install cross --git https://github.com/cross-rs/cross
```

로컬에 타깃만 쓰려면:

```bash
rustup target add x86_64-unknown-linux-musl
# musl 링크가 필요하면 호스트에 musl-gcc 또는 zig 필요. 없으면 cross를 쓴다.
```

`ldd dist/<target>/bintl`로 동적 의존을 확인한다. musl 정적 링크가 목표다. 동적 의존이 남으면 여기에 적는다.

## just

```bash
just ui              # ui/dist
just build           # 호스트 타깃 + embed UI
just build-target T  # cross 또는 cargo --target
just dist T          # ui + build-target → dist/<T>/bintl
just run             # ui 빌드 후 예제 설정으로 기동
just test
```

`just`가 없으면: `brew install just` 또는 `cargo install just`.

## 환경변수 (설정 파일보다 우선)

| 변수 | 의미 |
| --- | --- |
| `ETL_BIND` | bind 주소 |
| `ETL_DATA_DIR` | 데이터 디렉터리 |
| `ETL_SESSION_SECRET` | 세션 서명 비밀 |
| `ETL_AUTH_USERNAME` | 로그인 사용자 |
| `ETL_AUTH_PASSWORD` | 로그인 비밀번호 (평문, 뼈대) |
| `ETL_SKIP_AUTH` | `true`면 `/api` 인증 생략 |
| `ETL_UI_DIR` | embed 대신 이 폴더의 정적 UI |

## systemd 예시 (유닛 파일은 저장소에 없음)

```ini
[Service]
ExecStart=/opt/bintl/bintl --config /opt/bintl/config.toml
WorkingDirectory=/opt/bintl
Restart=on-failure
```

## 레이어

```
React UI → Axum (bintl) → jobs → engine (Polars)
                       ↘ storage (sqlx sqlite + 디스크)
                       ↘ connectors (extract / load)
```

engine은 axum / sqlx / ui를 모른다. HTTP 핸들러에서 Polars collect를 돌리지 않는다. 워커(`spawn_blocking`) 안에서만 변환한다. 추출은 Polars가 아니라 connectors다.
