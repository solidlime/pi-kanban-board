# #18 停滞検知（movedAt からの経過日数で警告）

## 決定事項（ユーザー確認済み 2026-11-01）

- **3 段階に拡張**: 3 時間（既存の早期警告は残す）→ 1 日 → 7 日。定数を第 3 の系統として増やさず、既存の閾値から連続させる。
- **対象は DOING のみ**。TODO は「まだやっていない」、DONE は「終わった」であって停滞ではない。
- **出す場所は 4 つすべて**: カードのバッジ / ボードヘッダの集計 / エージェント注入文 / TUI フッタ。

## 既に出来ていること（作り直さない）

- `staleTag(b, now)` `extensions/kanban.ts:933-942` — DOING の最古 `movedAt` から ` ⚠Nh` を返す。閾値 `STALE_MS = 3 * 60 * 60 * 1000`（`:155`）。TUI フッタの GLOBAL/PROJECT 2 行が使用（`:989-990`）。`movedAt` の無いカードは「推測で嘘を書かない」ためスキップ。
- `sinceLead(movedAt)` `web/dashboard.html:1805-1812` — `N分前から` + `STALE_GUI_MS = 2 * 60 * 60 * 1000`（`:437`）超で `⏳`。`tick()`（`:1819-1837`）が 1 分ごとに `.since` の**文字だけ**書き換える（DOM 構造は変えない = #74 の制約）。
- `renderInjectionText` の `doingAge` `extensions/kanban.ts:1072-1076` — DOING に `(N分前から)`。
- 期限バッジの規格 `cardOps()` `web/dashboard.html:720-737` + CSS `.card .sched.warn` / `.sched.bad`（`:96-100`）。
- payload には `movedAt` と `now`（分丸め）が既に載っている（`extensions/kanban.ts:3252`, `:3271`, `:3277-3283`）。**クライアント計算で足りる**。
- `movedAt` は列移動のたび更新（`stampMove` `extensions/kanban.ts:848-854`、呼び出し 10 箇所）。`/kanban take` は `movedAt` を触らない（`:5032-5034` — 所有権の移動は進捗ではない）。**take した直後に「何日も停滞」と出るのは正しい**（実際にその時間動いていない）。

## 足りないもの（このカードの範囲）

1. **日数スケールが無い。** 100 時間止まったカードは `⚠100h` と出る。日単位の重大度が読めない。
2. **Web 側に日数警告が無い。** `⚠Nd` は TUI フッタだけ。
3. **カード単体に警告チップが無い。** `⏳` は本文前の記号で、何日止まっているかは lead の文字を読むしかない。
4. **ボード単位の件数が無い。**「停滞 2 件」がどこにも出ない。

## 設計

### 単一の段階判定（サーバ）— `extensions/kanban.ts`

- `STALE_DAY_MS = 86_400_000` / `STALE_WEEK_MS = 7 * STALE_DAY_MS` を `STALE_MS`（`:155`）の隣に追加。
- 純関数 `staleSince(ageMs: number): string | null` — 1 日以上 → `⚠Nd`、3 時間以上 → `⚠Nh`、未満 → `null`。
- 純関数 `oldestDoingAge(b: Board, now: number): number` — DOING の最古 `movedAt` からの経過。DOING が無い／`movedAt` が無いときは `-Infinity`（警告しない）。`Math.floor(-Infinity / 86400000)` は実行されない（比較が false）ので安全。
- `staleTag` は `staleSince(oldestDoingAge(b, now))` を ` ${label}` にするだけ（3 行）。
- `renderInjectionText` の `doingAge` を日数対応に: 1 日以上 `(N日前から ⚠Nd)`、3 時間以上 `(N分前から ⚠Nh)`、未満 `(N分前から)`。

### Web（`web/dashboard.html`）

- `STALE_DAY_MS` / `STALE_WEEK_MS` を `STALE_GUI_MS`（`:437`）の隣に追加。**サーバから配らない**理由: `sigOf()` を汚さず、既存流儀（カード単位バッジはクライアント計算、集計はサーバ）の前者に属する。
- `sinceText(ageMs)`: 分 → 時間 → 日。**`sinceLead` と `tick()` の両方がこれを使う**（`tick` は `r.mins * 60000` を渡す）。1 分ごとの書き換えで日数に変わるようにする。
- `cardOps()` に `#18` チップ: `c.col === "doing"` かつ `movedAt` が 1 日以上前のとき `停滞 Nd`。1〜6 日は `sched warn`、7 日以上は `sched bad`。`title` に「N 日動いていない」。期限チップの直後（同じ `ops` 行）。
- `renderProject` の `head`（`:1263-1268`）と `renderGlobal` の `head`（`:1300-1305`）に `停滞 N` を追加。N は**絞り込み後の `cards`** から数える（表示しているボードと数字を一致させる）。0 件なら出さない。

### テスト

- 新規 `tests/kanban-stale.test.mjs`（assert ベース、`tests/kanban-due.test.mjs` の骨格）: `staleSince` の境界 6 本（2h59m / 3h / 23h / 24h / 7d / 8.5d）、`oldestDoingAge`+`staleTag` の DOING 限定・`movedAt` 無し・複数の最古 3 本、`renderInjectionText` の日数表記 2 本。
- 新規 `tests/kanban-dashboard-stale.test.mjs`（vm、`tests/kanban-dashboard-dues.test.mjs` と同型）: `sinceText` の 3 段階、チップの warn / bad / 非表示、ヘッダ集計。
- 既存追従: `(N分前から)` を固定しているテスト、`⚠Nh` を固定しているテスト。

## やらないこと（理由つき）

- **`stuck` / `halted` に時間条件を足さない。** `stuck` は「settle が同じカードで N 回続いた」＝**エージェントが動いていない証拠**で、時間経過とは判定対象が別（`nextStuckState` `extensions/kanban.ts:803-812` は時刻を 1 つも引数に取らない）。混ぜると `halted: "stuck"` の意味が壊れ、`tests/kanban-stuck-clear-tick.test.mjs` と `tests/kanban-loop-limit.test.mjs` が検証対象を失う。
- **TODO を対象にしない。** ユーザー判断（TODO は停滞ではなく未着手）。
- **サーバで集計値を焼き込まない。** `sigOf()` が `now` を外している設計（`web/dashboard.html:1780-1784`）を壊すと、閾値を跨ぐたび全カード再描画になる（#65/#74 の退行）。クライアントは `movedAt` と `now` だけで足りる。
- **閾値の二重管理（TUI 3h / Web 2h）は解消しない。** 別の関心事（TUI はフッタ 1 行、Web はカード本文）で、統合するとどちらかの UX が変わる。#18 で守ることだけ決める: **日数は両方に同じ値（1 日 / 7 日）で足し、第 3 の定数系統を作らない。**
- **`due` / `estimate` / `blocks` の作成後編集**は別カード（`/api/edit` が無い）。範囲外。

## Drive-by（別コミット `fix(drive-by):`）

- `extensions/kanban.ts:3953-3954` — `/api/move` が**同一列への move でも** `stampMove` する。`doing → doing` の空振りクリックで停滞時計がリセットされ、この機能が永久に出なくなる。`col` が変わったときだけ stamp する。
- `tests/kanban-due.test.mjs:148-157` — `res` を `void res;` で捨てており **assert が 1 つも無い**（常に pass）。循環する blocks の 400 を実際に検証する。

## 検証

- `npm test` 全緑、`node scripts/build-web.mjs --check` up to date。
- 実表示は vm テスト + 実 HTTP payload の確認で担保する。**ブラウザ操作ツールが無いため実ブラウザ確認は不可**（project-workflow の「本格」要件は満たせない。トリアージは「標準」とする）。

## 結果（実装後に追記）

- **サーバ**: `extensions/kanban.ts:156` に `STALE_DAY_MS`、`:938-963` に `staleSince` / `oldestDoingAge` / `staleTag`（`staleTag` の戻り値は ` ⚠Nd` / ` ⚠Nh` / `""` で不変）、`:1094-1102` の `doingAge`。
- **列移動の一本化（レビュー修正）**: `stampMove` の隣に `moveCardTo(card, col, sid)` を置き、**3 つの経路すべて**（HTTP `/api/move`・TUI ドリルダウンの「→ 列へ移動」・`kanban` ツールの `move`）がこれを通る。同一列は no-op。最初は HTTP だけ直して TUI とツールに同じ穴を残した（TUI のメニューは現在の列も並べるので、DOING カードで「DOING へ移動」を押すと停滞時計が戻る）。1 箇所に寄せたので、次に列移動を足す人間も踏まない。
- **注入文の重複排除（レビュー修正）**: `doingAge` は 3 時間未満だけ `(N分前から)`、それ以上は `(⚠Nh)` / `(⚠Nd)` のタグだけ。`(2日前から ⚠2d)` は同じ数字を 2 回言っていた。`age` は `Math.max(0, …)` で丸める（未来の `movedAt` で負の分数を出さない。クライアントの `sinceText` と対称）。
- **クライアント**: `web/dashboard.html:440-441` に定数、`:1827-1845` に `sinceText` / `staleDays` / `staleText`、`:736-744` に停滞チップ、`:1282` / `:1317` で見出しに `・ 停滞 N`（`renderProject` は集計のため絞り込みを DOM 構築前に前倒し、`:1272-1280`）。
- **テスト**: `tests/kanban-stale.test.mjs`（11 checks、サーバ起動なし・jiti で import）、`tests/kanban-dashboard-stale.test.mjs`（9 tests、vm。7 日ちょうどが `bad` / 6 日 23:59 が `warn` の境界を含む）。
- **テストの偽 DOM 修正（レビュー修正）**: `makeEl` の `innerHTML` が文字列のままで子要素を作らず、`sinceLive` が `.since` を掴めず box フォールバックに落ちていた（＝tick のテストが本物の経路を通っていなかった）。`innerHTML` 代入時に `.since` の子を作り `querySelector` を足した。実ブラウザでは `innerHTML` 代入で子ができるので、直したのはテスト側だけ。
- **既存追従**: `tests/kanban-dashboard-ops38.test.mjs` の #38-10 に可視 `.since` の 3 段階 assert を追加（180分前から は ⏳ の title 側だけになったため、可視側を明示的に見る）。`⚠Nh` を固定している既存テストは無く、期待値の書き換えはゼロ。
- **Drive-by テスト**: `tests/kanban-due.test.mjs` の循環 400 に実 assert（前方参照 `blocks=aid+2` を作って循環させる）、同一列 move が `movedAt` を刻まないことの check を追加。
- **`200 OK` だが stamp しない** move は `writeBoard` を 1 回走らせる（`movedAt` が変わらないので実害なし。mtime/ETag は動く）。必要になったら `card.col === col` の早期 return に変える。
