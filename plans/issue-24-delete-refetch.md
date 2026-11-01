# #24 削除直後の再取得が in-flight ポーリングに握り潰される

## 症状
プロジェクトタブで決定ログの行を削除しても、その行が最大 5 秒（ポーリング 1 周期）残る。

## 根因
`web/dashboard.html:1674-1689` の `loadProjects()`。

```js
var projectsBusy = false;   // 多重 fetch 防止。古い応答で新しい表示を塗り替えない
function loadProjects(){
  if (projectsBusy) return; // ← ここ
  ...
}
```

コメントの意図は「古い応答で新しい表示を塗り替えない」だが、実装は**新しい要求を捨てる**。
目的（freshness）と手段（dedupe）が逆になっている。

競合の筋書き:
1. ポーリングが `reload()` 末尾で `loadProjects()` を発火 → `projectsBusy = true`
2. ユーザーが ×→確認で削除。`api("/api/decision", {action:"delete"})` は成功する
3. 成功側の `.then(loadProjects)` が呼ばれるが `projectsBusy === true` なので**即 return**
4. 手順 1 の応答（削除前の payload）が届き、`projectData = 古い d` → `renderProjects()`
5. 消した行が復活したまま、次のポーリングまで残る（最大 `POLL_MS = 5000`）

サーバは無罪。`DELETE` 相当は `extensions/kanban.ts:4110` の `db.deleteDecision(id)` で同期実行。
`tests/db.test.mjs:292-296` で真偽まで検証済み。完全にクライアント側の競合。

## 修正方針: 捨てる → 1 本だけ控える（coalesce）

`projectsBusy` を維持したまま、busy 中に来た要求を `projectsAgain` で 1 回だけ控える。
控えがある場合、いま届いた応答は要求時点より古い状態なので**描かずに取り直す**。

```js
var projectsBusy = false;
var projectsAgain = false;  // busy 中に来た要求（1 本だけ控える）
function loadProjects(){
  if (projectsBusy) { projectsAgain = true; return; }
  projectsBusy = true;
  api("/api/projects").then(function(d){
    projectsBusy = false;
    if (projectsAgain) { projectsAgain = false; loadProjects(); return; }
    projectData = d;
    if (!isEditing()) renderProjects();
  }, function(){
    projectsBusy = false;
    projectsAgain = false;
    note("プロジェクトを取得できません");
  });
}
```

なぜ「古い応答を描かずに捨てる」のか: 控えが立っている＝誰かが「今の状態が欲しい」と言った。
その要求より前に発行された fetch の応答で描けば、まさに削除が消える。取り直せばよい。

### なぜ世代番号（requestId）方式にしないか
busy 中でも fetch を投げる方式は同時 2 本になり、`POLL_MS` の相乗りと重なると本数が読めない。
coalesce なら fetch は常に 1 本で、既存の「積み増さない」性質をそのまま保てる。
遅延は「最大 5 秒」から「in-flight 1 本の残り時間」に落ちる。

同型のバグが `web/dashboard.html:1841-1859` の `loadWeekly()` にもある（`weeklyBusy` が捨て）。
同じバグを 2 箇所に残さないため、こちらも同じ形にする。

## 触るファイル
- `web/dashboard.html`: `loadProjects`（`:1673-1689`）と `loadWeekly`（`:1840-1859`）
- `extensions/dashboard.generated.ts`: `npm run build` で再生成（手で編集しない）
- `tests/kanban-dashboard-projects.test.mjs`: 既存テスト 1 本の書き換え + 新規 1 本

## テスト

### 既存の書き換え: `#10 取得中に再要求しても積み増さない`（`:426`）
`assert.equal(d.ctl.projectsCalls, 1)` は coalesce でも成立（busy 中は投げない）。
ただし「1 回目の応答で描く」は成り立たなくなる — 控えがあるので描かずに 2 本目を投げる。
`resolve1` を 2 回呼ぶ形（1 回目で 1 本目、2 本目で控えの分）に直し、
「1 本目では描かず、2 本目の応答で描く」を assert する。**検出力は上げる**（下げない）。

### 新規: 削除直後の再取得が握り潰されない
1. `projectsFetch` を宙吊りにして 1 本目を発行
2. もう一度タブを押す（＝削除後の再取得に相当。busy 中）
3. 1 本目を「行あり」の payload で解決
4. `projectsCalls === 2` を assert（控えが拾われた＝捨てられていない）
5. この時点で行が描かれていないことを assert（古い応答で塗っていない）
6. 2 本目を「行なし」の payload で解決 → 行が消えていることを assert

## スコープ外（別カード）
- `reload()`（`:2104`）に多重実行ガードが無く `lastData = d` が後勝ち。カード削除（`act()` → `reload()`）と
  ポーリングが並走すると古い payload が勝ちうる。これは「握り潰し」ではなく「後勝ち」で別の穴
- `loadWeekSaved()`（`:1859`）に busy/世代ガードが無い。週を素早く切り替えると古い応答が勝つ
- `api()`（`:585`）が `If-None-Match` を送らず 304 を解釈しない（`sendEtagJson` のハッシュはブラウザ任せ）
- `web/dashboard.html:1709` のコメント参照 `カード削除（:757）` が stale（実際は `:834`）

## 検証
- `node tests/kanban-dashboard-projects.test.mjs` が 0 failed
- ミューテーション: `if (projectsBusy) { projectsAgain = true; return; }` を `if (projectsBusy) return;` に戻すと新規テストが赤
- `npm test` フル suite（`pretest` の `build-web --check` 含む）
- 実ブラウザでの確認は pi-web 再起動が要るため、ユーザー許可待ち（前回 #23 と同じ）