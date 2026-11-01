# #26: scope=global の doingLoop / autoPick が構造的に無効

## 症状

`scope=global` のループスイッチ（doingLoop / autoPick）は、どこから見ても動いていないのに、
UI と CLI と `/api/modes` からは本物の設定のように見える。

- ダッシュボード GLOBAL 行の「ループ / ピック」ボタン: 押せない（`boardCtx("global", "", false)` で `disabled`）
- dashbord 設定タブの GLOBAL 行: 同じく非活性
- footer 1 行目（`extensions/kanban.ts:1166`）: `GLOBAL[sid]` 未登録なら legacy flat 既定で両方 ON になり、**どのセッションでも常に ` loop pick` と表示される**
- `/api/modes?scope=global&key=doingLoop&value=off`: 200 を返し `modes.json` の `GLOBAL[sid]` に書く
- `/kanban loop off global`: 受け付ける

そして実際の駆動経路では全部 no-op:

| 経路 | なぜ無効か |
|---|---|
| `candidates(key, "global", f, actor)`（`extensions/kanban.ts:1359`） | `doingHeadOf` → `readBoard(boardPath("global", key))` |
| `doingHeadOf(key, "global", actor)`（`:1354`） | 同上 |
| `pickFirstTodo(sid, "global", actor)`（`:1619`） | `boardPath("global", sid)` で書こうとする（が、まず空なので null） |
| poll（`:5263`）`{ scope: "global", key: sid }` | `boardPath` が key を捨てる |
| settle autoPick の `for (const scope of ["global","project"])`（`:5956`） | global の `pickFirstTodo` が常に null |
| settle の駆動カード選定（`:5972`）`let scope = "global"; candidates(keyOf("global"), ...)` | 常に undefined |

## 根因

`boardPath(scope, key)`（`extensions/kanban.ts:346-347`）は `scope === "global"` のとき
**常に `GLOBAL_JSON` を返し、key を捨てる**。そして #16/#17 の移行後、`GLOBAL_JSON` は
**常に空**（`extensions/kanban.ts:5457` のコメント「GLOBAL_JSON is always empty」）。

つまり global は「全 project ボードの読み取り専用集約ビュー」であってボードではない。
ボードでないものに「どのカードを駆動するか」というスイッチを載せたのが誤り。

`plans/issue-19-next-up.md:5` に既に書かれていた:
> GLOBAL は読み取り専用の集約ビューなので「次を決める」場所にしない（#26 で global の doingLoop が構造的に無効と分かっているのと同じ筋）。

## 唯一 mg が実効を持つ場所

`extensions/kanban.ts:5931`:

```ts
if (!mg.doingLoop && !mg.autoPick && !mp.doingLoop && !mp.autoPick) return;
```

global を両方 OFF にすると settle 全体が早期 return する。実害は「何もしない」なので無害だが、
意味が嘘（global が project の駆動を止めているように読める）。`mg.autoPick` はこれ以外に読まれず、実効ゼロ。

## 方針: 案A — global からスイッチ概念を削除する

#17 で `scope=session` をボードから外した瞬間に 400 にし、`modes.json` の `SESSION` バケットも
削除した。同じ判断を `GLOBAL` バケットにも適用する。`GLOBAL` だけ残ったのは、当時
「global にもスイッチがある」という前提を検算しなかったから。

**`Scope` 型から `"global"` は消さない。** 集約ビューとしての global（`aggregateGlobal()`、
`/api/kanban?scope=global`、ダッシュボードの GLOBAL タブ、`tests/kanban-global-aggregate.test.mjs`、
`tests/kanban-global-readonly.test.mjs`）は生きている。消すのは**スイッチとしての global** だけ。

### 却下した案

**案B: global の doingLoop を「全 project ボードのマスタースイッチ」にする**

却下。根拠 3 つ。

1. **ゲートが 1 本しかない。** `:5931` を `mg` 主導にすると「master ON + project 両 OFF」で settle が
   通過し、`candidates(projectKey, "project", ...)` が DOING を見つけて **project の doingLoop が
   OFF なのに発火する**。だから `mp` 単独ゲートを併記する必要があり、`mg.doingLoop` は「AND で
   引くだけ」の第 2 スイッチになる。引くだけのスイッチは `mp` で足りる。
2. **autoPick を master 化できない。** settle が知っている project ボードは cwd の 1 枚だけ
   （`:5258-5263` のコメント「2 枚で十分、全 project を読むのは verdict の無いコスト」）。
   全 project の autoPick を回すには全ボード列挙が要る＝新しい状態。`ModePair` は 2 フィールド
   必須なので、片方だけ master 化すると GLOBAL 行が非対称になり `boardCtl` のレイアウトも崩れる。
3. **master が sid キーである以上、名前が嘘になる。** `GLOBAL` は `Record<sid, ModePair>`。
   全 project の master を名乗るものが per-session なのは #26 と同じ種類の嘘。

**案C: 残すが駆動から切り離し「効かない」と明記する**

却下。`/api/modes?scope=global` の 200、`global.modes` ペイロード、`settingsSidOf` の
`activeSessionId` フォールバックが残る。この 3 つは全部「global にスイッチがある」前提の
生き残りで、次に誰かがこれを見て「global スイッチを実装しよう」と思う。注記は型と削除に負ける。

## 変更

### C1: 計画書（このファイル）

### C2: 駆動経路から global を削除

| file:line | 変更 |
|---|---|
| `extensions/kanban.ts` `LoopState.scope` の型 | `Scope \| null` → `"project" \| null`（型で締めて将来の復活をコンパイルエラーにする） |
| `:4871` `restoreLoop` | `legacyGlobal = d.scope === "global"` なら **count / halted / stuckId / stuckCount を全て落とす**（scope だけ null にすると `paintLoop` が project として読み、上限到達済みの旧 global 予算が最初の settle で偽 HALTED を起こす）。`d.scope === undefined` の #17 以前エントリは正規な project カウントなので保持 |
| `:1166` `refresh` | GLOBAL 行から `loopTagFor(sessionId, "global")` と `modeTags(f, sessionId, "global")` を削除。集約ビューにスイッチ表示は無い |
| `:5261-5264` poll | `boards` から `{ scope: "global", key: sid }` を削除 |
| `:4951` `resumeWithModes` | `setMode(f, sid, "global", "doingLoop", true)` を削除、doc comment の "All three" を修正 |
| `:5805` tool resume | cap を `modesFor(readModesFile(), boardKeyFor(ctx, sessionSid, "project"), "project")` から読む。メッセージの "(session+global+project)" を "(project)" に |
| `:5926` | `keyOf` を削除し `projectKey` に一本化 |
| `:5928` `:5931` | `mg` を削除、`if (!mp.doingLoop && !mp.autoPick) return;` |
| `:5936` | `const driving = "project"` |
| `:5956` autoPick | `for (const scope of ["project"])` に。コメントの "GLOBAL first" を削除 |
| `:5972-5976` | `const scope: Scope = "project"; const card = candidates(projectKey, "project", f, sid);` |
| `:5998` | `modesFor(f, projectKey, "project")` |
| `:6001` | `setMode(f, sid, "global", "doingLoop", false)` を削除、コメントの "Both boards" を修正 |

**テスト書き換え（4 本）**: `tests/kanban-loop-limit.test.mjs:253`（cap の GLOBAL 断言を削除）、
`tests/kanban-loop-limit.test.mjs:349`（resume の両スコープ → project のみ）、
`tests/kanban-phase10.test.mjs:338`（`fg.GLOBAL[G].doingLoop` 断言を削除）、
`tests/kanban-resume.test.mjs:205`（両スコープ → project のみ）。

### C3: UI

| file:line | 変更 |
|---|---|
| `web/dashboard.html:1423` | GLOBAL ヘッダの `loopRestLine(maxLoopsOf(g && g.modes), loopCountOf("global"))` を削除（駆動しない盤面に「残り N / M」は無い） |
| `web/dashboard.html:1541` | `renderSettings` の GLOBAL 行を削除。GLOBAL は設定を持たないので行ごと消す（`#58` の halt 表示も駆動しないので不要） |
| `web/dashboard.html` `boardCtl` | 変更不要（global に呼ばれなくなる） |

`npm run build` を忘れると `tests/web-build.test.mjs` が落ちる。`web/dashboard.generated.ts` もコミット。

**テスト書き換え（1 本）**: `tests/kanban-dashboard-settings.test.mjs:162-196`（行数 `2` → `1`）。

### C4: HTTP / CLI の契約反転

| file:line | 変更 |
|---|---|
| `:3569` `SWITCH_PATHS` | 削除 |
| `:3618-3640` `settingsSidOf` | global 分岐（`sid ?? activeSessionId`）を削除し、常に key を返す |
| `:4331` ほか | `/api/modes` `/api/interval` `/api/stuck` `/api/maxloops` `/api/resume` で `scope=global` は 400。文言は `"global は集約ビューでスイッチを持たない（scope=project を使う）"` |
| `:3538-3540` `dashboardPayload` | `global.modes` を削除。`global.loops` と `global.halted` は「駆動しない盤面の実測値（常に 0/false）」として残す |
| `:4044` `/api/kanban` | `modes.global` を削除 |
| `:4967` `runModeCommand` | `global` 指定を notify で拒否、usage 文字列から `[global]` を外す |

**テスト書き換え（7 本）**: `tests/kanban-auth.test.mjs:143-157`、`tests/kanban-phase5.test.mjs:301`、
`tests/kanban-phase6.test.mjs:223-240`、`tests/kanban-maxloops.test.mjs:264-282,316-329`、
`tests/kanban-loop-limit.test.mjs:173,303`、`tests/kanban-fire.test.mjs:424`、`tests/kanban-dashboard.test.mjs:167`。

**削除するテストは 0 本。全部「書き換え」** — 消すと「global に書けないこと」を固定する網が無くなる。

## 触らないもの

- `Scope` 型から `"global"` を消すこと（集約ビューが死ぬ）
- `boardPath` / `boardKeyFor` / `aggregateGlobal()` / `resetScopesOnce`
- ボード書き込みの global 拒否（`:3591-3598`、`:5676`、TUI の `globalReadOnly()`）。正しいので触らない
- `modes.json` の `PROJECT` バケット
- `GLOBAL` バケットの移行コードは書かない。`readModesFile` は `JSON.parse` をそのまま流すので未知キーは読まれない。`writeModesFile` は `JSON.stringify(f)` なので preserve される（消えても構わない）

## 副作用

- **`refresh` の GLOBAL 行（`:1166`）が最大の見落とし。** ここを直さないと settle をどれだけ綺麗にしても footer は `GLOBAL: 2 todo / 1 doing loop pick` と嘘を出し続ける
- `global.halted` は恒久的に false、`global.loops` は恒久的に 0 になる。payload の形はテストが固定しているので残すが、**状態ではなく「駆動しない盤面の実測値」**
- `/api/resume` の 202 キュー（`resumeRequests`）は `settingsSidOf` の戻り値でキーされる。C4 でフォールバックが消えるので、キューに GLOBAL 由来の sid キーが残らないことを確認する
- `prune`（死んだ sid の modes 掃除）は**存在しない**（`tests/kanban-stuck-clear-tick.test.mjs:110` のコメントが古いだけ）。`modes.json` に死んだ `GLOBAL` 行が溜まっていても放置でよい

## 検証

各コミットで `npm test` green。C3 は `npm run build` 後に `tests/web-build.test.mjs` が通ること。

### C2 のテスト書き換え（実測で 4 本 → 10 本。計画時の見落としを追記）

C2 適用後の `npm test` は 194 中 7 本 fail（+ 並列 flake 1 本）。計画で挙げた 4 本に加えて、
**「GLOBAL ボードを駆動する」前提で書かれたテストが 6 本あった**。

決定的な根拠: `tests/kanban-todo-ownership.test.mjs:146` のコメントが既に書いている —
> global は読み取り専用の集約ビューになった（書き込みは 400）ので、共有ボードへの書き込みは project スコープ。

つまり global への書き込み経路は #17/security で 400 に塞がれており、これらのテストは
`global.json` を**ファイル直書き**して「UI から到達不能な状態」を作っていた。よって #26 の
根因分析（candidates/pickFirstTodo が global で常に空）は正しく、古い前提に乗っているのはテスト側。

| テスト | 落ちる理由 | 書き換え方針 |
|---|---|---|
| `tests/kanban-wip.test.mjs` の「3 他者 DOING は WIP 扱いしない: GLOBAL TODO を拾う」 | `writeGlobalFile` に積んだ TODO を settle が拾う前提。案A では拾わない | project ボードで同じ検証（他者 DOING + 自 TODO を project に置き、自 TODO が doing になる）。`setModes(S,"global",...)` は削除 |
| `tests/kanban-todo-ownership.test.mjs` の 1 / 1b / 1c / 2 / 3 / 4 | 同上。`writeGlobalFile` + `pickFirstTodo(sid,"global")` + `nextTodo(cards,"global",A)` + `continuationPrompt(card,"global")` | 駆動対象を project ボードに置き換える。`pickFirstTodo(sid,"project")`、`nextTodo(cards,"project",A)`、`continuationPrompt(card,"project")`。assert の `^GLOBAL TODO #1` → `^PROJECT TODO #1`。P1〜P4 の純関数テスト（`nextTodo(...,"global",A)`）は **scope 非依存の単体テストなので残してよい** |
| `tests/kanban-poll-observability.test.mjs` 「カード無しはどちらの板も skip:no-card」「project 板の行は発火」「トレースに sid/idle/…」「2 tick 目の project 行は skip:interval」「再起動後の初回 tick」 | poll の板が 2 枚前提（行数・正規表現・`1 !== 2`） | 板 1 枚前提に。行数カウントを 2 → 1、`どちらの板も` → `project 板は`、GLOBAL 行を期待する assert を削除 |
| `tests/kanban-phase11.test.mjs` 「live: GLOBAL の拾える TODO で 1 回 wake するはず」 | 同上 | global.json に積んで wake を期待している。**「global に積んでも wake しない」を固定する断言に反転**（案A の退行防止網になる）か project 版に置換 |
| `tests/kanban-phase10.test.mjs` 「live: Cannot read properties of undefined (reading 'doingLoop')」 | `fg.GLOBAL[G].doingLoop` が undefined（`GLOBAL[G]` が作られなくなった） | GLOBAL 断言を削除 |
| `tests/kanban-loop-limit.test.mjs` 「上限停止は doingLoop を両スコープで OFF にする」「再開は global と project の doingLoop を ON に戻す」「resume は可変の上限を反映した残量を返す」「resume は ON にしたスコープを報告する」 | 4 件。両スコープ前提 + メッセージ `(session+global+project)` 期待 | 両スコープ → project のみ。メッセージ期待を `(project)` に |

**並列 flake**: `tests/kanban-dashboard-collapse-search.test.mjs` は単体実行で 33 pass / 0 fail。
`npm test` の並列実行時のみ落ちる（`~/.pi/kanban` の共有 state 競合）。#26 の変更とは無関係。

**削除するテストは 0 本。全部「書き換え」** — 消すと「global では駆動しない」を固定する網が無くなる。

