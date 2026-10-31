# フェーズ2: プロジェクト管理

ボードは「今やること」、プロジェクトは「どこへ向かうか」。`card.project` の slug は既にあるので、
それを一級市民にする。フェーズ2のうち **2-1 はデータ層だけ**（#6）。

## 2-1 テーブル（`extensions/db.ts`）— このカードの範囲

### 型
```ts
export type Project = {
	slug: string;   // card.project と同じ名前空間（project:<slug> タグとも同値）
	name: string;
	createdAt: number;
	updatedAt: number;
};

export type Decision = {
	id: number;
	slug: string;   // "" はプロジェクト横断の決定
	at: number;
	text: string;
	why?: string;   // 「なぜそう決めたか」。これが無いと決定ログはただの日記になる
};
```

### テーブル
```sql
CREATE TABLE IF NOT EXISTS project (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL, at INTEGER NOT NULL,
  text TEXT NOT NULL, why TEXT
);
CREATE INDEX IF NOT EXISTS decision_by_slug ON decision (slug, at DESC);
```

### migration
既存の `user_version` ガードは `ALTER TABLE` のためだけにある。新テーブルは `SCHEMA` の
`CREATE TABLE IF NOT EXISTS` が毎回走るので **版番号を上げる必要はない**（上げても何も起きない）。
`user_version` は「列を足した回数」の記録として 1 のまま据え置く。

### 判断: マイルストーンとフェーズはテーブルにしない
- マイルストーン = 期限のあるカード。`project` で絞って `due` で並べれば出る。専用テーブルは二重管理になる。
- フェーズ = カードに付くラベル。表現方法（`card.phase` 列か、`phase:` タグか）は #7/#8 で決める。
  ここで空のテーブルだけ作っても、#7 の設計が変われば捨てる work になる。

### API（`KanbanDb`）
```ts
listProjects(): Project[];                                  // updated_at の新しい順
readProject(slug: string): Project | null;
writeProject(slug: string, name: string): boolean;          // upsert。false = 新規だった
deleteProject(slug: string): number;                        // 決定ログごと消す。返り値は消した決定数
listDecisions(slug?: string): Decision[];                   // 新しい順。省略で全件
addDecision(slug: string, text: string, why?: string): Decision;
deleteDecision(id: number): boolean;
```
`deleteProject` はプロジェクト本体と決定ログを**同一トランザクション**で消す（幽霊決定を残さない）。

## 2-2 API（`extensions/kanban.ts`）— #7
- `/api/projects` GET: プロジェクト一覧 + カード集計（件数・done・見積合計・期限超過）
- `/api/projects` は読み取り専用なので write-gate（#80-⑥）には入れない
- `/api/project?project=&name=`: プロジェクトの宣言・改名（`name` 省略 = slug）。カードが名乗るだけで一覧に出るので、これは名付けのためだけ
- `/api/decision?project=&text=&why=`: 決定の追記。`action=delete&id=` で削除、未知の `action` は 400。書き込みなので write-gate に入れる（POST ではなく GET + クエリ。#80-⑥）
- 進捗率は `done / 全カード` で計算（保存しない。保存すると必ずズレる）

## 2-3 UI（`web/dashboard.html`）— #8
タブ「プロジェクト」: 進捗バー / マイルストーン（期限つきカード）/ ブロッカー（`blocked` 付きカード）/ 決定ログ。

## 受け入れ条件（2-1）
- `node tests/db.test.mjs` が全通過（プロジェクトと決定の往復・削除の連鎖・v1 DB からの読める migration）
- 既存のボード読み書きに一切影響しない（`writeBoard` のシグネチャ不変）

## 受け入れ条件（2-3）とテスト対応表（#10）

| 契約 | テスト |
| --- | --- |
| 集計（件数 / done / 見積合計 / 期限超過 / 進捗率）、`/api/project` の slug 検証・改名、`/api/decision` の delete / 未知 action 400 | `tests/kanban-projects.test.mjs`（15） |
| project / decision の往復、改名で `created_at` が動かない、削除の連鎖、v1 DB からの migration | `tests/db.test.mjs`（15） |
| タブ・進捗バー・マイルストーン・ブロッカー・決定ログ・決定の削除・取り込み失敗・多重取得・編集中の描画ガード | `tests/kanban-dashboard-projects.test.mjs`（25） |
| 期限の色が看板チップとマイルストーンで一致する | `tests/kanban-dashboard-dues.test.mjs`（4） |
| write-gate に `/api/project` と `/api/decision` が入っている | `tests/kanban-security-80g.test.mjs` |

**意図的にテストしない**（挙動ではなく書式・環境の話）: `aria-label` を横断的に揃えること（意味を持つラベルだけ各テストが完全一致で固定する）、UTC 日界（別件）、実行中の時計（相対時刻は既存 ticker の担当）。5 秒ポーリングの配線（`reload()` の末尾 → `loadProjects()`）は部分文字列一致でしか固定していない。描画の入口が 1 箇所に閉じているので、ここを触る時に動的テストを足す。`/api/projects` の 500 経路は DB 例外を注入する口が無いので作らない（失敗時に表示を保つことは UI 側で担保する）。
