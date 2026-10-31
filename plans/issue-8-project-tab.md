# #8 プロジェクトタブの UI

ボードは「今やること」、プロジェクトは「どこへ向かうか」。#7 で `GET /api/projects` は完成している。
このカードは**見せるだけ**の話で、サーバ側は 1 行も変えない。

## データ（クライアントが取りに行く）

`GET /api/projects` →
```ts
{
  ok: true,
  projects: {
    slug: string; name: string; declared: boolean;
    counts: { todo: number; doing: number; done: number };
    total: number; done: number;
    points: { total: number; done: number };   // estimate の合計。未見積は 0pt
    progress: number;                          // 0-100 の整数（サーバ算出）
    overdue: number;                           // 未完了で期限切れ
    milestones: { id: number; text: string; due: string; col: string; scope: string; sid: string }[]; // due 昇順
    blockers:   { id: number; text: string; blocked: string; scope: string; sid: string }[];
    decisions:  { id: number; slug: string; at: number; text: string; why?: string }[]; // 新しい順
  }[];
  decisions: Decision[];   // slug が "" の横断ログ。どのプロジェクトにも属さない決定の置き場
}
```

取り方は**遅延 + 既存ポーリングに相乗り**。専用タイマーは作らない。

- `var projectData = null;`
- `function loadProjects()`: 読み込み中なら捨てる（多重 fetch 防止）。`api("/api/projects")` → then で `projectData = d` と `renderProjects()`。失敗時は前回の表示を維持して `note("プロジェクトを取得できません")`
- `selectTab("projects")` で即 `loadProjects()`
- `reload()` の `.then(schedule)` を `.then(function(){ if (activeTab === "projects") loadProjects(); schedule(); })` に変える

## 画面

タブは3つになる。**セッション / プロジェクト / 配信サーバー**（projects は真ん中）。

ペイン `#pane-projects` の中身は `projects` という id の div 1個だけ。中身は JS が組む。

### プロジェクト1件 = 1ブロック

```text
pi-kanban-board                                     ████████░░░░  62%
8/13 枚 · 13pt · 期限超過 1            決定 3 件

  マイルストーン
    09/01  #8 プロジェクトタブの UI            doing   あと12日
    09/15  #9 決定ログ UI                      todo    あと26日
  ブロッカー
    #12  テストが落ちる                        deps #11 が終わってない
  決定ログ
    3日前  進捗率は保存しない        なぜ: カードを動かした瞬間に嘘になるから   [×]
    1週間前 SQLite を採用           なぜ: 単一ファイルで済むから              [×]
    [テキスト                ] [なぜ（任意）        ] [追記]
```

- 名前: `name`。`declared === false` なら slug しか無いので、名前の横に「未宣言」を muted で添える
- 進捗バー: `points.total > 0` なら pt 比、無ければ枚数比。**どちらで描いたかが読めるようにする**（「13pt 中 8pt」/「13 枚中 8 枚」）
- 期限超過 > 0 は `--bad`、ブロッカー > 0 は `--warn` で色を付ける。0 の行は出さない
- マイルストーン/ブロッカー/決定が空なら、その見出しごと出さない（空セクションの墓標を並べない）
- 期限の残り日数は既存 `daysLeft()`、超過は「N日超過」、当日は「今日」
- 決定の時刻は既存 `ago()`、`title` に `full()` を入れる
- 決定の削除は `api("/api/decision", { action: "delete", id })`（`act()` はボード書き込みの契約なので通さない。下の「レビューで確定した追加事項」参照）、追記は `api("/api/decision", { project: slug, text, why })` → 成功したら入力欄を空にして `note("決定を記録した")` → `loadProjects()`
- 横断ログは末尾に別セクション（見出し「プロジェクト横断」+ 同じ追記フォーム、`project` を送らない）

### 空のとき
`empty(box, "\u25A1", "<b>プロジェクトはまだ無い</b> — カードに `project:<slug>` を付けると、ここに現れるよ")`
※ `empty()` の html は固定テンプレのみ。サーバの文字列を混ぜない。

## 実装の作法（既存コードに合わせる）

- 再利用必須: `el()` `empty()` `btn()` `api()` `act()` `flightGate()` `boardCtx()` `note()` `full()` `ago()` `dueOf()` `daysLeft()`
- 色・余白は既存の CSS 変数だけ（`--accent` `--muted` `--border` `--border-strong` `--card` `--panel` `--bad` `--warn` `--ok` `--bg`）。新しい色を発明しない
- サーバ由来の文字列は必ず `el(tag, cls, text)` / `textContent`。`innerHTML` は固定テンプレのみ
- `isEditing()` の `a.closest("#stats, #sessions, #global, #serve")` に `#projects` を足す。足さないと決定を打っている最中にポーリングが入力を消す
- aria: 既存の `role="tab"/"tabpanel"/aria-selected/aria-controls/hidden` パターンを踏襲。進捗バーは `role="progressbar"` + `aria-valuenow/min/max` + `aria-label`
- コメントは日本語で「なぜ」を書く（既存ファイルの流儀）。何をしているかは書かない

## 触ってはいけない

- `extensions/dashboard.generated.ts` — `web/dashboard.html` から `npm run build` が生成する。**手で編集しない**。最後に build を流して同期させる（`pretest` の `--check` が不一致を落とす）
- `extensions/kanban.ts` ほかサーバ側 — #7 で完成済み
- 既存のセッションタブ・配信サーバータブの挙動、並び、DOM id
- `web/md.js`, `web/memory.js`

## テスト

1. `tests/kanban-dashboard-tabs.test.mjs` を 3 タブに更新
   - `role="tab"` のカウント 2 → 3、`<button class="tab` のカウント 2 → 3
   - `["tab-sessions","tab-serve"]` のリストに `["tab-projects","プロジェクト"]` を足す
   - クリックで `pane-*` の hidden が入れ替わる vm 検査の対象に projects を足す
2. 新規 `tests/kanban-dashboard-projects.test.mjs`（`tests/kanban-dashboard-tabs.test.mjs` の骨組みを流用）
   - `/` の HTML に `tab-projects` / `pane-projects` / `id="projects"` があり、初期状態で `pane-projects` は hidden
   - プロジェクトを2つ作る: A =`due` 付きカード + `blocked` カード + 決定2件、B = カード1枚だけ
   - `/api/projects` の payload が A/B を slug 順で返すこと（HTTP はここまで。集計の細部は #7 のテストの担当）
   - vm で `renderProjects()` を回し、DOM から読む: 進捗バーの `aria-valuenow`、`width` の `%`、「8/13 枚」表記、マイルストーン行の日付と「あと N 日」、ブロッカー行、決定テキストと `why`、空プロジェクトで見出しが出ないこと
3. `npm test` 全通過（`pretest` の `build-web.mjs --check` 込み）

## 完了条件

- `npm test` が全通過
- `git status` の差分が `web/dashboard.html` / `extensions/dashboard.generated.ts` / `tests/kanban-dashboard-tabs.test.mjs` / `tests/kanban-dashboard-projects.test.mjs` のみ
- スマホ幅（既存 @media の 1 カラム）で進捗バーと決定フォームが潰れない

## このカードでやらないこと

- プロジェクトの改名・宣言 UI（`/api/project`）。名前は slug で出るし、要るなら別カード
- マイルストーンやブロッカーからカードへ飛ぶ導線
- プロジェクト横断の集計グラフ

## レビューで確定した追加事項（実装済み）

- 期限の色は `dueCls(due, col)` 1 か所で決め、看板のカードチップとマイルストーン行の**両方**がそれを通す。完了済みは色を付けず、「期限切れ」の語も出さない（title の超過日数は事実なので残す）。
  - 理由: 期限超過の集計（`cardStats`）は完了済みを数えないのに、チップだけ赤いと「超えているのに 0 件」と読めてしまう。片方だけ直す退行が実際に 2 回起きた。
  - 守り: `tests/kanban-dashboard-dues.test.mjs`（4 本）がチップ側を、`tests/kanban-dashboard-projects.test.mjs` がマイルストーン側を見る。ヘッダ件数は `aria-label="期限超過 N"` を DOM の赤いチップ本数と突き合わせる。
- 決定ログの削除は `act()`（ボード書き込みの契約）を通さず `api("/api/decision", {action:"delete", id})` を直接呼ぶ。`/api/decision` はボードに属さない。
- 決定の編集は作らない。決定は書き換えるものではなく積み重なるもの。
