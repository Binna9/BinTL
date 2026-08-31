# 서버 배포

작성: 2026-08-31

## 개요

BinTL은 **설치형 단일 바이너리**다. 운영 환경에서는 `bintl` 프로세스 하나만 띄운다.

- React UI는 빌드 시 바이너리에 embed된다. 서버에 Node.js가 필요 없다.
- API와 정적 UI를 Axum이 함께 서빙한다.
- SQLite(`data/etl.db`)와 파일 산출물은 `data_dir` 아래에 저장된다.
- Rust, Python, JVM, 외부 DB 패키지를 서버에 설치하지 않는다. (SQLite는 bundled, TLS는 rustls)

```
브라우저 ──► (선택) Nginx/Caddy ──► bintl:8080
                                      ├─ /api/*  (Axum)
                                      └─ /*      (embed UI)
                                      └─ data/
                                           ├─ etl.db
                                           ├─ extracts/
                                           ├─ outputs/
                                           └─ logs/
```

개발 환경만 Vite(5173) + API(8080) 두 프로세스로 나눌 수 있다. 운영 배포는 한 프로세스가 기준이다.

---

## 배포 흐름 요약

| 단계 | 어디서 | 무엇을 |
| --- | --- | --- |
| 1. 빌드 | 개발 PC / CI | `just dist <target>` → `dist/<target>/bintl` |
| 2. 전송 | scp, rsync, SFTP | 바이너리 + `config.toml` |
| 3. 설치 | 서버 | `/opt/bintl/` 등 고정 경로에 배치 |
| 4. 기동 | 서버 | systemd 또는 직접 실행 |
| 5. (권장) | 서버 | Nginx/Caddy로 HTTPS 역프록시 |

---

## 1. 빌드 (개발 PC 또는 CI)

### 사전 요구

- Rust stable (`rust-toolchain.toml` 기준)
- Node.js + npm (UI 빌드용, **서버에는 불필요**)
- `just` (`cargo install just` 또는 패키지 매니저)
- 크로스 컴파일 시 [cross](https://github.com/cross-rs/cross) 권장

```bash
# cross 설치 (리눅스 musl 타깃 권장)
cargo install cross --git https://github.com/cross-rs/cross

# UI + 릴리스 바이너리 → dist/
just dist x86_64-unknown-linux-musl
# 산출물: dist/x86_64-unknown-linux-musl/bintl
```

### 타깃 선택

| TARGET | 용도 |
| --- | --- |
| `x86_64-unknown-linux-musl` | **기본 배포** (정적 musl, glibc 무관) |
| `aarch64-unknown-linux-musl` | ARM64 서버 |
| `x86_64-unknown-linux-gnu` | glibc x86_64 |
| `aarch64-unknown-linux-gnu` | glibc ARM64 |
| `aarch64-apple-darwin` | macOS (개발·내부 테스트) |
| `x86_64-pc-windows-gnu` | Windows (지원 가능 시) |

musl 정적 링크 확인:

```bash
ldd dist/x86_64-unknown-linux-musl/bintl
# "not a dynamic executable" 또는 동적 의존 없음이 이상적
```

로컬 호스트에서만 빌드할 때:

```bash
just build
# target/release/bintl
```

---

## 2. 서버 디렉터리 구성

권장 경로: `/opt/bintl/`

```
/opt/bintl/
├── bintl              # 실행 파일
├── config.toml        # 운영 설정 (저장소에 커밋하지 않음)
└── data/              # 기동 시 없으면 자동 생성
    ├── etl.db         # SQLite (메타데이터·작업 이력)
    ├── extracts/
    │   ├── uploads/   # 업로드 파일
    │   ├── databases/ # DB 추출 결과
    │   └── api/       # API 추출 (예약)
    ├── outputs/       # 변환(parquet 등) 결과
    └── logs/          # 작업 진행 로그
        ├── extracts/
        ├── jobs/
        ├── query/
        ├── files/
        └── connections/
```

`data/`는 **백업 대상**이다. 바이너리 업그레이드 시 그대로 둔다.

---

## 3. 설정 (`config.toml`)

저장소의 `config.example.toml`을 복사해 운영 값으로 바꾼다.

```toml
bind = "127.0.0.1:8080"      # 역프록시 뒤면 localhost만 열기
data_dir = "/opt/bintl/data"
max_upload_mb = 512
max_concurrent_jobs = 2
session_secret = "랜덤-긴-문자열"   # 반드시 변경
skip_auth = false

[auth]
username = "admin"
password = "초기-비밀번호-변경"     # 최초 기동 후 UI에서 변경 권장
```

### 환경 변수 (설정 파일보다 우선)

| 변수 | 의미 |
| --- | --- |
| `ETL_BIND` | bind 주소 (`0.0.0.0:8080`) |
| `ETL_DATA_DIR` | 데이터 디렉터리 |
| `ETL_SESSION_SECRET` | 세션 HMAC 비밀 |
| `ETL_AUTH_USERNAME` | 부트스트랩 로그인 ID |
| `ETL_AUTH_PASSWORD` | 부트스트랩 비밀번호 (평문) |
| `ETL_SKIP_AUTH` | `true`면 API 인증 생략 (**운영 금지**) |
| `ETL_UI_DIR` | embed 대신 이 폴더의 정적 UI 서빙 |

비밀 값은 systemd `EnvironmentFile`이나 시크릿 매니저로 주입하는 편이 안전하다.

```ini
# /etc/bintl/env (권한 600)
ETL_SESSION_SECRET=...
ETL_AUTH_PASSWORD=...
```

### 최초 기동 (부트스트랩)

- `data/etl.db`에 사용자가 없으면 `[auth]` 계정으로 admin 사용자를 만들고 admin 역할을 붙인다.
- 기본 작업 공간이 없으면 함께 생성한다.
- 이후 사용자·역할·권한은 UI `/settings` 또는 API로 관리한다.

---

## 4. 서버에 올리기

```bash
# 예: 로컬에서 빌드 후 전송
just dist x86_64-unknown-linux-musl
scp dist/x86_64-unknown-linux-musl/bintl user@server:/opt/bintl/
scp config.production.toml user@server:/opt/bintl/config.toml

# 서버에서
ssh user@server
sudo mkdir -p /opt/bintl/data
sudo chown -R bintl:bintl /opt/bintl
chmod +x /opt/bintl/bintl
```

`rsync`로 업그레이드할 때는 바이너리만 교체하고 `data/`는 건드리지 않는다.

```bash
rsync -avz dist/x86_64-unknown-linux-musl/bintl user@server:/opt/bintl/bintl
```

---

## 5. 실행

### 수동 기동 (확인용)

```bash
cd /opt/bintl
./bintl --config config.toml
```

헬스 체크:

```bash
curl -s http://127.0.0.1:8080/api/health
# {"ok":true,"version":"0.1.0"}
```

### systemd (권장)

`/etc/systemd/system/bintl.service`:

```ini
[Unit]
Description=BinTL ETL console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bintl
Group=bintl
WorkingDirectory=/opt/bintl
ExecStart=/opt/bintl/bintl --config /opt/bintl/config.toml
EnvironmentFile=-/etc/bintl/env
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# data_dir 쓰기 권한
ReadWritePaths=/opt/bintl/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/bintl --shell /usr/sbin/nologin bintl
sudo systemctl daemon-reload
sudo systemctl enable --now bintl
sudo systemctl status bintl
journalctl -u bintl -f
```

---

## 6. HTTPS 역프록시 (권장)

`bintl`은 HTTP만 제공한다. 외부 공개 시 Nginx 또는 Caddy 앞에 둔다.

역프록시 뒤에서는 `bind`를 `127.0.0.1:8080`으로 제한해 직접 노출을 막는다.

### Nginx 예시

```nginx
server {
    listen 443 ssl http2;
    server_name etl.example.com;

    ssl_certificate     /etc/letsencrypt/live/etl.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/etl.example.com/privkey.pem;

    client_max_body_size 512m;   # max_upload_mb와 맞출 것

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;   # 긴 추출·변환 작업
        proxy_send_timeout 600s;
    }
}
```

Let's Encrypt:

```bash
sudo certbot --nginx -d etl.example.com
```

### 방화벽

```bash
# 역프록시 사용 시: 443만 개방, 8080은 내부만
sudo ufw allow 443/tcp
sudo ufw deny 8080/tcp
```

역프록시 없이 직접 노출할 경우 `bind = "0.0.0.0:8080"`과 방화벽에서 해당 포트만 허용한다. HTTPS는 적용되지 않으므로 내부망 전용으로만 쓴다.

---

## 7. 업그레이드

1. 서비스 중지: `sudo systemctl stop bintl`
2. (선택) `data/` 백업
3. 새 `bintl` 바이너리로 교체
4. 기동: `sudo systemctl start bintl`
5. `/api/health` 및 로그인·작업 실행 스모크 테스트

DB 스키마는 기동 시 `crates/storage/migrations/`가 자동 적용된다. 마이그레이션 실패 시 로그에 `storage error`가 남는다.

---

## 8. 백업·복구

| 대상 | 내용 | 주기 |
| --- | --- | --- |
| `data/etl.db` | 사용자, 작업 공간, 커넥션 메타, 실행 이력 | 매일 이상 |
| `data/extracts/` | 업로드·추출 파일 | 용량에 따라 |
| `data/outputs/` | 변환 결과 | 용량에 따라 |
| `config.toml` / `/etc/bintl/env` | bind, 비밀 (별도 안전 저장) | 변경 시 |

SQLite 일관 백업 (서비스 중):

```bash
sqlite3 /opt/bintl/data/etl.db ".backup '/backup/etl-$(date +%F).db'"
```

또는 서비스 중지 후 `etl.db` 파일 복사.

복구: 백업 `data/`를 `/opt/bintl/data`에 복원 후 동일 `session_secret`을 유지한다. `session_secret`을 바꾸면 기존 세션 쿠키가 무효화된다.

---

## 9. 용량·성능

| 설정 | 영향 |
| --- | --- |
| `max_upload_mb` | 단일 업로드 상한. Nginx `client_max_body_size`와 맞출 것 |
| `max_concurrent_jobs` | 동시 변환·추출 워커 수. CPU·메모리에 맞게 조정 |
| `data_dir` 디스크 | 추출·변환 산출물이 누적됨. 모니터링 필요 |

변환·추출은 내부 워커(`spawn_blocking`)에서 실행된다. 대용량 작업 시 서버 RAM과 디스크 I/O를 고려한다.

---

## 10. 보안 체크리스트

- [ ] `skip_auth = false` (운영)
- [ ] `session_secret` 랜덤·충분히 긴 값
- [ ] 기본 `admin` / `admin` 비밀번호 변경
- [ ] `bind`를 `127.0.0.1`로 두고 HTTPS 역프록시 사용
- [ ] `config.toml`, env 파일 권한 제한 (`chmod 600`)
- [ ] `data/` 디렉터리는 서비스 계정만 읽기/쓰기
- [ ] DB 커넥션 비밀번호는 SQLite에 암호화 저장 (커넥션 등록 시)

세션 쿠키는 `HttpOnly; SameSite=Lax`다. HTTPS 뒤에서는 역프록시가 TLS를 종료한다.

---

## 11. 트러블슈팅

| 증상 | 확인 |
| --- | --- |
| `ui not built` | embed 빌드 누락. `just ui` 후 다시 `just build` / `just dist` |
| `bind ... Address already in use` | 포트 충돌. `config.toml`의 `bind` 변경 |
| `session_secret is empty` | 설정 또는 `ETL_SESSION_SECRET` 누락 |
| 업로드 413 | `max_upload_mb`, Nginx `client_max_body_size` |
| 로그인 안 됨 | `skip_auth`, 쿠키(도메인·HTTPS), `session_secret` 변경 여부 |
| 마이그레이션 오류 | `journalctl -u bintl`, `data/etl.db` 권한·손상 여부 |

로그 레벨: `RUST_LOG=info` (기본). 상세 디버그는 `RUST_LOG=debug,bintl=trace`.

---

## 12. CI/CD 스케치

GitHub Actions 등에서:

1. `rustup` + `npm ci` + `just dist x86_64-unknown-linux-musl`
2. `dist/` 아티팩트 업로드
3. 배포 job에서 SSH/rsync로 서버 교체
4. `systemctl restart bintl`
5. `curl -f https://etl.example.com/api/health`

UI만 바꿔 긴급 패치할 때는 서버에 `ui/dist`를 올리고 `ETL_UI_DIR=/opt/bintl/ui/dist`로 embed 없이 서빙할 수 있다. 정식 배포는 바이너리 재빌드(embed)가 기준이다.

---

## 관련 문서

- [README](../README.md) — 로컬 실행·수락 테스트
- [schema.md](schema.md) — SQLite 스키마
- [extract.md](extract.md) — 추출 회로
- [transform.md](transform.md) — 변환 회로
- [workspace.md](workspace.md) — 작업 공간 모델
