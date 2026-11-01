# #21 全ボード横断のカード検索

## 目的

GLOBAL セクションは既に全プロジェクトのカードを集約している（`aggregateGlobal()` → `/api/dashboard` の `global.cards`）。**足りないのは検索対象の狭さだけ**——今は `text` の部分一致しか見ないので、番号・project・commit・session・ブロック理由で引き寄せられない。

## 発見（Explore の調査、前提を 2 つ壊した）

- **ボードはもう JSON ファイルではない**。`~/.pi/kanban/boards.sqlite` の行。`projects/<slug>.json` は `boardPath()` が組み立てる擬似パスで、ディスクに存在しない（`extensions/kanban.ts:241-243`, `:347-351`）
- **横断検索に新しい API は要らない**。`/api/dashboard` の `global.cards` に全ボード分が既に載っている（`extensions/kanban.ts:3335-3339`）。サーバ側で絞るのは通信量の最適化でしかない
- 検索入力 `#q` は `#filters` の中（`web/dashboard.html:270`）。`query` は小文字化済みの語だけ持つ（`:322`）
- 述語は **2 箇所に同じものが重複**している: `renderProject`（`:1345`）と `renderGlobal`（`:1374`）
- 同じ id が複数ボードに居る問題は既に `sid + "\u0000" + id` のキーで解決済み（`web/dashboard.html:328`, `:335-337`, `:1253-1263`）。**検索でも同じキーを使うこと**
- `tests/kanban-dashboard-collapse-search.test.mjs:114` が `String\(x\.text \|\| ""\)\.toLowerCase\(\)\.indexOf\(query\)` を assert している（実装文字列の固定）。述語を変えたらここも直す
- 同テスト `:112` が `placeholder="検索（/ でフォーカス, Esc でクリア）"` を固定。文言を変えたら更新

## 決定

### 1. サーバ API を足さない
`/api/dashboard` が既に全カードを返している。クライアントで絞る。新しいエンドポイントは「絞って通信量を削る」以外の価値が無く、その必要も出ていない。

### 2. 検索対象
人間がカードを思い出すときの語彙だけ。内部フィールド（`img` / `nextFireAt` / `firedFor` / `estimate` / `blocks` / `priority` / `col`）は入れない（`col` は `cardFilter` ボタンと重複する）。

| 対象 | 理由 |
|---|---|
| `text` | 現行。本文 |
| `id`（`7` と `#7` の完全一致） | 番号で探す需要は確実。**部分一致にしない**（`7` が 17・27 に当たると使い物にならない） |
| `project` / `sid` | `#proj` セレクトは完全一致の絞り込み。検索語での部分一致は別物 |
| `sessionId` | #20。文字列一致で十分 |
| `commit` | #20。保存時に小文字化済み、`query` も小文字化済み |
| `blocked` | 自由文。ブロック理由で探したい |
| ~~`movedBy`~~ | **対象外**（当初 🟠 で拾う計画だったが取り止め）。 #17 で session 行が消えて UI に actor が出なくなったため、検索対象から外した。画面で確かめられない値を検索させると、理由の分からない謎ヒットだけが増える |

### 3. 述語を 1 関数に切り出す
`cardHit(c, query)` を `renderProject` の前に置き、2 箇所から呼ぶ。**2 箇所に同じ述語を書かない**（#20 で同じ検証が 4 箇所に散って 3 箇所同時に壊れた前例）。

### 4. テストは関数を評価する
静的マークアップ検査だけでは「`cardHit` が `text` しか見ない」退行を検知できない。`web/dashboard.html` から `cardHit` を波括弧対応で抜き出して `new Function` で評価し、**挙動を直接テスト**する。

## 触る箇所

| ファイル | 変更 |
|---|---|
| `web/dashboard.html` `:1340` 付近 | `cardHit(c, query)` を定義（`renderProject` の前） |
| `web/dashboard.html:1345` | `renderProject` の述語を `cardHit` に |
| `web/dashboard.html:1374` | `renderGlobal` の述語を `cardHit` に |
| `web/dashboard.html:270` | プレースホルダに検索対象を明示 |
| `extensions/dashboard.generated.ts` | 再生成 |
| `tests/kanban-dashboard-collapse-search.test.mjs:114` | 実装文字列の assert を新述語に |
| `tests/kanban-dashboard-collapse-search.test.mjs:112` | placeholder の文言 |
| `tests/kanban-dashboard-search.test.mjs`（新規） | `cardHit` の挙動 |

## 触らないもの（別カードで追跡済み）

- `/api/projects` が自 cwd の 1 枚しか数えない件 → #28 / #25
- `check()` の node:test サブテスト化 → #31
- プロジェクトタブ（`renderProjects`）で検索が効かない件 → `#q` が `pane-board` の中にしかない構造の問題で、#21 の範囲外。GLOBAL が全ボードを出しているので実害が無い

## 罠

- `commit` の検索は**保存時に小文字化済み**（`normalizeCommit` が `toLowerCase()`）。`query` も小文字化済みなので両側 OK。ただし将来 `query` の小文字化が外れたら壊れる
- `id` の完全一致は `#7` と `7` の両方を受ける。`query` は `#` を含み得る
- 5 秒ポーリングで毎描画 `filter` が走る。対象フィールドを増やすので `cardHit` は早期 return を優先（`query === ""` は即 true）
- `renderGlobal` は検索中に `gexpanded` を強制 true にする（`:1378`）。この挙動は変えない
