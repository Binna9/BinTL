# 스크립트

작성: 2026-09-17

스크립트는 이미 떨어진 파일을 읽고 JavaScript로 **parquet**를 만드는 칩이다. SQL을 parquet에 돌리는 칩이 아니고, 커넥션으로 쿼리하는 칩도 아니다. DB는 extract / SQL 칩이 한다.

제품 화면은 `/workspace` 캔버스다. `/script`는 `/transform`처럼 **칩을 만들거나 고치는 도구**다. UUID로 고르는 두 번째 파이프라인을 만들지 않는다.

## 결정 (2026-09-17)

- 입력은 **한 줄**. extract / transform / script 슬롯 중 아무거나 **하나**. “총 3개”는 동시에 세 개를 받는 게 아니라, 그 세 종류가 스크립트로 떨어질 수 있다는 뜻이다. 한 칩이 extract+transform+script를 한꺼번에 받으면 `ctx.input()`이 이름 맵이 되고 변환 combine과 겹친다. 다음으로 미룬다.
- 등록 전에 입력 데이터셋을 고른다. 변환과 같다. 캔버스에서 열면 data 에지가 입력이고 고르기는 잠긴다 (`inputFromEdge`).
- 여러 JS 파일. 엔트리는 `main.js`. 헬퍼는 `require('./lib.js')`. `main(ctx)`가 `ctx.write(rows)`로 결과 한 장을 떨어뜨린다.
- 게스트에 커넥션을 넣지 않는다. `ctx.connection()` 없음.
- 편집은 AppDialog가 아니라 **페이지**. SQL 다이얼로그에 파일 트리·데이터셋 고르기를 넣어서 뭉개졌다.
- 언어는 JavaScript. 런타임은 서버에 심은 Boa(순수 Rust). musl 단일 정적 바이너리(`just dist x86_64-unknown-linux-musl`)를 깨지 않으려고 CPython / Node / Deno / QuickJS C는 쓰지 않는다. npm, `fs`, `fetch` 없음.
- 파일은 납작하다. `dto.js` / `service.js`처럼 한 칸 목록만. `dto/User.js` 폴더·자바 패키지·ES `import`/`export`는 없다.

## 입력

실행 시 data 에지의 최신 출력을 고른다. 변환과 같은 슬롯 규칙이다. 연결이 없고 단독 `input_dataset_id`도 없으면 빈 입력(`ctx.input() === null`)이거나 실패 — 페이지를 붙일 때 변환과 같은 쪽으로 맞춘다. 한 칩으로 들어오는 data 에지는 하나다.

허용 from: `extract` | `transform` | `script`. 허용 to: `transform` | `load` | `validation` | `serve` | `script`.

## Config

`chips.config_json`에 파일 맵을 둔다. 디스크 git 프로젝트가 아니다. 워크스페이스 저장이 이미 config를 스냅샷한다.

```json
{
  "entry": "main.js",
  "files": {
    "main.js": "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n",
    "lib.js": "module.exports = { bump: function (row) { ... } };\n"
  }
}
```

제한(서버): 파일 16개, 합계 256KB, 이름 `^[A-Za-z0-9._-]+\\.js$` (`.`으로 시작·경로 구분자 금지), 출력 5만 행, 실행 30초.

게스트 SDK:

```js
function main(ctx) {
  var rows = ctx.input() ?? [];
  ctx.log("n=" + rows.length);
  ctx.write(rows);
}
```

`require('./lib.js')`는 `files` 안의 다른 키만 읽는다. `.js`를 빼면 못 찾는다.

## 출력

변환과 같다. `chip_outputs/{workspace}/{chip}/current.parquet`. 표시 이름은 `{칩이름}.parquet`. 재실행이 덮어쓴다.

`data_files.kind` CHECK에 `script`가 있다. 스크립트 슬롯 upsert는 kind `"script"`를 쓴다.

## 화면

변환과 같은 메뉴 둘로 나눈다.

- 레시피 `/script`, 캔버스에서 열면 `/workspace/:id/chips/:chipId/script`.
- 결과 파일 `/scripts`: 작업구분 트리 + 스크립트 parquet 목록·미리보기·삭제. 변환 파일 페이지와 같다.
- 캔버스 “새 스크립트”: 빈 칩(입력 칩 연결) 또는 데이터셋 고른 뒤 `/script?new_chip=1`. 카탈로그 배치도 된다.
- 레시피 왼쪽: 입력 데이터셋. 단독 `/script`는 변환과 같은 종류 아코디언. 캔버스에서 열면 업스트림 칩만 보이고 잠긴다.
- 레시피 가운데: 이 칩의 JS 목록(`main.js` 엔트리). 헤더 오른쪽에서 파일 추가 팝업. CSV·작업구분 아님.
- 레시피 오른쪽: 고른 JS 에디터.
- 저장은 변환과 같다. 저장 → JS 적용 미리보기 → 취소/칩 적용·칩 등록. 실행·연결은 캔버스.

팝업이 남으면 `AppDialog` 규칙을 지킨다. 세로 목록에는 `scroll-pane`. 문구는 `ui/src/i18n/ko.ts` + `en.ts`.

## 코드 현황

- 마이그레이션 `crates/storage/migrations/0011_script_chip_kind.sql` — `chips` / `execution_steps` kind에 `script`
- 서버 `crates/server/src/script.rs` — parse/validate, Boa `run_js`, parquet 기록. 커넥션 호스트는 **뺐다**
- 큐/실행: `chip.rs` `queue_script_chip_run`, `workspace_execution.rs` producer에 script
- 에지·슬롯: `storage` validate, `chip_slot`, `workspace_repo` expected_filename
- 엔진 `PolarsEngine::records_from_file` / `write_records`
- UI: `/script` 페이지가 편집기다. 캔버스·칩 목록은 이 경로로 들어간다. `ScriptChipEditorDialog`는 없다.
- 의존 `@codemirror/lang-javascript`, `boa_engine = "0.20"`

테스트: `cargo test -p bintl script::` (default_main, helper `require`, path escape).

## 하지 않는 것

게스트 커넥션·SQL, npm, `fs`, `fetch`, 입력 여러 개, 미리보기 그리드, Python, 사용자 Rust, SQL-on-parquet, `/script`를 실행 허브로 키우기, 폴더 트리·자바 패키지·TypeScript.
