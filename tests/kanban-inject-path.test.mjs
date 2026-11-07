// #51: doing-loop 注入経路の 3 修正の自己検証。フレームワーク無しで
// `node tests/kanban-inject-path.test.mjs`。
//   ① poll wake の markFired は sendUserMessage 成功後だけ（reject で schedule が死なない）
//   ② settle 連鎖も注入クロック（lastChainAt）を進める（starvation/quiet の誤判定を止める）
//   ③ isUserInputHead が pendingMessages の user を見る（steer 直後に注入しない）
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-inject-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
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
const { createJiti } = require(process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"));
const jiti = createJiti(import.meta.url);
const target = process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(target);
useKanban(mod);
const { autoTickVerdict, isUserInputHead, continuationPrompt, LOOP_PROMPT_PREFIX, AUTO_TICK_MS } = mod;

const MIN = 60_000;
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

const doing = { id: 1, text: "x", col: "doing" };
const base = {
	isIdle: true,
	doingLoop: true,
	card: doing,
	halted: null,
	lastTickAt: 0,
	lastActivityAt: undefined,
	now: 5 * MIN,
};

// --- ②: starvation/interval は「最後に注入した方の時計」で測る ---------------------
await check("② chain が最近注入していれば interval は開かない（lastTickAt が古くても）", () => {
	const v = autoTickVerdict({ ...base, lastTickAt: 0, lastChainAt: 4 * MIN });
	assert.equal(v.fire, false);
	assert.equal(v.reason, "interval");
});
await check("② chain が生きている間は starved で quiet を開けない（#88 の relapse 側）", () => {
	// lastTickAt だけが古い（settle 連鎖が動いている）。修正前は starved が立って quiet が開き、
	// 活動中のエージェントに poll が割り込んでいた。
	const v = autoTickVerdict({
		...base,
		lastTickAt: 0,
		lastChainAt: 14 * MIN,
		lastActivityAt: 20 * MIN,
		now: 20 * MIN,
	});
	assert.equal(v.quiet, false, "最後の注入は 6 分前（chain）。 starvation ではない");
	assert.equal(v.fire, false);
	assert.equal(v.reason, "not-quiet");
});
await check("② 両時計とも 3 interval 沈黙したら活動時計を無視して発火する（escape は残る）", () => {
	const v = autoTickVerdict({
		...base,
		lastTickAt: 0,
		lastChainAt: 1 * MIN,
		lastActivityAt: 5 * MIN,
		now: 5 * MIN + 1,
	});
	assert.equal(v.fire, false, "chain が 1 分前に注入している間は quiet を開けない");
	const later = autoTickVerdict({
		...base,
		lastTickAt: 0,
		lastChainAt: 1 * MIN,
		lastActivityAt: 100 * MIN,
		now: 1 * MIN + 3 * AUTO_TICK_MS,
	});
	assert.equal(later.quiet, true, "3 interval 沈黙したら活動時計を無視する");
	assert.equal(later.fire, true);
});
await check("② lastChainAt 未指定は従来どおり lastTickAt だけで判定する（後方互換）", () => {
	assert.equal(autoTickVerdict({ ...base, lastTickAt: 4 * MIN, lastActivityAt: 0 }).fire, false);
	assert.equal(autoTickVerdict({ ...base, lastTickAt: 3 * MIN, lastActivityAt: 0, now: 8 * MIN }).fire, true);
});

// --- ③: pendingMessages の user は steer。我々の注入は steer ではない ----------------
await check("③ pending に user が残っていれば注入しない", () => {
	assert.equal(isUserInputHead([{ role: "assistant" }], [{ role: "user", content: "やめて" }]), true);
});
await check("③ pending が我々の [kanban-loop] 注入だけなら head 判定に戻る", () => {
	const own = [{ role: "user", content: `${LOOP_PROMPT_PREFIX}DOING #1 "x" を完了させろ。` }];
	assert.equal(isUserInputHead([{ role: "assistant" }], own), false);
	assert.equal(isUserInputHead([{ role: "user", content: "本物" }], own), true);
});
await check("③ pending が assistant/toolResult だけなら従来どおり", () => {
	assert.equal(isUserInputHead([{ role: "assistant" }], [{ role: "assistant" }, { role: "toolResult" }]), false);
});
await check("③ pending が判定不能（undefined / 非配列）でも注入は止まらない", () => {
	assert.equal(isUserInputHead([{ role: "assistant" }], undefined), false);
	assert.equal(isUserInputHead([{ role: "assistant" }], "junk"), false);
});

// --- ⑤: continuation 文面（識別子 / 丸め注記 / stuck 進捗 / resume 理由）----------
await check("⑤ 通常カードの文面は識別子だけ増える（既存の文言は不変）", () => {
	assert.equal(
		continuationPrompt(doing, "session"),
		`${LOOP_PROMPT_PREFIX}DOING #1 "x" を完了させろ。終わったら kanban ツール で DONE に移せ。`,
	);
});
await check("⑤(a) 80 文字で切ったら全文の場所を言う", () => {
	const p = continuationPrompt({ id: 2, text: "あ".repeat(200), col: "doing" }, "session");
	assert.match(p, /…/);
	assert.match(p, /全文は kanban ツールで確認/);
	assert.doesNotMatch(continuationPrompt(doing, "session"), /全文は kanban ツールで確認/);
});
await check("⑤(b) stuck 進捗は 2 回目から出る", () => {
	assert.doesNotMatch(continuationPrompt(doing, "session", { stuck: { count: 1, limit: 3 } }), /stuck/);
	const p = continuationPrompt(doing, "session", { stuck: { count: 2, limit: 3 } });
	assert.match(p, /stuck 2\/3/);
});
await check("⑤(c) resume 直後の 1 回だけ停止理由を言う", () => {
	const p = continuationPrompt(doing, "session", { resumeNote: "stuck" });
	assert.match(p, /halted:stuck/);
	assert.doesNotMatch(continuationPrompt(doing, "session"), /halted:/);
});

// ---------------------------------------------------------------------------
// ① 実タイマー経路: reject された wake は firedFor を刻まず、成功した wake だけ刻む
// ---------------------------------------------------------------------------
const SID = "inject-test-sid";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveFiredAfterSuccess() {
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	let rejectWakes = true;
	const pi = {
		registerCommand(name, def) {
			commands.set(name, def);
		},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(content) {
			sent.push(content);
			return rejectWakes ? Promise.reject(new Error("Agent is already processing")) : Promise.resolve();
		},
	};
	mod.default(pi);
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	};
	handlers.get("session_start")({}, ctx);

	const modesPath = `${HOME_DIR}/.pi/kanban/modes.json`;
	const SLUG = mod.projectSlugOf(process.cwd());
	const boardPath = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
	writeFileSync(
		modesPath,
		JSON.stringify({ PROJECT: { [SLUG]: { doingLoop: true, autoPick: false } }, GLOBAL: {} }),
	);
	// 過去の nextFireAt + firedFor 無し = 発火待ちのスケジュール。markFired が刻むと沈黙する。
	const scheduled = {
		id: 1,
		text: "scheduled",
		col: "doing",
		movedBy: SID,
		nextFireAt: new Date(Date.now() - 60_000).toISOString(),
	};
	seedBoard(boardPath, { cards: [scheduled], nextId: 2 });

	await sleep(1900);
	assert.equal(sent.length, 1, `1 回は wake を試みる: ${JSON.stringify(sent)}`);
	assert.match(sent[0], /scheduled/);
	assert.equal(
		readBoardAt(boardPath).cards[0].firedFor,
		undefined,
		"reject された wake の firedFor を刻んではいけない（schedule が永久に沈黙する）",
	);

	// 同じ schedule を成功する wake で処理すると、そこで初めて firedFor が刻まれる。
	rejectWakes = false;
	commands.get("kanban").handler("take", ctx); // lastTickAt を戻して即判定させる
	await sleep(1900);
	assert.equal(sent.length, 2, `成功 wake で 2 回目: ${JSON.stringify(sent)}`);
	const after = readBoardAt(boardPath).cards[0];
	assert.equal(after.firedFor, after.nextFireAt, "成功した wake は firedFor を刻む");

	// 刻まれた後は、同じ nextFireAt では二度と鳴らない。
	await sleep(1900);
	assert.equal(sent.length, 2, `同じ schedule で二重発火しない: ${JSON.stringify(sent)}`);
}

await check("① reject -> firedFor 未刻 / resolve -> 刻む", liveFiredAfterSuccess);

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
