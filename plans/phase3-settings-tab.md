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

## #12 配信サーバータブを設定に吸収（完了）
- 「配信サーバー」タブを廃止し、設定ペインの 1 セクションにする（`#serve` の入れ物はそのまま `#pane-settings` 内へ移す＝`renderServe()` は無変更）。
- `TABS` は `["sessions", "projects", "settings"]` の 3 つ。`#tab-serve` / `#pane-serve` は削除。
- 並び順: ボードのループ → 保存データ → 配信サーバー → 自己診断（インフラ系を後ろに寄せる）。
- テストのスライス境界が `id="pane-serve"` を marker にしているので `id="pane-settings"` に付け替える（tabs / cards / collapse-search / projects）。
- `isEditing()` の `#serve` は残る（入力欄は同じ id のまま設定ペイン内にある）。

## #13 DB メンテ操作（VACUUM・件数・診断）（完了: 4ce8959, a207ff7）
設定タブの「保存データ」に、今ある件数表示へ **診断** と **VACUUM** の 2 操作を足す。

### API（POST のみ。既存 /api/selftest と同じ流儀で、prefetch では叩けない）
- `POST /api/db/diagnose` → `{ok, integrity, pages, freelist, pageSize, bytes, boards, cards, projects, decisions}`。
  `integrity === "ok"` なら 200、それ以外は 503（/api/selftest と同じ扱い）。
- `POST /api/db/vacuum` → `{ok, before, after, saved, ...dbInfo}`。失敗は 500 `{ok:false, error}`。
- 書き込み系パス判定（`extensions/kanban.ts:1652` 付近の `if (pathname === "/api/upload" || pathname === "/api/selftest") return true;`）に 2 パスを追加する。忘れると CSRF/Origin ゲートを素通りする。

### db.ts
- `KanbanDb` に `maintenance()` と `vacuum()` を足す。`PRAGMA integrity_check / page_count / freelist_count / page_size` を 1 行ずつ読み、`VACUUM` は try/catch で失敗を投げ返す（握り潰さない）。
- pragma が取れない環境では `integrity: "unavailable"` を返して落ちない（node:sqlite は experimental）。

### UI（`web/dashboard.html` の `#settings-db`）
- 既存の行（サイズ・件数）はそのまま。下に `DB 診断` / `VACUUM` の 2 ボタンと結果行（`aria-live="polite"`）を足す。
- **`selfTestBusy` と同じモジュールスコープのフラグで連打と二重 POST を防ぐ**（`btn()` の flightGate は DOM ノードに閉じるので 5 秒ポーリングの再描画で無効化される）。押した瞬間に `renderDb()` を呼んで、押したノードごと無効な新品に置き換える。
- 診断成功の表示: `整合性 ok / ページ 24 / 空き 0 / 4.0 KB`。VACUUM 成功: `4.0 KB → 3.5 KB（-12%）`。
- 応答に `db` が入っているので、成功後は `reload()` で件数とサイズを取り直す（自前で再計算しない）。

### テスト
- `tests/db.test.mjs`: `maintenance()` が integrity ok / pages > 0、`vacuum()` 後もカードが読めて integrity ok。
- `tests/kanban-db-maint-http.test.mjs`（新規、既存の HTTP テストの雛形に倣う）: GET は 405 / token なしは 401 / diagnose は 200 で `integrity:"ok"`・`pages>0` / vacuum は 200 で `after <= before` かつカードが残る。
- `tests/kanban-dashboard-settings.test.mjs`: ボタン存在、診断クリックで `POST /api/db/diagnose` が 1 回だけ、連打しても 1 回、VACUUM クリックで `/api/db/vacuum` が 1 回、結果行に文言が出る。
- `tests/kanban-dashboard-projects.test.mjs:147` の `fetch(` 本数 assertion が増えるので追随する。

## #14 pi の実行状態を外部から読む口（調査・完了）

結論だけここに残す。詳細と実測ログは [issue-14-external-state.md](issue-14-external-state.md)。

- **公式に保証された口**: `~/.pi/agent/sessions/--<cwd>--/<ts>_<sid>.jsonl` の走査 + JSONL パース（`docs/session-format.md:11-14`）。読めるのは id / cwd / model(`model_change`) / thinkingLevel / 全メッセージ / `usage`（トークン + コスト）。
- **実行中かどうかは docs に存在しない**（lock / heartbeat / status は 0 件）。代わりに **pi-intercom の broker が生きた状態を持つ**: named pipe へ 4 バイト長プレフィックス + JSON で繋ぎ、`register` → `list` で `status`（`tool:codemode` 等）/ `contextPct` / `pid` / `lastActivity` が取れる（実測成功）。ただし register は `session_joined` を撒くので、使うなら常駐 1 接続で。
- **RPC `get_state` と `--mode json` は使えない**: どちらも自分が起動した子プロセス限定で、既存セッションへの attach は無い（`docs/rpc.md:7-10`）。
- セッション追記は `appendFileSync` 単発・fsync 無し（`dist/core/session-manager.js:812`）。**読む側は末尾の不完全行を捨てる**。
- 実装するなら: モデル名とコストはファイル読み、実行状態と contextPct だけ broker（無ければ列ごと非表示、`pi-intercom` は任意依存）。mtime で「動いていそう」を推測するのはやめる。
