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

`require('./lib.js')`는 `files` 안의 다른 키만 읽는다.

## 출력

변환과 같다. `chip_outputs/{workspace}/{chip}/current.parquet`. 표시 이름은 `{칩이름}.parquet`. 재실행이 덮어쓴다.

`data_files.kind` CHECK에 `script`가 없다. 슬롯 upsert는 당분간 kind `"transform"`을 쓴다. 새 CHECK를 열지 않는 한 그대로 둔다.

## 화면 (다음)

변환 페이지를 복사하지 말고 레이아웃만 맞춘다.

- 라우트: `/script`, 캔버스에서 열면 `/workspace/:id/chips/:chipId/script`. `chipEditorPath`의 script 분기를 다이얼로그에서 이 경로로 바꾼다.
- 왼쪽 위: 입력 데이터셋. extract / transform / script 결과만. 캔버스 모드면 업스트림 칩이고 잠긴다.
- 왼쪽 아래: 파일 목록 + 추가/삭제. 추가는 `lib.js` 유령 입력이 아니라 “파일 추가”. 엔트리 `main.js`는 삭제 불가.
- 오른쪽: 열린 파일 에디터 (CodeMirror JS).
- 저장은 변환과 같은 칩 등록. 실행·연결은 캔버스.

팝업이 남으면 `AppDialog` 규칙을 지킨다. 세로 목록에는 `scroll-pane`. 문구는 `ui/src/i18n/ko.ts` + `en.ts`.

## 코드 현황 (이어서 할 것)

이미 있는 것:

- 마이그레이션 `crates/storage/migrations/0011_script_chip_kind.sql` — `chips` / `execution_steps` kind에 `script`
- 서버 `crates/server/src/script.rs` — parse/validate, Boa `run_js`, parquet 기록. 커넥션 호스트는 **뺐다**
- 큐/실행: `chip.rs` `queue_script_chip_run`, `workspace_execution.rs` producer에 script
- 에지·슬롯: `storage` validate, `chip_slot`, `workspace_repo` expected_filename
- 엔진 `PolarsEngine::records_from_file` / `write_records`
- UI kind `script`, 캔버스 툴·레이어·개요·이력 필터, `ScriptChipEditorDialog`
- 의존 `@codemirror/lang-javascript`, `boa_engine = "0.20"`

지금 편집기는 다이얼로그에 `main.js`만 있다. 파일 트리와 데이터셋 고르기를 다이얼로그에 욱여넣었다가 빼 둔 상태다. **다음 작업은 이 다이얼로그를 페이지로 옮기는 것**이다. 캔버스 배치에서 “새 스크립트”는 변환처럼 입력 데이터셋을 고른 뒤 `/script`로 들어가게 한다.

테스트: `cargo test -p bintl script::` (default_main, helper `require`, path escape).

## 하지 않는 것

게스트 커넥션·SQL, npm, `fs`, `fetch`, 입력 여러 개, 미리보기 그리드, Python, 사용자 Rust, SQL-on-parquet, `/script`를 실행 허브로 키우기.
