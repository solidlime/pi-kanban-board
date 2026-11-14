# ダッシュボード: 成果物検索 / 帯の新旧ソート / 矩形選択の一括操作

対象: らうらうの依頼（2026-11-12）
- 成果物を検索できるように
- 成果物の新旧ソート
- ドラッグして複数選択 → 削除（成果物）
- 複数選択操作は TODO/DOING/DONE のカードでも

確定した選択（本人回答）:
- 検索は**既存の横断検索 `#q` を成果物にも効かせる**（専用ボックスは作らない）
- 複数選択の後は **削除 + 列へまとめて移動**
- 新旧ソートは**帯（成果物）だけ**。カード列の並びは変えない

## 0. 前提（実測した事実。ここを読めば実装できる）

| 事実 | 場所 |
|---|---|
| 横断検索 `#q` → `state.query` | `web/dash/_head.html:61`、`web/dash/_app.js:1588` |
| 絞り込みは `cardHit(c)` だけ。成果物は素通し | `web/dash/_app.js:133-139`、`delItems()` は `:616-621` |
| 成果物の形 `Deliv = { id, text, img?, at }`（global 集約時のみ `sid`） | `extensions/kanban.ts:129`、集約 `:3819-3826` |
| **`at` がある** → 新旧は `at`（同値は `id`）で決まる | 同上 |
| 帯の描画（順序・件数・署名 sig） | `web/dash/_app.js:728-747` |
| カード列の並び | `sortCol()` `web/dash/_app.js:176-181` |
| カード削除 `/api/remove {id}`、移動 `/api/move {id, col}` | `_app.js:1411,1542` / `:960` |
| 成果物削除 `/api/deliv/remove {p, id}` | `_app.js:716`、`extensions/kanban.ts:7307` |
| **一括 API は無い** → クライアントから N 発（サーバ変更なし） | — |
| 既存の「選択」`state.sel` は**キーボードカーソル 1 本**（`.card.sel`、矢印/j/k、Enter でモーダル） | `_app.js:827-831,1687-1689` |
| カードの DnD は HTML5（`draggable` + `text/plain` に id） | `_app.js:208-215`、列側 `:515-527` |
| 帯の header は `<summary>` の中（クリックで details が開閉する） | `_head.html:112-114` |
| 帯のタイル CSS | `web/dash/_b.css:140-201` |

## 1. 成果物の検索（`#q` 連動）— カード #113

- `delivHit(d)` を `cardHit` の隣に足す。hay = `text` + `"#"+id` + `img` の各ファイル名 + `sid`。`state.query` が空なら true。
  （`cardHit` は `blocked`/`labels`/`commit` も見るが `Deliv` には無い項目なので、持っている項目だけを見る。共通化して undefined を埋める必要はない）
- `renderDeliverables()` の `cards` を `delItems().filter(delivHit)` に。
- **署名 sig に query を入れる**（`_app.js:735`）。入れないと絞り込みが再描画されない。
- 件数（`:745`）: 絞り込み中は `成果物 3 / 全 12 枚`、未絞り込みは従来どおり `成果物 12 枚 / 参照型 2 枚`。
- 割り切り: 語はカードと共通（専用ボックスは作らない、と決めた）。

## 2. 帯の新旧ソート — カード #113

- `state.delSort`（既定 `"new"`）。`localStorage` の `del-sort` に保存（既存の `deliverables-open` と同じ流儀、`_app.js:1702-1706`）。
- `_head.html:113` の summary に 2 状態ボタン `#delsort`（`新→旧` / `旧→新`、`aria-pressed` で状態を出す）。
- **summary 内のボタンは details を開閉してしまう**ので `onclick` で `ev.preventDefault(); ev.stopPropagation();`。既存の `#deladd` の流儀に合わせる（要確認）。
- 並べ方: `at`（欠落は 0）降順 / 昇順、同値は `id` で安定化。**表示順だけ**でサーバの `ord` は触らない。
- sig に `state.delSort` を入れる。

## 3. 帯の矩形選択 → 一括削除 — カード #114

- `marquee(container, itemSel, onPick)` を**1 つだけ**作る（帯と `#board` で共用。2 実装に割らない）。
  - `pointerdown`（`pointerType !== "touch"`）→ 4px 動いたら開始。矩形は `position: fixed` の半透明 div（clientXY なのでスクロール中もズレない）。
  - 選択判定は `getBoundingClientRect()` の交差（`elementFromPoint` は使わない）。
  - 4px 未満で離したらクリック扱い＝選択は消さない（誤爆防止）。
  - `pointerup`/`pointercancel` で矩形を消し、`onPick(選択要素の配列)`。
- 押下開始点が**タイルの上**なら従来動作を優先（横ドラッグで添付切替 / lightbox / × / ✎）。矩形は**空き領域から**始まった時だけ。
- 選択は `state.dsel = { id: true }`、見た目は `.del-tile.msel`。`render()` のたびに id で付け直す（DOM が差し替わるため）。
- 選択中は summary の下に操作バー `#delbar`（`N 件選択 / 一括削除 / 解除`）。
  削除 = `confirm("成果物 N 件を削除する？")` → `Promise.all(N 発の /api/deliv/remove)` → `refresh()` + `toast`。
- タッチでは矩形を作らない（= スマフォは今のまま。タイルの操作を壊さないため）。`shortcut:` コメントで残す。
- 選択が空になったらバーを隠す。ボード切替・検索変更で選択は捨てる（別の板の id と混ざる）。

## 4. カードの矩形選択 → 一括削除 / 一括移動 — カード #115

- 同じ `marquee` を `#board` に載せる。選択は `state.csel = { id: true }`、クラスは `.card.msel`。
- **カードは `draggable`** なので、カードの上から始まった drag は従来の単体移動。矩形は列の空き領域から。
- `state.sel`（キーボードカーソル）とは完全に独立。`.sel` と `.msel` は別クラス。
- 操作バー `#cardbar`: `N 件選択 / → TODO / → DOING / → DONE / 削除 / 解除`。
  - 移動 = `Promise.all(N 発の /api/move)`。削除 = `confirm` → `Promise.all(N 発の /api/remove)`。
  - 移動先が今と同じ列のカードは飛ばす（無駄な rev を上げない）。
- 注意（既知の挙動として残す）: DONE へ送ると `movedAt` が変わる＝DONE の並びが変わる。DOM 順もそれに従う。

## 5. テスト（`tests/kanban-dashboard-v2.test.mjs` の静的アサート流儀）

- `delivHit` が定義され、`renderDeliverables` が `filter(delivHit)` を通ること。
- sig に `state.query` と `state.delSort` が入っていること。
- `#delsort` が `_head.html` にあり、`del-sort` を `localStorage` に書くこと。
- `function marquee` が**1 箇所**だけ定義され、`#delgrid` と `#board` の両方から呼ばれること（`split("function marquee").length - 1 === 1`）。
- 一括削除/移動が `Promise.all` を通り、`confirm` の文言に件数が入ること。
- `state.sel` が複数選択に流用されていないこと（`.card.sel` のトグルは `applySel` の 1 箇所だけ）。
- スライス境界は `indexOf` が -1 のとき空振りしないよう **assert で固定**する（#112 のレビュー指摘と同じ）。

## 6. 検証

- `npm run build`（`web/dashboard.html` と `extensions/dashboard.generated.ts` を同梱。`pretest` の `build-web.mjs --check` が要求する）。
- `node --test --test-concurrency=1` = 全件緑（現在 161）。
- 実ブラウザ確認は**pi 再起動後**。`DASHBOARD_HTML` は module 定数（`extensions/kanban.ts:5845`）なので、稼働中プロセスはビルド前の HTML を返す（#112 で実測済み）。
- ルアン・メェイのレビュー（PASS 必須）→ GATE → push。

## 7. 段取り

1. カード #113（検索+ソート）→ #114（帯の矩形選択）→ #115（カードの矩形選択）の 3 枚。
2. 1 コミットずつ。各段で `npm test`。
3. 最後にレビュー 1 回（3 枚まとめて）→ 残条件をカードに明記 → push。
