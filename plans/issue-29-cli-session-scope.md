# #29 CLI パーサが `session` を project として黙って受理する

> 状態: **未実装**。この文書は実装案とテスト案で、コードは入っていない。
> 経緯: #28 の作業中に一度だけ実装されたが #28 のスコープ外だったため巻き戻した
> （そのときの RED/GREEN 記録は下の「検証記録」に残してある）。カード #29 は todo に戻した。
> 実装するときは 1 コミットで。差分は単一 hunk（`:1518-1524` 付近）で他の変更と重ならない。

## 症状

`/kanban loop off session` が拒否されない。HTTP は #17 以降 `scope=session` を
400 `SESSION_SCOPE_GONE` で弾くのに、CLI パーサだけは「scope 無指定 = project」と同じに
読んでしまい、**誰も名指ししていないボードのスイッチを書く**。
`on` / `off` / `status` / `pick off session` のすべてが同じ経路で黙って通る。

## 根因

`parseKanbanArgs()` の mode 分岐（`extensions/kanban.ts:1518-1520` 付近）が scope 語を
`argv.slice(2).includes("global")` の真偽だけで判定していた:

```ts
const sub = argv[1];
if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") {
	return { kind: "reject", reason: "使い方: /kanban loop on|off|status / /kanban pick on|off" };
}
const scope: Scope | undefined = argv.slice(2).includes("global") ? "global" : undefined;
```

`session` はどの枝にも当たらず `scope === undefined` → 呼び出し側の
`parsed.scope ?? "project"` で project に落ちる。落ちる先が「今いるボード」なので、
タイプミスが別ボードの状態変更として成功する。

## 実装案（`extensions/kanban.ts`、3 行追加）

`sub` の検証の直後・scope 判定の直前に、`global` 判定と同じ形で `session` を弾く。
文言は HTTP の `SESSION_SCOPE_GONE`（`extensions/kanban.ts:3631` 付近）を再利用する ——
同じ誤りが 2 通りの文言で返ると、ユーザーには別々の不具合に見える。

```diff
 		const sub = argv[1];
 		if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") {
 			return { kind: "reject", reason: "使い方: /kanban loop on|off|status / /kanban pick on|off" };
 		}
+		// #29: scope=session は #17 で消えた語で、HTTP は 400 SESSION_SCOPE_GONE で弾く。
+		// scope 無指定と同じに読むと、誰も名指ししていない project ボードのスイッチを書く。
+		if (argv.slice(2).includes("session")) return { kind: "reject", reason: SESSION_SCOPE_GONE };
 		const scope: Scope | undefined = argv.slice(2).includes("global") ? "global" : undefined;
```

`SESSION_SCOPE_GONE` は `:3628` の定義（関数本体から参照するので実行時は問題ない）。
気になるなら定数定義を `GLOBAL_NO_SWITCH`（`:665` 付近）の隣へ移すと読みやすい。

## テスト案（`tests/kanban-cli-session-reject.test.mjs`、新規）

既存の CLI 系テストと同じ流儀（`createJiti` で `kanban.ts` を読み、`HOME` と
`KANBAN_PORT` を差し替えた使い捨て環境で `/kanban` を叩く）。`node:test` は使わず
`check()` / `failures` / `passed` の自前カウンタで揃えている。

```js
// #29: `session` は #17 で消えたスコープ。HTTP は scope=session を 400 SESSION_SCOPE_GONE で
// 弾くのに、CLI パーサは `/kanban loop off session` を「scope 無指定 = project」として黙って
// 受理し、誰も名指ししていないボードのスイッチを書いていた。CLI 側にも同じ網を張る。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-cli-session-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/projects`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = process.env.HOME;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

const failures = [];
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

// HTTP の 400 と同じ文言（別物の文言にすると、同じ誤りが 2 通りに見える）。
const SESSION_SCOPE_GONE = "scope=session is gone; boards are project-scoped";
const GLOBAL_NO_SWITCH = "global は集約ビューでスイッチを持たない（scope=project を使う）";
const SID = "cli-session-sid";

const handlers = new Map();
const commands = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
});

const notifications = [];
const ctx = {
	hasUI: false,
	isIdle: () => false,
	ui: {
		notify(msg) {
			notifications.push(msg);
		},
		setWidget() {},
	},
	sessionManager: { getSessionId: () => SID, getEntries: () => [] },
};
handlers.get("session_start")({}, ctx);
const kanban = (args) => commands.get("kanban").handler(args, ctx);
/** notify を 1 回分だけ取り出す（前回までの分は捨てる）。 */
const notifyFor = async (args) => {
	notifications.length = 0;
	await kanban(args);
	return notifications.join("\n");
};

const modesFile = `${HOME_DIR}/.pi/kanban/modes.json`;
const readModes = () => {
	try {
		return JSON.parse(readFileSync(modesFile, "utf8"));
	} catch {
		return {};
	}
};
const projectBucket = () => Object.values(readModes().PROJECT ?? {})[0] ?? {};

// --- 1: session は scope 語として拒否される ------------------------------------
for (const args of ["loop off session", "loop on session", "loop status session", "pick off session"]) {
	await check(`/kanban ${args} -> session 拒否`, async () => {
		const msg = await notifyFor(args);
		assert.equal(msg, SESSION_SCOPE_GONE, `受理された: ${msg}`);
	});
}

await check("session 拒否は modes.json に doingLoop=false を書かない", () => {
	// 拒否が「読むだけ」で終わっていること。書いてしまうと誰も名指ししていない
	// ボードのループが止まる（#29 の実害はこれ）。
	const bucket = projectBucket();
	assert.equal(bucket.doingLoop, undefined, `project ボードに書かれた: ${JSON.stringify(readModes())}`);
});

// --- 2: 拒否が効きすぎていない（project / global は今まで通り） -------------------
await check("/kanban loop off -> project の doingLoop を false にする", async () => {
	const msg = await notifyFor("loop off");
	assert.ok(msg.includes("[project]"), msg);
	assert.equal(projectBucket().doingLoop, false, JSON.stringify(readModes()));
});
await check("/kanban loop on session の後の loop on は通る（拒否が状態を壊していない）", async () => {
	await notifyFor("loop on");
	assert.equal(projectBucket().doingLoop, true, JSON.stringify(readModes()));
});
await check("/kanban loop off global -> global 拒否のまま", async () => {
	const msg = await notifyFor("loop off global");
	assert.equal(msg, GLOBAL_NO_SWITCH);
	assert.equal(projectBucket().doingLoop, true, "global 拒否が project を書いた");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// HTTP サーバと poll timer が残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
```

## 検証記録（一度実装したときの記録。現在そのコードは巻き戻し済み）

RED（実装前、`node tests/kanban-cli-session-reject.test.mjs`）:

```text
$ node --test tests/kanban-cli-session-reject.test.mjs
3 passed, 5 failed
  FAIL /kanban loop off session -> session 拒否: 受理された: [project] doingLoop OFF / autoPick ON / 残り 10/10 /
+ '[project] doingLoop OFF / autoPick ON / 残り 10/10 /'
- 'scope=session is gone; boards are project-scoped'
  FAIL /kanban loop on session -> session 拒否: 受理された: …
  FAIL /kanban loop status session -> session 拒否: …
  FAIL /kanban pick off session -> session 拒否: …
  FAIL session 拒否は modes.json に doingLoop=false を書かない
```

GREEN（実装後）: `8 passed, 0 failed`、`npm test` は 199 tests / 199 pass。

## 注意

- 拒否対象は mode コマンド（`loop` / `pick`）の scope スロットのみ。`interval session` /
  `stuck session` / `maxloops session` は元から「不正な数値」で reject される（黙って
  受理されるのは mode だけだった）。エラーメッセージは `使い方:` のまま。
- 関連する未修正の綻び（#29 の親戚）:
  - `extensions/kanban.ts:665` 付近 — `maxLoopsRequest()` は scope の語彙を
    `global|project` で検証するのに、CLI の `interval` / `stuck` / `maxloops` は
    `argv[1] === "global"` の真偽だけで scope を決める。語彙が一致していない。
  - `extensions/kanban.ts:1518-1524` — `argv.slice(2)` を 2 回評価している。
