# card 26: doing の wake は「止まったときだけ」注入する

ユーザーの指摘（原文）: 「doingのメッセージ注入なんだけど、エージェント処理中にキュー入れる必要なくない？完全にとまっちゃったときにいれるべきだよ」

## 0. 実測（pi-web 0.11, http://127.0.0.1:8787）

### `GET /api/agent/<id>?systemPrompt=0` — 新しく busy 判定に使う口
```
{"running":true,"state":{
  "isStreaming":true,"isPromptRunning":false,"isCompacting":false,"isBashRunning":false,
  "pendingMessageCount":2,
  "queuedMessages":{"steering":[],"followUp":["[kanban nous#44] …","[kanban nous#44] …"]},
  "messageCount":0,"thinkingLevel":"max", …}}
```
- `running:false` = pi-web が in-memory agent を持っていない（idle 確定）。`true` は「生きている」だけで idle を含む
- `?systemPrompt=0` で body が 5.8KB → 1.1KB に落ちる。付けないと KB 級
- **`pendingMessageCount` と `queuedMessages` は `state` の内側**。トップレベルには無い（2026-11-17 に `curl … | python3` で実測: `top-level: <absent>` / `state.pendingMessageCount: 5`）
- **`isStreaming` と `isPromptRunning` は独立**。上の実測で同時に `isStreaming:true / isPromptRunning:false` が成立した。片方だけでは busy を取りこぼす
- `pendingMessageCount` と `queuedMessages.followUp` が「積まれている数」をそのまま返す

### `/api/agent/running` — 既存。`runningSessionIds` を busy 判定に使ってはいけない
`{"runningSessionIds":["01a1e84c-…","01a1e7f6-…"],"subagentsActiveSessionIds":["01a1e84c-…"],…}`
集合の算出元が未確認で、「in-memory agent が生きている」寄りの意味。busy（ターン中）とは別物なので **busy 判定に使わない**。`session-lock.ts:65` の `runningInPiWeb()` は private のまま、用途も現状（二重書き手の検出）に限る。

### 現場で起きている実害
nous#44 のカードプロンプトが `followUp` に **2件**、`pendingMessageCount: 2`。
`adapter.ts:523` の move 即時 wake と `supervisor.ts` の tick wake が両方積んだ実物。ターン終了後に同じカードのプロンプトが2回連続で走る。

## 1. 現在の挙動と穴

| 場所 | 現状 | 穴 |
|---|---|---|
| `src/agent/driver.ts:144` | `{type:"prompt", message, streamingBehavior:"followUp"}` | busy なセッションに積む。積んだプロンプトは必ず消費されるので、ターンが長引くほど「もう done のカード」を触る。#24 で潰した穴の再発 |
| `src/agent/driver.ts:183-193` | `null` を返す | 「busy で見送った」「in-flight」「not-doing」「locked」「spawn 失敗」を全部潰している。呼び出し側が再試行の可否を決められない |
| `src/supervisor.ts:56` | `log.set` が wake の**前** | 配送しなかった場合も 5 分待つ。busy で見送ったときは次 tick で起こしたいのに、それができない |
| `src/agent/driver.ts:139-141` | コメント「busy でも届かせろ」 | 今回で反転する |

## 2. 設計（ルアン・メェイの BLOCK を反映）

### 不変条件
- **busy は「肯定」でしか判定しない**。判定できない（非2xx / JSON 不能 / timeout / connect 拒否）は **idle 扱いで POST を試す**。間違えて idle と読む代償は拒否1回、間違えて busy と読む代償はカードが永遠に動かないこと。非対称
- `streamingBehavior:"followUp"` は**削除**。残すと race が「古いプロンプトが後で流れる」形で隠れ、#24 が戻る。pi は streaming 中の素の `prompt` をエラーで返す（`@earendil-works/pi-coding-agent/docs/rpc-commands.md:29-31`）ので、**送信自体が busy の原子テスト**になる
- `accepted:false` を busy の証拠にしない。404 `Session not found` にも付く。busy を名乗れるのは probe の肯定だけ

### (1) `src/agent/driver.ts` に private probe を足す

```ts
type BusyProbe = "busy" | "idle" | "unknown";
async function probeSession(base: string, sessionId: string, doFetch: typeof fetch): Promise<BusyProbe>
// GET `${base}/api/agent/${sessionId}?systemPrompt=0`, AbortSignal.timeout(1000)
// !res.ok                          -> "unknown"
// body.running === false           -> "idle"
// state.isPromptRunning || state.isStreaming || state.isCompacting
//   || state.pendingMessageCount > 0 -> "busy"   ← pendingMessageCount は state の中
// それ以外                          -> "idle"
// throw / JSON 不能                 -> "unknown"
```

`pendingMessageCount > 0` を busy に含めるのは、**既に積まれている wake の二重積みを止める**ため（nous#44 の実例）。積まれた分は必ず実行されるので、カードは動く。

### (2) `wakeInPiWeb`
- `sessionId !== null` のときだけ probe → `"busy"` なら POST せず `{refused:"busy"}`
- body から `streamingBehavior` を削除
- `"unclear"` 文字列 → `{refused:"unclear"}`

### (3) 戻り値の型

```ts
export type WakeRefusal = { refused: "busy" | "in-flight" | "unclear" | "not-doing" | "locked" | "spawn-failed" };
export async function wakeCardSession(...): Promise<WakeResult | WakeRefusal>
```

`refuse(why)` を理由付きに。`running`/`waking` の重複は `"in-flight"`（adapter の即時 wake と tick が重なると、その tick の log が進んで busy と同じ穴が空くため）。

### (4) `src/supervisor.ts:50-62`
- `log.set` を wake の**後**に移す
- `refused === "busy" || refused === "in-flight"` のときだけ log を進めない（次 tick で再試行）
- それ以外（`unclear` / `not-doing` / `locked` / `spawn-failed`）は進める（既存の 5 分間隔を維持し、POST ストームを防ぐ）
- 二重 wake は既存の `inFlight` と末尾の `await Promise.allSettled(pending)` が防ぐ（tick は重ならない）

### (5) `src/agent/adapter.ts:523` は変更なし
`wakeCardSession` を通るので busy 判定は自動で効く。`.catch(()=>{})` が busy も飲むのは正しい（supervisor が拾う）。

### (6) `buildCardPrompt` の「まず doing か確認」ガード（`driver.ts:44-46`）は残す
followUp を外しても、配送済みプロンプトとカード移動の race は残る。プロンプト側の防御は #24 のもう半分。

## 3. 触るファイル
- `src/agent/driver.ts`（probe 追加、followUp 削除、戻り値型）
- `src/supervisor.ts`（log.set の位置と条件）
- `tests/unit/agent-driver.test.mjs`（既存 325 行の followUp アサートを差し替え）
- `tests/unit/supervisor.test.mjs`（`async () => null` スタブを `{refused:"unclear"}` に）
- `docs/W2_API.md` の wake 記述があれば同期

## 4. テストケース

`tests/unit/agent-driver.test.mjs`
1. streaming なセッション → `{refused:"busy"}`、`/api/agent/<id>` への POST が **0 件**
2. `isStreaming:false, isCompacting:true` → busy
3. `isStreaming:false, isPromptRunning:true` → busy（実測で独立なので必須）
4. `state.pendingMessageCount:2` → busy（二重積み防止。トップレベルでは**ない**）
5. probe が 500 / 非 JSON / ECONNREFUSED / timeout → busy にしない、POST は実行される
6. probe idle → POST body に `streamingBehavior` キーが**存在しない**
7. 新規セッション（sessionId null）→ probe の GET が 0 件
8. `running:true, isStreaming:false, isPromptRunning:false, pendingMessageCount:0`（pi-web で開いているだけの idle）→ 配送される
9. 既存の「500 prompt_rejected → refusal, spawn しない」「404 → refusal」「2xx 無体 → 配送」を維持

`tests/unit/supervisor.test.mjs`
10. `{refused:"busy"}` → `WAKE_RETRY_MS` 未満でも次の tick で再度呼ばれる **← 今回の核心**
11. `{refused:"in-flight"}` → 同様に再試行
12. `{refused:"unclear"}` / `{refused:"not-doing"}` → 5 分は呼ばれない
13. 配送成功 → 5 分は呼ばれない（既存維持）

## 5. 検証
- `npm run typecheck:v2`
- `npm run test:v2`（351 本が緑のまま + 追加分）
- `npm run build:v2`
- 実機: doing にカードを1枚置いて、`GET /api/agent/<id>?systemPrompt=0` の `pendingMessageCount` が増えないこと、ターン終了後に 1 回だけ配送されること

## 6. やらないこと
- `runningSessionIds` を busy 判定に使う（意味未確認）
- busy なセッションへの強制注入・abort（他人のターンを壊す）
- ハングの TTL 検出。可視化だけ足す: busy 連続の最初の 1 回だけ `console.error`（supervisor の log entry に `busy?: true` で dedupe）。pi-web 側のハングは `/api/loop` に出ないので今日は見えない、という宿題はここに明記して残す
- `unclear` の retry 短縮（POST ストームとのトレードオフ。証拠が出るまで入れない）
