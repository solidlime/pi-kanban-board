# Tier A タスク分解（実装中）

期間目標: 「時間・人・出力」の3軸を板に載せる。**新しいテーブルは A6 の1個だけ**、残りは既存データの射影。
担当は2本に割る（衝突しない境界）: **server = src/ + extensions/ + tests/{unit,integration}** / **ui = web/ + tests/e2e**。

| # | 項目 | 何を出すか | 担当 | 受け入れ条件 |
|---|---|---|---|---|
| A1 | 横断検索 | `GET /api/search?q=` の `project` を任意に。省略時は全板。hits に `projectId`。UI は「全板」トグルと、ヒットから板を跨いでジャンプ | server + ui | 板Aのカードが板Bから検索で見つかり、押すと板Bに切り替わって開く。`limit` は全体で効く |
| A2 | actor の可視化 | `Card.lastActor`（timeline の最新 actor を1クエリで射影。書き込み不可）。UI はカード面に小さく、詳細に大きく | server + ui | 別セッション/モデルが動かしたカードに、その actor が出る。null は非表示 |
| A3 | 時間の全面表示 | `web/src/gantt.ts`。`due`/`movedAt`/`closedAt` から週・月スケールの棒を**導出**（保存しない・読み取り専用） | ui | 時間タブに棒が出て、ドラッグしても何も書き換わらない |
| A4 | digest | `src/core/digest.ts`（純関数）+ `GET /api/digest?project=&since=` + `/kanban digest --since 7d` | server | 直近7日の done 遷移・成果物・commit が Markdown 1枚で出る。空期間で見出しだけ返る |
| A5 | 通知の外部送出 | `src/core/notify-sink.ts`。`KANBAN_NOTIFY_SINK=file:<path>` のとき JSON Lines 追記。24時間のスロットル | server | 同じ通知が24時間で二重に書かれない。sink 未設定なら完全に no-op |
| A6 | デーモンロック | schema v3 + `src/persistence/locks.ts`。`GET/POST/DELETE /api/locks`。競合は 409 `LOCK_HELD`、期限切れは取得時に回収 | server + ui | 2つ目の取得が 409。期限後に再取得できる。migration 1→2→3 の連続適用が冪等 |
| M | モバイル最適化 | viewport + 600/900px のブレークポイント。900px 未満は列を縦積み、タップ 44px、フォント 16px 以上 | ui | 幅 390px で横スクロールが出ない。ボタンが指で押せる。文字が勝手にズームしない |

## 境界（同時に走らせて衝突させない）
- server 担当は `web/` に触らない。ui 担当は `src/` に触らない。
- 契約は先に固定した（上の表の右列）。UI は契約に対して書き、サーバーは契約を満たす。
- テストは server が `tests/{unit,integration}`、ui が `tests/e2e}` のみ。

## ゲート（全項目共通）
`npm run typecheck:v2` pass / `node --test "tests/**/*.test.mjs"` 失敗0 / `node scripts/build-v2.mjs` 成功 /
実ブラウザ確認（M・A3・A1・A2 は必須）/ ルアン・メェイのレビュー PASS / docs/W2_API.md 同期。

## 実装しないと決めたこと
- ガントの書き込み（ドラッグで日付変更）: 権限と競合の設計が要る。B4 の後。
- 通知の push 先（デスクトップ・メール）: 今回はファイル sink のみ。送信先は環境ごとに違うので設定を増やさない。
- 検索のページング: 上限 200 件で足りる規模。必要になったら cursor を足す。
