// #27: ヘッダ cwd が空文字のセッション（旧セッション。dist/core/session-manager.js:541 が
// `cwd: ""` を返す）で、/api/dashboard の project 面が process.cwd() のボードを名乗ること。
// 直す前は cwdOfSidSync の `??` が "" を通し、projectSlugOf("") が "inbox" になっていた
// （cwdOfCtx は同じ入力を process.cwd() に落とすので、同じ「cwd 無し」で 2 つのボードができていた）。
// 偽 HOME と実行 cwd を差し替えるので本番の ~/.pi/kanban には触れない。
// 実行 cwd を非 git ディレクトリにするのは必須: `git -C ""` は git 2.x で自プロセスの cwd を
// 指すので、repo の中で走らせると projectSlugOf("") が偶然 cwd の slug に化けて差が出ない。
// フレームワーク無しで `node tests/kanban-dashboard-empty-cwd.test.mjs`。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { authFetch } from "./helpers/token.mjs";
import { seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-dashboard-empty-cwd-home";
// サーバの cwd（＝process.cwd()）を非 git の作業ディレクトリに差し替える。
// /tmp は Windows ではドライブ相対なので、 HOME のパスを組む前に chdir しておく。
const ORIG_CWD = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), "kb27-empty-cwd-work-"));
process.chdir(WORK);
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/projects`, { recursive: true });
const SESSIONS = `${HOME_DIR}/.pi/agent/sessions/encoded-elsewhere`;
mkdirSync(SESSIONS, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = process.env.HOME;
delete process.env.PI_CODING_AGENT_DIR;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);
const BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;

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

const SID = "dash-empty-cwd-sid";
const SLUG = mod.projectSlugOf(process.cwd());
// ヘッダ cwd は空文字（旧セッション）。
writeFileSync(
	`${SESSIONS}/${SID}.jsonl`,
	JSON.stringify({
		type: "session",
		version: 3,
		id: SID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "",
	}) + "\n",
);
// 実行 cwd のボードだけに DOING 1 枚。inbox ボードは空。
seedBoard(`${KB}/projects/${SLUG}.json`, {
	cards: [{ id: 7, text: "own board", col: "doing", movedBy: SID }],
	nextId: 8,
});
seedBoard(`${KB}/projects/inbox.json`, { cards: [], nextId: 1 });

const handlers = new Map();
const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
};
mod.default(pi);
const ctx = {
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => SID, getEntries: () => [], getCwd: () => process.cwd() },
};
handlers.get("session_start")({ type: "session_start" }, ctx);
let ready = false;
for (let i = 0; i < 100; i++) {
	try {
		if ((await authFetch(`${BASE}/api/kanban`)).ok) {
			ready = true;
			break;
		}
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}
await check("サーバが上がる", () =>
	assert.equal(ready, true, `port=${process.env.KANBAN_PORT} で listen しない`),
);

const data = ready ? await (await authFetch(`${BASE}/api/dashboard`)).json() : { project: {} };
await check("前提: 非 git の cwd の slug は inbox ではない（projectSlugOf(\"\") と区別できる）", () =>
	assert.notEqual(SLUG, "inbox", `SLUG=inbox（projectSlugOf("") と同じでこのテストは空振り）`),
);
await check("ヘッダ cwd が空なら project.id は process.cwd() の slug（inbox ではない）", () => {
	assert.notEqual(data.project.id, "inbox", `project.id=inbox（cwdOfSidSync が "" を通した）`);
	assert.equal(data.project.id, SLUG, `project.id=${data.project.id} SLUG=${SLUG}`);
});
await check("project.counts はそのボードの件数", () => {
	assert.equal(data.project.counts.doing, 1, JSON.stringify(data.project.counts));
	assert.equal(data.project.counts.todo, 0, JSON.stringify(data.project.counts));
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// Windows は cwd になっているディレクトリを削除できないので、先に戻る。
process.chdir(ORIG_CWD);
rmSync(WORK, { recursive: true, force: true });
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
