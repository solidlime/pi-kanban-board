# pi-kanban-board v2 再実装計画（Phase 0: IF凍結・タスク分解）

- 状態: **設計承認済み（m11504「進めていいよ」）**。本書は Phase 0 着手の具体化。
- 方針（確定）: 同一リポジトリ/パッケージ名 `pi-kanban-board` を維持して内部を再実装で置換。**コードも `~/.pi/kanban` データも破棄前提（移行/互換読込なし）**。土台先行。人形並列可。
- 現行HEAD参照: ab835bf（探索は現行コードの事実把握用。内部実装は引き継がない）。

## 1. 凍結IF（Phase 0 で固定し、後続フェーズが依存する契約）

### 1.1 パッケージ / ロード（互換維持・必須）
- `package.json`: `name: "pi-kanban-board"`, `type:"module"`, `pi.extensions: ["./extensions/kanban.ts"]` を維持（pi が拡張を発見する口）。
- 配布物: `extensions/` 配下のエントリ＋必要生成物＋README/LICENSE。ビルド成果物を配布に含める方針は現行踏襲（`prepack` で生成）。
- Node: 現行同様 Node 22.5+（`node:sqlite` 利用）。

### 1.2 pi 連携（互換を優先して再定義する境界）
- **ツール名は維持**: `kanban`, `deliverable`。登録順序依存があるため順序も維持（schema取り出し互換）。
- **/kanban コマンドは維持**（help/take/url/resume/add/loop/pick/interval/priority/img/stuck/maxloops 等の主要操作）。引数解釈の細部は再定義可だが、既存の利用感（ボード操作・URL・ループ制御）を壊さない。
- **イベント**: `turn_start`, `agent_before_settle`(continue連鎖), `session_start`, `session_tree`, `session_shutdown`, `before_agent_start`(request-only trailing message, system prompt非改変) を維持。カスタム型 `kanban-board` / `kanban-loop` / `kanban-loop-continue` と `LoopState` 永続形は v2 スキーマに合わせて再定義（旧エントリは無視/読めなくてよい＝データ破棄前提）。
- **自律ループ契約**: projectボードのみ駆動、globalは読取専用集約（駆動しない）。halt理由(limit/stuck)・resume/halt要求の跨ぎ・activity/tick判定の意味論は維持しつつ実装整理。`AUTO_TICK_MS` 等の既定値は定数として明示。
- **ウィジェット/注入**: footer widget key `kanban`、注入はボード非空時のみ・display:false・system prompt不変。

### 1.3 ツールI/O（v2で確定する最小契約）
- `kanban` action: `list|add|move|remove|check|resume|url|edit|img|ref`（現行集合を基準に維持）。`scope` は `project|global`（global書込は拒否）。`details` は少なくとも `{scope, cards, nextId}` 相当を返す。パラメータ名は現行互換を優先（text/id/col/nextFireAt/blocked/project/session/commit/labels/image）。
- `deliverable` action: `add|list|edit|remove|img|ref`、`details: {scope, deliverables}`。
- **ID表現の変更（重要・破壊的だが採用）**: 内部は複合ID `(projectId, entityId)` 第一級。ツール/HTTPでは `project`(slug) + `id` を常に要求/返却する形に正規化し、id単独解決・先頭一致を廃止。global集約の要素も出自projectを必ず持つ。

### 1.4 ストレージ / 実行時パス（v2で再定義・初期化対象）
- ルート: `~/.pi/kanban/`（維持）。**初回起動(v2)で v1データを破棄し新レイアウトで初期化**する。
- 想定レイアウト: `state.sqlite`（単一DB, WAL）/ `modes.json` or DB内設定 / `token`(0600) / `server.log` / `media/`(+`.trash/`) / `serve-allow.json`(任意)。
- 旧 `boards.sqlite`, `global.json`(擬似), `projects/`(擬似), `board.json`, `serve.json`, `inbox-seen.json`, `dashboard.html` ミラー等は **v2初期化で削除/退避対象**。

### 1.5 HTTP / サーバ（再定義）
- ポート既定 8789 / `KANBAN_PORT`、bind `0.0.0.0`、Host許可＋トークン(HttpOnly cookie, `/?token=`→303+Set-Cookie)＋Origin/Fetch-Metadata保護は維持。
- **メソッド規律**: 読取=GET、変更=POST/PATCH/DELETE（現行のGET書込を廃止）。UI/ツール双方を新APIに合わせる。
- **世代**: build hash + version を `/api/meta` で返し、サーバ再利用判定は「世代一致」に基づく。UIは不一致を表示。
- `/api/selftest` は存続（identity/health）。`scope=session` 相当は存在しない。

### 1.6 UI ビルド/配信
- ソースは `web/` 配下に分離。生成物はビルドで作り、配信は世代付き。`--check`/pretest/prepack の規律は維持。

## 2. データモデル（v2 SQLite 案・凍結候補）

- `project(project_id TEXT PK, slug TEXT UNIQUE, name TEXT, settings_json TEXT, created_at, updated_at)`
- `column_def(project_id, id, name, kind(todo/doing/done/custom), ord, wip_limit NULL, PRIMARY KEY(project_id,id))`
- `card(project_id, id, column_id, title, body, priority INT, owner TEXT NULL, due DATE NULL, estimate REAL NULL, blocked_reason TEXT NULL, labels_json TEXT, session_id TEXT NULL, commit_sha TEXT NULL, created_at, updated_at, moved_at, closed_at NULL, version INT, PRIMARY KEY(project_id,id))`
- `dependency(project_id, from_card, to_card, type, PRIMARY KEY(project_id,from_card,to_card,type))`（循環禁止はdomain）
- `deliverable(project_id, id, card_id NULL, title, ref TEXT, kind, meta_json, created_at, updated_at, PRIMARY KEY(project_id,id))`
- `attachment(project_id, id, card_id NULL, deliverable_id NULL, storage_key, safe_name, mime, size, created_at, PRIMARY KEY(project_id,id))`
- `timeline_event(project_id, seq INTEGER PK AUTOINCREMENT, entity_type, entity_id, kind, actor, payload_json, at)`（append-only）
- `saved_view(project_id, id, name, query_json, PRIMARY KEY(project_id,id))`
- `kv_meta(k PK, v)`（schema version, generation 等）
- インデックス: (project_id,column_id), (project_id,updated_at), timeline(project_id,seq)。全FK整合。ID採番はproject内シーケンスをトランザクションで。

## 3. API 契約案（Phase 0 で固定）

- 認証: `GET /?token=<t>`→303 cookie。全 `/api/*`(書込含む)・保護対象に適用。例外パスを作らない。
- メタ/読取(GET): `/api/meta`, `/api/projects`, `/api/board?project=`, `/api/cards?project=`, `/api/timeline?project=`, `/api/search?q=&project=`, `/api/views?project=`, `/api/media/:key`, `/api/ref?project=&id=`(厳格化)。
- 変更(POST/PATCH/DELETE):
  - `POST /api/projects`, `POST /api/cards`, `PATCH /api/cards/:project/:id`, `DELETE /api/cards/:project/:id`
  - `POST /api/cards/:project/:id/move`
  - dependencies/deliverables/attachments/views も複合ID
  - ループ/モード: `POST /api/modes`, `POST /api/loop/resume`, `POST /api/loop/halt`
- 応答: `{ok,data}` / `{ok:false,error:{code,message}}`。変更系は更新後エンティティ+`version`を返す。楽観ロック用 `version` を受け付ける。

## 4. ~/.pi/kanban 初期化手順（破壊的・着手前最終確認を要する）

- 対象: `~/.pi/kanban` ディレクトリ全体の v1 内容（boards.sqlite, global.json, projects/, board.json, modes.json, serve.json, inbox-seen.json, dashboard.html, media/, serve-allow.json, token, server.log 等）。
- 手順案（実装時）:
  1. サーバ停止状態を確認。
  2. `~/.pi/kanban` を `~/.pi/kanban.v1.bak-<timestamp>` に退避 **または** 中身を削除して再作成（「コードもデータも捨てる」合意済み。退避は復旧用で移行ではない。**実行直前にユーザーへ対象パスを明示して最終確認を取る**）。
  3. v2 が `state.sqlite` を新規作成・migration適用・token生成(0600)/dir(0700)・media/.trash作成。
- Phase 0 実装では「初期化を行う明示コマンド/関数」と安全ガードを用意し、自動無確認破壊は避ける。

## 5. リポジトリ再編（目標構造）

- `extensions/kanban.ts` → 薄いエントリ（登録と配線のみ）
- `src/core/` domain（型・遷移・検証・依存/WIP/完了条件・イベント）
- `src/persistence/` sqlite, migrations, repos
- `src/api/` server, routes, auth, schema, generation
- `src/agent/` tools, commands, loop, injection
- `src/shared/` ids, dto, errors, constants
- `web/` ui source + build
- `scripts/` build/check
- `tests/unit|integration|e2e|contract/`
- 旧モノリス・旧生成物・旧テストは置換対象（段階的に削除/差し替え）。

## 6. Phase 0 縦スライス（完了条件）

「1本通る」を DoD とする最小機能:
- v2 DB初期化→project作成→card add/list/move/remove が **domain↔persistence↔api↔ui↔agent-adapter** で一貫。
- 認証付きHTTP（GET読取/POST・PATCH・DELETE）・世代メタ。
- UI: 単一プロジェクト盤面の表示・追加・移動・削除（複合ID、ビュー限定選択の土台）。
- `kanban` tool の list/add/move/remove + `/kanban url|add` の最小動作。
- typecheck + unit/契約テスト + build --check が通る。

## 7. 並列投入ウェーブ（人形）

- **W0 (直列/統合, 私)**: 本計画確定・共有IF(型/ID/イベント/API DTO/エラー)の雛形コミット・`src/shared` と境界骨格・初期化の安全仕様。
- **W1 (並列)**: #A `core/domain`（エンティティ/遷移/検証/イベント, unit） ∥ #B `persistence`（schema/migration/repo/tx/init, 結合） ※共有IF凍結後。
- **W2 (並列)**: #C `api`（auth/routes/validation/meta/generation, 契約テスト） ∥ #D `ui-shell`（store/描画基盤/キー差分/選択, モック可）。
- **W3 (並列)**: #E `ui-features`（盤面操作・横断の土台） ∥ #F `agent-adapter`（tool/command/loop） ∥ #G `test/qa`（E2E/契約横断/境界）。
- 各ウェーブ終端で統合・typecheck/test・ルアン・メェイレビュー（認可, 複合ID解決, 初期化破壊, 添付境界）。

## 8. 現行から持ち込む知見（不具合の再発防止）

- 複合ID解決のみ（先頭一致禁止）。visible/選択は現在ビューに限定。state-changing GET禁止。全write pathに同一認可/Origin検査。build hashを再利用判定・UI表示に含める。`indexOf`文字列固定だけに依存しないUI検証（E2E）。timelineを状態変更と同一トランザクションで記録。

## 9. 未確定（W0で決める）

- 周辺機能 `/serve`, `/api/ehr|quiz`, `/api/ref`(広域), `/api/host`, inbox の v2 扱い（Phase 0 は中核集中、周辺は除外/スタブ可）。
- ツールのパラメータ細部・コマンド全サブコマンドの互換粒度。
- UI技術選定（素DOM継続か軽量フレームワークか）— キー差分・E2E容易性・ビルド複雑性で判断。

## 10. W0 タスク（直列・着手順）

1. **共有IF凍結（コード）**: `src/shared/` に ids(複合ID型/parse/format), dto(card/project/board/column), events, api envelope/error, constants を定義。
2. **リポジトリ骨格**: `src/core|persistence|api|agent|web|scripts` のディレクトリと index/境界ファイル、`tsconfig`/build/test 設定の v2 用意（旧と並走→切替方針を明記）。
3. **初期化安全仕様**: `~/.pi/kanban` 対象パス列挙・退避先命名・明示フラグ/関数・dry-run出力を実装（自動無確認破壊なし）。**実行前にユーザーへ最終確認**。
4. **縦スライス配線**: 薄い `extensions/kanban.ts` から新モジュールへ接続できる最小エントリと、W1へ渡すIFドキュメント/型を確定。
5. **検証基盤**: typecheck/lint/test/build のスクリプト土台と、契約テストの置き場を用意。
