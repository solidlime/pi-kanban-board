# #22 カードのラベル（bug / feature / chore / 調査）

**Status**: PLAN（オーケストレーターが確定。実装は #011 に委譲）

## 決定（ユーザー回答）

| 論点 | 決定 |
|---|---|
| 集合 | **固定 4 種のみ**: `bug` / `feature` / `chore` / `調査`（`LABELS` 定数） |
| 枚数 | 1 枚に**複数**（`string[]`） |
| 付与 | **手動のみ**。渡したときだけ付き、`""` で消える（#20 の session/commit と同じ方針） |

### 内部値を日本語にしてよい理由
`normalizeProject` は `[a-z0-9._-]` に絞るが、あれは **slug = 識別子**だから。ラベルは人が読む語彙で、sqlite も JSON も UTF-8 をそのまま扱う。内部＝表示＝`調査` にして**マップを 1 つ作らない**。外部が HTTP で打つときは `encodeURIComponent` が必要（`?labels=%E8%AA%BF%E6%9F%BB`）。打ち忘れは未知のラベルとして 400 になる——typo は 400、の既存の規律どおり。

## データ層（`extensions/db.ts`）

**JSON 列 1 本**（`labels TEXT`）。`card_dep` 型の別テーブルにはしない。

理由: `extensions/db.ts:144-145` のコメントが `card_dep` を分けた根拠は「**関係**だから、1 枚の行を触らずに書き換えられる」——つまり多対多の参照。ラベルは他カードへの参照ではなく、そのカードの値の列挙なので当てはまらない。別テーブルにすると `writeDeps` 相当（全削除→再挿入）、`listProjectBoards` のマージ、`writeBoard`/`importBoard` の 2 箇所、の 4 箇所が増える。列なら 1 個。

**#20 で踏んだ 18 引数の罠が今も残っている**（`insertCard.run` が `extensions/db.ts:374-393` と `:418-437` にバイト同一で 2 箇所）。今回は 19 引数になるので**両方**触る。片方忘れると `importBoard` 経由だけラベルが消え、`tests/db.test.mjs:128-137` が番人になる。

必須 5 点セット:
1. `Card` 型（`:44` 付近、`blocks` の隣）に `labels?: string[];`
2. `CREATE TABLE card`（`:141`）に `labels TEXT` を `session_id, commit_sha,` の後ろへ
3. migration（`:259-260`）に `if (!cols.has("labels")) db.exec("ALTER TABLE card ADD COLUMN labels TEXT");`
4. `selectCards`（`:266`）の**明示列挙**に `labels` を追加（忘れると読み戻しで無音欠落。`selectProjectCards` は `SELECT *` なので GLOBAL だけは通ってしまい、project 側のテストだけでは見逃す）
5. `rowToCard`（`:198-201` 付近）に `const labels = parseLabelColumn(r.labels); if (labels !== undefined) card.labels = labels;`

`insertCard` の prepared statement（`:289`）: `..., session_id, commit_sha, labels) VALUES (` + `?, ` × 19。

書き込み側の値は `c.labels && c.labels.length > 0 ? JSON.stringify(c.labels) : null`。空配列と「無い」を区別しない（`blocks` も空なら列を作らない流儀）。

JSON の読み戻しは**手で守る**: `JSON.parse` した値が配列で、各要素が `LABELS` に含まれる文字列のときだけ採用。壊れた値・未知のラベルは**黙って捨てる**（読み取り側は投げない。`priorityOf` のコメントと同じ方針）。`LABELS` は `kanban.ts` にあるので、`db.ts` から import すると循環するかもしれない——**その場合は `db.ts` 側に検証関数を置かず、`JSON.parse` の結果が配列であることだけ見て `string[]` として返し、`LABELS` への照合は `kanban.ts` の書き込み境界で行う**。読み取りは寛容、書き込みは厳格。

## 正規化（`extensions/kanban.ts`、`parseBlocks` の隣 `:746` 付近）

```ts
export const LABELS = ["bug", "feature", "chore", "調査"] as const;
export type Label = (typeof LABELS)[number];
const LABEL_SET = new Set<string>(LABELS);

/** "bug,調査" -> ["bug","調査"]. null = reject (unknown label), [] = nothing given ("", clears). */
export function parseLabels(raw: string | null): string[] | null {
	if (raw === null || raw.trim() === "") return [];
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const s = part.trim();
		if (!LABEL_SET.has(s)) return null;
		if (!out.includes(s)) out.push(s);
	}
	return out;
}
```

- `null`/`""` → `[]`（何も指定しない = 空。`parseBlocks` と同じ）
- 未知の語・空白のみの要素 → `null` → 呼び側で **400**
- 重複除去
- **`trim()` した上で照合する**。`?labels=%20bug%20` は `bug` として通す（`normalizeCommit` と同じ）。だが `?labels=%20` は `null` ではなく「空要素」なので **400**（`parseBlocks` の厳格さに合わせる: `"1,,2"` は `Number("")=0` で弾かれる）

## API

### `/api/add`（`:4020` 付近、`blocks` の直後）
```ts
const labels = parseLabels(q.get("labels"));
if (labels === null) {
  sendJson(res, 400, { ok: false, error: "labels must be a comma-separated list of: bug, feature, chore, 調査" });
  return;
}
...
if (labels.length > 0) card.labels = labels;
```

### `/api/schedule`（`:4189`）
- 必須判定（`:4189-4193`）に `q.get("labels") === null` を足す
- エラーメッセージを `"at, blocked, project, session, commit or labels is required"` に
- `const labelsParam = q.get("labels"); const labs = labelsParam === null ? null : parseLabels(labelsParam);`
- `if (labs === null) 400`
- `if (labs !== null) { if (labs.length === 0) delete card.labels; else card.labels = labs; }`
- **全置換**。`labels=bug` は `["bug"]` になり `調査` は消える。`project`/`session`/`commit` と同じ意味論。差分追加は作らない

### tool（`:5403` 付近の `Type.Object`）
```ts
// Comma-separated. Allowed: bug, feature, chore, 調査. "" clears.
labels: Type.Optional(Type.String()),
```
`Type.Array` の前例がリポジトリに 0 件なので作らない。`blocks` も **tool パラメータに無い**（HTTP のみ）が、ラベルはカード編集の主要操作なので tool に載せる。

- `add` 分岐: `normalizeProject` の並びに `const labels = parseLabels(params.labels ?? null); if (labels === null) return fail(...)`。`params.labels` が `undefined` のときは何もしない（`parseLabels(null) = []` なので「空」と区別する必要がある——**`params.labels === undefined` の早期 return を忘れると、`labels` を渡さない `add` でも空になる。それは害が無いが、`edit` では害がある**）
- `edit` 分岐: `params.labels === undefined ? undefined : parseLabels(params.labels)`。`""` → `[]` → `delete card.labels`
- `edit` の「何も指定されていない」エラー文（`:5505`）に `labels` を足す

## 表示

### ツール出力（`formatCard` `:920`）
```ts
`${c.labels && c.labels.length > 0 ? `${c.labels.join(",")} ` : ""}`
```
commit の後・text の前。

### `CARD_FIELDS`（`:3587-3607`）
`"labels",` を `"commit",` の後ろに足す。**忘れると `?fields=` 呼び出しだけ無音で欠落**。

### ダッシュボード（`web/dashboard.html`）
- CSS（`:78`）: `.card .sess,.card .commit` に `.lab` を足す（宣言を共有。1 行の差分）
- カード行（`:1030` の後、`if (c.sid)` の前）:
```js
  // #22: ラベル。固定 4 種なので検証はサーバ側。ここは出すだけ。
  if (c.labels && c.labels.length) {
    for (var li = 0; li < c.labels.length; li += 1) card.appendChild(el("span", "lab", String(c.labels[li])));
  }
```
- 検索（`cardHit` の `fields` 配列 `:1335`）に `(c.labels || []).join(" ")` を足す。「bug で引ける」は自然
- フィルタ: **新しい排他ボタンは作らない**（`cardFilter` は単一選択で `ok`/`blocked` と共存できない）。代わりに独立した `<select>`
  - `#filters`（`:263-271`）に `<select id="lab" class="q" aria-label="ラベルで絞り込み"><option value="">ラベル: 全部</option><option value="bug">bug</option><option value="feature">feature</option><option value="chore">chore</option><option value="調査">調査</option></select>` を `#proj` の後ろ
  - `var labFilter = "";`（`cardFilter` の隣 `:328`、コメント付き）
  - `cardFilterOk` の先頭に `if (labFilter !== "" && (c.labels || []).indexOf(labFilter) < 0) return false;`
  - `filtered` の **2 箇所**（`:1358` と `:1387`）に `|| labFilter !== ""` を足す。忘れると「該当なし」が出ず GLOBAL が畳まれたまま
  - `uiSig` には**載せない**（`cardFilter` と同じ理由: 静的な DOM なので復元が要らない。載せると選択のたびに余計な描画が走る）
  - change 配線（`:2008-2013` の `projEl` の隣）に `labEl` を足す

## 落とし穴

1. **`tests/kanban-dashboard-search.test.mjs:184-188` が `cardFilterOk(x, all) && (!search || cardHit(` をソース文字列で固定**している。`cardFilterOk` の**中身**を変えるのは安全（呼び出し側の文字列は変わらない）。`filtered` の行を触るのは安全（固定していない）。だが**呼び出しの形を変えると落ちる**
2. **`npm run build` を忘れると全テストが旧 HTML を検査して偽陽性で緑**。`web/` を直したら必ず build
3. `extensions/dashboard.generated.ts` を直接編集しない（`--check` が落ちる）
4. `aggregateGlobal`（`:3179-3191`）は `...card` のスプレッドなので `labels` は自動で生き残る。`listProjectBoards` も `SELECT *`。**落ちるのは `selectCards` だけ**
5. ダッシュボードの可視性テストは**生成物**を読む。実ブラウザ確認は不要（#21 で確認済みの経路）

## テスト

1. `tests/db.test.mjs`: ラベルの保存・読み戻し。**`writeBoard` と `importBoard` の両方**（`:128-137` の隣）。空配列が `undefined` に落ちることも固定
2. `tests/kanban-labels.test.mjs`（新規、`kanban-link.test.mjs` の形）:
   - `?labels=bug,調査` → 2 つ付く、順序保持
   - `?labels=BOGUS` → 400、**カードが増えていない**
   - `?labels=` → 何も付かない
   - `?labels=bug,bug` → 重複しない
   - `?labels=%20bug%20` → `bug`（trim）
   - `/api/schedule?labels=feature` → 全置換（`調査` が消える）
   - `/api/schedule?labels=` → クリア
   - `/api/schedule` に `labels` も他も無し → 400
   - tool `add` の `labels: "bug" ` → 付く
   - tool `edit` の `labels: " "` → 400（`""` と空白のみの区別。**#20 で踏んだ罠**）
3. `tests/kanban-dashboard-labels.test.mjs`（新規）: 配信 HTML から `cardFilterOk` を波括弧対応で抜き出して `new Function` で評価し、`labFilter` との組み合わせを直接叩く（静的 grep では「`labFilter` が `cardFilterOk` から呼ばれていない」を検知できない）。カード行に `.lab` が出ることを `textOf` で固定

## 検収

`npm run build` → `npm test`（**178 pass から減らない**）→ 個別ファイルの `ok N checks` を確認 → `build-web --check` → ルアン・メェイ REVIEW → commit（`feat(kanban): カードにラベル（bug / feature / chore / 調査） (#22)`）→ DONE。

**やらないこと**: ラベルの自動付与、自由入力、ラベル別の集計（`cardStats`）、`?addLabel=` の差分操作、`check()` の node:test 化（#31）、ラベルテーブル化。
