---
type: operations
title: 인증과 접근제어
description: 세션은 users.id HMAC 쿠키다. 저장된 비밀번호는 Argon2 해시이고 config.toml의 평문 비밀번호는 부트스트랩과 skip_auth에만 쓰인다. 워크스페이스는 소유자 경계, 커넥션은 조직 전역이다.
tags: [auth, session, rbac, workspace, connections]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-5ef7491ff3e7a6bb02fd5477
    resource: repo://crates/server/src/access.rs
  - id: openwiki-source-4a1983c1eb8066dafb2960a6
    resource: repo://crates/server/src/auth.rs
  - id: openwiki-source-0fdc6753bf2731fa7b499ee0
    resource: repo://crates/storage/src/connection_repo.rs
  - id: openwiki-source-617125e12371a6524c78d64e
    resource: repo://crates/storage/src/identity.rs
  - id: openwiki-source-57599bcc98d7096aec769717
    resource: repo://crates/storage/src/password.rs
  - id: openwiki-source-a098fdc1c547ffb8079a0720
    resource: repo://docs/workspace.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 인증과 접근제어

한 설치는 회사 하나다. 사용자는 워크스페이스를 소유하고, 커넥션만 조직 전역이다. 워크스페이스 멤버 공유는 현재 범위 밖이다.

관련 페이지: [배포와 설정](/openwiki/operations/deploy-and-config.md), [Quickstart](/openwiki/quickstart.md), [워크스페이스 캔버스](/openwiki/workflows/workspace-canvas.md).

## 세션

공개 라우트는 `/api/health`, `/api/login`, `/api/logout`뿐이다. 나머지 `/api`는 `auth::require_auth` 미들웨어를 탄다.

로그인 성공 시 `session` 쿠키를 심는다. 값은 `{users.id}.{HMAC-SHA256}`이고 `HttpOnly; Path=/; SameSite=Lax`다. 검증은 상수 시간 비교다. 비활성 사용자는 거절한다. 로그아웃은 Max-Age=0으로 지운다.

`skip_auth`(config 또는 `ETL_SKIP_AUTH`)가 켜지면 쿠키를 보지 않고 부트스트랩 사용자를 현재 사용자로 넣는다. 개발 편의용이다.

## 부트스트랩과 비밀번호

기동 시 `ensure_bootstrap`이 사용자를 보장한다. 사용자가 없으면 `config.toml`의 `auth.username` / `auth.password`로 admin 역할 계정을 만든다. 이미 사용자가 있으면 기존 admin(또는 첫 사용자)을 돌려주고, 소유자 없는 워크스페이스를 그 계정에 붙인다.

README가 말하는 뼈대 평문 비밀번호는 **설정 파일**이다. `users.password_hash`에는 Argon2 해시를 넣는다. 로그인은 그 해시를 검증한다. 설정 평문을 `password_hash`로 교체하는 것은 이후 과제다. 저장된 비밀번호는 최소 4자다.

사용자 CRUD는 `USER_MANAGE`가 있는 역할만 한다. 비밀번호를 비운 PATCH는 기존 해시를 유지한다.

## RBAC

권한 코드는 세 개다.

| 권한 | 효과 |
| --- | --- |
| `USER_MANAGE` | 사용자 생성·수정 |
| `CONNECTION_WRITE` | 커넥션 등록·수정·삭제 |
| `WORKSPACE_ALL` | 모든 워크스페이스 열람·쓰기 |

조회는 전원 가능하다. 등록·수정은 `CONNECTION_WRITE`만 한다. 커넥션 비밀번호는 `password_cipher`로 암호화되고, 칩 설정이나 실행 스냅샷에 복사되지 않는다. 실행은 `connection_id`로 산 자격 증명만 읽는다.

역할·권한 매핑은 `roles`, `permissions`, `user_roles`, `role_permissions`다. `users`에 역할 컬럼이나 홈 워크스페이스 타입은 없다. 사용자 생성 시 시작용 워크스페이스를 만들 수 있지만 특별 홈이 아니다.

## 워크스페이스 소유

데이터 범위는 `DataScope`다. `WORKSPACE_ALL`이 없으면 `workspaces.owner_user_id`가 본인인 것만 보인다. 남의 워크스페이스는 `not found`로 숨긴다. 폴더(`workspace_folders`)도 같은 소유 경계다.

파일·추출·변환·잡은 그 워크스페이스 접근을 통과해야 한다. 쓰기 대상 워크스페이스를 지정하지 않으면 보이는 목록의 첫 항목을 쓴다. 목록이 비면 워크스페이스를 먼저 만들라는 오류다.

`/workspace`는 최근 수정 순 첫 워크스페이스를 연다. 세션 쿠키의 주체는 `users.id`다.

## 불변

- 보호 API는 세션 사용자 없이 진행하지 않는다. `skip_auth`만 예외다.
- 비활성 계정은 쿠키가 맞아도 401이다.
- 커넥션 시크릿은 레시피에 들어가지 않는다.
- 워크스페이스 공유 ACL은 없다. 소유자 또는 `WORKSPACE_ALL`만 본다.
