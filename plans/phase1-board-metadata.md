# フェーズ1: ボード強化（期限・依存・見積）

カードに3つの情報を足して「読めるボード」にする。UI の骨格は今のまま。

## 1-1 スキーマ（`extensions/db.ts`）

### Card 型に追加
```ts
due?: string;      // YYYY-MM-DD（UTC の日付のみ。時刻は持たない）
estimate?: number; // ポイント。0 以上
blocks?: number[]; // このカードが待つ相手（先行）。全部 done になるまで着手不可
```

### テーブル変更
- `card` に `due TEXT` と `estimate INTEGER` を追加。
- 新規 `card_dep`:
```sql
CREATE TABLE IF NOT EXISTS card_dep (
  scope TEXT NOT NULL, sid TEXT NOT NULL,
  card_id INTEGER NOT NULL, blocks_id INTEGER NOT NULL,
  PRIMARY KEY (scope, sid, card_id, blocks_id)
);
```
意味: `card_id` は `blocks_id` が done になるまで着手不可（`blocks` = 待つ相手＝先行）。

### migration（重要）
既存 DB には `CREATE TABLE IF NOT EXISTS` が効かない。`PRAGMA user_version` で 0 → 1 に上げ、
**列が無いときだけ** `ALTER TABLE card ADD COLUMN due TEXT` / `estimate INTEGER` を流す。
`PRAGMA table_info(card)` で判定するのが安全（`user_version` を先に上げると失敗時に片手落ちになるので、
ALTER を全部流し終えてから `PRAGMA user_version = 1`）。

### 読み書き
- `selectCards` に `due, estimate` を足す。
- `rowToCard` で `due` / `estimate` を復元（既存の `optionalText` / `optionalNumber` を使う）。
- `insertCard` の VALUES に2列追加（位置引数なので末尾に足す）。
- `blocks` は `card_dep` から別クエリで引いて `readBoard` で貼る（カード配列に埋め込まない）。
- `writeBoard` で `card_dep` を `deleteStale` 相当で洗い替え（`writeBoard` は全体を書くので、依存も全体を書き直す）。

## 1-2 API（`extensions/kanban.ts`）

- `/api/add` で `due` / `estimate` / `blocks` を受け付ける。
- バリデーション: `due` は `/^\d{4}-\d{2}-\d{2}$/`、`estimate` は 0 以上の整数、`blocks` は数値配列。
- 不正値は **エラーにして拒否**（黙って捨てない）。
- `/api/dashboard` は既存のカード JSON をそのまま返すので、型に足せば自動で載る。
- 依存の循環検出: `card_dep` に書く前に、`card_id → blocks_id` の連鎖を辿って自分に戻るなら 400。
  自己参照（`card_id === blocks_id`）も即拒否。

## 1-3 UI（`web/dashboard.html`）

カードの下に小片を足す（既存の `.meta` 行に追加）:
- `期限 MM/DD`（3日以内は `--warn`、超過は `--bad`）
- `⊕ 依存 N`（依存先の数）
- `Npt`（estimate）

色トークン `--warn: #fbbf24` / `--bad: #f87171` を追加（dark/light 両方）。

依存の解決状態は**クライアントで計算**する（API を増やさない）:
- `blocked` = `blocks` の中に col !== "done" のカードが居る
- `ok` = 依存先が全部 done か、依存なし

## 1-4 フィルタ（`web/dashboard.html`）

ボードの上にフィルタバー（全部 / 着手可能 / 期限超過 / ブロック中）。**クライアント側の絞り込みのみ**。
指標は STATS を置き換えず、その上に4つ足す（着手可能・期限超過・ブロック中・進捗率）。

## 1-5 テスト（`tests/kanban-due.test.mjs`）

- 期限と見積が書けて読み戻せる
- 不正な due は 400
- 依存を張ると blocked になり、依存先を done にすると解除される
- 循環依存は 400
- 既存 DB（列なし）からの migration で落ちない

## 受け入れ条件

- `node tests/kanban-db-migrate.test.mjs` と既存 66 ファイルが全通過
- 既存カー��は `due` / `estimate` / `blocks` が無い状態のまま正常に読める（後方互換）
