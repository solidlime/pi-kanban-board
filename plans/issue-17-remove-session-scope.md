# #17 session スコープ撤廃 → project 一本化

状態: 実装中
正典: 2026-11 のユーザー決定（session 概念の完全撤廃 / 既存ボードは破棄してよい / 再起動許可済み）

## 目的

`board` の名前空間から `session` を消す。ボードは `project`（slug）と `global`（読み取り専用集約）の 2 つだけ。
pi のセッション ID は「実行時の actor」としてだけ残す — ボードキー・URL・modes バケットには載せない。

## 決定

| # | 主題 | 決定 |
|---|---|---|
| 1 | `Scope` | `type Scope = "project" \| "global"`。`sid` はボードキー（project=slug, global=`""`）。列名は据え置き。 |
| 2 | セッション ID | 捨てない。`movedBy`/`stampMove`/`tagKey`/`haltedBySid`/ループの actor として残す。ボードキーには使わない。 |
| 3 | `/kanban` ドリルダウン | 自 cwd の slug に固定。トグルは `project ↔ global`。slug 選択 UI は作らない。 |
| 4 | `kanban` ツール | `scope` は残す。`Union(project, global)`、既定 project。global 書き込みガードは維持。 |
| 5 | `/api/kanban` | `sessions`/`sessionId`/`/api/sessions` を削除。`{ok, projectId, project, global, modes:{global, project}}` に。 |
| 6 | `modes.json` | `SESSION` バケット削除。後方互換は作らない（リセットで既定値に書き直す）。 |
| 7 | sweep 系 | `sweepSessions`/`SESSION_TTL_MS`/`SESSIONS_DIR`/`sessionKeys()`/`ensureSessionBoard()`/`importBoards` を全削除。 |
| 8 | 移行 | `migrateScopeOnce` を `resetScopesOnce` に置換。project 以外の行を DELETE し `meta.scopes_reset="2"`。新キーにする（旧 `scope_migrated` を流用しない）。 |
| 9 | スキーマ | CHECK 制約は付けない（型 + コメントで守る）。drift 修復の `if (version < 1)` ゲートを外し、guarded ALTER を毎回走らせる。 |
| 10 | テスト | 30 ファイル / 189 箇所。削除・書換・無変更の 3 バケットに分ける。機械置換しない。 |
| 11 | コミット | C1 型 → C2 DB → C3 移行 → C4 サーバ → C5 ツール/コマンド → C6 UI → C7 テスト → C8 文書。各段で `npm test` 緑。 |

## 危険箇所

- **DOING が再起動で静かに止まる**: project は `headOwnedDoing`（`movedBy === sid`）で絞る。再起動で `movedBy` が死んだセッション ID のまま残ると誰も駆動しない。→ `/kanban take` で対象ボードの DOING の `movedBy` を自 sid に貼り替える。
- **旧 `scope=session` URL が project に化ける**: 旧タブの `/api/kanban?scope=session&sid=X` が project に書く。`parseScope` は 400 ではなく project に倒す方針だが、`/api/kanban` では既知の session ID 形式を 400 で弾く。
- **`modes` のキー取り違え**: `tagKey`/`loopCountOf` の key が `sessionId` → `slug`/`""` に変わる。ずれると settings が全部 OFF → ループが止まる。キー一致の単体テストを C1 に置く。
- **`resetScopesOnce` の順序**: バックアップ → DELETE → meta。逆にしない。冪等。
- **settle 前に seed すると消える**: テストの seed は `settleMigration()` の後。

## 検証

- 旧スキーマ（`due`/`estimate` 無し、`project`/`card_dep`/`decision` 無し、`user_version=0`）の DB を作り、`openKanbanDb` 後に全列・全テーブルが在ること。
- `resetScopesOnce` が session/global 行を消し、project 行を残し、`scope_migrated="1"` でも走ること。
- `npm test` 全緑 + `npm run build` 済み（`pretest` の `build-web --check` が stale で落ちるため）。
