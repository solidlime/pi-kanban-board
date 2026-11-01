# #27 ボードキーの源泉を統一する

## 状態

**poll / refresh / settle は既に統一済み。** `extensions/kanban.ts:5292` の poll は
`{ scope: "project", key: projectSlugOf(cwdOfCtx(ownCtx)) }`、`extensions/kanban.ts:5959` の
settle は `boardKeyFor(ctx, sid, "project")` → `cwdOfCtx`。どちらも #26 の作業で
同じ源泉に落ちた（#26 の diff に poll のコメント
`// cwdOfCtx, not process.cwd(): refresh/settle use the ctx cwd, and a key mismatch here`
`// would poll a board nobody draws or settles.` が入っている）。

カード本文の `projectSlugOf(process.cwd()) → cwdOfCtx(ownCtx)` は poll については
**達成済み**。だが同じ「源泉のズレ」が 3 箇所に残っている。それらを潰すのが本 issue。

## 根因（2 つの源泉が実在する）

| 関数 | 源泉 | 定義 |
|---|---|---|
| `cwdOfCtx(ctx)` | `ctx.sessionManager.getCwd()` | `extensions/kanban.ts:409` |
| `cwdOfSidSync(sid)` | `sessionInfoCache.byId.get(sid).cwd`（セッションファイルのヘッダ。30s TTL） | `extensions/kanban.ts:402` |

**同一 sid で両者が違う値を返す状況は実在する**（pi ホスト側コードで確認）:

1. **別プロジェクトのセッションを resume した時** — `dist/main.js:335`
   `SessionManager.open(selectedPath, sessionDir)` は `cwdOverride` を渡さないので、
   `getCwd()` = **ヘッダの cwd**、`process.cwd()` = **起動ディレクトリ**。
   `main.js:311` に `"Session found in different project"` の分岐まである。
2. **記録された cwd が消えていて選び直した時** — `dist/main.js:563-566` は
   `SessionManager.open(..., selectedCwd)` と **cwdOverride を渡す**。`getCwd()` =
   selectedCwd、ヘッダ cwd = 古い値。キャッシュが warm でもズレる。
3. 補助要因: キャッシュ cold（`/api/dashboard` を一度も叩いていない）や TTL 30s の stale
   → `cwdOfSidSync` は `process.cwd()` に落ちる。

## 直す 3 箇所

### 1. `extensions/kanban.ts:5382` — `/kanban` コマンドの projKey（最大の実害）

```ts
const projKey = projectKeyOfWrite(sid) ?? projectSlugOf(cwdOfSidSync(sid));
```

このハンドラは `ctx` を持っている（`:5371 handler: async (args, ctx) =>`）。`take`(`:5396`)、
`add`(`:5463`)、drilldown の書き込みが **HTTP 側のキャッシュ cwd** へ行き、poll/settle は
ctx cwd を駆動する。resume セッションを repo B から起動すると `/kanban take` は repo B の
ボードの所有権を書き換え、ループは repo A を回す → **take したのにループが動かない**。

```ts
const projKey = boardKeyFor(ctx, sid, "project");
```

`projectKeyOfWrite` の「未知 sid は null」ゲートは HTTP のための防波堤で、コマンド内の sid は
常に生きたセッションなので不要。

### 2. `extensions/kanban.ts:5504` / `:5530` — drilldown が sid をキーに modes を読む

```ts
const cur = modesFor(readModesFile(), boardKeyFor(ctx, sid, scope), scope);   // :5504
const m = modesFor(readModesFile(), boardKeyFor(ctx, sid, scope), scope);     // :5530
```

書き手の `runModeCommand`(`:4974`) は `boardKeyFor` = **slug**。読み手だけ sid なので
存在しないキーを読み、`modesFor` の「不在キー = ON」既定（`:547-551`）に落ちる。
**loop を OFF にしてもメニューは ON と表示**、`intervalMinOf`/`stuckLimitOf` も既定値表示。
`:554` の #61 コメントが警戒しているのと同じ種類の嘘。

`scope` は `:5476` で `let scope: Scope = "project"`、`:5525` で `global` に反転しうる（`:5497` の
`switchOption` はその行のラベル）。よって `projKey` ではなく `boardKeyFor(ctx, sid, scope)` を渡す
（global のキーは sid、project のキーは slug = 書き手と同じ）。`GLOBAL` バケットに書く経路は
#26 以降ゼロなので global 面の差は表示に出ないが、**project 面は出る**: `PROJECT[slug]` に
`doingLoop: false` を置けば ⚙ 行は `loop: OFF`、旧読み手（sid キー → 不在キー = 既定）は
`loop: ON` と描く。固定は `tests/kanban-global-readonly.test.mjs` の SOURCE pin
（`modesFor(readModesFile(), boardKeyFor(ctx, sid, scope), scope)` の存在と、生の `sid` キーの不在）。

### 3. `extensions/kanban.ts:3514` — dashboardPayload の project 面だけ process.cwd()

```ts
const slug = projectSlugOf(process.cwd());
```

`/api/dashboard` は引数なしで呼ばれ（`:4016 void dashboardPayload()`）、リクエストに ctx は無い。
だが同じ関数が既に `:3486 await sessionInfoById()` でキャッシュを温め、`:3496 sidActor = activeSessionId`
で `loops`/`halted` をセッション基準で返している。project 面だけ process cwd を見ているのは不揃い。

```ts
const slug = projectSlugOf(cwdOfSidSync(null)); // activeSessionId の cwd
```

`:3574 modes: modesFor(f, slug, "project")` も同時に `/api/modes` の書き込み先と一致する
（今は dashboard が process cwd のスイッチを見せ、トグルはキャッシュ cwd のボードに書く、
という表示と書き込みの食い違いがある）。

**到達性の訂正**: 旧記述の「cold 時は現状と同値 = 厳密な上位互換」は誤りであり、
「fallback は `listAll()` 失敗時のみ＝実質到達不能」も誤り。`cwdOfSidSync` の `process.cwd()`
fallback は per-request で普通に起きる:

1. `activeSessionId === null`（`:6093` で shutdown 時に null 化、サーバは跨いで生存 `:6105-6107`）
   → `cwdOfSidSync(null)`（`:402-405`）は id が null で即 fallback
2. キャッシュ TTL 30s 内に作られた新規セッションは `byId` に居ない → fallback
3. ヘッダ cwd が `""`（旧セッション）→ fallback（下の「空 cwd」節）
4. `sessionInfoById()` の `listAll()` 例外 catch（`:3254-3257`）で `byId` が空 → 任意の sid が fallback

通常経路はヘッダ cwd に変わる（意図した変更）。

## 空 cwd（`cwd: ""`）は「cwd 無し」の第 3 の外れ方

`dist/core/session-manager.js:541` は**旧セッション**のヘッダに cwd が無い時
`const cwd = typeof header.cwd === "string" ? header.cwd : "";` を返す（型にも
`Empty string for old sessions` と明記）。`cwdOfSidSync` が `info?.cwd ?? process.cwd()` だと
`""` が素通りし（`??` は nullish しか見ない）、`projectSlugOf("")` が `inbox` を名乗る。
一方 `cwdOfCtx` は `typeof cwd === "string" && cwd !== ""` で fallback するので、
**同じ「cwd が無い」入力で 2 つの源泉が別ボードを名乗る**（`/api/dashboard` は `inbox`、
`/kanban`・poll・settle は `process.cwd()` のボード）。

到達経路は `dist/main.js:555-566` が `MissingSessionCwdError` から
`SessionManager.open(file, dir, selectedCwd)` で開き直したセッション（ヘッダ cwd は空のまま）が
`activeSessionId` の時。

修正は `:402-405` の 1 行（`cwdOfCtx` と同じ判定に揃えた）:

```ts
function cwdOfSidSync(sid: string | null): string {
	const id = sid === null || sid === "" ? activeSessionId : sid;
	const cwd = id === null || id === "" ? undefined : sessionInfoCache?.byId.get(id)?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}
```

回帰テストは `tests/kanban-dashboard-empty-cwd.test.mjs`（**新しい実行 cwd が必要**）。
`git -C ""` は git 2.x で自プロセスの cwd を指すので、repo の中で走らせると
`projectSlugOf("")` が偶然 `process.cwd()` の slug に化けて差が出ない。よって
`mkdtempSync(tmpdir())` に `chdir` してから偽 HOME を組む（`/tmp` は Windows ではドライブ相対なので
chdir を先に）。終了時に `process.chdir(ORIG_CWD)` で戻してから rm（Windows は cwd を消せない）。

## そのままにする箇所

- `extensions/kanban.ts:3592 projectKeyOfWrite` / `:4027 /api/kanban` / `:3628 settingsSidOf` —
  HTTP に ctx は無く、未知 sid を弾く必要がある。`cwdOfSidSync` が唯一の扉
- `extensions/kanban.ts:6100 before_agent_start` — ctx があるので `cwdOfCtx(ctx)` が正解
- **dashboardPayload（`:3514`）の残差**: `:3514` が見るのはセッションファイルの**ヘッダ cwd** で
  あって ctx cwd ではない。`dist/main.js:563-566` のように `cwdOverride` を渡して開き直した
  セッションではヘッダ cwd が古いまま残り、project 面は記録時のボードを名乗る。直すには
  module レベルの driver cwd が要る（`dashboardPayload` は module 直下、`ownCtx` は default
  export のクロージャ内なので `cwdOfCtx` を渡せない）。#27 では閉じない

## テスト

`tests/kanban-poll-timer.test.mjs` に section 5 を追加。`ctxWithCwd` 相当をローカルに作る
（既存の `mkCtx` は `getCwd` を持たず `cwdOfCtx` が `process.cwd()` に落ちる前提で書かれている）。

- `mkdtempSync` で実行 cwd と**別の**ディレクトリを作り、`assert.notEqual(OTHER, SLUG)` で
  空振りを防ぐ
- そのディレクトリのボードにだけ DOING カードを 1 枚置き、実行 cwd のボードは空のまま
- `getCwd: () => otherDir` を持つ ctx で `session_start` → `poll()`
- **assert**: `sent.length === 1`（旧実装なら空ボードを読んで 0）、`sent[0]` に
  `DOING #7 "elsewhere"`
- **assert**: footer 2行目（`:1175` の `PROJECT: \${projectKey}: ...`）が `OTHER` を名乗り、
  件数が `0 todo / 1 doing`（旧実装は `0 todo / 0 doing`）

これで poll と refresh の両源泉を 1 本で固定できる。settle は `boardKeyFor` 共有で同一経路。

`:5382`（`/kanban add|take`）と `:3514`（dashboard）は別ファイルで固定する:

- `tests/kanban-cli-global-reject.test.mjs` — `getCwd: () => otherDir` の ctx で `kanban("add")`。
  `OTHER` のボードに入り、実行 cwd の `SLUG` のボードには入らない
- `tests/kanban-dashboard-cwd.test.mjs` — `$HOME/.pi/agent/sessions/<dir>/<sid>.jsonl` にヘッダ
  `cwd = otherDir` の 1 行目（`{type:"session",version:3,id,cwd}`）を置き、`session_start` →
  `GET /api/dashboard`。`project.id === OTHER`、件数と `project.modes` が `PROJECT[OTHER]` の値
  （セッション形式は `dist/core/session-manager.js:505-513` のヘッダ読みだけで足りる）
- `tests/kanban-dashboard-empty-cwd.test.mjs` — 同じハーネスでヘッダ `cwd: ""`。
  `project.id` が `inbox` ではなく `process.cwd()` の slug になること（上の「空 cwd」節）

`PI_CODING_AGENT_DIR` ガード: これら 2 本は偽 HOME を使うので、テスト冒頭で
`delete process.env.PI_CODING_AGENT_DIR` が要る。`getAgentDir()` は `PI_CODING_AGENT_DIR` が
あると HOME を無視するので、設定済みのシェルから走らせると偽 HOME の sessions/ を見ずに
`/api/dashboard` が実セッションを引く。したがって:

- テスト内で必ず `delete` する（両ファイルとも実施済み）
- 検証時は `PI_CODING_AGENT_DIR="C:/tmp/kb-fake-agent-dir" node tests/kanban-dashboard-cwd.test.mjs`
  でも緑になること（ガードが効いていることの確認）

## スコープ外

- `tests/kanban-poll-timer.test.mjs:78` の `writeModes` が `SESSION` バケットに書いている
  （poll は `PROJECT[slug]` を読む。通るのは「不在キー = ON」の既定頼み）。レガシー残留だが
  #27 の主題ではない
- `extensions/kanban.ts:3574` の `modes` が slug キー / `loops` が sidActor キーという設計
  （count はセッション、スイッチはボード — 意図どおり）
