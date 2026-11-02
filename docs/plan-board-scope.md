# 計画: 「プロジェクト」をボード基準に寄せ、ボードタブを総合管理ボードにする

## 起点（ユーザーの不満）
「このプロジェクト って WEB ダッシュボードに出てるけど、このってなに？単体プロジェクトをみるダッシュボードじゃないし不要だよね？『プロジェクトはまだ無い — カードに project:<slug> を付けると、ここに現れるよ』も消えてないし。もうタグ管理は廃止したよね？」

ユーザー決定:
1. `writeBoardPath` に `?p=<slug>` を通し、選択ボードに書けるようにする
2. `#global`（全プロジェクト・読み取り専用）の欄は**削除**する

## 根本原因（実測）
- **プロジェクトが2つある**: ボード = ディレクトリ名 `sid`（実体）と、カードの `project` タグ（自由記述ラベル）。
  `projectRollup`（`extensions/kanban.ts:3326-3372`）は**タグ**で絞る（`:3334` `if (card.project) slugs.add(card.project)` / `:3344` `cards.filter((e) => e.card.project === slug)`）。
  だから `Pi-Kanban-Board` に38枚あってもタグが無ければ「まだ無い」と言い続ける。
  `projectsPayload`（`:3441-3452`）のコメント `:3442-3443` は「供給は aggregateGlobal() / weekly と同じ、この機械の全プロジェクトボード」と宣言していて、**実装と食い違っている**。
- **書き込み先を選べない**: `projectKeyOfWrite`（`:3623-3626`）は `sid` を**セッションID**として解釈するため、書き込み先は常に cwd のボード。
  `#35` で `#project` が `projPick` に追従するようになった（`boardOf` `web/dashboard.html:2126-2132` → `/api/kanban?p=<slug>` で `d.project` を差し替え）結果、**他ボードを表示したままドラッグ・追加すると cwd のボードに書く**（または 404）。
  これが「このプロジェクト」欄が消せない理由でもある（唯一の書き込み面）。

## 変更（8 箇所 + テスト）

### A. サーバ: 書き込み先ボードの指定（`extensions/kanban.ts`）
`writeBoardPath`（`:3636-3646`）に `?p=` を追加する。**判定順は legacy → global → p → sid**（global は `p` があっても 400 のまま）。
```ts
const pRaw = q.get("p");
if (pRaw !== null && pRaw !== "") {
	const slug = normalizeProject(pRaw);
	if (slug === "") return { ok: false, error: "p must match [A-Za-z0-9._-]" };
	return { ok: true, path: boardPath("project", storedProjectKey(slug)) };
}
```
呼び出しは `:3697`（`/api/upload`）と `:4246`（`/api/add|edit|del|move|priority|modes|interval|stuck|resume` の switch）の **2箇所だけ** なので、ここ1点で全書き込みルートが選択ボードに対応する。
`storedProjectKey`（`:480-482`）を通すのは #36（保存表記に寄せる）と同じ理由。

### B. サーバ: ボード一覧をペイロードに（`extensions/kanban.ts`）
`dashboardPayload` に `boards` を追加する。空のボードも選択肢に出したいので、カードからではなく DB から引く。
```ts
boards: kanbanDb().listProjectBoards().map((b) => b.slug).sort(),
```

### C. サーバ: 集計をボード基準に（`extensions/kanban.ts:3326-3372` `projectRollup`）
- slug の供給を `card.project` から `scope === "project" && sid !== ""` に変える
- 絞り込みを `cards.filter((e) => e.scope === "project" && e.sid === slug)` に変える
- `declared`（名前登録）と `decisions` の slug はそのまま残す
- 結果、`allRollupCards()` の GLOBAL 残骸（`scope:"global", sid:""`）はプロジェクトタブから落ちる（意図どおり。週次は `projectBoardsOf` で既に落としている）

### D. UI: 「このプロジェクト」欄を消す（`web/dashboard.html`）
- `:287-290` の `section[aria-labelledby=h-project]` ラッパーと見出しを削除し、`<div id="project"></div>` だけ絞り込みバーの直下に残す
- `renderProject`（`:1378-1408`）内の `#project-slug` 参照（`:1383-1384`）を削除
- 文言「このプロジェクト」は `#proj` 選択肢（全部／ボード名）が兼ねる

### E. UI: GLOBAL 欄を削除（`web/dashboard.html`）
- `:292-295` の `section[aria-labelledby=h-global]` を削除
- `renderGlobal`（`:1410-`）を削除し、`:1977` の呼び出しと `:2155` の失敗時呼び出しも削除
- **`d.global` はペイロードに残す**: `cardStats`（`:1305`）と `syncProjOptions`（`:1334`）が読んでいる

### F. UI: 描画中の盤面を書き込み先にする（`web/dashboard.html`）
- `boardCtx(scope, sid, active, board)` に第4引数を足し、`ctx.board` を持たせる（`:648`）
- `renderProject` は `boardCtx("project", "", true, projPick)`、`renderSettings`（`:1553`）も同様に `projPick` を渡す
- 書き込み params を組み立てる `:609`（move）と `:672`（upload）に `if (ctx.board) params.p = ctx.board;` を追加
- `renderSettings` の見出し `:1552`「このプロジェクト（id）」も同じ扱いに（`p.id` をそのまま出す）

### G. UI: ボード選択肢の供給（`web/dashboard.html:1322-1348` `syncProjOptions`）
`d.boards` があればそれを優先し、無ければ従来どおり `d.global.cards` / `d.project.cards` の `sid` から作る（後方互換）。

### H. UI: 空メッセージ（`web/dashboard.html:1839`）
「プロジェクトはまだ無い — カードに project:<slug> を付けると、ここに現れるよ」を、ボード基準の文言に差し替える（例:「ボードがまだ無い — どのディレクトリでも kanban を使えばここに並ぶよ」）。

## やらないこと（スコープ外）
- `card.project` タグの削除。`/api/schedule?project=`、`/api/upload`、CLI `add` の `project:` でまだ生きている。**プロジェクトタブの集計から外すだけ**
- 新規依存・外部 CDN・Web フォント（`#40` の UI モダン化は別カード）
- `GLOBAL_JSON` の残骸行の移行・削除

## テスト
| ファイル | 変更 |
|---|---|
| `tests/kanban-projects.test.mjs:51-93` | seed をボード基準に。期待 slug を `["ghost","kb-core"]` → ボード名に |
| `tests/kanban-projects.test.mjs:248-262` | `projectOf(body, "other-proj")` → `"other-repo"` |
| `tests/kanban-rollup-source.test.mjs:138-148` | GLOBAL 残骸が落ちるので 4 枚 → 3 枚 |
| `tests/kanban-dashboard-projects.test.mjs:166-180` | `closest(...)` のセレクタから `#global` を除去 |
| 新規 | `POST /api/move?scope=project&p=alpha&id=1&col=done` が alpha に着地し、cwd のボードが変わらない |
| 新規 | `POST /api/move?scope=project&p=<不正文字>` が 400 `p must match [A-Za-z0-9._-]` |
| 新規 | `POST /api/move?scope=global&p=alpha` は 400（global は読み取り専用のまま） |
| 新規 | `projectsPayload()` が空でないボードを全部返す（タグ無しでも）|

## 完了条件（GATE）
型 check pass / `npm test` 失敗0 / lint 0 / format ok / 契約テスト（API 応答の形）pass / ドキュメント同期 / 禁止操作なし
**加えて UI 変更なので実ブラウザ確認必須**: ボードタブで (1) 見出し「このプロジェクト」が消えている (2) 選択ボードのカードをドラッグして `?p=` が飛ぶ (3) プロジェクトタブに `Pi-Kanban-Board` が出る (4) 「まだ無い」文言が消えている。

## リスク
- **データ破壊の修正なので、書き込み経路を1つも漏らさないこと**。`writeBoardPath` の 2 呼び出し以外に直接 `boardPath(...)` へ書く経路が無いことを確認する
- `#global` 削除で `d.global` を読む箇所（`cardStats` / `syncProjOptions`）を壊さない
- `renderProject` / `renderSettings` / `syncProjOptions` の**関数名は変えない**（多数のテストが `vm` で名前で抜き出す）
- `tests/kanban-ops38-frozen.test.mjs:85` の `.col.doingcol{...}` 完全一致文字列を壊さない
