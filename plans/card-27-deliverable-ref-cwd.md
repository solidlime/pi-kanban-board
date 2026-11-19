# card-27: 成果物 ref の cwd 解決 — なぜ nous が「添付失敗」するか

## 0. 実測事実（調査済み・DB とコードで確認）
- nous の deliverable #2/#3 は `ref = 'docs/chat-flow.md'`（**相対パス**）。実ファイルは `/root/workspace/Nous/docs/chat-flow.md`（23.8K）に存在する。
- serve の `resolveRef`（`src/api/routes.ts:540`）は相対パスを **kanban home 結合**で読む → `/root/.pi/kanban/docs/chat-flow.md` → `NOT_FOUND ref is missing on disk`。
- 拡張側 `src/agent/adapter.ts` の deliverable `add`/`ref` は生パスを DB に書く（cwd 解決しない）。同じ関数の `img` は `resolve(env.cwd, path)` している — 先例と不一致。エージェントは自分の cwd 相対で渡すのが自然なので、ここが食い違う。
- serve 側は絶対パスなら **どのディレクトリでも** realpath して表示する（root 制限なし・`..` は拒否・symlink は realpath）。つまり「コピーせず任意の場所のファイルを表示」はサーバー側で成立済み。欠けているのは拡張側の cwd 解決だけ。
- 既存テスト基盤: `tests/integration/agent-adapter.test.mjs`（KANBAN_HOME を temp に向ける。deliverable テスト :239 あり）。

## 1. 変更（最小）
1. `src/agent/adapter.ts` — deliverable `add`/`ref` の path を `resolve(env.cwd, path)` で絶対化（`..` は resolve が正規化）。`img` と同じ式。加えて `existsSync` で存在チェックし、無ければ `ok: false` をその場で返す（今日は「add は成功し、表示だけが静かに死ぬ」）。
2. `extensions/kanban-v2.ts` — `ref` の description に「セッション cwd 相対でよい（絶対化される）」を明記。エージェント向けの案内。
3. `tests/integration/agent-adapter.test.mjs` — ①相対パスで add し DB の ref が絶対パスになる ②存在しないパスで add/ref が ok:false になる。
4. `docs/W2_API.md` — deliverable の ref に cwd 解決を一言。

## 2. データ修復（コード反映後）
nous #2/#3 の ref を `/root/workspace/Nous/docs/chat-flow.md` に書き直す（deliverable ref action）。DB は直接触らない。

## 3. やらないこと
- serve 側の root 制限（~/workspace 等）の導入。v2 は絶対パス自由が既定で、/tmp の成果物が今もそれで動いている。信頼境界は token。
- `..` 拒否の緩和（resolve 後は消えるので触る意味がない）。
- ブラウザ UI からの ref 相対入力対応（ブラウザに cwd は無い）。

## 4. 検証
- `npm run typecheck:v2` / `npm run test:v2` / `npm run build:v2`
- 実ブラウザ（8789）: 修復後の nous #2 の /view が開くこと、ref バッジから表示できること。
- 8789 のプロセス入れ替え（kill → 起動し直し）。
