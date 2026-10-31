// #87: GLOBAL TODO は所有を持たない。所有は DOING だけが持つ。
// 症状（修正前）: B が sid=B で GLOBAL に TODO を足すと stampMove が movedBy=B を書き、
// ownedTodos が movedBy!==sid を除外するため、poll を回す唯一のセッション A の tick が
// そのカードを永久に拾わない（誰も拾わない人質）。
// ここで実測するもの:
//   1. A の poll が movedBy=B の GLOBAL TODO を wake し、settle が DOING に移す（本丸）
//   2. 他人の DOING は奪わない（#10 の懸念は DOING 側で保たれる）
//   3. 2セッションが同時に拾っても DOING は1枚だけ（並行プロセスで実測）
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb87-test-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
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
const JITI = process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti");
const { createJiti } = require(JITI);
const jiti = createJiti(import.meta.url);
// KB87_SRC: 修正前の kanban.ts を差して「修正前は人格になる」ことを同じテストで実測する。
const SRC = process.env.KB87_SRC ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(SRC);
useKanban(mod);
const { nextTodo, tickCardFor, pickFirstTodo, continuationPrompt } = mod;
const { readToken } = await import("./helpers/token.mjs");

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
	seedBoard(boardFile(sid), { cards, nextId: 1 });
const writeGlobalFile = (cards) => seedBoard(GLOBAL, { cards, nextId: 1 });
const readGlobal = () => readBoardAt(GLOBAL).cards;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = "kb87-driver";
const B = "kb87-sibling";

// ---------------------------------------------------------------------------
// 純関数: TODO は所有を持たない / DOING は持つ
// ---------------------------------------------------------------------------
await check("P1 GLOBAL TODO: movedBy が他人でも拾う（#87 の本丸）", () =>
	assert.equal(nextTodo([{ id: 1, text: "theirs", col: "todo", movedBy: B }], "global", A)?.id, 1));

await check("P2 GLOBAL TODO: 他人スタンプ(高priority)が priority 順で先頭に来る", () =>
	assert.equal(
		nextTodo(
			[
				{ id: 1, text: "free", col: "todo", priority: 1 },
				{ id: 2, text: "theirs", col: "todo", movedBy: B, priority: 9 },
			],
			"global",
			A,
		)?.id,
		2,
	));

await check("P3 isSilent の除外は残る（blocked はまだ拾わない）", () => {
	assert.equal(nextTodo([{ id: 1, text: "b", col: "todo", movedBy: B, blocked: "wait" }], "global", A), undefined);
	assert.equal(
		nextTodo([{ id: 1, text: "f", col: "todo", movedBy: B, nextFireAt: "2999-01-01T00:00:00Z" }], "global", A),
		undefined,
	);
});

await check("P4 GLOBAL DOING: 他人の DOING は tickCardFor が拾わない（所有は維持）", () => {
	const cards = [
		{ id: 5, text: "theirs", col: "doing", movedBy: B },
		{ id: 6, text: "mine", col: "doing", movedBy: A },
	];
	assert.equal(tickCardFor(cards, "global", A)?.id, 6);
	assert.equal(tickCardFor([{ id: 5, text: "theirs", col: "doing", movedBy: B }], "global", A), undefined);
});

// ---------------------------------------------------------------------------
// ライブ経路: 実タイマー poll（driver A）+ 実ファイル + 本物の /api/add
// ---------------------------------------------------------------------------
const MODES_STATE = { SESSION: {}, GLOBAL: {} };
const writeModes = () => writeFileSync(MODES, JSON.stringify(MODES_STATE, null, 2));
const setModes = (sid, scope, doingLoop, autoPick) => {
	MODES_STATE[scope][sid] = { doingLoop, autoPick };
	writeModes();
};

function startDriver() {
	const handlers = new Map();
	const sent = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(content) {
			sent.push(content);
		},
	};
	mod.default(pi); // 空きポートで 1 回だけ立ち、HOME は /tmp 配下
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => A, getEntries: () => [] },
	};
	handlers.get("session_start")({}, ctx);
	return { handlers, sent, ctx };
}
const settle = (sess) =>
	sess.handlers.get("agent_before_settle")({ context: { contextMessages: [{ role: "assistant" }] } }, sess.ctx);

/** B の sid で GLOBAL に TODO を足す（ダッシュボードと同じ /api/add 経路）。 */
async function addGlobalAsB(text) {
	const res = await fetch(
		`http://127.0.0.1:${PORT}/api/add?scope=global&sid=${B}&text=${encodeURIComponent(text)}`,
		{ headers: { Cookie: `kb_auth=${readToken()}` } },
	);
	assert.equal(res.status, 200, `api/add failed: ${res.status}`);
}

try {
	const sessA = startDriver();
	setModes(A, "SESSION", true, true);
	setModes(A, "GLOBAL", true, true);
	writeBoardFile(A, []); // SESSION に拾うものは無い -> GLOBAL を見る
	writeGlobalFile([]);

	// --- 1: B の sid で足した GLOBAL TODO を A の tick が拾う -------------------
	await addGlobalAsB("sibling work");
	const added = readGlobal();
	assert.equal(added.length, 1, `add されていない: ${JSON.stringify(added)}`);
	assert.equal(added[0].movedBy, B, "add は movedBy=B を刻む（この状態が人質の原因）");
	const card = added[0];

	let woke = null;
	for (let i = 0; i < 60 && woke === null; i++) {
		await sleep(100);
		if (sessA.sent.length > 0) woke = sessA.sent[0];
	}
	await check("1 A(driver) の poll が movedBy=B の GLOBAL TODO を wake する", () => {
		assert.ok(woke !== null, "movedBy=B の GLOBAL TODO で wake しなかった（人質のまま）");
		assert.equal(woke, continuationPrompt(card, "global"));
		assert.match(woke, /^GLOBAL TODO #1 "sibling work" を着手しろ。/);
	});

	await check("1b settle がそのカードを DOING に移し、movedBy が A になる", () => {
		const res = settle(sessA);
		const live = readGlobal().find((c) => c.id === 1);
		assert.equal(live.col, "doing", `DOING に移っていない: ${JSON.stringify(readGlobal())}`);
		assert.equal(live.movedBy, A, "着手した A が所有を取る");
		assert.equal(res && res.continue, true, "続行するはず");
	});

	await check("1c 移した後は A の DOING になり、poll の wake 式がそのカードを返す", () => {
		// poll の wake 式そのもの（AUTO_TICK は 5 分待つので、実時間ではなく式で見る）
		const cards = readGlobal();
		const picked = tickCardFor(cards, "global", A) ?? nextTodo(cards, "global", A);
		assert.equal(picked?.id, 1, `A が DOING を駆動できない: ${JSON.stringify(cards)}`);
		assert.match(continuationPrompt(picked, "global"), /^GLOBAL DOING #1/);
	});

	// --- 2: 他人の DOING は奪わない ---------------------------------------------
	writeGlobalFile([{ id: 5, text: "sibling doing", col: "doing", movedBy: B }]);
	const sentBefore = sessA.sent.length;
	await sleep(2000); // poll を 1 周以上回す
	await check("2 他人(B)の DOING は A の tick が動かさない", () => {
		assert.equal(sessA.sent.length, sentBefore, `他人の DOING で wake した: ${sessA.sent.slice(sentBefore)}`);
		const live = readGlobal().find((c) => c.id === 5);
		assert.equal(live.col, "doing");
		assert.equal(live.movedBy, B, "所有が書き換わった");
		assert.equal(settle(sessA), undefined, "他人の DOING では settle が続行しない");
	});

	// --- 3: CAS。同じカードを2回拾おうとしても移るのは1回だけ -------------------
	await check("3 二重 pick は 1 回だけ通る（CAS で敗者を弾く）", () => {
		writeGlobalFile([{ id: 9, text: "only once", col: "todo" }]);
		const first = pickFirstTodo(A, "global");
		const second = pickFirstTodo(B, "global"); // B が同じカードを狙う
		assert.equal(first?.id, 9);
		assert.equal(second, null, "既に DOING のカードを再度移した");
		const live = readGlobal().filter((c) => c.id === 9);
		assert.equal(live.length, 1, "カードが複製された");
		assert.equal(live[0].col, "doing");
		assert.equal(live[0].movedBy, A);
	});

	// --- 4: 2プロセス同時。DOING になるのは1枚だけ -----------------------------
	await check("4 2プロセスが同時に拾っても DOING は1枚だけ", async () => {
		writeGlobalFile([{ id: 11, text: "race", col: "todo" }]);
		const startAt = Date.now() + 900;
		const child = (sid) => {
			const harness = `${HOME_DIR}/race-${sid}.mjs`;
			writeFileSync(
				harness,
				`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createJiti } = require(${JSON.stringify(JITI)});
const mod = await createJiti(import.meta.url).import(${JSON.stringify(SRC)});
const startAt = ${startAt};
while (Date.now() < startAt) {} // 同じ瞬間に read-modify-write へ入る
const r = mod.pickFirstTodo(${JSON.stringify(sid)}, "global");
console.log("__R__" + JSON.stringify({ sid: ${JSON.stringify(sid)}, id: r === null ? null : r.id }));
setTimeout(() => process.exit(0), 100);
`,
			);
			const p = spawn(process.execPath, [harness], { env: { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR } });
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			return new Promise((resolve) =>
				p.on("exit", () => resolve(JSON.parse(out.slice(out.indexOf("__R__") + 5).split("\n")[0]))),
			);
		};
		const results = await Promise.all([child("race-a"), child("race-b")]);
		const winners = results.filter((r) => r.id !== null).length;
		console.log(`  race: ${winners} winner(s) of 2 processes -> ${JSON.stringify(results)}`);
		const live = readGlobal().filter((c) => c.id === 11);
		assert.equal(live.length, 1, `カードが複製された: ${JSON.stringify(readGlobal())}`);
		assert.equal(live[0].col, "doing");
		assert.ok(results.some((r) => r.id === 11), `どちらも移せなかった: ${JSON.stringify(results)}`);
		assert.ok([A, B, "race-a", "race-b"].includes(live[0].movedBy), "所有が壊れた");
	});
} catch (err) {
	failures.push(`live: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
