# #23 週次サマリの自動生成

ユーザー決定（ask_user_question 済み）:
1. **内容** = 完走＋停滞＋ブロックの一覧（プロジェクト別・決定論的・LLM 呼び出しなし）
2. **出力先** = ダッシュボードの新タブ「週次」
3. **トリガー** = tick が週変わりを検知したら自動生成

## 設計判断

### 保存先は既存の `meta` テーブル（新テーブルを作らない）
`extensions/db.ts:170` に `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)` が
既にあり、`getMeta`/`setMeta` が `db.ts:117-118`（型）と `db.ts:507-513`（実装）にある。
週次サマリは「キー = ISO 週、値 = その週の JSON」の 1 行で足りるので、**migration 不要**。
`card` に列を足す必要もない（サマリは導出物で、カードの属性ではない）。

- キー: `weekly:<week>` → `WeeklySummary` の JSON
- キー: `weekly:lastWeek` → 直近に観測した ISO 週（週変わりの検知用）

### なぜ保存が要るのか（計算だけでは足りない理由）
`moved_at` は**上書きされる**（`stampMove()` = `extensions/kanban.ts:903-906`、同一列への移動は
no-op で stamp しない #18）。週をまたいでカードを動かすと「先週 done した」事実が消える。
だから**先週分は確定させて残す**必要がある。今週分は毎回計算し直して上書きすればよい。

近似としての限界（仕様として受け入れる）: done → doing → done と往復すると完了時刻は最新に
なる。`card` に作成時刻が無いので「今週追加されたカード」は**集計に含めない**。

### tick への相乗り（新規タイマーを作らない）
`poll()` = `extensions/kanban.ts:5040`。先頭で `sweepServeThrottled()` が既に「毎 tick 呼ぶが
中で時刻スロットルする」パターン（`kanban.ts:1951-1960`、`SERVE_SWEEP_MS` で 1 時間）。
週次も同じ形で 1 行足す。**`setInterval` を増やさない**（`ensurePollTimer()` が唯一の
タイマー生成箇所 `kanban.ts:4999-5003` という不変条件を壊さない）。

`lastTickAt` / `tickInFlight` は auto-tick 専用なので**触らない**（`kanban.ts:4647`, `:5113`）。

### ロジックは純関数に切り出す（テスト直撃のため）
`isoWeek` / `weekRange` / `weeklySummary` は `Date` と `Card[]` だけを受け取る純関数にする。
tick・HTTP・GUI はそれらを呼ぶだけ。`projectRollup`（`kanban.ts:3139`）を再利用しない理由は、
その入力型 `RollupCard`（`kanban.ts:3103-3111`）が **movedAt を持たない**ため。

## 型

```ts
export type WeeklyBuckets = {
  done: { id: number; text: string; at: number }[];      // moved_at が週内 && col === "done"
  stale: { id: number; text: string; days: number }[];   // col === "doing" && age >= 1 日
  blocked: { id: number; text: string; blocked: string }[]; // blocked が非空
};
export type WeeklySummary = {
  week: string;        // "2026-W35"
  from: number;        // ISO 週の月曜 00:00 UTC (epoch ms)
  to: number;          // 翌週月曜 00:00 UTC
  generatedAt: number;
  projects: ({ slug: string } & WeeklyBuckets)[];
  totals: { done: number; stale: number; blocked: number };
};
```

## 実装箇所

### `extensions/kanban.ts`
| 何 | どこ |
|---|---|
| `isoWeek(d: Date): string` | 純関数群の並び（`staleSince` `:1002` の近く）|
| `weekRange(week: string): { from: number; to: number } \| null` | 同上 |
| `weeklySummary(boards, week, now): WeeklySummary` | 同上。`boards` は `{ slug, cards }[]` |
| `weeklyTickThrottled(): void` | `sweepServeThrottled` の隣（`:1958` 付近）|
| `poll()` に 1 行 | `extensions/kanban.ts:5086` の直後 |
| `weeklyPayload(week: string \| null)` | `projectsPayload()` `:3215` の隣 |
| `GET /api/weekly` | `/api/projects` の隣（`:3868` 付近）|

`weeklyTickThrottled` の中身:
```ts
const WEEKLY_MS = 3_600_000;          // 1 時間。sweepServeThrottled と同じ刻み
const WEEKLY_LAST = "weekly:lastWeek";
let lastWeeklyAt = 0;                  // sweep の lastServeSweep と同じ流儀

function weeklyTickThrottled(): void {
  const now = Date.now();
  if (now - lastWeeklyAt < WEEKLY_MS) return;
  lastWeeklyAt = now;
  const cur = isoWeek(new Date(now));
  const db = kanbanDb();
  const last = db.getMeta(WEEKLY_LAST);
  // 週が変わった: 先週の行を最後にもう一度作る（週末の最終 tick 以降の移動を拾う）
  if (last !== null && last !== cur) storeWeekly(last, now);
  storeWeekly(cur, now);
  if (last !== cur) db.setMeta(WEEKLY_LAST, cur);
}
```
`storeWeekly(week, now)` は `weeklySummary(kanbanDb().listProjectBoards(), week, now)` を
`setMeta("weekly:" + week, JSON.stringify(s))` するだけ（`try/catch` で tick を殺さない）。

### `extensions/db.ts`
**変更なし。** `meta` と `listProjectBoards()`（`:572`）で足りる。

### `web/dashboard.html`
| 何 | どこ |
|---|---|
| `var TABS` に `"weekly"` を追加（projects の隣）| `:494` |
| タブボタン `id="tab-weekly"` | `:252` の隣 |
| ペイン `id="pane-weekly"` | `:293` の隣 |
| タブクリックフックで `loadWeekly()` | `:506-513`（`n === "projects"` と同じ形）|
| `loadWeekly()` / `renderWeekly()` | `loadProjects()` の隣 |

`renderWeekly()` の要件:
- 週セレクタ（`<select>`）に `/api/weekly` の `weeks` を新しい順で並べる。既定は現週
- プロジェクトごとに **done / 停滞 / ブロック** の 3 グループを出す。0 件のグループは見出しごと出さない
- カード本文は `esc()` でエスケープ（`md()` は使わない。本文は Markdown ではない）
- 停滞は `⚠Nd`、ブロックは理由文字列をそのまま
- 取得失敗時は何も描かない（`renderServe` 等の既存流儀に合わせる）

**`extensions/dashboard.generated.ts` の再生成が必須**: `npm run build`（`scripts/build-web.mjs`）。
`pretest` が `--check` で stale を落とす（`package.json:26`）。

### `README.md`
`## Use` 節に「週次タブ」の 3-4 行（何が出るか、自動生成のタイミング、近似の限界）。

## API 仕様

`GET /api/weekly` → `{ ok: true, current: WeeklySummary, weeks: string[] }`
`GET /api/weekly?week=2026-W35` → `{ ok: true, summary: WeeklySummary | null }`（保存済みのみ）
`?week=` が `isoWeek` の往復検証を通らない → **400** `{ ok: false, error: "bad week" }`

`current` は常にその場で計算する（tick を待たない。GUI が開かれた瞬間の状態を見せる）。

## テスト

`tests/kanban-weekly.test.mjs`（新規）:
1. `isoWeek` の境界 — 年跨ぎ（2026-01-01 は 2026-W01）、月曜と日曜が同じ週、53 週の年
2. `weekRange` の往復 — `isoWeek(new Date(weekRange(w).from)) === w` を数週で
3. `weekRange` の不正入力 — `"2026-W54"`, `"x"`, `""` で `null`
4. `weeklySummary` — done は週内のみ拾い、週外は落とす / stale は doing のみ、days が切り捨て / blocked は理由を持つものだけ / プロジェクト別に分かれ、totals が合計と一致 / 0 件プロジェクトは出る（空配列）
5. HTTP `/api/weekly` — `current.week` が現在週、`weeks` が配列
6. HTTP `?week=2026-W35` — 保存が無ければ `summary: null`
7. HTTP `?week=bogus` → 400
8. tick — `/api/weekly?week=<前週>` を読む前に週を進めると…は **時刻を注入できないので省略**。代わりに `weeklyTickThrottled` が `meta` に現週キーを書くことを `/api/weekly` の `weeks` に現週が入ることで確認する

## 落とし穴（実装者へ）
- `card.project` ではなく **`listProjectBoards()` の slug** を使う（正規化済みの真実）
- `movedAt` は**既に epoch ms**（`stampMove` が `Date.now()`）。秒に直さないこと
- `movedAt` が `undefined` のカードは done 判定から外す（`at: 0` を捏造しない）
- `stale` の閾値は既存の `STALE_DAY_MS`（`kanban.ts:162`）を使う。GUI の `⚠Nd` と数字が食い違うと嘘になる
- `poll()` は**毎 tick 呼ばれる**。`weeklyTickThrottled` の中で必ず時刻で return すること（重い集計なので）
- tick 内で例外を投げると poll の `deadCtx` 判定に巻き込まれる。**必ず try/catch**
- タブを足したら `TABS`・ボタン・ペイン・レンダラの **4 つ全部**。1 つ忘れるとタブだけ出て白紙になる
- 5 秒再描画は `render()` が `selectTab(activeTab)` を再適用する設計。`renderWeekly` を `render()` に直接混ぜない（プロジェクトタブと同じ「開いた時だけ取る」流儀）
