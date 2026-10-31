# プロジェクト総合管理ボードへ

いまのボードは「1セッションのカンバン + 自動 doing ループ + ファイル配信」で、
その形は完成している。足りないのは**横断**と**時間軸**の2つだけで、どちらも
データモデルの変更1回で入る。

## いま出来ること

- セッション単位のボード（`~/.pi/kanban/sessions/<sid>.json`）と共有ボード（`global.json`）
- カード = `id` / `text` / `col`（TODO|DOING|DONE）/ `project` ラベル。1枚に1状態、履歴なし
- 自動 doing ループ（`AUTO_TICK_MS`、飢餓検出、停止理由の公開）
- 配信（`serve`）とメディア添付、1画面ダッシュボード、5秒ポーリング + ETag

## 足りないもの

| 軸 | いま | 足りないこと |
|----|------|--------------|
| 横断 | per-session が基本、共有ボードは1枚 | 全セッション・全プロジェクトを1画面で見る |
| 履歴 | 現在状態だけ | いつ誰がどこへ動かしたか |
| 関係 | 無い | A が終わるまで B は着手不可、という依存 |
| 時間 | 無い | 期限、停滞日数、見積/実績 |
| 理由 | 停止理由のみ | なぜ止まったか、次の候補はどれか |

## 機能提案（優先度順）

### P0 — 総合ボードの骨格（これだけで「総合管理」を名乗れる）

1. **Projects タブ** — プロジェクトごとに枚数 / DOING / 最終活動 / 停滞日数。行クリックで既存ボードへ降りる
2. **Timeline タブ** — 全カードの移動履歴。`move` 時にイベントを1行追記するだけで、既存 API は変えない
3. **横断検索** — いまの `#q` はセッション内。全セッション横断に広げる

### P1 — 計画の道具

4. **依存エッジ** — カードに `blockedBy: number[]`。自動ループは blocked を飛ばす（`STARVATION_FACTOR` の判定にも効く）
5. **期限と停滞** — `due` と `movedAt`。Projects タブで赤/黄
6. **見積と実績** — `estimate`、DOING に入ってから DONE までの実測

### P2 — 運用

7. **SSE** — 5秒ポーリングをやめる。`/api/events` で push。ポーリングの指数バックオフも消える
8. **ループ診断** — `/api/stuck` を広げ、停止理由・次の候補・実行履歴を1か所に
9. **日次ダイジェスト** — 「今日動いた/停滞したカード」を生成してメディアとして配信

### P3 — 拡張

10. **外部ボード同期** — GitHub Issues / Linear から1方向（読み取りのみ）
11. **グラフビュー** — 依存関係を Mermaid で出力

## 1から作るならの構成

前提は変えない: 単一プロセス、外部依存ゼロ、pi 拡張1枚。

```
~/.pi/kanban/
├── db.sqlite          node:sqlite（WAL）
├── media/
└── token

extensions/kanban.ts   pi ツール登録だけの薄い層
lib/
  db.js        スキーマとクエリ。イベント追記は add/move/remove の3箇所
  hub.js       HTTP + SSE + 静的配信。拡張とはプロセス分離
  loop.js      自動 doing ループ（タイマー、飢餓検出）
web/
  index.html   タブのシェル
  app.js       状態と差分描画
  tabs/board.js  tabs/projects.js  tabs/timeline.js  tabs/serve.js
  styles.css
```

### データモデル

```sql
cards(id PK, sid, project, text, col, created_at, moved_at, due, estimate, created_by)
events(id PK, card_id, at, kind, from_col, to_col, actor)   -- 唯一の真実
deps(card_id, blocked_by, PRIMARY KEY(card_id, blocked_by))
serve(id PK, path, title, expires_at, permanent)
sessions(sid PK, last_activity_at, loop_halted)
```

`events` が真実で、`cards` はそこから畳める Materialized View。最初は素直に両方書く。

### いまの構成から変える理由

- **JSON 直書き → SQLite** — いまの `writeBoard` は read-modify-write で、プロセスが2つ書くと後勝ちでカードが消える（テストにも「ロックが無いこと」を仕様として固定したものがある）。`node:sqlite` なら同時書き込みの問題ごと消える
- **拡張内サーバ → hub 分離** — いまは HTTP サーバが拡張プロセスの中で動くので、`kanban.ts` を触るたびに pi の再起動が要る。hub を別プロセスにすると、ボードは動かしたまま拡張だけ差し替えられる
- **ポーリング → SSE** — 一方向の push で足りる。WebSocket は要らない
- **バンドラは入れない** — 76KB の連結に esbuild は過剰。`scripts/build-web.mjs`（済）で足りる

### 移行パス

| 段階 | 内容 | 状態 |
|------|------|------|
| 2 | ダッシュボード HTML を `web/` へ、`npm run build` 導入 | 済 |
| 3 | JSON → SQLite（`cards` + `events`）、既存 JSON を1回インポート | 未 |
| 4 | hub を別プロセスに、`extensions/kanban.ts` は HTTP クライアントへ | 未 |
| 5 | SSE + Projects / Timeline タブ | 未 |
| 6 | 依存・期限・見積 | 未 |

段階3が分岐点。ここだけは既存テストの前提（「ロックが無いこと」を固定したテスト、
`~/.pi/kanban/*.json` のパスを直接触るテスト群）を作り直す必要がある。
