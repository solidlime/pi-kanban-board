# DOING のカードでセッションを起こす（spawn）

## 決定（ユーザー）

- 起動方式は **ヘッドレス `pi -p` を spawn**。条件は「pi-web でセッションの中身が見えること」。
- 完了は **エージェント自身が `kanban` ツールで DONE に移す**。

## 前提（調査済み）

- pi はセッションを `~/.pi/agent/sessions/<cwd をエンコードしたディレクトリ>/<timestamp>_<id>.jsonl` に保存する。pi-web は cwd 単位でセッションを一覧するので、cwd が `/root/workspace/pi-kanban-board` なら既存の `--root-workspace-pi-kanban-board--/` に出る。
- `--session-id <id>` は「その cwd にその ID のセッションがあれば使う、無ければ作る」。自分で UUID を決めて渡せばよい。
- `--print/-p` は非対話の 1 ターン実行（ツール呼び出しループは回る）。`--name` で表示名を付ける。
- 板（`Project`）は cwd を持たない。`Project.settings` は `Record<string, unknown>` なので `settings.cwd` を置ける。`createProject` は settings を受けるが `postProject` が捨てている。
- `Card.sessionId` と `UpdateCardPatch.sessionId` は既にある（`src/persistence/repos.ts:301-305`）。

## 変更

### 1. `src/agent/driver.ts`（新規）

```ts
export function sessionCwd(project: Project): string
// settings.cwd が非空 string ならそれ、違えば process.cwd()

export function buildCardPrompt(project: Project, card: Card): string
// slug / id / title / body / 受け入れ条件を書き、
// 「完了したら kanban ツールで done へ移す」「中断するなら blockedReason を書いて doing に残す」
// 「cwd 外のファイルは触らない」を明記

export interface WakeOptions { spawn?: SpawnFn; bin?: string }
export function wakeCardSession(db: Db, project: Project, card: Card, opts?: WakeOptions):
  { sessionId: string; pid: number | undefined } | null
```

- projectId ごとに 1 プロセスだけ。モジュールレベルの `Map<ProjectId, ChildProcess>` で排他（実行中なら `null`）。
- `card.sessionId` が無ければ `randomUUID()` を `updateCard(db, projectId, id, { sessionId }, { actor: "loop" })` で保存する。
- `spawn(bin ?? "pi", ["-p", "--session-id", sessionId, "--name", `kanban #${card.id}`, prompt], { cwd: sessionCwd(project), stdio: ["ignore", "pipe", "pipe"], env: process.env })`
- `child.on("exit")` と `child.on("error")` で Map から消す。stderr は `console.error` に 1 行だけ流す（stdio は握りつぶさない）。
- stdout は捨てる（会話はセッション JSONL に残り、pi-web が読む）。

### 2. `src/supervisor.ts`

`tickProject` の戻り値に `moved` があれば `wakeCardSession(db, project, result.moved)` を呼ぶ。失敗は握って次の板へ。

### 3. `src/api/routes.ts`

- `postLoop` の tick も同じく `moved` で wake する。
- `postProject` で `body.settings` を通す（`createProject(db, { slug, name, settings })`）。cwd を板に持たせるため。

### 4. `tests/unit/agent-driver.test.mjs`（新規）

- `buildCardPrompt` に slug / id / title / 「done」が入る。
- `wakeCardSession` が sessionId 無しのカードに UUID を作り DB に保存する（`:memory:` DB ヘルパを使う）。
- spawn を fake に差し替え、`-p` / `--session-id` / `--name` / `cwd` が渡ることを確認。
- 2 回目の呼び出しは `null`（排他）。

## 受入条件

- `npm run test:v2:unit` / `npx tsc -p tsconfig.v2.json --noEmit` が pass。
- fixer の報告後、ヘルタが実機で 1 回 spawn して `~/.pi/agent/sessions/--root-workspace-pi-kanban-board--/` に新しい JSONL が増えることを確認。pi-web で開いて本文が見えること。

## やらないこと

- タイムアウト kill、成果物の自動登録、timeline イベントの追加、複数並列。
- 既存板の cwd 設定 UI（ヘルタが `updateProject` で直接入れる）。

## リスク

- spawn した pi が「グローバル設定の v2 拡張」と「cwd の package.json の v2 拡張」を二重に読む可能性。`kanban` ツールが衝突すれば DONE にできない → 実機確認で見る。
- spawn した pi は `~/.pi/kanban/state.sqlite` をサーバーと共有する。WAL なので同時書き込みは吸収されるが、`SQLITE_BUSY` は起こり得る。
