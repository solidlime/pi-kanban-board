// #29: `session` は #17 で消えたスコープ。HTTP は scope=session を 400 SESSION_SCOPE_GONE で
// 弾くのに、CLI パーサは `/kanban loop off session` を「scope 無指定 = project」として黙って
// 受理し、誰も名指ししていないボードのスイッチを書いていた。CLI 側にも同じ網を張る。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-cli-session-home";
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

// HTTP の 400 と同じ文言（別物の文言にすると、同じ誤りが 2 通りに見える）。
const SESSION_SCOPE_GONE = "scope=session is gone; boards are project-scoped";
const GLOBAL_NO_SWITCH = "global は集約ビューでスイッチを持たない（scope=project を使う）";
const SID = "cli-session-sid";

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
const projectBucket = () => Object.values(readModes().PROJECT ?? {})[0] ?? {};

// --- 1: session は scope 語として拒否される ------------------------------------
for (const args of ["loop off session", "loop on session", "loop status session", "pick off session"]) {
	await check(`/kanban ${args} -> session 拒否`, async () => {
		const msg = await notifyFor(args);
		assert.equal(msg, SESSION_SCOPE_GONE, `受理された: ${msg}`);
	});
}

await check("session 拒否は modes.json に doingLoop=false を書かない", () => {
	// 拒否が「読むだけ」で終わっていること。書いてしまうと誰も名指ししていない
	// ボードのループが止まる（#29 の実害はこれ）。
	const bucket = projectBucket();
	assert.equal(bucket.doingLoop, undefined, `project ボードに書かれた: ${JSON.stringify(readModes())}`);
});

// --- 2: 拒否が効きすぎていない（project / global は今まで通り） -------------------
await check("/kanban loop off -> project の doingLoop を false にする", async () => {
	const msg = await notifyFor("loop off");
	assert.ok(msg.includes("[project]"), msg);
	assert.equal(projectBucket().doingLoop, false, JSON.stringify(readModes()));
});
await check("/kanban loop on session の後の loop on は通る（拒否が状態を壊していない）", async () => {
	await notifyFor("loop on");
	assert.equal(projectBucket().doingLoop, true, JSON.stringify(readModes()));
});
await check("/kanban loop off global -> global 拒否のまま", async () => {
	const msg = await notifyFor("loop off global");
	assert.equal(msg, GLOBAL_NO_SWITCH);
	assert.equal(projectBucket().doingLoop, true, "global 拒否が project を書いた");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// HTTP サーバと poll timer が残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
