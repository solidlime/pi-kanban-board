# #14 pi の実行状態を外部から読む口（調査）

調査日: 2026-10-31 / 対象: `@earendil-works/pi-coding-agent` 1.4.0 / `pi-intercom`（`~/.pi/agent/npm/node_modules/pi-intercom`）
調査方法: docs 全文（#042 librarian が行番号つきで裏取り）＋ このマシンでの実測（broker へ実際に接続、セッションファイルを実際に読む）。

## 結論

1. **公式に保証されている口は「セッションファイルのディレクトリ走査 + JSONL パース」だけ**。ここから読めるのは id / cwd / モデル / thinking level / 全メッセージ / usage（トークン・コスト）。
2. **「今そのセッションが動いているか」は公式にはどこにも書かれていない**（lock / pid / heartbeat / status フィールドすべて docs に 0 件）。だが **pi-intercom のブローカーが生きた状態を持っていて、外部から読める**（実測成功）。`status`（`tool:codemode` / `idle`）、`contextPct`、`pid`、`lastActivity` が取れる。これが唯一「実行中か」を正しく答えられる口。
3. RPC（`get_state`）と `--mode json` は **自分が子プロセスとして起動した pi にしか使えない**。「既に動いているセッションに後から問い合わせる」機能は存在しない。

## 口の一覧（実測と出典つき）

| 口 | 読めるもの | 既存セッションへの後付け | 認証 | 副作用 | 依存 |
|---|---|---|---|---|---|
| セッションファイル走査 | id, cwd, model, usage, 全メッセージ, mtime | ○ | ファイル権限のみ | なし | なし |
| intercom broker `list` | id, name, model, **status**, **contextPct**, pid, cwd, lastActivity | ○（register 必須） | なし（同ユーザーの named pipe） | join/left の一瞬のブロードキャスト | pi-intercom が動いていること |
| RPC `get_state` | isStreaming, messageCount, sessionFile… | ✗ 自分が起動した子のみ | — | — | — |
| `--mode json` | イベントストリーム | ✗ ワンショットで終了 | — | — | — |
| SDK `SessionManager.listAll()` | id, name, cwd, modified | ○ **インプロセス限定** | — | — | pi 本体（今ここで使用中） |

## 1. セッションファイル

### docs が保証していること
- パス: `~/.pi/agent/sessions/--<cwd を - に潰したもの>--/<timestamp>_<session-id>.jsonl`（`docs/session-format.md:11`, `:14`）
- 上書き優先順: `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` 設定（`docs/sessions.md:50`, `docs/cli.md:96-97`）
- 形式: JSONL、1 行 1 レコード、`type` で判別（`docs/session-format.md:3`）。バージョン v3 へロード時に自動移行（`:22-30`）
- レコード種別は 12 種（`docs/session-format.md:62-207`）: `session` / `message` / `model_change` / `thinking_level_change` / `usage` / `compaction` / `context_edit` / `branch_summary` / `custom` / `custom_message` / `label` / `session_info`
- `usage`: `{input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost{...}}`（`docs/message-types.md:71-88`）。**`reasoning` は `output` に含まれるので二重計上禁止**（`:90`）
- モデルは assistant message の `provider`/`model`/`api`、選択モデルは最新の `model_change`（`docs/session-format.md:93-103`）

### 実測（このマシン）
```
~/.pi/agent/sessions/--D--Code-pi-kanban-board--/2026-10-31T03-23-16-129Z_01a18ffb-....jsonl
{"type":"session","version":3,"id":"01a18ffb-...","cwd":"D:\\Code\\pi-kanban-board"}
{"type":"model_change","provider":"litellm","modelId":"Orchestrator"}
{"type":"message","message":{"role":"assistant",...,"usage":{"input":1085,"output":176,"cacheRead":69376,"cacheWrite":0,"reasoning":0,"totalTokens":70637,"cost":{...}}}}
```
セッションの cwd ごとにディレクトリが分かれる（21 ディレクトリあった）。

### docs が保証していないこと（＝依存してはいけない）
- **実行中判定の手段は皆無**（lock / heartbeat / status / PID すべて記載なし）
- **追記の原子性**。実装は `appendFileSync(file, JSON.stringify(entry) + "\n")` を 1 エントリ 1 回（`dist/core/session-manager.js:812`）。fsync なし。O_APPEND なので単発 write は概ね原子的だが、**docs に保証はなく、読む側が末尾の不完全行を掴む可能性を排除できない**。読むなら「`\n` までの完全な行だけ採用し、末尾の切れ端は捨てる」が必須。
- サブエージェントのセッションファイル表現（`parentSession` は fork/clone 用）

## 2. intercom broker（実測で確定した唯一の「生きた状態」の口）

### 接続先
- Windows: named pipe `\\.\pipe\pi-intercom-<sanitize(agentDir)>`（`broker/paths.ts:66-73`）。`sanitize` は `[^a-zA-Z0-9]+` → `-`、小文字化。
  このマシンの実値は `\\.\pipe\pi-intercom-c-users-owner-pi-agent`（`getBrokerSocketPath()` を tsx で実行して取得。**手計算は外れる。必ず関数に計算させること**）
- 非 Windows: `~/.pi/agent/intercom/broker.sock`
- Windows で `PI_INTERCOM_TRANSPORT=tcp` のときだけ TCP + `broker.port.json`（`paths.ts:35-47`, `:83-110`）。このマシンは pipe。
- 生存確認: `~/.pi/agent/intercom/broker.pid`（実測: 42252、`tasklist` で生存）

### framing
4 バイト big-endian 長 + JSON（`broker/framing.ts:17-24`）。**改行区切りではない**（JSONL だと思って書くと無言でタイムアウトする。実際に踏んだ）。

### プロトコル（実測）
- `{"type":"health","requestId":"h1"}` → **未登録でも通る**（`broker/broker.ts:477-490`）。返るのは protocol 名と version だけ。実測レスポンス:
  `{"type":"health_ok","requestId":"h1","protocol":"pi-intercom","version":1}`
- `{"type":"list","requestId":"l1"}` → **register 前は throw して切断**（`broker/broker.ts:493-495`）。
- `register` → `registered` → `list` → `sessions`。実測で 7 セッションが返り、各要素は:
  ```
  {"id":"01a18ffb-...","name":"subagent-chat-...","model":"Orchestrator","pid":3752,
   "status":"tool:codemode","ctxTokens":71464,"ctxWindow":1000000,"ctxPct":7,
   "last":1793454196143,"cwd":"D:\\Code\\pi-kanban-board"}
  ```
  `status` は `tool:codemode` / `idle` のように**実行中のツール名まで出る**。`contextPct` は圧縮判断にそのまま使える。
- `SessionInfo` の全フィールドは `pi-intercom/types.ts`（`id, name, cwd, model, pid, startedAt, lastActivity, status, contextPct, contextTokens, contextWindow, tmuxPane, herdrPaneId, herdrLocation`）

### 落とし穴
- **register しないと list できない**。register は `session_joined` を全クライアントへブロードキャストする（`broker/broker.ts:600`）ので、ポーリングのたびに他人の UI にセッションが出入りする。読むためだけの常駐クライアントを作るなら、**1 本の接続を張りっぱなしにして join/left を 1 回で済ませる**のが唯一まともな形（毎回 connect→register→list→切断は行儀が悪い）。
- ストリームには `presence_update` が流れ続ける。読み手は自分の欲しい `type` だけ拾う。
- pi-intercom は**このリポジトリの依存ではない**（`package.json` の peerDeps は `pi-coding-agent` と `typebox` のみ）。使うなら「無ければ機能を出さない」任意依存として扱う。
- 認証は同ユーザーの pipe 権限のみ。他ユーザーからは繋げない（`INTERCOM_DIR_MODE 0o700`）。

## 3. 使えない口
- **RPC `get_state`**（`docs/rpc-commands.md:155-186`）: `isStreaming` / `isCompacting` / `messageCount` まで返るが、`pi --mode rpc` で**自分が起動した子プロセス**の stdin/stdout 経由のみ（`docs/rpc.md:7-10`）。既存プロセスへの attach は存在しない。
- **`--mode json`**（`docs/json.md:5-9`）: ワンショット。プロンプト完了でプロセスが終わる。注意: `--json` フラグは `auth check`/`mcp list` 専用でセッションとは無関係（`docs/cli.md:311`, `:327`）。
- **CLI にセッション一覧コマンドは無い**（`docs/cli.md:78-107`）。

## 4. 今の実装との関係
- `extensions/kanban.ts:2981` `sessionInfoById()` は SDK の `SessionManager.listAll()`（`:2987`）を 1 回スキャンして TTL キャッシュ。インプロセスなので**拡張からはこれが一番素直**。ただし返るのは id / name / cwd / modified のみで、**モデルも実行状態もコンテキスト使用率も無い**。
- ダッシュボードに足すなら、優先度は: (1) モデル名（ファイルで足りる）、(2) 実行状態と contextPct（broker が要る）、(3) コスト（ファイルの usage 合計。圧縮で古い usage が文脈から消えても行は残るので合計できる）。

## 5. 推奨
- **実行状態を出す機能を作るなら、broker の常駐 1 接続 + `list` を購読**し、broker が無ければその列を出さない（`pi-intercom` は任意依存）。セッションファイルの mtime で「動いていそう」を推測するのは**やめる**（誤判定を出すだけで、正解を持つ口が既にある）。
- **モデル名・コストだけならファイル読みで十分**。ただし末尾の不完全行を捨てる防御を必ず入れる。
- **書き込みは一切しない**。読み取り専用。

## 未検証 / リスク
- `dist/core/session-manager.js` の追記は `appendFileSync` 単発呼び出しで fsync 無し（`:812`）。docs に原子性の保証は無いので、読み手側で防御する前提を崩さないこと。
- broker のプロトコルは **pi-intercom の内部実装**（公開 API ではない）。バージョンアップで壊れうる。壊れたら機能が静かに消える形（列ごと非表示）にする。
- broker の TCP モード（`PI_INTERCOM_TRANSPORT=tcp`）は実測していない。
