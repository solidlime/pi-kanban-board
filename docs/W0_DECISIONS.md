# W0 決定事項（W1投入の前提）

## 周辺機能スコープ
- **Phase 0 (縦スライス)**: projects/cards/columns の CRUD・move、認証付きダッシュボード、世代メタ、`kanban` tool (list/add/move/remove/check/url) と `/kanban` (help/url/add/move/remove/take/resume 基本) の最小。timeline基盤を状態変更と同一txで記録。
- **除外/後続フェーズ**: `/serve` 配信と inbox、`/api/ehr`・`/api/quiz`、`/api/host`、広域 `/api/ref`（任意FS参照）、添付の高度機能、deliverable の完全機能、保存ビュー/検索拡張、通知、ループ高度制御の一部。除外APIは 501/未実装応答または未登録とし、例外的な無認可write面は作らない。
- `deliverable` tool は Phase 0 では最小スタブ互換（list空/add最小 or 明示未対応）を許容し、Phase 2 で本実装。

## UI 技術選定
- **素のDOM + TypeScriptモジュール**を `web/src/` に分離し、単純バンドルで `web/dist/app.js`(＋css) を生成。生成物は配信資産に埋め込み/参照し build hash を付与。
- 理由: キー付き差分描画を自前で明示制御（sig全面再利用の再発防止）、依存最小、E2E容易、既存「1 HTML 生成物」配布と整合。
- 状態は正規化ストア（entity map + view/selection state）。描画はキー=複合ID、visible集合は現在ビューのみ。

## ツール/コマンド互換粒度
- ツール名・登録順序・主要action名・`scope: project|global`・`details {scope,cards,nextId}` / `details {scope,deliverables}` を維持。
- パラメータは現行互換を優先: `text,id,col,nextFireAt,blocked,project,session,commit,labels,image` 等。**`project` は複合解決に必須（global集約要素は出自projectを保持）**。id単独指定は project 文脈が一意な場合のみ許容し、曖昧/不一致は明示エラー（先頭一致禁止）。
- `/kanban`: help, url, add, list/take, move, remove, check, resume, loop/pick/interval 系は維持。未実装サブコマンドは明示メッセージで失敗。

## API 確定（Phase 0 実装対象）
- GET `/?token=`→303 cookie, `/` dashboard, `/api/meta`, `/api/selftest`, `/api/projects`, `/api/board?project=`
- POST `/api/projects`, POST `/api/cards`, PATCH `/api/cards/:project/:id`, DELETE `/api/cards/:project/:id`, POST `/api/cards/:project/:id/move`
- 応答 envelope `{ok,data}|{ok:false,error:{code,message,details?}}`。変更系は `version` を返す/受ける。

## 初期化
- `~/.pi/kanban` の v2 初期化は **明示実行 + 事前パス提示 + ユーザー最終確認** が必須。backup を既定（`~/.pi/kanban.v1.bak-<ts>`）。
- 自動無確認破壊なし。未初期化検知時は「initが必要」と案内し停止。

## 完了の定義
- Phase 0〜4 の機能マップを実装し、typecheck/test/build が通り、縦スライスが動作すること。並列人形で進め、各ウェーブで統合・検証する。
