# カード#29: `session: self` で自分のカードを引き受ける

## 目的

エージェントが「ボードから仕事を取りに行く」手段が無い。`add` は作ったセッションを自動で
`sessionId` に入れるので「投げる」は既にできるが、他所のセッションが持つカードを自分が
引き受けるには、**自分のセッション id を知る手段が無い**（`edit session:<id>` は要る）。
`session: "self"` を `env.sessionId` に解決する一行で両方向が閉じる。

## §0 実測事実（この計画を書いた時点のコード）

| 事実 | 場所 |
|---|---|
| `env.sessionId` はホストの session id。`add` はこれでカードを紐付ける | `src/agent/adapter.ts:37`, `:505` |
| `edit` も `sessionOf(args.session)` を通す（`""` → `null` で解除） | `src/agent/adapter.ts:547` |
| `sessionOf` はバリデーションのみ。`self` は現状ただの文字列 | `src/agent/adapter.ts` `sessionOf` |
| `move` で doing へ入ると、カードの `card.sessionId` を叩き起こす | `src/agent/adapter.ts:523` |
| wake 経路は `fresh.sessionId` を見る。誰が動かしたかは見ない | `src/agent/driver.ts:259` |
| `probeSession` は既に busy/idle/unknown を返す（非 export） | `src/agent/driver.ts:132` |
| `piWebUrl` は `KANBAN_PIWEB_URL` → `127.0.0.1:8787` | `src/agent/session-lock.ts:29` |

**根本原因**: カードの `sessionId` が「誰が叩かれるか」の全てで、そこには「いま自分がやる」
を表明する動詞が無い。move した側は表明できない。

## §1 設計（採用: 断る方式）

`session: "self"` を `env.sessionId` に解決する。それだけでは静かな乗っ取りになるので、
**上書きの瞬間に元の持ち主を probe し、生きていれば断る**。

```
edit <id> session:self
  ├ env.sessionId 空 → 失敗 "session: self needs the host's session id (none in this context)"
  ├ card 無し → NOT_FOUND（updateCard が投げる。既存挙動）
  ├ card.sessionId が null か self と同じ → そのまま採用
  ├ card.sessionId が別セッション
  │   ├ probe が "idle"    → 採用（元の持ち主はもう走っていない）
  │   ├ probe が "busy"    → 断る "card #N is in <sid>'s turn; move it only when it is idle"
  │   └ probe が "unknown" → 採用（pi-web が答えられない = 生きている証拠が無い）
  └ 採用時は DB に絶対 id を書く（"self" は保存しない）
```

`add session:self` も同じ解決を通す（env が無ければ失敗。今の `add` は env 無しを `null` に
落とすので、明示 `self` だけは失敗にする — 「自分のつもりが無言で null」が一番悪い）。

**`unknown` を採用する理由**: `probeSession` の既存コメント（`src/agent/driver.ts:126-131`）が
「unknown を busy と読むとカードが doing で永久に止まる。逆は拒否1回の損。非対称だ」と
書いている。同じ判断を踏襲する。ただし**断る方が安全側**という原則もあるので、
`unknown` で上書きした事実は戻りテキストに明記する。

## §2 変更ファイル（3 + テスト1）

1. `src/agent/adapter.ts`
   - `resolveSession(spec: string | undefined, env: Env): string | null | undefined`
     - `undefined` → `undefined`（未指定 = 変更しない）
     - `""` → `null`（解除）
     - `"self"` → `env.sessionId ?? fail`（空なら throw で失敗）
     - 他 → `sessionOf` の結果そのまま
   - `edit` case: `sessionOf(args.session)` → `resolveSession(...)`、採用前に `claimGuard(...)`
   - `add` case: 同上（`args.session` が `"self"` のときだけ env 解決）
   - `claimGuard` は adapter 内の小さな関数。`probeSession` を driver から export して使う
2. `src/agent/driver.ts`
   - `probeSession` を export（既存の振る舞いは変えない）
   - `piWebUrl` 用のデフォルト解決を adapter が使えるよう、`probeCardOwner(base, sid)` を
     export する薄いラッパを置く（`WakeOptions` の fetch seam を活かすため）
3. `extensions/kanban-v2.ts`
   - `session` の description に `self` を追記
4. `tests/integration/agent-adapter.test.mjs`
   - 5ケース（下記）

## §3 テスト（5ケース）

1. `add session:self` が `env.sessionId` を保存する
2. `add session:self` で env に sessionId が無ければ失敗し、**カードが作られない**
3. `edit session:self` が既存の `null` カードを自分の id で埋める
4. `edit session:self` で持ち主が idle なら上書きできる（`fetch` seam で `running:false`）
5. `edit session:self` で持ち主が busy なら断り、**DB の sessionId が変わらない**

## §4 やらないこと

- **新ツールを作らない**。`add`/`edit`/`move` の3動詞で足りる。動詞を増やすとモデルが迷う。
- **`move` に `claim` を足さない**。`edit` → `move` の2手で足りる。使われてから畳む。
- **乗っ取りの相手セッションへ通知を送らない**。「B が持った」を A に流すのは wake 経路の
  二重化になり、A が busy なら同じ問題を再生産する。断る方式なら通知は不要。
- **`unknown` のときの警告 UI を作らない**。戻りテキストに書くだけ。
- **カード一覧に「持ち主が生きているか」を出さない**。API 呼び出しが一覧のたびに増える。

## §5 検証

```
npm run typecheck:v2
npm run test:v2
npm run lint
npm run build:v2
```

新規テスト5本 + 既存 404本が緑であること。実機確認は pi-web 経由の `edit session:self` が
`env.sessionId` を受け取れるか（§1 の前提）を、実セッションで1回試す。

## §6 残る窓（REVIEW 指摘・許容済み）

- probe が `idle` を返してから `updateCard` まで最大 1 秒。相手がその間に起きれば奪える。
  塞ぐには claim の原子性が要るが、DB トランザクション内で外部 I/O はできない（`src/persistence/repos.ts:355` の `withTx`）。
  この差分は**窓を狭めただけ**で閉じていない。今日より悪くはない（旧 `edit session:<他人>` は無防備に乗っ取れた）。
- `KANBAN_PIWEB_URL` が別マシンを指す構成では probe が常に `unknown` になり、`unknown` 採用により乗っ取りが素通りする。
  `src/agent/session-lock.ts:34-35` は同じ構成で警告を出すが、claim 側は無警告。その構成を使うなら別カードで塞ぐこと。
