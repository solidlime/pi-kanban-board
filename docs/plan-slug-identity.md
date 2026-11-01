# 計画: slug の同一性と cwd 解決（#34 / #35）

環境で観測した事実（2026-11-01, pi-web PID 17020, 起動 21:48）:

- `GET /api/kanban` → `{"projectId":"pi-web"}`。DB には `pi-kanban-board` / `kk_dualbox` /
  `assetscraping` の 3 ボードがあるのに、どれも引けない
- `GET /api/kanban?sid=<セッションID>` → `{"projectId":"assetscraping"}`。セッション ID なら解決する
- `GET /api/kanban?sid=assetscraping`（slug を渡す）→ `{"projectId":"pi-web"}`。**sid は slug ではない**
- `GET /api/projects` → `{"projects":[],"decisions":[]}`
- 画面は「このプロジェクト（—）」でカード 0 枚

## 原因

### #34 — 大文字小文字を潰している
`extensions/kanban.ts:699` `normalizeProject()`:
```ts
return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, PROJECT_MAX);
```
`toLowerCase()` で大文字が消え、さらに `[a-z]` が大文字を除去する。
`Pi-Kanban-Board` → `pi-kanban-board`。ディレクトリ名が継承されない。

**照合は大小無視にする必要がある**: Windows の FS は大小を区別しないので、
`C:\Code\Pi-Kanban-Board` と `c:\code\pi-kanban-board` は同じディレクトリ。
slug を保存時に大文字のまま残すと、同じディレクトリが 2 つのボードに分かれる。

### #35 — cwd 解決が process.cwd() に落ちる
`extensions/kanban.ts:402`:
```ts
function cwdOfSidSync(sid: string | null): string {
	const id = sid === null || sid === "" ? activeSessionId : sid;
	const cwd = id === null || id === "" ? undefined : sessionInfoCache?.byId.get(id)?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}
```
`extensions/kanban.ts:4065`:
```ts
const projectSid = projectSlugOf(cwdOfSidSync(sid));
```
`sessionInfoCache` は `sessionInfoById()`（`:3253`）だけが埋める。`:3503`（`dashboardPayload`）
が `await sessionInfoById()` するが、`/api/kanban` はそれを呼ばない。冷えていると
`process.cwd()` = pi-web のインストール先になり、`projectSlugOf` が `pi-web` を返す。
存在しないボードなので空 → 画面は global 集計しか出せない。

## Slice 1（#34）— normalizeProject を大小保持 + 照合を NOCASE に

1. `extensions/kanban.ts:699` `normalizeProject()`:
   - `.toLowerCase()` を削除
   - `/[^a-z0-9._-]/g` → `/[^A-Za-z0-9._-]/g`
2. `extensions/db.ts` の `board.sid` 照合を大小無視にする。対象は `sid` を条件にする全 SQL:
   - `readBoard` / `writeBoard` / `listProjectBoards` / `touchBoard` / 削除系
   - `WHERE sid = ?` → `WHERE sid = ? COLLATE NOCASE`
   - `ORDER BY sid` は表示順なのでそのままでよい
3. 新規ボード作成時は**受け取った slug の表記をそのまま** `sid` に保存する（照合だけ無視）
4. 既存 3 ボード（すべて小文字）は無変更で動く

#### 受け入れ条件
- `normalizeProject("Pi-Kanban-Board")` === `"Pi-Kanban-Board"`
- `normalizeProject("My Project!")` === `"MyProject"` / `normalizeProject(42)` === `""`
- 任意の slug で `writeBoard` → 小文字化した slug で `readBoard` が同じ内容を返す
- `listProjectBoards()` に同じディレクトリの大小違いが 2 件出ない
- 既存 `npm test` が全 pass（`tests/kanban-projects.test.mjs` など slug 期待値の追随が必要）

**やらないこと**: 既存ボードの名前変更、slug の自動正規化マイグレーション

## Slice 2（#35）— ボードを slug で直接指定できるようにする

`process.cwd()` フォールバックは**残す**（予測不能なボードを勝手に選ぶ方が危険）。
代わりに、UI がボードを明示する経路を足す。

1. `extensions/kanban.ts:4065` `/api/kanban` に `?p=<slug>` を受け付ける:
   ```ts
   const pRaw = q.get("p");
   const projectSid = pRaw === null || pRaw === ""
   	? projectSlugOf(cwdOfSidSync(sid))
   	: normalizeProject(pRaw);
   ```
   空文字になった場合は 400（`p` を送ったのに不正、を黙って cwd に落とさない）
2. `web/dashboard.html`:「プロジェクト」タブで選んだ slug を保持し、ボード取得を
   `/api/kanban?p=<slug>` にする。選択なしのときは従来どおり（`p` 無し）
3. `renderProject(p)` の slug 解決を、選択中の slug 優先にする

#### 受け入れ条件
- `GET /api/kanban?p=pi-kanban-board` が 33 枚のボードを返す（cwd と無関係に）
- `GET /api/kanban?p=Pi-Kanban-Board` も同じ 33 枚を返す（NOCASE 照合）
- `GET /api/kanban?p=!!` は 400
- 画面でプロジェクトを選ぶと、そのボードが表示される

## テスト

- `tests/kanban-slug-case.test.mjs`（新規）: normalizeProject の大小保持 / NOCASE 往復 /
  `?p=` の 200・400
- 既存の slug 期待値テストを追随（`grep -rn 'toLowerCase\|pi-kanban-board' tests/` で洗う）

## 未検証・リスク

- `sessionInfoById()`（`:3253`）がなぜ `01a18ffb` を解決できないのかは未確定。
  `sessionInfoCache` の中身を外から観測する手段が無いため、Slice 2 は「キャッシュに頼らない経路を足す」
  という回避で進める。**根本原因（キャッシュが温まらない理由）は別カードで追う**
- `/api/projects` が空（`project` テーブルが 0 行）なのは #33 の設計変更（declared 廃止）と整合する。
  Slice 2 のプロジェクト一覧は `listProjectBoards()` を供給元にする（既存計画 `docs/plan-projects-tab.md` Slice 1 と同じ）
