# 스크립트

작성: 2026-09-17

스크립트는 이미 떨어진 파일을 읽고 JavaScript로 **parquet**를 만드는 칩이다. SQL을 parquet에 돌리는 칩이 아니고, 커넥션으로 쿼리하는 칩도 아니다. DB는 extract / SQL 칩이 한다.

제품 화면은 `/workspace` 캔버스다. `/script`는 `/transform`처럼 **칩을 만들거나 고치는 도구**다. UUID로 고르는 두 번째 파이프라인을 만들지 않는다.

## 결정 (2026-09-17)

- 입력은 여러 장. 캔버스에서는 extract / transform / script 칩을 **여러 줄**로 잇는다. `/script` 레시피에서는 데이터셋을 여러 개 고른다. `ctx.input()`은 첫 표, `ctx.input("이름")`은 고른 표, `ctx.inputs()`는 이름 맵이다.
- 등록 전에 입력 데이터셋을 고를 수 있다. 캔버스에서 열면 data 에지가 잠긴 입력이고, 레시피에서 표를 더 고를 수 있다.
- 여러 JS 파일. 엔트리는 `main.js`. 헬퍼는 `require('./lib.js')`. `main(ctx)`가 `ctx.write(rows)`로 결과 한 장을 떨어뜨린다.
- 게스트에 커넥션을 넣지 않는다. `ctx.connection()` 없음.
- 편집은 AppDialog가 아니라 **페이지**. SQL 다이얼로그에 파일 트리·데이터셋 고르기를 넣어서 뭉개졌다.
- 언어는 JavaScript. 런타임은 서버에 심은 Boa(순수 Rust). musl 단일 정적 바이너리(`just dist x86_64-unknown-linux-musl`)를 깨지 않으려고 CPython / Node / Deno / QuickJS C는 쓰지 않는다. npm, `fs`, `fetch` 없음.
- 파일은 납작하다. `dto.js` / `service.js`처럼 한 칸 목록만. `dto/User.js` 폴더·자바 패키지·ES `import`/`export`는 없다.

## 입력

실행 시 캔버스 data 에지의 최신 출력과 레시피에서 고른 데이터셋을 합친다. 같은 파일은 한 번만 넣는다. 연결이 없고 단독 입력도 없으면 `ctx.input() === null`.

허용 from: `extract` | `transform` | `script`. 허용 to: `transform` | `load` | `validation` | `serve` | `script`. 스크립트로 들어오는 data 에지는 최대 8개.

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

제한(서버): 파일 16개, 합계 256KB, 입력 표 8개, 이름 `^[A-Za-z0-9._-]+\\.js$` (`.`으로 시작·경로 구분자 금지). 첫 표는 5만 행씩 나눠 돌리고 결과를 이어 붙인다. 실행 전체 10분.

게스트 SDK:

```js
function main(ctx) {
  var orders = ctx.input("orders") || ctx.input() || [];
  var codes = ctx.input("codes") || [];
  ctx.log("n=" + orders.length);
  ctx.write(orders);
}
```

`require('./lib.js')`는 `files` 안의 다른 키만 읽는다. `.js`를 빼면 못 찾는다.

## 출력

변환과 같다. `chip_outputs/{workspace}/{chip}/current.parquet`. 표시 이름은 `{칩이름}.parquet`. 성공한 재실행만 슬롯을 덮어쓴다. 실패·취소·타임아웃은 직전 성공 parquet를 유지한다. JS는 JSON만 보므로 날짜·숫자는 한 번 문자열이 된다. 나가는 parquet는 첫 입력 표에 있던 같은 이름 컬럼의 타입을 다시 붙인다. JS가 새로 만든 컬럼은 JSON에서 추론한다.

`data_files.kind` CHECK에 `script`가 있다. 스크립트 슬롯 upsert는 kind `"script"`를 쓴다.

## 화면

변환과 같은 메뉴 둘로 나눈다.

- 레시피 `/script`, 캔버스에서 열면 `/workspace/:id/chips/:chipId/script`.
- 결과 파일 `/scripts`: 작업구분 트리 + 스크립트 parquet 목록·미리보기·삭제. 변환 파일 페이지와 같다.
- 캔버스 “새 스크립트”: 빈 칩(입력 칩 연결) 또는 데이터셋 고른 뒤 `/script?new_chip=1`. 카탈로그 배치도 된다.
- 레시피 왼쪽: 입력 데이터셋. 단독 `/script`는 변환과 같은 종류 아코디언에서 여러 장을 고른다. 캔버스에서 열면 업스트림 칩은 잠기고, 카탈로그에서 표를 더 고를 수 있다. 캔버스 칩 속성에서도 입력 칩을 여러 개 고른다.
- 레시피 가운데: 이 칩의 JS 목록(`main.js` 엔트리). 헤더 오른쪽에서 파일 추가 팝업. CSV·작업구분 아님.
- 레시피 오른쪽: 고른 JS 에디터.
- 저장은 변환과 같다. 저장 → JS 적용 미리보기 → 취소/칩 적용·칩 등록. 실행·연결은 캔버스.

팝업이 남으면 `AppDialog` 규칙을 지킨다. 세로 목록에는 `scroll-pane`. 문구는 `ui/src/i18n/ko.ts` + `en.ts`.

## 코드 현황

- 마이그레이션 `crates/storage/migrations/0011_script_chip_kind.sql` — `chips` / `execution_steps` kind에 `script`
- 서버 `crates/server/src/script.rs` — parse/validate, Boa `run_js`, parquet 기록. 커넥션 호스트는 **뺐다**
- 큐/실행: `chip.rs` `queue_script_chip_run`, `workspace_execution.rs` producer에 script
- 에지·슬롯: `storage` validate, `chip_slot`, `workspace_repo` expected_filename
- 엔진 `PolarsEngine::records_from_file` / `write_records` / `RecordWriter::finish_like`
- UI: `/script` 페이지가 편집기다. 캔버스·칩 목록은 이 경로로 들어간다. `ScriptChipEditorDialog`는 없다.
- 의존 `@codemirror/lang-javascript`, `boa_engine = "0.20"`

테스트: `cargo test -p bintl script::` (default_main, helper `require`, path escape).

## 하지 않는 것

게스트 커넥션·SQL, npm, `fs`, `fetch`, Python, 사용자 Rust, SQL-on-parquet, `/script`를 실행 허브로 키우기, 폴더 트리·자바 패키지·TypeScript.
