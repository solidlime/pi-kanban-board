# フェーズ0 実装メモ（cwd スコープ化）

方針は [phase0-cwd-scope.md](phase0-cwd-scope.md)。ここには **実コードの構造に合わせた決定** だけを書く。

## 決定

- **D1 擬似パス**: project ボードのパスは `<KANBAN_DIR>/projects/<slug>.json`。実体は sqlite の行（`board.scope='project', sid=slug`）。
  `boardPath` と `boardKeyOf` を対で拡張する。**この対称性を崩さない**（boardKeyOf がパスから scope を逆算する唯一の場所）。
- **D2 slug**: `git -C <cwd> rev-parse --show-toplevel` → 失敗なら cwd そのもの → basename → `normalizeProject`（`[a-z0-9._-]`, 24字）。
  cwd→slug は Map でキャッシュ（`git` を毎回 fork しない）。
  正規化後に別パスが同じ slug に来たら既存へ寄せて 1 行警告。`shortcut:` コメントを添える（衝突検出はフェーズ2の project テーブル）。
- **D3 cwd の出所**:
  - ツール: `ctx.sessionManager.getCwd()`（`ReadonlySessionManager` に `getCwd` がある）
  - HTTP: `sid` クエリ → `sessionInfoById().get(sid)?.cwd` → `activeSessionId` の cwd → `process.cwd()`
- **D4 board key と actor の分離**: project ボードでは sid の代わりに **slug** がボードキーになる。下流関数は sid を「ボードキー」として受け取っているので、**境界で差し替える**（シグネチャは変えない）。
  - ツール execute 冒頭: `const sessionSid = sidOf(ctx);` / `const sid = scope === "project" ? projectSlugOf(cwdOf(ctx)) : sessionSid;`
  - `movedBy` と `nextTodo` のフィルタは **`sessionSid`** を渡す（actor はセッションのまま）。
- **D5 global は読み取り専用**: `writeBoardPath` の戻りを `{ ok: true; path } | { ok: false; error }` に変え、`/api/add` 系のゲートと `handleUpload` の 2 箇所で 400 `{ok:false, error:"global board is read-only"}`。
- **D6 既定**: ツール `scope` の既定と `parseScope` の未知値は `"project"`。
- **D7 移行**: `meta.scope_migrated` で 1 回だけ。`db.ts` に `getMeta(k)` / `setMeta(k, v)` を足す（`meta` テーブルは今 死んでいる）。
- **D8 変更しないもの**: `sweepSessions` / `sessionKeys` / `sweep` の `scope='session'` リテラルはそのまま（session ボードの掃除という意味で正しい）。`boardPath("session", ...)` の直書きも内部機構（ループ・掃除・injection）なのでそのまま。

## 触る関数（依存順）

1. `extensions/kanban.ts:76` `type Scope`
2. `extensions/db.ts:44` `export type BoardKey`
3. `extensions/kanban.ts:222` 付近 `PROJECTS_DIR`
4. `extensions/kanban.ts:318` `boardPath` / `:370` `boardKeyOf`
5. `extensions/kanban.ts:324` `parseScope`
6. 新規 `projectSlugOf(cwd: string): string` / `cwdOfSid(sid: string | null): string`（`boardPath` の近く）
7. `extensions/kanban.ts:3349` `writeBoardPath` + `:3883` ゲート + `:3391` `handleUpload`
8. `extensions/kanban.ts:5214` ツール既定 + `sessionSid`/`sid` 分離
9. `extensions/kanban.ts:3736` `/api/kanban`（project 面を返す）
10. `extensions/kanban.ts:3276` `dashboardPayload`（`project` キーを足す）
11. `web/dashboard.html` の scope 選択（project を既定に）
12. `extensions/db.ts` `getMeta`/`setMeta` + 新規 `migrateScopeOnce()`

## テスト

- 新規 `tests/kanban-project-scope.test.mjs`: 同一 cwd の 2 セッションが同じボードを見る / global への書き込みが 400 / slug が git ルートから出る / 移行が冪等。
- 既存 27 ファイル・194 箇所は `scope=session` を明示しているので既定値変更では壊れない見込み。壊れたものだけ直す。
- **反証**: global の 400 を消すと新規テストが赤くなることを確認する。

## やらないこと

- ダッシュボードの大規模な作り直し（project タブの追加まで）
- slug 衝突のハッシュ化（フェーズ2）
- `/api/resume` の scope 無視（既存の drive-by。今回触らない）
