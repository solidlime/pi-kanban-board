// kanban「発火制御」の自己検証。フレームワーク無しで `node tests/kanban-fire.test.mjs`。
// 対象: blocked / nextFireAt / firedFor（isSilent 等の純関数、pickFirstTodo、settle 経路、
// kanban ツール、/api/schedule、実タイマー）。Phase 10/11 の挙動は一切変えない。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-fire-home";
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
const target = process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(target);
useKanban(mod);
const {
	isBlockedCard,
	fireAtMs,
	isSilent,
	normalizeFireAt,
	tickCardFor,
	nextTodo,
	pickFirstTodo,
	continuationPrompt,
} = mod;

const HOME = `${HOME_DIR}/.pi/kanban`;
const SESSION_DIR = `${HOME}/sessions`;
const MODES = `${HOME}/modes.json`;
const baseBoard = { cards: [], nextId: 1 };

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
// async checks are queued and awaited in order (check() cannot await).
const asyncChecks = [];
const checkA = (name, fn) => {
	asyncChecks.push([name, fn]);
};

const board = (sid) => readBoardAt(`${SESSION_DIR}/${sid}.json`);
const readRaw = (p) => readBoardAt(p);
const writeSession = (sid, b) => seedBoard(`${SESSION_DIR}/${sid}.json`, b);
const writeGlobal = (b) => seedBoard(`${HOME}/global.json`, b);

const ctxFor = (sid) => ({
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => sid, getEntries: () => [] },
});

// ---------------------------------------------------------------------------
// 1: 純関数 — blocked / nextFireAt / firedFor / 後方互換
// ---------------------------------------------------------------------------
const NOW = Date.parse("2026-10-17T20:00:00.000Z");
const PAST = "2020-01-01T00:00:00.000Z"; // 実時刻に対しても過去

check("Car なし = isSilent false（従来動作）", () => {
	assert.equal(isSilent({ id: 1 }, NOW), false);
	assert.equal(isBlockedCard({ id: 1 }), false);
	assert.equal(fireAtMs({ id: 1 }), null);
});

check("nextFireAt 未来 -> silent / 過去 -> 鳴る", () => {
	assert.equal(isSilent({ id: 1, nextFireAt: "2026-10-17T21:00:00.000Z" }, NOW), true);
	assert.equal(isSilent({ id: 1, nextFireAt: PAST }, NOW), false);
});

check("境界: nextFireAt の瞬間（== now）は鳴る", () => {
	assert.equal(isSilent({ id: 1, nextFireAt: new Date(NOW).toISOString() }, NOW), false);
});

check("blocked は nextFireAt に勝つ（過去でも未来でも沈黙）", () => {
	assert.equal(isSilent({ id: 1, blocked: "外部待ち", nextFireAt: PAST }, NOW), true);
	assert.equal(isSilent({ id: 1, blocked: "外部待ち", nextFireAt: "2026-10-17T21:00:00.000Z" }, NOW), true);
});

check('blocked: "" は解除（沈黙しない）/ 空白のみも解除', () => {
	assert.equal(isSilent({ id: 1, blocked: "", nextFireAt: PAST }, NOW), false);
	assert.equal(isSilent({ id: 1, blocked: "   ", nextFireAt: PAST }, NOW), false);
});

check("firedFor == nextFireAt -> 沈黙（1回だけ鳴る）", () => {
	assert.equal(isSilent({ id: 1, nextFireAt: PAST, firedFor: PAST }, NOW), true);
});

check("nextFireAt を再設定 -> 再発火（firedFor と不一致）", () => {
	assert.equal(isSilent({ id: 1, nextFireAt: PAST, firedFor: "2026-10-17T18:00:00.000Z" }, NOW), false);
});

check("不正な nextFireAt は制限なし（従来動作）", () => {
	assert.equal(fireAtMs({ nextFireAt: "not-a-date" }), null);
	assert.equal(isSilent({ id: 1, nextFireAt: "not-a-date" }, NOW), false);
});

check("normalizeFireAt: 相対 +3h / +90m は絶対へ解決（保存前に解決）", () => {
	assert.equal(normalizeFireAt("+3h", NOW), new Date(NOW + 3 * 3_600_000).toISOString());
	assert.equal(normalizeFireAt("+90m", NOW), new Date(NOW + 90 * 60_000).toISOString());
	assert.equal(normalizeFireAt(PAST, NOW), PAST);
	assert.equal(normalizeFireAt(""), null);
	assert.equal(normalizeFireAt("garbage"), null);
});

check("今 firedFor を書いても nextFireAt 自体は動かない（自動延長禁止）", () => {
	const c = { id: 1, nextFireAt: PAST };
	const before = c.nextFireAt;
	c.firedFor = before;
	assert.equal(c.nextFireAt, before);
});

// ---------------------------------------------------------------------------
// 2: 選定の純関数 — blocked は置かれた場所を問わず沈黙（TODO / DOING 両方）
// ---------------------------------------------------------------------------
const TODO_PLAIN = { id: 1, text: "plain", col: "todo" };
const TODO_BLOCKED = { id: 2, text: "blocked", col: "todo", blocked: "外部待ち" };
const TODO_FUTURE = { id: 3, text: "later", col: "todo", nextFireAt: "2026-10-17T21:00:00.000Z" };
const TODO_DUE = { id: 5, text: "overdue", col: "todo", nextFireAt: PAST };

check("nextTodo: blocked の TODO は除外（統計にも乗らない）", () => {
	assert.equal(nextTodo([TODO_BLOCKED, TODO_PLAIN], "session", "me", NOW).id, 1);
});

check("nextTodo: 全 TODO が blocked -> undefined（ただし例外なし）", () => {
	assert.equal(nextTodo([TODO_BLOCKED], "session", "me", NOW), undefined);
});

check("nextTodo: nextFireAt 未来は除外 / 過去は選ぶ", () => {
	assert.equal(nextTodo([TODO_FUTURE, TODO_PLAIN], "session", "me", NOW).id, 1);
	assert.equal(nextTodo([TODO_FUTURE, TODO_DUE], "session", "me", NOW).id, 5);
	// orderTodos の既存規則（id 昇順）は黙って変えない。
	assert.equal(nextTodo([TODO_FUTURE, TODO_DUE, TODO_PLAIN], "session", "me", NOW).id, 1);
});

check("blocked 1枚は autoPick 全体を殺さない（非 blocked は従来どおり）", () => {
	assert.equal(nextTodo([TODO_BLOCKED, TODO_PLAIN], "session", "me", NOW).id, 1);
	assert.equal(nextTodo([TODO_PLAIN, TODO_BLOCKED], "session", "me", NOW).id, 1);
});

const DOING_HEAD = { id: 1, text: "head", col: "doing" };
const DOING_BLOCKED = { id: 2, text: "manual blocked", col: "doing", blocked: "外部待ち" };

check("tickCardFor: 手で DOING に置いた blocked も沈黙する（注入しない）", () => {
	assert.equal(tickCardFor([DOING_BLOCKED], "session", "me", NOW), undefined);
	assert.equal(tickCardFor([DOING_HEAD, DOING_BLOCKED], "session", "me", NOW).id, 1);
});

check("tickCardFor: 沈黙 head は後続を飢えさせない", () => {
	const cards = [DOING_BLOCKED, { id: 3, text: "due", col: "doing", nextFireAt: PAST }];
	assert.equal(tickCardFor(cards, "session", "me", NOW).id, 3);
	const cards2 = [
		{ id: 1, text: "future", col: "doing", nextFireAt: "2026-10-17T21:00:00.000Z" },
		{ id: 2, text: "due", col: "doing", nextFireAt: PAST },
	];
	assert.equal(tickCardFor(cards2, "session", "me", NOW).id, 2);
});

// ---------------------------------------------------------------------------
// 3: pickFirstTodo（実ファイル）
// ---------------------------------------------------------------------------
const PICK = "fire-pick";
writeFileSync(MODES, JSON.stringify({ SESSION: {}, GLOBAL: {} }, null, 2));
writeSession(PICK, { cards: [TODO_BLOCKED, TODO_PLAIN], nextId: 9 });
check("pickFirstTodo: blocked を飛ばして次の TODO を DOING に上げる", () => {
	const picked = pickFirstTodo(PICK, "session");
	assert.equal(picked && picked.id, 1);
	const b = board(PICK);
	assert.equal(b.cards.find((c) => c.id === 1).col, "doing");
	assert.equal(b.cards.find((c) => c.id === 2).col, "todo", "blocked は TODO のまま");
});

writeSession(PICK, { cards: [TODO_BLOCKED], nextId: 9 });
check("pickFirstTodo: blocked しか無ければ null（上げない）", () => {
	assert.equal(pickFirstTodo(PICK, "session"), null);
	assert.equal(board(PICK).cards[0].col, "todo");
});

// ---------------------------------------------------------------------------
// 4: settle 経路（実ファイル + agent_before_settle ハンドラ）
// ---------------------------------------------------------------------------
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
// poll は「静かな」セッション（空ボード）を見せる: settle 検証に実タイマーが割り込まない。
const quiet = (sid) => {
	modesWith(sid, { doingLoop: false, autoPick: false });
	writeSession(sid, { cards: [], nextId: 1 });
	handlers.get("session_start")({}, ctxFor(sid));
};

const modesWith = (sid, m) => writeFileSync(MODES, JSON.stringify({ SESSION: { [sid]: m }, GLOBAL: {} }));
const settle = (sid, cards, opts = {}, contextMessages = undefined) => {
	modesWith(sid, { doingLoop: true, autoPick: true, intervalMin: 1, ...opts });
	writeSession(sid, { cards, nextId: 20 });
	return handlers.get("agent_before_settle")({ context: { contextMessages } }, ctxFor(sid));
};

quiet("fire-quiet");

check("settle: DOING が blocked で他に DOING 無し -> 注入なし", () => {
	const r = settle("fire-b1", [DOING_BLOCKED]);
	assert.ok(r === undefined || (r && r.continue !== true), "注入されない");
});

check("settle: doingLoop OFF -> continue しない（従来）", () => {
	const r = settle("fire-b2", [{ id: 1, text: "x", col: "doing" }], { doingLoop: false });
	assert.ok(r === undefined || (r && r.continue !== true));
});

check("settle: フラグ無しの既存カードは従来どおり continue（後方互換）", () => {
	const r = settle("fire-b3", [{ id: 1, text: "x", col: "doing" }]);
	assert.ok(r && r.continue === true, "フラグ無しは従来どおり");
	assert.match(r.entries[0].content, /#1/);
});

check("settle: blocked を外して nextFireAt 過去 -> 直ちに鳴る", () => {
	// 解除は blocked を消すだけ。fireAt は過去のまま -> due。
	const r = settle("fire-b4", [{ id: 1, text: "x", col: "doing", nextFireAt: PAST }], {}, undefined);
	assert.ok(r && r.continue === true, "解除後は過去 fireAt で鳴る");
});

check("settle: user が head の run -> 乗っ取らない（従来）", () => {
	const r = settle("fire-b5", [{ id: 1, text: "x", col: "doing" }], {}, [{ role: "user" }]);
	assert.ok(r === undefined || (r && r.continue !== true));
});

// loop の stuck/count は factory 単位で、session_start が既定値に戻す。
// poll の対象も同時に空ボードへ戻すので、実タイマーは settle 検証に割り込まない。
const resetLoop = () => quiet("fire-quiet");

// 飢餓: DOING に due が2枚。head だけ鳴り、次の settle では2枚目が鳴る。
checkA("settle: due が2枚でも注入は1枚ぶん（列挙しない。head だけ）", async () => {
	const SID = "fire-sched";
	resetLoop();
	const cards = [
		{ id: 1, text: "A", col: "doing", nextFireAt: PAST },
		{ id: 2, text: "B", col: "doing", nextFireAt: PAST },
	];
	const r = settle(SID, cards);
	assert.ok(r && r.continue === true, "1枚目は注入される");
	assert.match(r.entries[0].content, /#1/, "head は #1");
	assert.doesNotMatch(r.entries[0].content, /#2/, "1回で列挙しない");
	const b = board(SID);
	assert.equal(b.cards.find((c) => c.id === 1).firedFor, PAST, "firedFor が注入後に書かれる");
	assert.equal(b.cards.find((c) => c.id === 1).nextFireAt, PAST, "nextFireAt は動かない");
	assert.equal(b.cards.find((c) => c.id === 2).firedFor, undefined, "2枚目はまだ記録なし");
});

checkA("settle: 次の settle では2枚目が鳴る（1枚目が連続で鳴らない = 飢餓しない）", async () => {
	const SID = "fire-sched"; // 直前の checkA と同じセッションを継続
	const r = handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxFor(SID));
	assert.ok(r && r.continue === true, "2枚目が鳴る");
	assert.match(r.entries[0].content, /#2/, "今度は #2");
	const b = board(SID);
	assert.equal(b.cards.find((c) => c.id === 2).firedFor, PAST);
});

checkA("settle: nextFireAt を再設定すると再び鳴る（再点火）", async () => {
	const SID = "fire-sched";
	resetLoop();
	// #1 を別の due 値に再設定 -> firedFor と不一致 -> 再発火。
	const b = board(SID);
	const rearmed = new Date(Date.now() - 30_000).toISOString(); // 過去だが旧 firedFor と別値
	b.cards.find((c) => c.id === 1).nextFireAt = rearmed;
	writeSession(SID, b);
	const r = handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxFor(SID));
	assert.ok(r && r.continue === true, "再設定後は鳴る");
	assert.match(r.entries[0].content, /#1/);
	assert.equal(board(SID).cards.find((c) => c.id === 1).firedFor, rearmed);
});

// ---------------------------------------------------------------------------
// 5: kanban ツール — エージェントが blocked / nextFireAt を設定できる
// ---------------------------------------------------------------------------
const tool = () => {
	const registered = [];
	const p = {
		registerCommand() {},
		registerTool(spec) {
			registered.push(spec);
		},
		appendEntry() {},
		on() {},
		sendUserMessage() {},
	};
	mod.default(p);
	const spec = registered.find((s) => s.name === "kanban");
	assert.ok(spec, "kanban ツールが登録されている");
	return spec;
};

checkA("kanban ツール add: blocked / 相対 nextFireAt を絶対時刻で保存", async () => {
	const before = Date.now();
	const r = await tool().execute("c1", { action: "add", text: "sched", blocked: "外部待ち", nextFireAt: "+90m" }, undefined, undefined, ctxFor("fire-tool"));
	assert.ok(!r.isError, r.content[0].text);
	const c = board("fire-tool").cards.find((x) => x.text === "sched");
	assert.equal(c.blocked, "外部待ち");
	const t = Date.parse(c.nextFireAt);
	assert.ok(t >= before + 90 * 60_000 - 5_000 && t <= Date.now() + 90 * 60_000 + 5_000, `絶対時刻 ${c.nextFireAt}`);
	assert.match(c.nextFireAt, /^\d{4}-\d{2}-\d{2}T.*Z$/, "ISO 8601 (Z) で保存");
	assert.equal(c.firedFor, undefined);
});

checkA("kanban ツール move: blocked 解除 / nextFireAt 解除", async () => {
	const r = await tool().execute("c2", { action: "move", id: 1, col: "doing", blocked: "", nextFireAt: "" }, undefined, undefined, ctxFor("fire-tool"));
	assert.ok(!r.isError, r.content[0].text);
	const c = board("fire-tool").cards.find((x) => x.id === 1);
	assert.equal(c.col, "doing");
	assert.equal(c.blocked, undefined, 'blocked "" はフィールド削除');
	assert.equal(c.nextFireAt, undefined);
});

checkA("kanban ツール add: 不正な nextFireAt は保存せずエラー", async () => {
	const r = await tool().execute("c3", { action: "add", text: "bad", nextFireAt: "garbage" }, undefined, undefined, ctxFor("fire-tool"));
	assert.ok(r.isError, "エラーになる");
	assert.equal(board("fire-tool").cards.some((x) => x.text === "bad"), false, "カードは追加されない");
});

// add は params.col を尊重する（未指定のみ todo にフォールバック）。
const addCol = async (text, params, sid) => {
	const r = await tool().execute(`c-${text}`, { action: "add", text, ...params }, undefined, undefined, ctxFor(sid));
	assert.ok(!r.isError, r.content[0].text);
	return { card: board(sid).cards.find((x) => x.text === text), message: r.content[0].text };
};

checkA("kanban ツール add: col 未指定 -> todo（後方互換）", async () => {
	const { card, message } = await addCol("col-default", {}, "fire-add-col");
	assert.equal(card.col, "todo");
	assert.match(message, /to todo \(session\)/);
});

checkA('kanban ツール add: col "doing" を尊重', async () => {
	const { card, message } = await addCol("col-doing", { col: "doing" }, "fire-add-col");
	assert.equal(card.col, "doing");
	assert.match(message, /to doing \(session\)/, message);
});

checkA('kanban ツール add: col "done" を尊重', async () => {
	const { card, message } = await addCol("col-done", { col: "done" }, "fire-add-col");
	assert.equal(card.col, "done");
	assert.match(message, /to done \(session\)/, message);
});

// ---------------------------------------------------------------------------
// 6: /api/schedule（既存の GET+query 規約 / sid 必須）
// ---------------------------------------------------------------------------
const api = async (path, sid) => {
	const res = await tf(`${API_BASE}${path}${path.includes("?") ? "&" : "?"}sid=${sid}`);
	return { status: res.status, body: await res.json() };
};
const API_BASE = (() => {
	const port = process.env.KANBAN_PORT;
	return `http://127.0.0.1:${port}`;
})();

const sessionsJson = async () => (await tf(`${API_BASE}/api/sessions`)).json();

checkA("session_shutdown は driver の pin を解放する（#55）", async () => {
	// ここまでで pin されているのは fire-quiet（プロセス最初の session_start）。
	const before = await sessionsJson();
	assert.equal(before.activeSessionId, "fire-quiet", JSON.stringify(before.activeSessionId));
	handlers.get("session_shutdown")();
	const after = await sessionsJson();
	assert.equal(after.activeSessionId, null, "shutdown 後も pin が残っている");
	assert.equal(after.sessions.filter((s) => s.isActive).length, 0, "ACTIVE の看板が残っている");
});

checkA("/api/schedule: blocked 設定（GET+query）-> 保存される", async () => {
	// #40: activeSessionId is pinned by the FIRST session_start in the process
	// (fire-quiet, released by the shutdown check above). pin it again so
	// fire-api is the driver for this block.
	quiet("fire-api");
	writeSession("fire-api", { cards: [{ id: 1, text: "g", col: "todo" }], nextId: 2 });
	const { status, body } = await api("/api/schedule?id=1&blocked=%E5%A4%96%E9%83%A8%E5%BE%85%E3%81%A1", "fire-api");
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(board("fire-api").cards[0].blocked, "外部待ち");
	const r2 = await api("/api/schedule?id=1&at=%2B3h", "fire-api");
	assert.equal(r2.status, 200);
	assert.match(board("fire-api").cards[0].nextFireAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
	const r3 = await api("/api/schedule?id=1&at=&blocked=", "fire-api");
	assert.equal(r3.status, 200);
	assert.equal(board("fire-api").cards[0].nextFireAt, undefined, '"" で解除');
	assert.equal(board("fire-api").cards[0].blocked, undefined);
	// at も blocked も無い = 呼び出し側のミス。黙って書き込み成功にしない。
	const r4 = await api("/api/schedule?id=1", "fire-api");
	assert.equal(r4.status, 400, JSON.stringify(r4.body));
});

checkA("/api/schedule: 不正な at は 400（黙って解除しない）", async () => {
	const { status } = await api("/api/schedule?id=1&at=garbage", "fire-api");
	assert.equal(status, 400);
});

// ---------------------------------------------------------------------------
// 7: 実タイマー — due は1回だけ注入し、firedFor が disk に載る
// ---------------------------------------------------------------------------
const SID = "fire-live";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveFire() {
	const handlers2 = new Map();
	const sent = [];
	const p = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers2.set(ev, fn);
		},
		sendUserMessage(content) {
			sent.push(content);
		},
	};
	mod.default(p);
	handlers2.get("session_start")({}, ctxFor(SID));

	const modesPath = `${HOME}/modes.json`;
	const boardPath2 = `${SESSION_DIR}/${SID}.json`;
	const writeModes = (m) => writeFileSync(modesPath, JSON.stringify({ SESSION: { [SID]: m }, GLOBAL: {} }));
	const writeBoard2 = (cards) => seedBoard(boardPath2, { cards, nextId: 9 });
	const due = new Date(Date.now() - 5 * 60_000).toISOString();
	const later = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
	// 1.2s 間隔なら 1.8s のポーリングで連続発火の間隔判定を満たす。
	writeModes({ doingLoop: true, autoPick: false, intervalMin: 0.02 });

	// (A) 未来 -> 鳴らない。
	writeBoard2([{ id: 1, text: "fire me", col: "doing", nextFireAt: later }]);
	await sleep(1800);
	assert.equal(sent.length, 0, `未来は鳴らない (got ${sent.length})`);

	// (B) due -> 1回だけ鳴り、firedFor が disk に載る。
	writeBoard2([{ id: 1, text: "fire me", col: "doing", nextFireAt: due }]);
	await sleep(1800);
	assert.equal(sent.length, 1, `due で1回注入 (got ${sent.length})`);
	assert.match(sent[0], /#1 "fire me"/);
	assert.equal(readBoardAt(boardPath2).cards[0].firedFor, due, "firedFor は注入後に書かれる");
	assert.equal(readBoardAt(boardPath2).cards[0].nextFireAt, due, "nextFireAt は動かない");

	// (C) 同じ nextFireAt のまま -> もう鳴らない（firedFor と等値）。
	await sleep(2400);
	assert.equal(sent.length, 1, `同じ schedule では再発火しない (got ${sent.length})`);

	// (D) blocked を立てる -> 鳴らない（blocked が時間軸より先）。
	writeBoard2([{ id: 1, text: "fire me", col: "doing", nextFireAt: due, blocked: "x", firedFor: undefined }]);
	await sleep(1800);
	assert.equal(sent.length, 1, `blocked は鳴らない (got ${sent.length})`);

	// (E) 再設定（別の due 値 + blocked 解除）-> 再び鳴る。
	const due2 = new Date(Date.now() - 60_000).toISOString();
	writeBoard2([{ id: 1, text: "fire me", col: "doing", nextFireAt: due2, firedFor: due }]);
	await sleep(2400);
	assert.equal(sent.length, 2, `再設定で再発火 (got ${sent.length})`);
}

for (const [name, fn] of asyncChecks) {
	try {
		await fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

try {
	await liveFire();
	passed += 1;
} catch (err) {
	failures.push(`live timer fire-control: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
