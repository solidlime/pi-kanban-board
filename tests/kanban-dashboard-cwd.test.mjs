// #27/#93: GET /api/dashboard の project 面は「driver の live cwd」のボードを返す。
// 判定に効くよう 3 つを別ディレクトリにする:
//   A = セッションファイルのヘッダ cwd（旧実装の答え。#27 が「間違った源」と判定した）
//   B = ctx.sessionManager.getCwd()（= pinDriver が publish する live cwd。これが正解）
//   C = このプロセスの cwd（pin が無い時の答え）
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
// 旧実装はここから cwd を読んでいた（SessionManager.listAll）。もう読まれないことの証拠として残す。
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
const PROC = process.cwd();
const HEADER_DIR = mkdtempSync(join(tmpdir(), "kb27-header-"));
const DRIVER_DIR = mkdtempSync(join(tmpdir(), "kb27-driver-"));
const HEADER = mod.projectSlugOf(HEADER_DIR);
const DRIVER = mod.projectSlugOf(DRIVER_DIR);
const PROC_SLUG = mod.projectSlugOf(PROC);

// A: ヘッダ cwd（もう読まれない源）。
writeFileSync(
	`${SESSIONS}/${SID}.jsonl`,
	JSON.stringify({
		type: "session",
		version: 3,
		id: SID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: HEADER_DIR,
	}) + "\n",
);
// B: ctx の cwd のボードに DOING 1 枚。A と C のボードは空。
seedBoard(`${KB}/projects/${DRIVER}.json`, {
	cards: [{ id: 7, text: "driven", col: "doing", movedBy: SID }],
	nextId: 8,
});
seedBoard(`${KB}/projects/${HEADER}.json`, { cards: [], nextId: 1 });
seedBoard(`${KB}/projects/${PROC_SLUG}.json`, { cards: [], nextId: 1 });
// スイッチも B のキーに置く（既定 ON と区別できるよう doingLoop を OFF）。
writeFileSync(
	`${KB}/modes.json`,
	JSON.stringify({
		PROJECT: { [DRIVER]: { doingLoop: false } },
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
// getCwd は B を返す。ここが live な源で、session_start が cwdBySid に publish する。
const ctx = {
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => SID, getEntries: () => [], getCwd: () => DRIVER_DIR },
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

await check("前提: A(ヘッダ) / B(driver) / C(process) が別の slug（同じならこのテストは空振り）", () => {
	assert.notEqual(HEADER, DRIVER, `HEADER=${HEADER} DRIVER=${DRIVER}`);
	assert.notEqual(DRIVER, PROC_SLUG, `DRIVER=${DRIVER} PROC=${PROC_SLUG}`);
	assert.notEqual(HEADER, PROC_SLUG, `HEADER=${HEADER} PROC=${PROC_SLUG}`);
});

const data = ready ? await (await authFetch(`${BASE}/api/dashboard`)).json() : { project: {} };
await check("project.id は ctx の live cwd（B）の slug。ヘッダ cwd（A）ではない", () =>
	assert.equal(data.project.id, DRIVER, `project.id=${data.project.id} B=${DRIVER} A=${HEADER}`),
);
await check("project.counts はそのボードの件数", () => {
	assert.equal(data.project.counts.doing, 1, JSON.stringify(data.project.counts));
	assert.equal(data.project.counts.todo, 0, JSON.stringify(data.project.counts));
});
await check("project.modes は B の slug キー（PROJECT[B]）", () => {
	assert.equal(data.project.modes.doingLoop, false, JSON.stringify(data.project.modes));
	assert.equal(data.project.modes.autoPick, true, JSON.stringify(data.project.modes));
});

rmSync(HEADER_DIR, { recursive: true, force: true });
rmSync(DRIVER_DIR, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// HTTP サーバと poll timer が残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
