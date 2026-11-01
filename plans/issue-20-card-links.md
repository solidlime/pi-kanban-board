# #20 カードに会話リンク（sessionId / commit）

## 決定（ユーザー確認済み）

1. **リンクは張らない。ID を表示するだけ**。pi-web は `/?session=<id>` で会話を開けるが、拡張から pi-web の origin は分からない（ダッシュボードは kanban サーバの別ポートから配信される）。嘘の URL を作るより ID を出す。
2. **明示指定のみ**。`add` / `schedule` で渡したときだけ入り、空文字で消える。自動で入れると「見た目のために嘘をつく」経路ができる。
3. **TUI / `list` は commit だけ 7 桁**。sessionId は長いので出さない。project は既に `📁` で出ている。

## フィールド名（`sid` と混ぜない）

- `Card`: `sessionId?: string` / `commit?: string`
- HTTP クエリ: `session` / `commit`（`sid` はボードキーで、project scope では slug。混ぜると追跡不能なバグになる）
- sqlite カラム: `session_id TEXT` / `commit_sha TEXT`（`commit` は SQL 予約語ではないが、意味が広いので `_sha`）

## 正規化（`normalizeProject` の隣、`extensions/kanban.ts:685` 付近）

```ts
export const SESSION_MAX = 128;

/** Write-boundary normalization: "" means "no session" (the field is deleted). */
export function normalizeSessionId(raw: unknown): string {
	if (typeof raw !== "string") return "";
	// URL のクエリに載る値なので、区切り文字になりうる文字は落とす
	return raw.trim().replace(/[^A-Za-z0-9._:@-]/g, "").slice(0, SESSION_MAX);
}

/** "" means "no commit"; any other non-sha input is a typo, not a silent drop. */
export function normalizeCommit(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const s = raw.trim().toLowerCase();
	return /^[0-9a-f]{7,40}$/.test(s) ? s : "";
}
```

- `session`: `project` と同じ扱い（正規化して空になったら 400、空入力ならクリア）
- `commit`: **非空で形式が違えば 400**（`parseDue` の厳格側と同じ思想）。7〜40 桁の hex、小文字化して保存

## データ層 `extensions/db.ts`

- `SCHEMA` の `card` テーブルに `session_id TEXT, commit_sha TEXT`（`:129-138`）
- migration: `if (!cols.has("session_id")) db.exec("ALTER TABLE card ADD COLUMN session_id TEXT")` と同型を 2 本（`:240-251`）。`user_version` は既存の 2 のまま（列名で判定する既存方針）
- `selectCards`（`:254-257`）の列挙に 2 列追加
- `insertCard`（`:277-279`）のプレースホルダを 2 つ増やす
- `writeBoard` の `insertCard.run(...)`（`:362-381`）に 2 値
- `importBoard`（`:405+`）も同様
- `rowToCard`（`:175-198`）で `optionalText` 経由で読む

## API `extensions/kanban.ts`

- `/api/add`（`:3943-3985`）: `session` / `commit` を読む。`session` は `project` と同じ 400 条件、`commit` は非空で不正なら 400。検証は `b.cards.push` の**前**
- `/api/schedule`（`:4139-4185`）: 必須条件に `session` / `commit` を追加。`session` は `project` と同じ delete 分岐、`commit` も同様
- `CARD_FIELDS`（`:3560-3576`）に `sessionId` / `commit` を追加（罠: 忘れると `?fields=` の呼び出し側が取れない）
- `/api/rename` は触らない（text だけの契約）

## ツール層

- schema（`:5300-5335`）に `session: Type.Optional(Type.String())` / `commit: Type.Optional(Type.String())`
- description（`:5302`）に 1 文追加: 「session/commit は add と edit で設定、空でクリア、commit は 7〜40 桁 hex」
- `add`（`:5384-5398`）/ `edit`（`:5416-5437`）で正規化して渡す。`edit` の「project だけ変更」判定に `session` / `commit` も入れる

## TUI / list

- `formatCard`（`:890-893`）: `${c.commit ? ` ${c.commit.slice(0, 7)}` : ""}` を `📁project` の後ろに足す

## UI `web/dashboard.html`

カード行（`:1014-1025`）の `.proj` の隣に 2 つの小片。**リンクにしない**（決定 1）。

- `sessionId` は 8 文字 + `…`、`title` に全文
- `commit` は 7 桁、`title` に全文
- 0 件なら何も出さない（`project` と同じ）
- 検索（`:1330` / `:1359`）は `c.text` のまま。**含めない**（横断検索は #21）
- CSS は `.card .sess` / `.card .commit` を `.card .proj`（`:77`）と同系で。トークンのみ

## テスト

- `tests/kanban-link.test.mjs`（`tests/kanban-project.test.mjs` と同型）:
  - `normalizeSessionId` / `normalizeCommit` の純関数（URL 危険文字の除去、128 桁切り、7 桁未満 / 非 hex / 41 桁）
  - `/api/add?session=&commit=` → 保存 / 不正 commit → 400 かつカード未作成 / 空 session だけでは 400 にならない
  - `/api/schedule?session=` → キー削除 / `commit` だけ変更 → 200 で text 不変
  - `?fields=sessionId,commit` の投影
  - `formatCard` に commit 7 桁が出る・sessionId は出ない
  - ツール add / edit
- `tests/db.test.mjs` に migration 1 本（`:71-97` と同型: 新列の無い DB → 開く → 書いて読める）
- `tests/kanban-dashboard-links.test.mjs`（vm）: 小片が出る / 8 文字 + `…` / `title` に全文 / commit 7 桁 / 両方無ければ何も出ない

## やらないこと

- リンク化（決定 1）
- 自動取得（決定 2）
- sessionId の TUI 表示（決定 3）
- 検索対象への追加（#21）

## 検証

`npm test`（169 → 期待 175 前後）、`node scripts/build-web.mjs --check`、実ブラウザは #30。
