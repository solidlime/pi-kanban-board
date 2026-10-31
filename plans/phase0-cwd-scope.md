# フェーズ0: ボードのスコープを cwd（git ルート）単位へ

## 問題

今の3スコープのうち2つが壊れている。

- **session**: 会話が終わるとボードが孤立する。実測でセッション盤が19〜20個あり、ほぼ全部が誰にも読まれない死んだボード。
- **global**: 全プロジェクトのカードが同じ列に混ざる。置き場所として使えない。

正しい単位は **作業ディレクトリ（git ルート）**。同じリポジトリを開いたセッションは同じボードを見る。

## 設計

### BoardKey

```ts
type BoardKey = { scope: "global" | "session" | "project"; sid: string };
```

- `project` の `sid` は slug。
- `session` は残すが、**明示的に選んだときだけ**。
- `global` は**読み取り専用の集約ビュー**へ降格。

### slug の決め方

1. `git -C <cwd> rev-parse --show-toplevel` が成功すればそのパス、失敗すれば `cwd` そのもの。
2. basename を `normalizeProject` と同じ規則（`[a-z0-9._-]`、24字以内）に通す。
3. 正規化後に衝突する場合（別パスの同名ディレクトリ）は、フルパスの sha1 先頭4文字を `-<hash>` で付ける。**衝突検出は db の `project` テーブル（フェーズ2）が持つ**。フェーズ0では「同一 slug に別パスが来たら警告ログを出して既存に寄せる」で妥協する（`shortcut:` コメントを添える）。

### デフォルト

- `kanban` ツールの `scope` 既定を `"session"` → `"project"` に変える。
- `kanban_server` 側の `/api/add` 等も、scope 未指定なら project。
- `/api/dashboard` は変わらず全部返す。ビュー側で「今のプロジェクト」を既定選択にする。

### global の扱い

- 書き込み（add / move / remove / edit）は **400**。
- 読み取りは全 project のカードを `project` 付きで返す集約。
- `kanban check` の自己診断はそのまま。

### カードの `project` 属性との関係

カードには `project` 列（自由なタグ）が既にある。**ボードの scope.sid とカードの project は別物**。
- scope 単位 = ボードがどこにあるか（物理）
- card.project = そのカードがどの案件か（論理）

project スコープのボードでは、`add` 時に card.project が未指定なら scope の slug を入れる（同じ値になるのが自然）。

### 移行

1. 既存の session ボードを、そのセッションの `cwd` から解決した project ボードに **merge** する。
   - カード ID は project ボードの `next_id` から振り直す。
   - 衝突（同じ text のカード）は放置。重複は許容する（黙って消すより良い）。
2. 既存の global ボードは、`card.project` が決まっているカードを対応する project ボードへ移す。決まっていないカードは `_inbox` という slug のボードにまとめる。
3. 移行は**1回だけ**。`meta` テーブルに `scope_migrated=1` を書いて再実行を防ぐ。

## 受け入れ条件

- 同じディレクトリの2セッションが**同じボード**を見る（カードを足すと両方に出る）。
- `global` に card を足そうとすると 400。
- `~/.pi/kanban` の既存ボードが移行後も消えていない（カード枚数の合計が一致）。
- `~/.pi/kanban/kanban.db` の `board` 行が移行後に減っている（session が project に畳まれる）。
- 移行を2回流しても二重に増えない。

## 実装ノート（#15 で確定したこと）

- global は読み取り専用の集約ビュー。HTTP は 400、`kanban` ツールも `add/move/remove/edit` を拒否、ダッシュボードはボタンを非活性にする。
- `modes.json` に `PROJECT` バケツを追加。キーはセッション id ではなく slug。`sweepSessions` は slug のボード存在で生存判定する（session ボードを見ない）。
- scope 移行のバックアップは `PRAGMA wal_checkpoint(TRUNCATE)` の後に取る。WAL の未 checkpoint ページを取りこぼすと、直後の `deleteBoard` でカードが戻らなくなるため。
- `scope=project` に明示 sid を付けた場合、`sessionInfoCache` に載っていない sid は 400 `unknown sid`。別リポジトリのボードに黙って着地するより拒否する。sid 無しはこのプロセスの cwd で解決する。
- ボードキーと claim するセッションを分ける（project ではキー=slug、`movedBy`/`nextTodo` の actor=sid）。`pickFirstTodo` / `doingHeadOf` / `candidates` は第3引数 `actor` を受ける。
- poll と settle は session → global → project の順に見る。DOING の所有フィルタは session 以外（global / project）に効かせる。

## 既知の制約（フェーズ1以降）

- 同 basename の別パスは同じ slug に畳まれる（衝突検知はプロセス内 Map のみ）。
- ダッシュボードの project 面はサーバプロセスの cwd 固定。サイドバーで別セッションを選んでも変わらない（1 プロセス 1 cwd 前提）。
- `/api/resume` の `resumeRequests` キーは slug になり得るが、poll 側は sid で delete する（未対応）。
- 移行バックアップの完全性を守る恒久テストは無い（一時スクリプトで 400 枚一致を確認したのみ）。
- 既定ボードが project になったのに、設定タブに **project 行が無い**。ループ ON/OFF・上限・間隔・停止理由は UI から触れない（session 行と GLOBAL 行だけ）。halt からの再開は /api/resume（全バケツを ON）で効くが、個別の設定変更はフェーズ1送り。
- cwd の出所が 3 系統に割れている: poll とダッシュボードは process.cwd()、ツールと settle は cwdOfCtx(ctx)、HTTP 書き込みは sessionInfoCache。「1 プロセス 1 cwd」が崩れると、settle はボード A を駆動し poll は B を見る。前提が崩れる条件（同一プロセスで別 cwd のセッションを開く）は未検証。
- slug 衝突はプロセス内 Map でしか検知しないので、同名 basename の別リポジトリは**カードが混ざる**（消失ではない）。
- 移行の `writeError` 経路はボードを残しつつ session/global 行を消さないので、次回起動で**二重マージ**になり得る。受入条件「2 回流しても二重に増えない」は成功経路でしか成立しない（バックアップは既にあるので、損失より重複を選ぶ設計と明記）。
- `execFileSync(git, timeout:2000)`（`:352-370`、呼び出し `:396`）はリクエスト経路と settle 上の同期呼び出し。cwd ごとの初回だけ最大 2 秒イベントループが止まる（キャッシュ後は無害）。
- `_inbox` に落ちたカードは poll・ダッシュボード・ツールのどれも名前で参照しないので、生きているのに到達不能（slug を手で指定しない限り）。
- 移行折り込みの窓（`migrationPending`）での書き込みは、HTTP とツールは待って通るが、settle は continuation を落とし、poll は `firedFor` を書かずに wake だけ送る（1 間隔分の重複）。**落とした settle は再送されない**（Pi の `agent_before_settle` は 1 ターン 1 回）ので、そのターンの回数は数えられず pick も次ターンへ回る——上限側は安全。折り込みが実際に走る起動直後だけの窓で、`scope_migrated` 済みならゲートは閉じない。
- ダッシュボードの「残り N / 上限」は分子が 3 スコープの max（`loopCountOf`）・分母がセッション行の `maxLoops` なので、project の cap がセッションより小さいとき数字が合わない（footer の `HALTED` と `残り/上限` は正しい）。直すには `sessionRows` に `modes.project`（キーは slug）を足して同じスコープから分子分母を取る——フェーズ1の設定行と同時にやる。
- `/api/resume` の実体は poll が ownCtx で実行する（`:5162`）ため、resume の cwd は ownCtx 固定。「1 プロセス 1 cwd」前提の一部。
