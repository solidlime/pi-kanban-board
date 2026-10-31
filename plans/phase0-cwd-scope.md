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
