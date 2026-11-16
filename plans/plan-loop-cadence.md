# plan: ループの自動起動と「次はいつ」カウントダウン

## 症状（報告済み）
- pi-web 再起動後、`nous` の loop は `running` / `ticks 15` のまま `lastTickAt` が止まっている（15:xx のまま）。
- todo #7 が doing に移らず、セッションも起きない。

## 原因
`src/agent/adapter.ts:112` が `startServer({ home })` を呼び、`loop` オプションを渡していない。
`src/api/start.ts` は `loop` 未指定なら `loopMs = 0` → `startSupervisor` を立てない。
8789 は pi-web プロセス内の adapter が握っているので、**supervisor が一度も起動していない**。
（`ticks: 15` は再起動前の旧プロセスが残した値。）

## 直すこと

### 1. adapter で supervisor を起動する
`src/agent/adapter.ts` の `openRuntime()`:
```ts
const loopMs = Number(process.env.KANBAN_LOOP_MS ?? SUPERVISOR_INTERVAL_MS);
const run = await startServer({ home, loop: Number.isFinite(loopMs) && loopMs > 0 ? { intervalMs: loopMs } : false });
```
- `SUPERVISOR_INTERVAL_MS` を `../supervisor.js` から import。
- `KANBAN_LOOP_MS=0` で無効化できる（テスト・静かな環境向け）。
- EADDRINUSE で attach した場合はサーバーを持たないので何もしない（現状のまま）。

### 2. 次 tick の時刻を API に載せる
- `src/api/server.ts` の `ServerDeps` に `loopMs: number`（既定 0）を追加。
- `src/api/routes.ts` の `Ctx` に `loopMs` を通し、`getLoopRoute` の応答に
  `nextTickAt: string | null` を足す。
  - `loop.status === "running" && loopMs > 0` のときだけ
    `new Date(Date.parse(loop.lastTickAt) + loopMs).toISOString()`、それ以外は null。
  - `lastTickAt` が空/null なら null。
- `src/api/start.ts` で `opts.loop` から `loopMs` を計算して `createServer` に渡す
  （既存の `loopMs` 計算を再利用する。二重計算しない）。

### 3. UI のカウントダウン
`loopText`（`web/src/render.ts:846-848`）は今 `tick N` だけ。
- `web/src/api.ts` の loop 型に `nextTickAt: string | null` を足す。
- `renderLoop` で `nextTickAt` を `view.loopText.dataset.nextTickAt` に保存し、
  表示は `tick N · 次 12s`（残り 0 以下は `まもなく`）。
- 1 秒ごとの更新は `web/src/app.ts` に `setInterval(..., 1000)` を 1 本足し、
  **テキストだけ差し替える**（`loadBoard` は呼ばない＝再描画しない）。
  `document.hidden` のときは何もしない（既存の POLL と同じ扱い）。
- スタイル追加は不要（`loop-txt` のまま）。等幅数字は既に `font-variant-numeric: tabular-nums`。

### 4. ドキュメント
`docs/FEATURE_MAP_V2.md` のループ節に「adapter が既定 15 秒で supervisor を立てる」「`KANBAN_LOOP_MS=0` で無効」「UI は次 tick までの残り秒を出す」を 1〜2 行。

## 触ってはいけない
`src/agent/driver.ts` / `src/supervisor.ts` / `src/loop-runner.ts` / `src/core/*` /
`web/dist/*`（`npm run build` の生成物だけ）。

## 検証
```
npx tsc -p tsconfig.v2.json --noEmit
npx tsc -p web/tsconfig.json --noEmit
npm run test:v2:unit
node --test tests/integration/api-extras.test.mjs
npm run build
```
`nextTickAt` の計算に 1 ケース（running + loopMs>0 → ISO、loopMs=0 → null）。
`tests/integration/loop-supervisor.test.mjs` は実 spawn しない（wake 注入済み）ので触らない。

## 未検証として残す
- 実ブラウザでのカウントダウン表示。
- 実 spawn と pi-web 側のセッション表示。
