# autoPick 復活 + 成果物/履歴タブ

## 背景（調査結果）

- ユーザーの体感「自動で doing に pick されない」はバグではなく v2 の設計。`src/core/loop.ts` 冒頭と `docs/FEATURE_MAP_V2.md:20` に「executor を持たない・状態を記録するだけ」と明記。
- ただし v1 は実際に移していた: `extensions/kanban.ts:7431` の `if (mp.autoPick && doingHeadOf(...) === undefined) pickFirstTodo(...)`、`pickFirstTodo` (`:1887`) は `mutateBoard` 内で `moveCardTo(live, "doing", actor)`。WIP=1（doing に自分のカードがあれば pick しない）。
- v2 の `readyCards` は done 列以外すべてを対象にするため、doing に居座るカード（現 DB の `nous#4`）を next に指名し続ける。v1 の `nextTodo` は `c.col === "todo"` 限定。
- UI は「成果物 / 履歴」を 1 枚のパネルに縦積み（`web/src/render.ts` の `renderPanel`、`panelTitle`）。成果物は増えて残り、履歴は `slice(-40)` で流れるため押し合う。

## 方針（ユーザー決定）

1. ループは **todo を doing へ移す**（v1 の autoPick と同じ体感、WIP=1、モデルは起こさない）。
2. 成果物と履歴は **右枠のタブ2枚**。

## 変更

### 1. `src/core/loop.ts`
- `readyCards` の対象を **`kind === "todo"` の列のみ**に変える（v1 `nextTodo` と同じ）。doing のカードは next にならない。
- 冒頭コメントを「tick は todo を doing に移す・モデルは起こさない」に更新。

### 2. `src/loop-runner.ts`（新規）
- `tickProject(db, projectId, now = ISO, actor = "loop"): { loop, nextCardId, moved } | null`
  - `getLoop` が running でなければ null。
  - `readBoard` → `tickLoop`。
  - `nextCardId !== null` かつ doing 列が空（WIP=1）なら `moveCard(db, projectId, id, doingId, { actor })`。
  - `saveLoop(db, result.state, actor, "loop.tick")`。
- doing 列が埋まっているときは move しない（`nextCardId` は候補として返す）。

### 3. `src/supervisor.ts`
- `tickAllLoops` の中身を `tickProject` 呼び出しに置き換える。try/catch と「板ごとに独立」は維持。
- 冒頭コメントに「tick は WIP=1 で次の TODO を DOING へ移す」を追記（「モデルは起こさない」は維持）。

### 4. `src/api/routes.ts` `postLoop` の tick
- `tickProject(db, project.projectId, now, ACTOR)` を使う。レスポンスに `moved` を足す。
- 「No executor: ...」コメントを実態に合わせる。

### 5. 文言（ドキュメント同期）
- `src/agent/adapter.ts` の resume 応答: 「the loop has no executor in v2: it records state and names the next ready card」→「tick で次の TODO を DOING へ移す（WIP=1）。モデルは起こさない」。
- `extensions/kanban-v2.ts` の HELP: `resume ... （実行器は無い・状態だけ）` → `（todo を doing へ送る・モデルは起こさない）`。
- `docs/FEATURE_MAP_V2.md:20` の末尾を同じ意味に更新。

### 6. `web/src/render.ts` パネルのタブ
- `View` に `panelTab: "deliverables" | "timeline"`（初期 `"deliverables"`）。
- `renderPanel` の先頭にタブ行（成果物 (n) / 履歴）。クリックで `view.panelTab` を変え、`view.panelSig = ""` にして `renderPanel(view, s)` を再実行。
- 選択中でないセクションは `hidden`。両セクションの組み立ては現状のまま。
- `panelSig` に `view.panelTab` を含める（早期 return でタブ切替が効くように）。
- ヘッダ `panelTitle` の「成果物 / 履歴」はタブと重複するので短い名前に変える。
- 開くボタン（`panelBtn`）は今の 1 つのまま。

### 7. `web/src/styles.css`
- `.panel-tabs` / `.panel-tab` の最小スタイル（`styles.css:86-91` の panel 群の隣）。

### 8. テスト
- 新規 `tests/unit/core-loop.test.mjs`: doing のカードを next に選ばない / todo の priority 順 / ready 無しで halt。
- `tests/integration/api-extras.test.mjs` の loop テスト: tick でカードが doing へ移る / WIP=1 で 2 枚目が動かない / todo が尽きたら halt。

## 受入条件
- `npm run test:v2:unit` と `node --test tests/integration/api-extras.test.mjs` が pass。
- `npm run typecheck:v2` が pass。
- 実ブラウザでパネルのタブ切替（成果物/履歴）が動く。
- 既存の `nous` 板では `#4` が doing に居るので、loop を start しても WIP=1 で何も動かない（安全）。

## リスク
- supervisor が 15 秒ごとに tick するため、loop を running にすると todo が 1 枚ずつ doing に流れる。`doing` の列が埋まれば止まる（WIP=1）。v1 と同じ。
- 自動移動で `card.moved` が timeline に増える（actor `loop`）。
