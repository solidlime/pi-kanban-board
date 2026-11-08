// #93: /api/dashboard が cold でも一瞬で返ること。
// 直す前は dashboardPayload() が `await sessionInfoById()` → SessionManager.listAll() で
// 全セッション jsonl を 1 行目から JSON.parse していた（実測 6.5〜10.4 秒）。
// 使うのは cwd 1 フィールドだけなので、sync() が publish した driver cwd を読む。
// フレームワーク無しで `node tests/kanban-dashboard-cold.test.mjs`。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-dashboard-cold-home";
// /tmp は Windows ではドライブ相対なので、HOME のパスを組む前に一時 cwd を作る。
const DRIVER = mkdtempSync(join(tmpdir(), "kb93-driver-"));
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/projects`, { recursive: true });
// セッションの jsonl は置かない: このテストが見たいのは「listAll を踏まないこと」だけ。
mkdirSync(`${HOME_DIR}/.pi/agent/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() は USERPROFILE を優先するので揃える。
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

// 決定論的な側の検証: listAll が呼ばれた回数を数える。時間だけだと、セッションが
// 少ないマシン（このテストの偽 HOME もそう）では listAll を踏んでも一瞬で返る。
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
let listAllCalls = 0;
const listAll = SessionManager.listAll;
SessionManager.listAll = function (...args) {
	listAllCalls += 1;
	return listAll.apply(this, args);
};

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

const SID = "dash-cold-sid";
const DRIVER_SLUG = mod.projectSlugOf(DRIVER);
const PROC_SLUG = mod.projectSlugOf(process.cwd());

const handlers = new Map();
const commands = new Map();
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
};
mod.default(pi);
// session_start は必ず通る。ここで driver cwd が publish される（sessionInfoById は踏まない）。
const ctx = {
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => SID, getEntries: () => [], getCwd: () => DRIVER },
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

await check("前提: driver cwd の slug は実行 cwd の slug と違う", () =>
	assert.notEqual(DRIVER_SLUG, PROC_SLUG, `DRIVER=${DRIVER_SLUG} PROC=${PROC_SLUG}（同じなら空振り）`),
);

// 1 発目（= cold）の実測だけを見る。2 発目以降はキャッシュに助けられるので使わない。
const t0 = performance.now();
const res = ready ? await authFetch(`${BASE}/api/dashboard`) : null;
const data = res === null ? { project: {} } : await res.json();
const ms = performance.now() - t0;

// 閾値 1500ms の根拠: 修正前は listAll（757〜990 セッション / 1.9GB）で 5500〜8300ms、
// 修正後は 10〜20ms。1500ms は両者を確実に分ける。
await check("初回 /api/dashboard が 1500ms 未満（listAll を踏んでいない）", () =>
	assert.ok(ms < 1500, `初回 ${ms.toFixed(0)}ms（listAll を踏んでいる）`),
);
await check("初回 /api/dashboard は SessionManager.listAll を呼ばない", () =>
	assert.equal(listAllCalls, 0, `listAll を ${listAllCalls} 回呼んだ`),
);

await check("project.id は sync が publish した driver cwd の slug", () =>
	assert.equal(data.project.id, DRIVER_SLUG, `project.id=${data.project.id} DRIVER_SLUG=${DRIVER_SLUG}`),
);

// 中心不変条件: publish はピンの分岐の外（全 session_start が自分の sid を publish）、
// driverCwd だけをピンで gate する。ここが崩れると「後のセッション」方向で BLOCKER 1 が再発する。
const OTHER_DIR = mkdtempSync(join(tmpdir(), "kb93-other-"));
const OTHER_SID = "second-sid";
const ctx2 = {
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => OTHER_SID, getEntries: () => [], getCwd: () => OTHER_DIR },
};
await check("前提: 後発セッションの slug は driver と違う", () =>
	assert.notEqual(mod.projectSlugOf(OTHER_DIR), DRIVER_SLUG, `OTHER=${mod.projectSlugOf(OTHER_DIR)} DRIVER=${DRIVER_SLUG}`),
);
handlers.get("session_start")({ type: "session_start" }, ctx2);
await check("後発 session_start はパネル（driverCwd）を奪わない", async () => {
	const d = await (await authFetch(`${BASE}/api/dashboard`)).json();
	assert.equal(d.project.id, DRIVER_SLUG, `project.id=${d.project.id} DRIVER=${DRIVER_SLUG}`);
});
await check("後発 sid も自分の cwd に解決する（publish はピンの gate の外）", async () => {
	const r = await authFetch(`${BASE}/api/kanban?sid=${OTHER_SID}`);
	const d = await r.json();
	assert.equal(r.status, 200, `status=${r.status} body=${JSON.stringify(d).slice(0, 200)}`);
	assert.equal(d.projectId, mod.projectSlugOf(OTHER_DIR), `projectId=${d.projectId} OTHER=${mod.projectSlugOf(OTHER_DIR)}`);
});

// 兄弟（非 driver）の teardown が、生きた driver のピンも cwdBySid も壊さないこと。
handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx2);
await check("兄弟の shutdown は生きた driver のボードを残す", async () => {
	const d = await (await authFetch(`${BASE}/api/dashboard`)).json();
	assert.equal(d.project.id, DRIVER_SLUG, `project.id=${d.project.id} DRIVER=${DRIVER_SLUG}`);
});
await check("兄弟の shutdown は生きた driver の sid を消さない", async () => {
	const r = await authFetch(`${BASE}/api/kanban?sid=${SID}`);
	const d = await r.json();
	assert.equal(r.status, 200, `status=${r.status} body=${JSON.stringify(d).slice(0, 200)}`);
});
await check("兄弟の shutdown は自分の sid だけを落とす", async () => {
	const r = await authFetch(`${BASE}/api/kanban?sid=${OTHER_SID}`);
	const d = await r.json();
	assert.equal(r.status, 400, `status=${r.status} body=${JSON.stringify(d).slice(0, 200)}`);
});
rmSync(OTHER_DIR, { recursive: true, force: true });

// BLOCKER 1 の回帰: publish の口は session_start だけでなく `/kanban take` にも要る。take 直後に
// cwdBySid が空だと、ctx を持たない dashboard が旧 repo のボードを返す。
const TAKE_DIR = mkdtempSync(join(tmpdir(), "kb93-take-"));
await check("前提: take 先の slug は元の driver と違う", () =>
	assert.notEqual(mod.projectSlugOf(TAKE_DIR), DRIVER_SLUG, `TAKE=${mod.projectSlugOf(TAKE_DIR)} DRIVER=${DRIVER_SLUG}`),
);
await check("/kanban take の後、dashboard は新しい driver の cwd に従う", async () => {
	await commands.get("kanban").handler("take", {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => "dash-take-sid", getEntries: () => [], getCwd: () => TAKE_DIR },
	});
	const after = await (await authFetch(`${BASE}/api/dashboard`)).json();
	assert.equal(after.project.id, mod.projectSlugOf(TAKE_DIR), `project.id=${after.project.id} take=${TAKE_DIR}`);
});
rmSync(TAKE_DIR, { recursive: true, force: true });

console.log(`${passed} passed, ${failures.length} failed (cold /api/dashboard ${ms.toFixed(0)}ms)`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
rmSync(DRIVER, { recursive: true, force: true });
// HTTP サーバと poll timer が残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
