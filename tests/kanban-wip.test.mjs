// kanban WIP=1 の自己検証。`node tests/kanban-wip.test.mjs`。
// settle の autoPick は「その scope に自分の DOING がある」とき TODO を拾わない。
// DOING が空なら TODO を拾う（Phase 10 の意図）。他セッションの DOING は WIP 扱いしない。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-wip-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));

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

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const GLOBAL = `${HOME_DIR}/.pi/kanban/global.json`;
const boardFile = (sid) => `${HOME_DIR}/.pi/kanban/sessions/${sid}.json`;
const writeBoardFile = (sid, cards) =>
	writeFileSync(boardFile(sid), JSON.stringify({ cards, nextId: 90 }, null, 2));
const writeGlobalFile = (cards) => writeFileSync(GLOBAL, JSON.stringify({ cards, nextId: 90 }, null, 2));
const readCards = (sid) => JSON.parse(readFileSync(boardFile(sid), "utf8")).cards;
const readGlobal = () => JSON.parse(readFileSync(GLOBAL, "utf8")).cards;

// 全セッション分を毎回書き戻す: poll は modes.json を読み直す。
const modesState = { SESSION: {}, GLOBAL: {} };
const writeModes = () => writeFileSync(MODES, JSON.stringify(modesState, null, 2));
const setModes = (sid, scope, doingLoop, autoPick) => {
	modesState[scope][sid] = { doingLoop, autoPick };
	writeModes();
};

function startSession(sid) {
	const handlers = new Map();
	const sent = [];
	mod.default({
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(content) {
			sent.push(content);
		},
	});
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => sid, getEntries: () => [] },
	};
	handlers.get("session_start")({}, ctx);
	return { handlers, sent, ctx };
}
const settle = (s) =>
	s.handlers.get("agent_before_settle")({ context: { contextMessages: [{ role: "assistant" }] } }, s.ctx);

const S = "wip-me";
const OTHER = "wip-other";
const col = (cards, id) => cards.find((c) => c.id === id)?.col;

// 1: DOING に自分のカードがある -> TODO を拾わない（WIP=1）
{
	const sess = startSession(S);
	setModes(S, "SESSION", true, true);
	writeBoardFile(S, [
		{ id: 1, text: "todo", col: "todo" },
		{ id: 2, text: "doing", col: "doing" },
	]);
	writeGlobalFile([]);
	settle(sess);
	await check("1 DOING あり: TODO は todo のまま（WIP=1）", () =>
		assert.equal(col(readCards(S), 1), "todo"));
	await check("1b DOING あり: 既存 DOING は動かない", () =>
		assert.equal(col(readCards(S), 2), "doing"));
}

// 2: DOING が空なら TODO を拾う（Phase 10 の意図を維持）
{
	const sess = startSession(S);
	setModes(S, "SESSION", true, true);
	writeBoardFile(S, [{ id: 3, text: "todo", col: "todo" }]);
	writeGlobalFile([]);
	settle(sess);
	await check("2 DOING 空: TODO を DOING に移す", () => assert.equal(col(readCards(S), 3), "doing"));
}

// 3: 他セッションの DOING はブロックしない（GLOBAL は movedBy で所有判定）
{
	const sess = startSession(S);
	setModes(S, "SESSION", true, true);
	setModes(S, "GLOBAL", true, true);
	writeBoardFile(S, []);
	writeGlobalFile([
		{ id: 5, text: "theirs", col: "doing", movedBy: OTHER },
		{ id: 6, text: "mine", col: "todo" },
	]);
	settle(sess);
	await check("3 他者 DOING は WIP 扱いしない: GLOBAL TODO を拾う", () =>
		assert.equal(col(readGlobal(), 6), "doing"));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
