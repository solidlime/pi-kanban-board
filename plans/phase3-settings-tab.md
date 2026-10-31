# #11 設定タブ（modes / db / selftest の集約）

状態: 実施中（ユーザー回答 m02262 で「templates はスルー」「4つ目のタブとして追加」確定）

## なぜ
ループ設定（ループ / ピック / 間隔 / 上限 / 残り / DOING 全停止）が **セッションカードと GLOBAL ボードの各所**に描かれている（`web/dashboard.html:769` の `boardCtl` が `:1294` と `:1342` から呼ばれる）。設定は1か所に集め、ボードからは状態（halt と 再開）だけ残す。

## なに
1. **4つ目のタブ `設定`**（`TABS` に `settings` を追加、`#tab-settings` / `#pane-settings`）
2. **ボードのループ**: GLOBAL + 全セッションの `boardCtl` を設定ペインに一列で並べる（行ラベル＝ボード名）。既存の `boardCtl`/`boardCtx`/`act` をそのまま使い、書き込み API は増やさない。
3. **保存データ（sqlite）**: `/api/dashboard` の新フィールド `db`（`file` は固定名のみ＝絶対パスは出さない #80-⑦ の流儀に合わせる / `bytes` / `boards` / `cards` / `projects` / `decisions`）。
4. **自己診断**: ボタン → 既存の `POST /api/selftest`（`extensions/kanban.ts:3589`、ok=false は 503）を叩き、`ok` と失敗チェック名を表示。結果はモジュール変数に保持して再描画でも出る。
5. **セッションカード / GLOBAL から `boardCtl` を外す**（halt 表示と 再開ボタン `:1276-1285` は残す）。

やらないこと: templates（存在しない。ユーザー了承）、配信サーバーの吸収（#12）、DB メンテ操作（#13）。

## 触るファイル
- `web/dashboard.html`（タブ・ペイン・`renderSettings`・`renderDb`・selftest UI・boardCtl 呼び出しの移動）
- `extensions/kanban.ts`（`dashboardPayload()` に `db` を追加。カウントは既存 `totals` + `sessionKeys()` + `listProjects()` + `listDecisions()` + `statSync`。db.ts は触らない）
- `extensions/dashboard.generated.ts`（`npm run build`）
- `tests/kanban-dashboard-tabs.test.mjs`（4タブ化）
- `tests/kanban-dashboard-cards.test.mjs`（ctl の探索先を設定ペインへ）
- `tests/kanban-dashboard-settings.test.mjs`（新規）

## 受け入れ条件
- 設定タブに GLOBAL + N セッションの ctl 行があり、書き込みは `scope=session&sid=<そのボード>` / `scope=global&sid=<active>` を載せる
- セッションカードには ctl が無い（halt / 再開のみ）
- `db` フィールドでサイズと件数が出る
- selftest ボタンが `POST /api/selftest` を1回叩き、ok/NG を出す（多重クリックは flightGate で1回）
- `npm test` 緑、実ブラウザで表示確認
