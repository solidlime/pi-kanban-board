// #26: `/kanban interval|stuck|maxloops` の global 指定は CLI でも拒否する。
// HTTP の 400 と同じ「書けるが誰も読まない」状態を CLI 側に残さないための網。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-cli-global-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/projects`, { recursive: true });
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

const GLOBAL_NO_SWITCH = "global は集約ビューでスイッチを持たない（scope=project を使う）";
const SID = "cli-global-sid";

const handlers = new Map();
const commands = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
});

const notifications = [];
const ctx = {
	hasUI: false,
	isIdle: () => false,
	ui: {
		notify(msg) {
			notifications.push(msg);
		},
		setWidget() {},
	},
	sessionManager: { getSessionId: () => SID, getEntries: () => [] },
};
handlers.get("session_start")({}, ctx);
const kanban = (args) => commands.get("kanban").handler(args, ctx);
/** notify を 1 回分だけ取り出す（前回までの分は捨てる）。 */
const notifyFor = async (args) => {
	notifications.length = 0;
	await kanban(args);
	return notifications.join("\n");
};

const modesFile = `${HOME_DIR}/.pi/kanban/modes.json`;
const readModes = () => {
	try {
		return JSON.parse(readFileSync(modesFile, "utf8"));
	} catch {
		return {};
	}
};

// --- global は拒否される（status 形も書き込み形も同じ） ------------------------
for (const args of ["interval global", "interval global 5", "stuck global", "stuck global 2", "maxloops global", "maxloops global 2"]) {
	await check(`/kanban ${args} -> global 拒否`, async () => {
		const msg = await notifyFor(args);
		assert.equal(msg, GLOBAL_NO_SWITCH);
	});
}

await check("global 拒否は modes.json に GLOBAL バケットを作らない", () => {
	const f = readModes();
	assert.equal(f.GLOBAL ?? undefined, undefined, `GLOBAL が書かれた: ${JSON.stringify(f.GLOBAL)}`);
});

// --- project は今まで通り通る（拒否が効きすぎていない） ------------------------
await check("/kanban interval 9 -> project に書かれる", async () => {
	const msg = await notifyFor("interval 9");
	assert.equal(msg, "[project] 自動再開の間隔を 9分 に設定");
	const bucket = Object.values(readModes().PROJECT ?? {})[0] ?? {};
	assert.equal(bucket.intervalMin, 9);
});
await check("/kanban stuck 2 -> project に書かれる", async () => {
	const msg = await notifyFor("stuck 2");
	assert.equal(msg, "[project] スタック判定を 2回 に設定");
	const bucket = Object.values(readModes().PROJECT ?? {})[0] ?? {};
	assert.equal(bucket.stuckLimit, 2);
});
await check("/kanban maxloops 4 -> project に書かれる", async () => {
	const msg = await notifyFor("maxloops 4");
	assert.equal(msg, "[project] ループ上限を 4回 に設定");
	const bucket = Object.values(readModes().PROJECT ?? {})[0] ?? {};
	assert.equal(bucket.maxLoops, 4);
});

// --- help に [global] が残っていない ------------------------------------------
await check("/kanban help に [global] が無い", async () => {
	const msg = await notifyFor("help");
	assert.ok(msg.includes("/kanban interval <分>"), msg);
	assert.ok(!msg.includes("[global]"), msg);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// HTTP サーバと poll timer が残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
