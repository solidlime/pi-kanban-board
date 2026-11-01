# #19 「次にやること」を最上部に出す

## 決定（ユーザー確認済み 2026-11-01）

- 対象は **project ボードの 1 枚だけ**。GLOBAL は読み取り専用の集約ビューなので「次を決める」場所にしない（#26 で global の doingLoop が構造的に無効と分かっているのと同じ筋）。
- 候補は **既存 `nextTodo` と同一の規則**（priority 降順 → id 昇順、blocked と予約済みを除外）。**期限は順序に混ぜない**。
- **表示だけ**。着手ボタンは付けない（既存のドラッグ / Enter で足りる）。
- 位置は **ボードタブの最上部**、`#statsec` の前。

## 既存の再利用（作り直さない）

- `nextTodo(cards, _scope, _sid, now)` `extensions/kanban.ts:1456-1460` — 純粋関数。`orderTodos`（priority 降順 → id 昇順、`:797-800`）と `isSilent`（blocked / nextFireAt / firedFor、`:767-772`）で決まる。**そのまま呼ぶ**。
- `dashboardPayload` の `project.cards` `extensions/kanban.ts:3309` は `pb.cards` = `readBoard(boardPath("project", slug)).cards`。`nextTodo` にそのまま渡せる。
- `sigOf(d)` `web/dashboard.html:1793-1797` は **payload 全体を JSON 比較し `now` だけ除外**。`next` は Card（時刻フィールドを含まない）なので安全。カードが動いたときだけ再描画される（正しい挙動）。
- 期限チップの規格 `dueCls` `web/dashboard.html:1167-1174`、優先度 `prioOf` `:672`、行の見出し `.hd` `:37`、トークン `--panel` / `--accent` / `--accent-soft` / `--warn` / `--bad`。
- `el(tag, cls, text)` と `boardCtx` 周りの流儀は `cardOps` / `haltBox` を参照。

## サーバ（1 行）

`dashboardPayload` の `project` に追加:

```ts
next: nextTodo(pb.cards, "project", sidActor) ?? null,
```

- `null` を返す（`undefined` は JSON で消える）。
- Card をそのまま載せる（1 枚分）。`sigOf` に入るが、内容はカードが動いたときだけ変わる。
- **`stats` 配下には足さない**（`tests/kanban-dashboard.test.mjs:155-158` がキー完全一致を固定している）。`project` 配下なら既存テストは壊れない。

## クライアント

- HTML: `<section id="nextsec" aria-live="polite"></section>` を `#statsec`（`web/dashboard.html:245`）の直前に置く。
- `render(d, nowMs)` ``web/dashboard.html:1733` の中から `renderNext(d)` を呼ぶ（`board` 系の描画より前）。
- `renderNext(d)`:
  - `var n = d && d.project ? d.project.next : null;`
  - `n` が無ければ「次にやることはない（TODO が空）」を出す。**セクションは消さない**（画面から行が消えるとレイアウトが跳ねる）。
  - あれば `次にやる` ラベル + `#id` + テキスト（60 字で切る。既存の clamp と同じ長さ）+ 優先度チップ + 期限チップ（`dueCls` の warn/bad を流用）。
  - テキストは `md()` を使わない（`textContent` で入れる。ここは 1 行の要約で、リンクを展開する場所ではない）。
- CSS: `.next` は `--panel` 背景 + 左ボーダー 3px `--accent` + `padding:10px 12px` + `border-radius:8px` + `margin-bottom:8px`。ラベル `.next-lbl` は `.hd` と同じ字間・`--accent`。
- ライトテーマのトークンは既存の変数を経由するので追加定義は不要。

## テスト

- 新規 `tests/kanban-dashboard-next.test.mjs`（vm、`kanban-dashboard-stale.test.mjs` と同型の `makeEl` + サンドボックス）:
  - `project.next` があるとき、`#nextsec` に `#19` とテキストとチップが出る
  - `next: null` で「TODO が空」が出る（セクションが空にならない）
  - 期限が過去なら `sched bad`、2 日以内なら `sched warn`、期限なしならチップ無し
  - 60 字超のテキストが切られる
- `tests/kanban-dashboard.test.mjs` の shape テストに「`project.next` は Card か null」を 1 本追記。
- 既存テストの期待値は変えない。

## やらないこと

- 着手ボタン（ユーザー判断）。
- GLOBAL の次（読取専用の集約は「次」を決める場所ではない）。
- 期限を順序に混ぜる（`nextTodo` の規則を 1 箇所に保つ）。
- `#statsec` の畳みロジックの変更。

## 検証

`npm test`、`node scripts/build-web.mjs --check`。実ブラウザは次回再起動後（#30）。

## 結果（#011, 未コミット）

- サーバ: `extensions/kanban.ts:3318-3322` — `next: nextTodo(pb.cards, "project", sidActor) ?? null,`（project 配下のみ、stats は不変）。引数の呼び出し規約とスナップショット（`sigOf` が `now` を除くため時刻だけで変わる候補は次の payload 変化まで古い）をコメントに残した。
- クライアント: `web/dashboard.html` — CSS `:33-41`、`#nextsec` `:254`（`aria-live` は付けない）、`dueChip` `:736-746`、`renderNext` `:1140-1174`、`render()` からの呼び出し `:1793`。
- `extensions/dashboard.generated.ts` 再生成（`node scripts/build-web.mjs`）。
- テスト: `tests/kanban-dashboard-next.test.mjs` 10 本（静的マークアップ 1 / あるとき 2 / 空 2 / 期限 3 / 長い本文 2）、`tests/kanban-dashboard.test.mjs` に `project.next` の shape 1 本。
- 検証: `npm test` → 169 pass / 0 fail。`node scripts/build-web.mjs --check` → `build-web: up to date`。型チェックは repo に `tsc` が無いため N/A（kanban.ts の差分はコメントのみ）。
- 赤確認: TODO 分岐を潰すと「着手できない」テストが落ちる / `#nextsec` を消すと静的マークアップテストだけが落ちる（偽 DOM が要素を自動生成するので他 9 本は緑のまま）/ `slice` に戻すとサロゲートペアのテストが落ちる。いずれも戻し済み。
- oracle BLOCK 反映: 空メッセージ 2 分岐 / `#nextsec` の静的検査追加 + 意味の無い `sec.hidden` assert 削除 / `dueChip` 抽出で期限の語と `title` を `.next` にも出す / `aria-live` 削除 / `Array.from` で 60 文字切り / `prioOf` 1 回 / 冗長な `stats.next` テスト削除。
- 実ブラウザ未検証（#30）。`#statsec` の畳み・`nextTodo` の規則・`sigOf` は未変更。
