# 計画: プロジェクトタブをディレクトリ名の一覧にする（sid 第一級化）

## ゴール

「プロジェクト」タブに、この機械の作業ディレクトリ（git ルート名 = `sid`）の一覧を出す。
行をクリックすると、そのプロジェクトのボードがタブ内に開く。

## 決定（ユーザー承認済み）

| 論点 | 決定 |
|---|---|
| プロジェクトの同一性 | `sid` = `git rev-parse --show-toplevel` の basename を `normalizeProject()` した値 |
| `card.project`（自由タグ） | 廃止 |
| `project` テーブル（宣言リスト） | 廃止 |
| プロジェクトページへの遷移 | タブ内切り替え（URL は変えない） |
| カード 0 枚のディレクトリ | 出さない |

## 現状の分裂

```
extensions/kanban.ts:3312  projectRollup()      ← card.project 軸で集計（実測 0 件）
extensions/kanban.ts:3374  projectBoardsOf()    ← sid 軸で集計（正しい）
extensions/db.ts:568       listProjectBoards()  ← sid の一覧そのもの（未使用）
```

週次は sid 軸、プロジェクトタブは card.project 軸。sid に寄せれば 1 本になる。

## 段階

### Slice 1 — 集計を sid に（backend のみ）

- `projectRollup(cards, decisions, today)` に署名変更。`declared` 引数を落とし、slug は `entry.sid` から集める
- `projectsPayload()`（`extensions/kanban.ts:3427`）の供給元を `db.listProjects()` から `listProjectBoards()` に
- `tests/kanban-projects.test.mjs` の 3 箇所を追随
- 受け入れ: `GET /api/projects` が `pi-kanban-board` を 1 件返し、`total` が実カード数と一致する

### Slice 2 — プロジェクトタブ（UI）

- `renderProjects()` の空メッセージから「カードに project:<slug> を付けると」を削除
- 一覧の行をクリック → `projSel` に slug を保持し、`/api/board?scope=project&sid=<slug>` で取得して詳細描画
- 詳細の描画は既存 `renderProject(p)`（`web/dashboard.html:1371`）を使い回す（slug を引数化）
- 受け入れ: 実ブラウザで一覧 → クリック → そのプロジェクトのカードが出る

### Slice 3 — card.project 撤去（機械的）

- 型 `Card.project`（`extensions/kanban.ts:110`, `extensions/db.ts:34`）を削除
- `db.ts` の読み書き（`:225`, `:420`, `:464`）を削除。**列は残す**（破壊的移行を避ける）
- API の `project` パラメータ（`:3718`, `:4242`, `:4494`）と MCP ツール（`:5688`, `:5752`, `:5793`）から削除
- UI の絞り込み `projPick`（`:1249-1253`）を `c.sid` を読むように変更
- `docs/project-board.md` のデータモデル記述を sid 基準に更新

## リスク

- `card.project` 列は残すので、既存 DB に値があっても無害（読まないだけ）
- Slice 1 と 3 の間は、`project` パラメータを受け付けても無視される期間がある（自分しか使っていないので許容）
- `docs/project-board.md` の P0-1「行クリックで既存ボードへ降りる」がまさにこの作業

## やらないこと

- 監視ディレクトリのスキャン（カード 0 枚のプロジェクトを出す）
- プロジェクト名の手動上書き
- URL にプロジェクトを載せる（`?p=`）
