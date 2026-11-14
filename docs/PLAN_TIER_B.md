# Tier B 計画（設計から）

A（Tier A 6項目）と同時並行で走らせない。各 B 項目は「v3 の契約（event log / 権限 / 板の id 解決）」に触るので、
A のゲート通過後に 1 項目ずつ縦スライスで入れる。順序は B1 → B3 → B2 → B4 → B5。
根拠: B1 は他の全ての前提（時間の正本）を作る。B3 は新規テーブルだけで閉じる（安い）。B2 は B1 の実績と B4 の権限の両方を使う。
B4 は API 全体の入口を触るので、機能追加が落ち着いてから最後から2番目。B5 は一番高い。

---

## B1. 実績の記録（estimate vs actual） ／ 見積り 2-3日

### 問題
Card に `estimate: number | null` はあるが実測が無い。`movedAt` は1個しか残らず、
「doing に何時間いたか」「見積りが何割外れたか」が計算できない。

### 設計
- **正本は event log**（A3 で daemon lock 用に入れる `event` テーブルを汎用化して先に使う）。
  `event(id, at, project_id, card_id, kind, payload)`、kind は `card.created|card.moved|card.closed|card.reopened`。
- **実績は保存しない。射影で出す。** 列滞在 = イベント列から `kind='doing'` の区間長の合計。
  保存すると必ず本当のイベントと乖離する（v1 の `halted` と同じ失敗）。
- 既存カードの移行: 各カードについて `card.created`(createdAt, column=todo-ish) と
  `card.moved`(movedAt, 現在の列) の2件を合成して seed する。**過去の滞在は復元できない**旨を docs に書く。
- 射影は SQL 1本（ウィンドウ関数 `lead(at) over (partition by card_id order by at)`）で
  `card_time(card_id, doing_seconds)` を出す。snapshot に `actualSeconds` として同梱（列数は数十なので安い）。

### 契約
- `Card.actualSeconds?: number`（読み取り専用の射影。書き込みは受け付けない）
- `GET /api/cards/:pid/:id/time?from=&to=` — 区間指定の内訳（ガントのツールチップ用）
- 422 で `actualSeconds` を送られたら **無視せず拒否**（書き込み可能なフィールドと誤解させない）

### テスト
- 単体: イベント列 → 区間長（doing を2回経由、done で閉じる、未 closed は now まで）
- 統合: 作成→move→move→closed の順で doing 合計が期待値。タイムゾーンは UTC 固定
- 境界: 同一ミリ秒のイベント2件（順序不定）で負の区間にならないこと

### リスク
- event log が単調増加する → **保持期間（既定 400 日）を超えた `card.moved` は捨てる**が要る。
  捨てると実績が縮むので、年間集計 `card_time_month` に畳んでから捨てる（B1 の一部として実装）。
- 見積り精度の可視化は「外れ値の晒し」になり得る。UI では数値ではなく**バンド（±25%以内/超過）**で出す。

---

## B3. プロジェクトテンプレート ／ 見積り 1-2日

### 問題
今あるのは**カード**テンプレート（`card_template`）だけ。板の骨格（列構成・ラベル・初期カード）を
毎回手で作っている。

### 設計
- `project_template(slug, name, body)` 1行。`body` は JSON:
  `{columns:[{id,name,kind,ord,wipLimit}], labels:[], cards:[{title,columnId,priority,acceptance}]}`
- 実体化は **1トランザクション**で `projects` + `columns` + `cards` を作る。
- **検証は既存の正規化関数を再利用**（`assertColumnId`/`assertName`/`assertPriority`）。テンプレート JSON 用の
  第二のバリデータを書かない（B5 以前に一番バグる場所）。
- テンプレートは板に紐づかない（`project_id` 列を持たない）。読み出しは全板共通。

### 契約
- `POST /api/project-templates { slug, name, body }` / `GET /api/project-templates`
- `POST /api/project-templates/:slug/instantiate { slug }` → `{project, columns, cards}` を 201
- slug 衝突は 409 `CONFLICT`

### テスト
- 統合: 実体化 → 列3本とカード2枚が期待通り、WIP 上限が保持される、同じテンプレートから2回実体化して slug だけ変わる
- 失敗時: 途中で WIP 違反になるテンプレートは**全体がロールバック**する（部分適用しない）

### リスク
- JSON と `ColumnDef` のスキーマ乖離。型は共有する（`ProjectTemplateBody` を dto に置き、保存時と実体化時に同じ型を使う）。

---

## B2. マイルストーン / リリース束 ／ 見積り 3日

### 問題
「今回出すもの」が板を跨ぐ。カードは板に属し、成果物は帯に属する。その上に「束」が要る。

### 設計
- `milestone(id, name, status:'open'|'shipped'|'cancelled', due_on, closed_at, created_at)` — 板に属さない。
- `milestone_item(milestone_id, project_id, kind:'card'|'deliv', ref_id, added_at)`。
  主キーは `(milestone_id, project_id, kind, ref_id)`。**id は板を跨いで重複するので必ず (project_id, id) の組**。
- 進捗は射影: 束ねたカードの `closedAt` 率。`shipped` 遷移は明示操作のみ（自動で閉じない）。
- 未出荷のまま due を過ぎた束は通知（既存の `notifications` の新カテゴリ `milestone`）。

### 契約
- `GET /api/milestones?status=open` / `POST /api/milestones` / `PATCH /api/milestones/:id` / `DELETE`
- `POST /api/milestones/:id/items { project, kind, id }` / `DELETE /api/milestones/:id/items/:pid/:kind/:id`
- `GET /api/milestones/:id` → `{milestone, items:[{projectId, kind, id, title, state}], progress:{done,total}}`

### テスト
- 統合: 2つの板のカードを束ねる → progress が 1/2 → 片方 close → 2/2。cross-board の id 衝突（両板に #1）でも別項目
- 削除: カードを消したら `milestone_item` は `ON DELETE CASCADE` で消える（腐った参照を残さない）

### リスク
- 「束ねた瞬間のスナップショット」を撮りたくなるが**撮らない**（正本を二重化しない）。shipped 時に成果物を1枚生成して固定する。

---

## B4. 読み取り専用トークン / スコープ ／ 見積り 2-3日

### 問題
単一トークンで全部書ける。「見せるだけ」の相手に渡せない。agent adapter はローカルの`/kanban` から叩くので
影響を受けないが、HTTP を外に開くときに詰む。

### 設計
- `auth_token(id, name, scope_json, hash, created_at, revoked_at, last_used_at)`
- `scope_json`: `{ mode: 'read' | 'write', projects?: string[] }`（`projects` 省略 = 全板）
- **保存は sha256 のみ**。平文は発行時のレスポンスに1度だけ載せる（ログ・エラー・timeline に流さない）。
- 既存の env トークンは「full access の特別扱い」として残す（移行の互換）。
- 判定は**ルート表の write フラグ**（routes.ts:41 の一覧をそのまま使う）: 読み取り専用トークンが
  書き込みルートに来たら 403 `FORBIDDEN`。プロジェクト絞り込みはパス/ボディの `project` を解決した後で比較。
- `timingSafeEqual` は hash 同士で比較（長さ固定なので前置比較が要らなくなる）。

### テスト
- 統合: read トークンで GET 200 / POST 403 / `?token=` ブートストラップは read でも通る
- スコープ: `projects:['alpha']` のトークンで beta を GET → 403（404 ではない。存在は隠さない）
- 失効: revoked_at 後は 401。`last_used_at` が更新される

### リスク
- **トークン漏洩の経路が増える**（複数発行できる）。docs に「発行できるのは write スコープのトークンだけ」と明記。
- 拒否を 404 にすると相手が混乱し、403 にすると板の存在が漏れる。**403 を選ぶ**（ローカル前提の道具なので隠す価値がない）。

---

## B5. 板を跨ぐ依存 ／ 見積り 1日（板レベル）→ 3日（カードレベル）

### 問題
`dependencies` は同一板内に閉じている（`(project_id, from_card, to_card)`）。2つの案件が噛み合うとき表現できない。

### 設計（段階）
- **第1段: 板レベルの依存** `project_dependency(from_project, to_project, type:'blocks'|'relates')`。
  「beta が終わるまで alpha の done にできない」を表現する。**1日で済む。まずこれだけ入れる。**
- 第2段（必要になってから）: カードレベルの板跨ぎ。`dependencies` の両側に project を持たせ、
  循環検出を全板の辺で回す。**id は (project_id, id) の組で解決**（v1 の教訓）。
- どちらも未解決の参照は作らせない（`ON DELETE CASCADE`）。

### テスト
- 第1段: alpha→beta の blocks を作る → beta のカードが「板が blocked」と表示され、alpha が done になると解除
- 循環: alpha→beta→alpha を拒否（`CYCLE`）

### リスク
- 板レベルの blocks を「カードの blocked」に混ぜると、解除条件が曖昧になる。**別バッジ**（`板待ち`）で出す。
- カードレベルに進むと循環検出が全板 BFS になり、板が増えると遅い。上限（10板）を設ける。

---

## 実装順と依存

```text
B1 (event log + actualSeconds) ──┬──> B2 (milestone progress が実績を使う)
                                 └──> B4 (書き込み判定はトークン、実績とは独立)
B3 (template) ── 独立。ただし B2 の「shipped 時にテンプレから成果物」で再利用
B5 (板跨ぎ) ── B1/B2/B4 と独立。最後
```

## 各項目の共通ゲート
型チェック（src+web）／ テスト失敗0 ／ 統合テストは**temp home** で（`~/.pi/kanban` を触らない）／
実ブラウザ確認（UI が変わる項目）／ ルアン・メェイのレビュー PASS ／ docs/W3_API.md 同期。
