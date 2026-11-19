# カード#27 セッションピッカー: 人形を出さない / id を併記

## 0. 実測事実（2026-11-19、この環境で確認）

**読み取り側**
- `src/core/sessions.ts:76 readSessions(dir)`: `readdir` → `*.jsonl` のみ → mtime 降順 → `SCAN_MAX = 50` 件だけ `headAndTail`（先頭 32KB + 末尾 32KB、`CHUNK = 32*1024`）で読む。
- `src/core/sessions.ts:43 formatSessions(entries)`: `name !== null` だけ残し、`{id,name,updatedAt}` にして mtime 降順で返す。
- `src/api/routes.ts:957-962 getSessions`: `GET /api/sessions?project=` → `readSessions(sessionDirOf(project))`。
- `docs/W2_API.md` の Routes 表に `/api/sessions` の行が**無い**（未文書化）。

**人形（サブエージェント）の見分け方**
- pi-web が子セッションの JSONL 先頭に `{"type":"custom","customType":"pi-web:subagent","data":{...}}` を書く。side ペインは `"customType":"pi-web:side"`。
- このフォルダ（`--root-workspace-pi-kanban-board--`、93 ファイル）の実測:
  - 子マーカーの位置は **全 46 ファイルでオフセット 330**（先頭 32KB の head チャンクに確実に入る）。
  - **親セッションのファイルには子マーカーが 1 つも無い**（マーカーは子のファイルにだけ書かれる）。
  - 親側に現れるのは `custom_message` の `pi-web:subagent-notification` で、`customType` が別物。**部分一致 `"pi-web:subagent` だと通知に誤爆する**ので、JSON を parse して `customType` を完全一致で比べる。
- このフォルダの内訳: 命名済み 49 件のうち **45 件が子**、トップレベルは 4 件。`readSessions` が返す 16 件のうち 15 件が人形（＝今のピッカーはほぼ人形しか出していない）。

**クライアント側**
- `web/src/detail.ts:60 sessionLabel(card, list)`: id が list にあれば `hit.name`、無ければ `id.slice(0,8)`。
- `web/src/detail.ts:71 sessionIdOfInput(value, ...)`: `list.find(s => s.name === wanted)`、无ければ label 一致、それも無ければ「新規セッション」通知 + `null`。
- `web/src/detail.ts:117-119`: `datalist` の `option.value = s.name`（`detail.ts:287-291` で構築）。
- 同じ name のセッションが複数あると `find` が先頭を拾う（id を出せば人間にも区別できる）。

## 1. 変更

1. `src/core/sessions.ts`
   - `isChildChunk(chunk: string): boolean` を追加。`chunk` を行分割し、`"pi-web:"` を含む行だけ JSON parse、`type === "custom"` かつ `customType` が `pi-web:subagent` / `pi-web:side` の完全一致なら true。parse 失敗行は無視（`sessionNameOf` と同じ扱い）。
   - `formatSessions(entries)` の entry に `child?: boolean` を追加し、`child` なら捨てる。
   - `readSessions` で `child: isChildChunk(本文)` を渡す。
2. `web/src/detail.ts`
   - `sessionLabelOf(s: SessionRef): string`（export、テスト用）= `` `${s.name}（id:${s.id.slice(0,8)}）` ``。
   - `sessionLabel` は list にあれば `sessionLabelOf(hit)`、無ければ `id.slice(0,8)`。
   - `sessionIdOfInput` は label 完全一致 → name 完全一致 の順で解決（後者は手入力の後方互換）。
   - `datalist` の `option.value` を `sessionLabelOf(s)` に。
3. `tests/unit/core-sessions.test.mjs`: 子マーカー付きの名前ありファイルが落ちること、`isChildChunk` が `pi-web:subagent-notification` に反応しないこと。
4. ラベルの書式テスト（`sessionLabelOf` の export を使う）。
5. `docs/W2_API.md` Routes 表に `GET /api/sessions?project=` の行を足し、子セッション（人形・side）は返さないと書く。

## 2. 検証

- `npm run typecheck:v2` / `npm run test:v2`（369 + 追加）/ `npm run build:v2`
- 実ブラウザ: http://127.0.0.1:8789/ でカード詳細を開き、「セッション」欄の候補が `タイトル（id:xxxxxxxx）` 形式で、人形の名前（例「ルアン・メェイ レビュー #25」）が出ないこと。保存して再度開き、id が保たれること。
