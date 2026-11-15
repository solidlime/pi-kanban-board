# v2: footer widget（TUI の 1 行）を戻す

## 事実（実測）
  v1 `extensions/kanban.ts:1331` に `ctx.ui.setWidget(WIDGET_KEY, [1 行], { placement: "aboveEditor" })`。
  中身は `PROJECT: <key>: <counts>` + `staleTag()` + `HALTED:*` / `API:*` タグ。v1 は `deadCtx()` で
  破棄済み ctx の `setWidget` を握り潰している（`extensions/kanban.ts:6574`）。
  pi が読むのは `package.json` の `pi.extensions: ["./extensions/kanban-v2.ts"]` **だけ**。
  v2 は `ctx.ui.notify` 16 箇所のみで `setWidget` / `select` / `input` は 0。
- 仕様側の約束は `docs/REWRITE_V2_PLAN.md:19`「footer widget key `kanban`」に残ったまま未実装。

## 作る
- `extensions/kanban-v2.ts` に `ctx.ui.setWidget("kanban", [line], { placement: "aboveEditor" })`。
- データ源は `GET /api/overview`（web と同じスナップショット）。**DB 直読みも集計ロジックの複製もしない**。
- 1 行形式: `PROJECT: <slug>: todo N · doing N · done N` + 停滞タグ + `HALTED` / `API: <status>`（サーバに届かないときは `API: DOWN`）。
- ポーリング 15s・`unref`・`session_shutdown` と ctx 破棄で `clearInterval` + widget 削除。
- 停滞閾値は `src/shared/` の定数に寄せて web と共有する
  （`plans/issue-18-stale-detection.md:53` の「TUI 3h / Web 2h」二重管理を増やさない）。

## 受入
- ボードが空のときは widget を出さない（常時ノイズにしない）。
- サーバ死・401 のときは `API: <status>` / `API: DOWN` を出して沈黙しない。
- 壊れた/破棄済み ctx で `setWidget` が throw してもプロセスを落とさない。
- `npm run typecheck:v2` と `npm run test:v2` green。

## やらない
- v1 の `select`/`input` ドリルダウン（列移動メニュー等）は戻さない。web に同じ操作がある。
- `extensions/kanban.ts`（v1, 339KB）の削除は別件。
