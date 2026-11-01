# #25 projectsPayload が自 cwd のボードしか数えない — 修正計画

## 根因
`extensions/kanban.ts` の `projectsPayload()`（GET /api/projects）が、カードの供給を `projectSlugs()` 経由で**自 cwd のプロジェクトボード 1 枚だけ**から作っていた。

```ts
function projectSlugs(): string[] {
	return [projectSlugOf(process.cwd())];
}
```

同じデータを出す他の経路は既に全ボードを読んでいる:

| 経路 | 供給 |
|---|---|
| `aggregateGlobal()`（/api/dashboard, /api/kanban?scope=global, /api/db/*） | `kanbanDb().listProjectBoards()` |
| `/api/weekly` | `db.listProjectBoards()` |
| `dbInfo().boards` | `store.projectKeys().length` |
| **`/api/projects`** | **`projectSlugOf(process.cwd())` の 1 枚だけ** |

よってプロジェクトタブだけ他リポのカードが欠け、`declared`（`db.listProjects()` は全件）は出るのに件数が 0 に見える、という不整合になっていた。

## 方針
供給を `kanbanDb().listProjectBoards()` に差し替え、`aggregateGlobal()` / weekly と同一にする。デッドコードになった `projectSlugs()` は削除する。

GLOBAL_JSON の残骸（pre-migration 行）はそのまま足す。理由: `aggregateGlobal()` も同じように足しており、`/api/projects` だけ落とすと今度はそちらが欠ける。

## 変更
1. `extensions/kanban.ts` `projectsPayload()` — 供給を `kanbanDb().listProjectBoards().flatMap(...)` に
2. `extensions/kanban.ts` — `projectSlugs()` 削除（参照は `projectsPayload` の 1 箇所だけだった）
3. `extensions/kanban.ts` `dbInfo()` — stale コメント修正
4. `tests/kanban-projects.test.mjs` — 実装を写経していた `ROLLED()` ヘルパを削除し、`/api/projects` の実 payload を見る
5. `tests/kanban-projects.test.mjs` — #25 の回帰テスト追加

## テスト
`other-repo` ボードを `seedBoard` で seed し、`/api/projects` に `other-proj` が出ること、`total`/`done`/`points.done` が正しいこと、かつ自 cwd の `kb-core` が消えていないことを固定する。

旧実装（自 cwd 1 枚）に戻すと `他リポのボードのプロジェクトが一覧に出ない` で赤になることをミューテーションで実測する。

## 検証
- `node tests/kanban-projects.test.mjs` → 16 passed / 0 failed
- `npm test` → 194 tests / 194 pass / 0 fail
- ミューテーション実測済み（上記）

## スコープ外
- `/api/weekly` は GLOBAL_JSON の残骸を含まない（`aggregateGlobal()` と `/api/projects` は含む）。pre-migration 行が残っている間だけ差が出る
- 他リポのボードを**編集**する経路は無い（この process の cwd ボードにしか書けない）。今回の変更は読み取りの集約だけで、`#27` / `#28` とは独立