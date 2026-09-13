---
type: workflow
title: 워크스페이스 캔버스
description: 캔버스는 칩을 배치하고 data/제어 에지로 잇는 제품 화면이다. 초안은 로컬이고, 저장이 배치·연결을 커밋하며 version과 revision 스냅샷을 올린다.
tags: [workspace, canvas, edges, save, chips]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-13T03:59:15.080Z
sources:
  - id: openwiki-source-3a9e14836453a58467b063e9
    resource: repo://.cursor/rules/workspace-pipeline.mdc
  - id: openwiki-source-3d69f6ede087b5ac86f663ad
    resource: repo://crates/server/src/workspace.rs
  - id: openwiki-source-5fb98e50287bf5c277a5d3ff
    resource: repo://crates/storage/migrations/0001_schema.sql
  - id: openwiki-source-9e9e8b83dcdcfb11054a2a0c
    resource: repo://crates/storage/src/workspace_repo.rs
  - id: openwiki-source-a098fdc1c547ffb8079a0720
    resource: repo://docs/workspace.md
  - id: openwiki-source-baec428566100ea25ffcbb6a
    resource: repo://ui/src/pages/WorkspacePage.tsx
generated: { by: "cursor", at: "2026-09-13T03:59:15.080Z" }
---

# 워크스페이스 캔버스

`/workspace`가 제품 중심이다. 왼쪽에서 폴더·워크스페이스를 고르고, 툴을 흰 캔버스에 끌어 칩을 놓는다. 연결선으로 잇고 칩을 눌러 설정한다. `/db`, `/files`, `/transform/*`는 칩을 만들거나 고치는 도구다.

관련 페이지: [칩, 실행, 최신 출력](/openwiki/concepts/chip-current-output.md), [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md), [추출](/openwiki/workflows/extract.md), [Quickstart](/openwiki/quickstart.md).

## 소유와 탐색

사용자는 워크스페이스를 여러 개 소유한다. `folder_id`로 중첩 폴더에 넣는다. 목록은 소유 범위다. `/workspace`는 최근 수정 순 첫 공간을 연다. 커넥션은 조직 전역이라 캔버스 밖 `/connections`에서 관리한다.

## 디자인 대 저장

새로 놓은 칩은 `draft:` id를 가진 로컬 초안이다. 저장 전에 배치·이름·에지를 고쳐도 SQLite 배치 테이블에는 안 들어간다. 떠날 때 dirty면 저장을 묻는다.

우측 하단 **저장**은 다음을 한 커밋으로 한다.

1. 초안 칩을 `POST /api/workspaces/{id}/chips`로 만들어 실제 id를 받는다.
2. `PUT /api/workspaces/{id}/save`에 layout, chip id 목록, edges를 보낸다.
3. 서버는 배치를 맞추고 해당 워크스페이스 에지를 갈아끼운 뒤 `workspaces.version`을 1 올리고 `workspace_revisions`에 layout+chips+edges 스냅샷을 넣는다.
4. data 에지가 있으면 planned 입력 계약(`schema` + 예상 파일명)을 동기화한다.

저장에 없는 배치는 그 워크스페이스에서 빠진다. 초기화는 마지막 저장본으로 되돌린다.

## 에자와 편집

에지는 `data` | `on_success` | `on_error` | `always`다. data 에지는 업스트림 최신 출력 계약이다. 변환 입력은 업스트림 칩 이름이지 `dataset_id` 선택이 아니다.

칩을 누르면 종류별 도구로 간다.

- extract: `/db` 계열로 소스·구분자
- transform: `/transform/…?workspace=&chip=`
- load / validation: 각 설정 화면

캔버스에는 **Run**이 있다. 전체 실행과 칩 단독 실행은 [워크스페이스 전체 실행](/openwiki/workflows/workspace-execution.md)이다. 파일이 없어도 업스트림 레시피 컬럼으로 체인을 짤 수 있다.

## 불변

- 사용자 정체는 칩 이름이다. `stored_path`를 캔버스에 노출하지 않는다.
- data 에지가 입력이다. 파일 카탈로그를 두 번째 파이프라인으로 키우지 않는다.
- 저장되지 않은 초안은 서버 실행 대상이 아니다.
- 자격 증명은 캔버스 설정에 복사하지 않는다.
