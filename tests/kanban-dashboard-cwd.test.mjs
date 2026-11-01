// #27: GET /api/dashboard の project 面は「セッションファイルのヘッダ cwd」のボードを返す。
// フレームワーク無しで `node tests/kanban-dashboard-cwd.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-dashboard-cwd-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/projects`, { recursive: true });
// sessionInfoById() の源泉。header の cwd だけが dashboard の鍵になる。
const SESSIONS = `${HOME_DIR}/.pi/agent/sessions/encoded-elsewhere`;
mkdirSync(SESSIONS, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = process.env.HOME;
// PI_CODING_AGENT_DIR があると getAgentDir() が HOME を無視して偽 HOME の sessions/ を見ない。
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

const SID = "dash-cwd-sid";
const SLUG = mod.projectSlugOf(process.cwd());
const otherDir = mkdtempSync(join(tmpdir(), "kb27-dash-"));
const OTHER = mod.projectSlugOf(otherDir);

// SessionManager.listAll() が読むのは JSONL の 1 行目 = type:"session" のヘッダ。
// 必要なのは id と cwd だけ（dist/core/session-manager.js:505-513）。
writeFileSync(
	`${SESSIONS}/${SID}.jsonl`,
	JSON.stringify({
		type: "session",
		version: 3,
		id: SID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: otherDir,
	}) + "\n",
);
// 実行 cwd のボードは空、ヘッダ cwd のボードには DOING 1 枚。
seedBoard(`${KB}/projects/${SLUG}.json`, { cards: [], nextId: 1 });
seedBoard(`${KB}/projects/${OTHER}.json`, {
	cards: [{ id: 7, text: "elsewhere", col: "doing", movedBy: SID }],
	nextId: 8,
});
// スイッチもヘッダ cwd のキーに置く（既定 ON と区別できるよう doingLoop を OFF）。
writeFileSync(
	`${KB}/modes.json`,
	JSON.stringify({
		PROJECT: { [OTHER]: { doingLoop: false } },
		GLOBAL: {},
	}),
);

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
	// getCwd は実行 cwd を返す（旧実装の答え）。dashboard がこれを使えば SLUG になる。
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

await check("前提: 別ディレクトリの slug は実行 cwd の slug と違う", () =>
	assert.notEqual(OTHER, SLUG, `OTHER=${OTHER} SLUG=${SLUG}（同じならこのテストは空振り）`),
);

const data = ready ? await (await authFetch(`${BASE}/api/dashboard`)).json() : { project: {} };
await check("project.id はセッションファイルのヘッダ cwd の slug", () =>
	assert.equal(data.project.id, OTHER, `project.id=${data.project.id}`),
);
await check("project.counts はそのボードの件数", () => {
	assert.equal(data.project.counts.doing, 1, JSON.stringify(data.project.counts));
	assert.equal(data.project.counts.todo, 0, JSON.stringify(data.project.counts));
});
await check("project.modes はヘッダ cwd の slug キー（PROJECT[OTHER]）", () => {
	assert.equal(data.project.modes.doingLoop, false, JSON.stringify(data.project.modes));
	assert.equal(data.project.modes.autoPick, true, JSON.stringify(data.project.modes));
});

rmSync(otherDir, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// HTTP サーバと poll timer が残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
