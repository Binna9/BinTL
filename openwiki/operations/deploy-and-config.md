---
type: operations
title: 배포와 설정
description: 운영은 bintl 한 바이너리와 config.toml이다. 서버에 Rust/Node/SQLite 패키지를 설치하지 않으며, 환경변수가 설정 파일보다 우선한다.
tags: [deploy, config, just, musl, systemd]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-7aa209ee4f993345d7092214
    resource: repo://config.example.toml
  - id: openwiki-source-b691fa90e62f9509a0c1869a
    resource: repo://crates/server/src/config.rs
  - id: openwiki-source-a13fe4db1eee073d0a7e2c4d
    resource: repo://crates/server/src/main.rs
  - id: openwiki-source-cc96dfbea8fbfef7a98bfad0
    resource: repo://crates/storage/src/lib.rs
  - id: openwiki-source-c59fe4336a371ea1052a01dd
    resource: repo://justfile
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-e3729acc44d676765f1ee3b4
    resource: repo://scripts/build-target.sh
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 배포와 설정

운영 산출물은 실행 파일 하나다. 리눅스 서버에 `bintl`과 `config.toml`을 올리고 `./bintl --config config.toml`하면 된다. React는 빌드 시 바이너리에 embed된다. 서버에 Rust, Python, JVM, Node, 시스템 SQLite를 설치하지 않는다. SQLite는 bundled, TLS는 rustls다.

관련 페이지: [런타임과 크레이트 경계](/openwiki/architecture/runtime.md), [인증과 접근제어](/openwiki/operations/auth-and-access.md), [Quickstart](/openwiki/quickstart.md).

## 설정

`--config`가 필수다. `Config::load`가 TOML을 읽고 환경변수로 덮는다. `session_secret`이 비면 기동 실패다.

| 키 / 환경변수 | 의미 |
| --- | --- |
| `bind` / `ETL_BIND` | listen 주소 |
| `data_dir` / `ETL_DATA_DIR` | SQLite와 파일 루트. 없으면 기동 시 생성 |
| `max_upload_mb` | 업로드·본문 상한. 바이트는 `* 1024 * 1024` |
| `max_concurrent_jobs` | 인프로세스 실행 세마포어. 최소 1 |
| `session_secret` / `ETL_SESSION_SECRET` | 세션 HMAC과 커넥션 암호 키 |
| `skip_auth` / `ETL_SKIP_AUTH` | `true`/`1`/`yes`면 API 인증 생략 |
| `auth.username` / `ETL_AUTH_USERNAME` | 부트스트랩 로그인 id |
| `auth.password` / `ETL_AUTH_PASSWORD` | 부트스트랩 평문 비밀번호 |
| `ETL_UI_DIR` | embed 대신 이 폴더의 정적 UI |

예제 파일은 `config.example.toml`이다. 운영 `config.toml`은 커밋하지 않는다. 역프록시 뒤면 `bind = "127.0.0.1:8080"`을 권장한다.

## 개발 대 운영

운영은 프로세스 하나다. 접속은 `http://서버:포트`(예제 기본 `0.0.0.0:8083`, 문서 기본 `8080`).

개발만 프론트 핫 리로드를 위해 둘로 나눈다.

1. `cargo run -p bintl -- --config config.example.toml`
2. `cd ui && npm run dev` — Vite `5173`이 `/api`를 `8080`으로 프록시한다. CORS는 이 두 origin만 허용한다.

`just run`은 UI 빌드 후 예제 설정으로 기동한다. `ETL_UI_DIR=./ui/dist`면 embed 대신 그 폴더를 서빙한다.

## 빌드

| 명령 | 결과 |
| --- | --- |
| `just ui` | `ui/dist` |
| `just build` | 호스트 타깃 릴리스 + embed UI |
| `just dist <TARGET>` | `scripts/build-target.sh` → `dist/<TARGET>/bintl` |
| `just test` | `cargo test --workspace` |

크로스 툴은 `cross`를 우선한다. 없으면 `rustup target add` 후 `cargo build --target`이다. 기본 배포 타깃은 `x86_64-unknown-linux-musl`이다. musl 빌드는 전역 allocator를 mimalloc으로 바꾼다. `ldd`로 동적 의존이 없는지 확인한다.

서버에 올리는 것은 바이너리와 설정이다. `data/`는 백업 대상이고 업그레이드 때 그대로 둔다. systemd 유닛 파일은 저장소에 없다. `ExecStart=/opt/bintl/bintl --config /opt/bintl/config.toml` 형태를 README가 예시로 적는다.

## 데이터 디렉터리

`Store::open`이 레이아웃을 만든다. 현재 상대 경로는 `extract_runs/{uploads,databases,api}`, `outputs/`, `chip_outputs/`, `logs/`, `staging/`이다. 예전 `extracts/` 이름 문서가 남아 있을 수 있다. 코드 계약은 `storage` 상수가 우선한다.

## 불변

- 운영에서 Node를 띄우지 않는다.
- 환경변수가 TOML보다 우선한다.
- `session_secret` 공백은 기동 거부다.
- OS가 바뀌면 소스가 아니라 빌드 타깃만 바꾼다.
