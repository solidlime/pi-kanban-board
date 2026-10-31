// #4 再発の回帰テスト: footer の GLOBAL 行は aggregateGlobal()（全 project ボード）を
// 表示するので、poll の変化検知（diskSnapshot）も同じ集合を見ていなければならない。
// 見ていなかった場合、GUI（/api/move）や他プロセスが project ボードを書いても
// `snap === pollSnapshot` で poll が抜け、footer の GLOBAL 件数が古いまま残る。
// フレームワーク無しで `node tests/kanban-poll-project-snapshot.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { useKanban, seedBoard } from "./helpers/board.mjs";
import { useMigrate, settleMigration } from "./helpers/migrate.mjs";

const HOME_DIR = "/tmp/kb-poll-projsnap-home";
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
useKanban(mod);
useMigrate(mod);
// phase 0: 起動時移行がシードしたボードを畳むので、先に消化する。
await settleMigration();

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

const KB = `${HOME_DIR}/.pi/kanban`;
const SID = "sid-projsnap";
const SLUG = mod.projectSlugOf(process.cwd()); // この process の project ボード
// ループは全スコープで OFF: このテストが見たいのは wake ではなく footer の再描画だけ。
writeFileSync(
	`${KB}/modes.json`,
	JSON.stringify({
		SESSION: { [SID]: { doingLoop: false, autoPick: false } },
		GLOBAL: {},
		PROJECT: { [SLUG]: { doingLoop: false, autoPick: false } },
	}),
);

const widgets = [];
function mkCtx(sid) {
	return {
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify() {},
			setWidget(_key, lines) {
				widgets.push(lines.join("\n"));
			},
		},
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => [],
		},
	};
}

const handlers = new Map();
const commands = new Map();
const sent = [];
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage(c) {
		sent.push(c);
	},
};
const t = mod.default(pi).__test;
const ctx = mkCtx(SID);

const globalLine = () => (widgets.at(-1) ?? "").split("\n")[0];

handlers.get("session_start")({ type: "session_start" }, ctx);

// --- 1: 基準の描画（project ボードは空） ---------------------------------------
t.poll();
check("poll 1 回目が footer を描く（GLOBAL は空）", () => {
	assert.equal(widgets.length, 1, `widgets=${widgets.length}`);
	assert.match(globalLine(), /^GLOBAL: 0 todo \/ 0 doing/);
});
check("wake は出ない（doingLoop OFF）", () => assert.equal(sent.length, 0, `sent=${sent.length}`));

// --- 2: 変化なしなら描き直さない（スナップショットの短絡は無傷） ----------------
t.poll();
check("変化の無い tick は setWidget しない", () => assert.equal(widgets.length, 1, `widgets=${widgets.length}`));

// --- 3: project ボードへの書き込みを poll が拾う（本題） ----------------------
// GUI（/api/move）や他プロセスが書いた場合と同じく「session/global の rev も
// modes.json も動かない」書き込み。diskSnapshot が project を見ていないと、
// ここで poll が短絡して footer が 0 todo のまま残る。
const before = widgets.length;
seedBoard(`${KB}/projects/${SLUG}.json`, {
	cards: [{ id: 1, text: "from gui", col: "todo" }],
	nextId: 2,
});
t.poll();
check("project ボードの書き込みで poll が footer を描き直す", () => {
	assert.equal(widgets.length, before + 1, `widgets=${widgets.length}（短絡した）`);
});
check("GLOBAL 行の件数が project ボードの 1 枚を反映する", () => {
	assert.match(globalLine(), /^GLOBAL: 1 todo \/ 0 doing/, `line=${JSON.stringify(globalLine())}`);
});

// --- 4: 別 slug の project ボード（他リポ）でも同じ（集約 = 監視対象） ----------
const before2 = widgets.length;
seedBoard(`${KB}/projects/other-repo.json`, {
	cards: [{ id: 1, text: "elsewhere", col: "doing" }],
	nextId: 2,
});
t.poll();
check("別 slug の project ボード書き込みでも描き直す", () => {
	assert.equal(widgets.length, before2 + 1, `widgets=${widgets.length}（短絡した）`);
	assert.match(globalLine(), /^GLOBAL: 1 todo \/ 1 doing/, `line=${JSON.stringify(globalLine())}`);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start で立つので、明示終了する（既存テストと同じ流儀）。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
