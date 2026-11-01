# #28: 全ボード供給の式を 1 関数に寄せる

## 問題
「この機械の全カード」を組む式が **4 箇所**に散っている（カードは 3 箇所と書くが、tick の週次書き込みを含めると 4）。

| # | 関数 | 行 | 現在の式 |
|---|------|----|----------|
| 1 | `storeWeekly()` | `extensions/kanban.ts:2089` | `weeklySummary(db.listProjectBoards(), week, now)` |
| 2 | `aggregateGlobal()` | `extensions/kanban.ts:3359` | `readBoard(GLOBAL_JSON).cards` + `listProjectBoards()` |
| 3 | `weeklyPayload()` | `extensions/kanban.ts:3397` | `weeklySummary(db.listProjectBoards(), cur, now)` |
| 4 | `projectsPayload()` | `extensions/kanban.ts:3404` | `readBoard(GLOBAL_JSON).cards` + `listProjectBoards()` |

#25 は 4 番が自 cwd の 1 枚からしか取っていなかった症状。式が 4 つある限り同じドリフトが再発する。

## 変更
`aggregateGlobal()` の直前に 2 つの関数を追加し、4 箇所すべてをそこへ寄せる。

```ts
/** #28: 「この機械の全カード」の唯一の式。 */
type RollupEntry = { scope: Scope; sid: string; card: Card };

function allRollupCards(): RollupEntry[] {
	return [
		...readBoard(GLOBAL_JSON).cards.map((card) => ({ scope: "global" as const, sid: "", card })),
		// Fixed order: slug ascending, id ascending inside a board (listProjectBoards).
		...kanbanDb()
			.listProjectBoards()
			.flatMap(({ slug, cards }) => cards.map((card) => ({ scope: "project" as const, sid: slug, card }))),
	];
}

/** allRollupCards() からプロジェクトボードだけを slug ごとに畳む（週次は GLOBAL 残骸を数えない）。 */
function projectBoardsOf(entries: RollupEntry[]): { slug: string; cards: Card[] }[] {
	const by = new Map<string, Card[]>();
	for (const { scope, sid, card } of entries) {
		if (scope !== "project") continue;
		const list = by.get(sid);
		if (list === undefined) by.set(sid, [card]);
		else list.push(card);
	}
	return [...by].map(([slug, cards]) => ({ slug, cards }));
}
```

置換:
1. `:2089` → `weeklySummary(projectBoardsOf(allRollupCards()), week, now)`
2. `aggregateGlobal()` → `return { cards: allRollupCards().map(({ sid, card }) => ({ ...card, sid })), nextId: 1 };`
3. `:3397` → `current: weeklySummary(projectBoardsOf(allRollupCards()), cur, now),`
4. `projectsPayload()` → `const cards = allRollupCards();`（`gb` の readBoard と flatMap を削除）

結果: `listProjectBoards()` の直接呼び出しは `allRollupCards()` の 1 箇所だけになる。

## 挙動の不変条件（テストで固定する）
- `aggregateGlobal().cards` は「GLOBAL 残骸（sid=""）→ slug 昇順の各ボード」の順で、従来と同一
- `projectsPayload()` の scope/sid/card も従来と同一（GLOBAL は `scope:"global", sid:""`）
- `weeklyPayload().current` / `storeWeekly()` は **GLOBAL 残骸を含めない**（カードのスコープ外。`projectBoardsOf` の filter で維持）

## テスト
`tests/kanban-rollup-source.test.mjs`（新規、SOURCE pin + 実動作）
- SOURCE: `listProjectBoards()` の呼び出しが 1 回だけ、かつ `allRollupCards` の中
- SOURCE: `readBoard(GLOBAL_JSON)` の呼び出しが `allRollupCards` 以外に無い（`boardPath` 等の定義は除く）
- SOURCE: `aggregateGlobal` / `projectsPayload` / `storeWeekly` / `weeklyPayload` の本体が `allRollupCards()` を含む
- 実動作: GLOBAL 残骸 1 枚 + project 2 ボードを seed し、`aggregateGlobal` と `projectsPayload` が同じ 3 枚を返す

## スコープ外（カード記載どおり）
- `/api/weekly` に GLOBAL 残骸を含めるか（pre-migration 行が残る間だけ差が出る）
- `/api/projects`（`card.project` でグループ化）と `/api/weekly`（ボード slug でグループ化）の差
