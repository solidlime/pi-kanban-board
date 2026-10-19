// #61 「デフォルト pick on」の自己検証。
// 発端: ボードが「ピック OFF」と表示していたのに、ループは実際に TODO を拾っていた。
// 原因は modesFor() が SESSION[sid] のエントリをそのまま返していたこと。エントリが
// 部分的（{doingLoop:true} だけで autoPick が無い）だと autoPick が undefined になり、
// GUI は `!!m.autoPick` で描くので OFF に見える。フラット既定（autoPick: true）に
// フォールバックしていなかった。
// フレームワーク無しで `node tests/kanban-default-pick.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-default-pick-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const { createJiti } = createRequire(import.meta.url)(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

const failures = [];
let passed = 0;
const check = (name, fn) => {
	try {
		const r = fn();
		if (r && typeof r.then === "function")
			return r.then(
				() => {
					passed += 1;
				},
				(err) => {
					failures.push(`${name}: ${err.message}`);
				},
			);
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
	return undefined;
};

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const writeModes = (o) => writeFileSync(MODES, JSON.stringify(o, null, 2));
const readModes = () => JSON.parse(readFileSync(MODES, "utf8"));
const SID = "sess-partial";

// --- サーバ起動 (このテスト専用ポート) ----------------------------------------
const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

/** /api/kanban?sid= は modes を直接返す（GET。実在セッションに限らない）。 */
async function sessionModes() {
	const r = await tf(`${BASE}/api/kanban?sid=${SID}&fields=id`);
	assert.ok(r.ok, `/api/kanban が ${r.status}`);
	const j = await r.json();
	assert.ok(j.modes && j.modes.session, `modes.session が無い: ${JSON.stringify(j).slice(0, 300)}`);
	return j.modes.session;
}

// ===========================================================================
await check("#61 新品の modes.json は両方 true で生成される（既定が ON である前提）", () => {
	// 起動直後に modes.json が無ければ readModesFile が書いている。
	// 既に在る場合は中身が既定と一致していること。
	const m = readModes();
	assert.equal(m.doingLoop, true, `doingLoop の既定が true でない: ${m.doingLoop}`);
	assert.equal(m.autoPick, true, `autoPick の既定が true でない: ${m.autoPick}`);
});

await check("#61 SESSION エントリが部分的（autoPick 欠落）でも autoPick は true に解決される", async () => {
	writeModes({ doingLoop: true, autoPick: true, SESSION: { [SID]: { doingLoop: true } } });
	const m = await sessionModes();
	assert.equal(m.autoPick, true, `部分エントリで autoPick が true にならない（GUI は OFF と表示する）: ${JSON.stringify(m)}`);
});

await check("#61 SESSION エントリが部分的（doingLoop 欠落）でも doingLoop は true に解決される", async () => {
	writeModes({ doingLoop: true, autoPick: true, SESSION: { [SID]: { autoPick: true } } });
	const m = await sessionModes();
	assert.equal(m.doingLoop, true, `部分エントリで doingLoop が true にならない: ${JSON.stringify(m)}`);
});

await check("#61 明示 false は尊重される（autoPick: false を勝手に ON にしない）", async () => {
	writeModes({ doingLoop: true, autoPick: true, SESSION: { [SID]: { doingLoop: true, autoPick: false } } });
	const m = await sessionModes();
	assert.equal(m.autoPick, false, `明示 false が true に化けた: ${JSON.stringify(m)}`);
});

await check("#61 明示 false は尊重される（doingLoop: false）", async () => {
	writeModes({ doingLoop: true, autoPick: true, SESSION: { [SID]: { doingLoop: false, autoPick: true } } });
	const m = await sessionModes();
	assert.equal(m.doingLoop, false, `明示 false が true に化けた: ${JSON.stringify(m)}`);
});

await check("#61 エントリが全く無いセッションはフラット既定に解決される", async () => {
	writeModes({ doingLoop: true, autoPick: true, SESSION: {} });
	const m = await sessionModes();
	assert.equal(m.doingLoop, true, `エントリ無しで doingLoop が true でない: ${JSON.stringify(m)}`);
	assert.equal(m.autoPick, true, `エントリ無しで autoPick が true でない: ${JSON.stringify(m)}`);
});

await check("#61 片方だけ切り替えても、応答の modes は両方 boolean で返る", async () => {
	writeModes({ doingLoop: true, autoPick: true, SESSION: { [SID]: { doingLoop: true } } });
	const r = await tf(`${BASE}/api/modes?scope=session&sid=${SID}&key=autoPick&value=off`);
	assert.ok(r.ok, `/api/modes が ${r.status}`);
	const j = await r.json();
	assert.equal(j.ok, true, `modes 書き込みが失敗: ${JSON.stringify(j)}`);
	assert.equal(typeof j.modes.session.autoPick, "boolean", `autoPick が boolean でない: ${JSON.stringify(j.modes.session)}`);
	assert.equal(j.modes.session.autoPick, false, `off にしたのに false でない: ${JSON.stringify(j.modes.session)}`);
	assert.equal(typeof j.modes.session.doingLoop, "boolean", `doingLoop が boolean でない: ${JSON.stringify(j.modes.session)}`);
});

// --- 集計 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-default-pick: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
