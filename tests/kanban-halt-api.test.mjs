// #43/#48: ダッシュボードからの一時停止（/api/halt）と解除（/api/resume）の往復。
// フレームワーク無しで `node tests/kanban-halt-api.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-halt-api-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
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
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

const failures = [];
let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}
const get = async (path) => {
	const r = await authFetch(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
};
const rowOf = async () => (await get("/api/dashboard")).body.project;

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const readModesRaw = () => JSON.parse(readFileSync(MODES, "utf8"));
const PROJ_KEY = mod.projectSlugOf(process.cwd());
const PROJ_FILE = `${HOME_DIR}/.pi/kanban/projects/${PROJ_KEY}.json`;

function mkPi() {
	const handlers = new Map();
	const appended = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry(type, data) {
			appended.push({ type, data });
		},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage() {},
	};
	return { pi, handlers, appended };
}

function mkCtx(sid, entries = []) {
	return {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => entries,
		},
	};
}

const loopEntry = (count, halted = null) => ({
	type: "custom",
	customType: "kanban-loop",
	data: { count, halted, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: Date.now() },
});

const SID = "sid-halt";
const run = mkPi();
const t = mod.default(run.pi).__test;
seedBoard(PROJ_FILE, { cards: [{ id: 1, text: "t", col: "doing", movedBy: SID }], nextId: 2 });
writeFileSync(
	MODES,
	JSON.stringify({ PROJECT: { [PROJ_KEY]: { doingLoop: true, autoPick: false } }, GLOBAL: {} }, null, 2),
);
run.handlers.get("session_start")({ type: "session_start" }, mkCtx(SID, [loopEntry(1)]));

{
	const g = await get(`/api/halt?scope=global&sid=${SID}`);
	check("/api/halt?scope=global は 400（集約ビューはスイッチを持たない）", () => {
		assert.equal(g.status, 400, JSON.stringify(g.body));
		assert.equal(t.haltRequests.size, 0, `keys=${[...t.haltRequests]}`);
	});
}

{
	const r = await get("/api/halt?scope=project");
	check("/api/halt?scope=project は 202（resume と同じ受け方）", () => {
		assert.equal(r.status, 202, JSON.stringify(r.body));
		assert.equal(r.body.ok, true, JSON.stringify(r.body));
		assert.equal(r.body.queued, true, JSON.stringify(r.body));
	});
	check("要求はボードキーではなく sid で積まれる", () => {
		assert.equal(t.haltRequests.has(SID), true, `keys=${[...t.haltRequests]}`);
		assert.equal(t.haltRequests.has(PROJ_KEY), false);
	});
}

// 実際の halt はプロセスのメモリなので、poll が消費して初めて動く。
t.poll();
check("poll が halt 要求を消費する", () => assert.equal(t.haltRequests.has(SID), false));

{
	const row = await rowOf();
	check("halt 後の dashboard 行は halted", () => assert.equal(row.halted, true, JSON.stringify(row)));
}
check("halt は project の doingLoop を落とす（limit halt と同じ形）", () => {
	assert.equal(readModesRaw().PROJECT[PROJ_KEY].doingLoop, false, JSON.stringify(readModesRaw().PROJECT));
});
check("halt は残り回数を消費しない（count 据え置き）", () => {
	const last = run.appended.filter((e) => e.type === "kanban-loop").pop();
	assert.equal(last.data.count, 1, JSON.stringify(last.data));
	assert.equal(last.data.halted, "limit", JSON.stringify(last.data));
});

// 二度目の halt は何もしない（count も状態も動かない）。
{
	await get("/api/halt?scope=project");
	t.poll();
	const last = run.appended.filter((e) => e.type === "kanban-loop").pop();
	check("既に halted なら halt は no-op", () => {
		assert.equal(last.data.count, 1, JSON.stringify(last.data));
		assert.equal(last.data.halted, "limit", JSON.stringify(last.data));
	});
}

// 解除は resume（#43）。上限 halt と同じく doingLoop を戻し、count は 0 に戻る。
{
	await get("/api/resume?scope=project");
	t.poll();
	const row = await rowOf();
	check("resume 後の dashboard 行は halted:false", () => assert.equal(row.halted, false, JSON.stringify(row)));
	check("resume は doingLoop を ON に戻す", () =>
		assert.equal(readModesRaw().PROJECT[PROJ_KEY].doingLoop, true, JSON.stringify(readModesRaw().PROJECT)));
	check("resume は budget を戻す（count 0）", () => {
		const last = run.appended.filter((e) => e.type === "kanban-loop").pop();
		assert.equal(last.data.count, 0, JSON.stringify(last.data));
	});
}

if (failures.length) {
	console.error(`kanban-halt-api: ${passed} passed, ${failures.length} failed`);
	for (const f of failures) console.error("FAIL " + f);
	process.exit(1);
}
console.log(`kanban-halt-api: ${passed} passed`);
run.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
setTimeout(() => process.exit(0), 100);
