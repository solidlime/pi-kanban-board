// #111 `/kanban resume` の回帰テスト。フレームワーク無しで `node tests/kanban-resume-cmd.test.mjs`。
// 対象: halt（doing-loop の一時停止）を人間が手で解除する唯一の口。parseKanbanArgs が resume を
// 知らないと最後の `return { kind: "add", ... }` に落ちて、TODO カードが 1 枚増えるだけになる。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-resume-home";
rmSync(HOME_DIR, { recursive: true, force: true });
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

// dist/jiti.cjs は壊れているので jiti を使う（既存テストと同じ経路）。
const require = createRequire(import.meta.url);
const { createJiti } = require(process.env.KANBAN_JITI ?? require.resolve("jiti"));
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
const eq = (a, b) => assert.deepEqual(a, b);

// #17: project ボードのキーは cwd の slug。
const SLUG = mod.projectSlugOf(process.cwd());
const PROJECT = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;

function mkPi() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage() {},
	};
	return { pi, handlers, commands };
}

function mkCtx(sid, entries = []) {
	const notes = [];
	return {
		notes,
		hasUI: false,
		isIdle: () => true,
		ui: {
			notify(m) {
				notes.push(m);
			},
			setWidget() {},
		},
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => entries,
		},
	};
}

const haltingEntry = (at) => ({
	type: "custom",
	customType: "kanban-loop",
	data: { count: 10, halted: "limit", scope: null, stuckId: null, stuckCount: 0, lastActivityAt: at },
});

// --- 1. parseKanbanArgs が resume を返す（add に落ちない）---------------------
check("parseKanbanArgs(['resume']) は kind:resume（バグの本体）", () =>
	eq(mod.parseKanbanArgs(["resume"]), { kind: "resume" }));
check("resume は引数を無視する（reject にしない）", () =>
	eq(mod.parseKanbanArgs(["resume", "extra"]), { kind: "resume" }));
check("回帰: 未知語はカードのまま", () => eq(mod.parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));

// --- 2. handler がカードを作らず halt を解除する ------------------------------
{
	const { pi, handlers, commands } = mkPi();
	mod.default(pi).__test;
	const kanban = commands.get("kanban");
	const SID = "sid-resume";
	seedBoard(PROJECT, { cards: [{ id: 1, text: "t", col: "doing", movedBy: SID }], nextId: 2 });
	// このセッションの entry に halted:"limit" を仕込み、session_start に復元させる。
	const ctx = mkCtx(SID, [haltingEntry(Date.now())]);
	handlers.get("session_start")({ type: "session_start" }, ctx);

	await kanban.handler("resume", ctx);
	check("resume はカードを増やさない", () =>
		assert.equal(readBoardAt(PROJECT).cards.length, 1, JSON.stringify(readBoardAt(PROJECT).cards.map((c) => c.text))));
	check("resume の notify は解除の文言（旧状態 / count / doingLoop / 予算）", () =>
		assert.match(ctx.notes.at(-1), /^resumed: .+ \/ count \d+ → 0 \/ doingLoop ON \(project\) \/ /));

	await kanban.handler("help", ctx);
	check("/kanban help に resume の行がある", () =>
		assert.match(ctx.notes.at(-1), /\/kanban resume {2}doing-loop の halt を解除/));

	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
