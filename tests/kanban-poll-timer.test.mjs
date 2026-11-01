// #89 poll タイマーの起動経路の回帰テスト。フレームワーク無しで
// `node tests/kanban-poll-timer.test.mjs`。
// 対象:
//   1. session_start を一度も送らなくても `/kanban take` がタイマーを立てる（#40 の引き継ぎ口）
//   2. sync() -> take の順で呼んでも interval は 1 本（二重起動で tick が早発ちしない）
//   3. sync() 経由の通常起動は壊れていない（既存挙動の回帰）
//   4. ownCtx が無い間はタイマーを立てない（shutdown -> take の順で 1 本だけ）
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { useKanban, seedBoard } from "./helpers/board.mjs";
import { useMigrate, settleMigration } from "./helpers/migrate.mjs";

const HOME_DIR = "/tmp/kb-polls89-home";
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

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う（既存テストと同じ経路）。
const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);
useMigrate(mod);
// phase 0: 起動時移行がシードした session ボードを畳むので、先に消化する。
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

// #17: poll が回すのは project ボード（cwd の slug）1 枚。session ボードは無い。
const SLUG = mod.projectSlugOf(process.cwd());
const PROJECT_BOARD = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
writeFileSync(MODES, JSON.stringify({ PROJECT: {}, GLOBAL: {} }));
const writeBoardFile = (sid) =>
	// DOING の所有権は movedBy === sid（#17）。
	seedBoard(PROJECT_BOARD, { cards: [{ id: 1, text: "t", col: "doing", movedBy: sid }], nextId: 2 });
const writeModes = (sid) =>
	writeFileSync(MODES, JSON.stringify({ SESSION: { [sid]: { doingLoop: true, autoPick: false } }, GLOBAL: {} }));

// factory は 1 呼び出し = 1 クロージャ。テストごとに新しい pi を作って隔離する。
function mkPi() {
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const pi = {
		// take はコマンドハンドラなので、登録された関数を掴んでおく。
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
	return { pi, handlers, commands, sent };
}

function mkCtx(sid, idle = true) {
	return {
		hasUI: false,
		isIdle: () => idle,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => [],
		},
	};
}

// --- 1: session_start 無しで take がタイマーを立て、tick が発火する ---------------
{
	const { pi, commands, sent } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-take-only";
	writeBoardFile(SID);
	writeModes(SID);
	const ctx = mkCtx(SID);

	check("session_start 前は ownCtx=null / timer=null", () => {
		assert.equal(t.ownCtx(), null);
		assert.equal(t.hasTimer(), false);
	});

	await commands.get("kanban").handler("take", ctx);
	check("take が ownCtx を取る（既存挙動）", () => assert.equal(t.ownCtx(), ctx));
	check("take だけで poll タイマーが立つ", () => assert.equal(t.hasTimer(), true));

	// tick が実際に回る: 初回は lastTickAt=0 なので必ず発火する。
	t.poll();
	check("take 後の poll が wake を 1 件送る", () => assert.equal(sent.length, 1, `sent=${sent.length}`));
	check("wake の中身は DOING カードの継続プロンプト", () => assert.match(sent[0], /DOING #1/));
}

// --- 2: sync -> take の順で呼んでも interval は 1 本 -----------------------------
// setInterval を差し替えて「何本作られたか」を直接数える。実タイマーの刻みに頼らない。
{
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const made = [];
	globalThis.setInterval = (fn, ms) => {
		const handle = { fn, ms, unref() {} };
		made.push(handle);
		return handle;
	};
	globalThis.clearInterval = () => {};

	const { pi, handlers, commands } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-double";
	writeBoardFile(SID);
	writeModes(SID);
	const ctx = mkCtx(SID);

	handlers.get("session_start")({ type: "session_start" }, ctx);
	const afterSync = made.length;
	await commands.get("kanban").handler("take", ctx);
	const afterTake = made.length;
	// 3 本目の経路: 同じ ctx で枝移動（session_tree）が来ても増えない。
	handlers.get("session_tree")({ type: "session_tree" }, ctx);
	const afterTree = made.length;
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;

	check("sync() はタイマーを 1 本作る", () => assert.equal(afterSync, 1, `made=${afterSync}`));
	check("take は既存タイマーを増やさない（二重起動しない）", () => assert.equal(afterTake, 1, `made=${afterTake}`));
	check("session_tree でも増えない", () => assert.equal(afterTree, 1, `made=${afterTree}`));
	check("period は 1500ms のまま", () => assert.equal(made[0].ms, 1500));
	check("issuer は poll（unref 済みのハンドル）", () => {
		assert.equal(typeof made[0].fn, "function");
		assert.equal(typeof made[0].unref, "function");
	});
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	check("shutdown 後は timer=null / ownCtx=null（停止経路は無傷）", () => {
		assert.equal(t.hasTimer(), false);
		assert.equal(t.ownCtx(), null);
	});
}

// --- 3: sync 経由の通常起動は壊れていない --------------------------------------
{
	const { pi, handlers, sent } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-sync";
	writeBoardFile(SID);
	writeModes(SID);
	const ctx = mkCtx(SID);

	handlers.get("session_start")({ type: "session_start" }, ctx);
	check("sync で ownCtx が入る", () => assert.equal(t.ownCtx(), ctx));
	check("sync でタイマーが立つ", () => assert.equal(t.hasTimer(), true));
	t.poll();
	check("通常起動の初回 tick が発火する", () => assert.equal(sent.length, 1, `sent=${sent.length}`));
	check("2 tick 目は interval で抑制される", () => {
		t.poll();
		assert.equal(sent.length, 1, `sent=${sent.length}`);
	});
}

// --- 4: ownCtx が無い間はタイマーを立てない（見るものが無い） -------------------
{
	const { pi, handlers, commands } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-null-ctx";
	const ctx = mkCtx(SID);

	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	check("shutdown 直後は timer=null", () => assert.equal(t.hasTimer(), false));
	// take は ownCtx を入れてから ensure するので、ここで初めてタイマーが立つ。
	await commands.get("kanban").handler("take", ctx);
	check("ownCtx 無しで take された場合は take が立てる", () => assert.equal(t.hasTimer(), true));
}

// --- 5: poll / refresh は ctx の cwd を見る（process.cwd() ではない） --------------
// #27: cwdOfCtx と cwdOfSidSync は別の源泉。resume したセッションはヘッダの cwd と
// 起動ディレクトリが違いうるので、実行 cwd にボードを置いて旧実装（process.cwd）なら 0 件で落ちる。
{
	const { pi, handlers, sent } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-other-cwd";
	const otherDir = mkdtempSync(join(tmpdir(), "kb27-other-"));
	const OTHER = mod.projectSlugOf(otherDir);
	const OTHER_BOARD = `${HOME_DIR}/.pi/kanban/projects/${OTHER}.json`;
	const widgets = [];
	// mkCtx は getCwd を持たない（cwdOfCtx が process.cwd() に落ちる前提）。ここは ctx cwd を
	// 明示するので、footer を読むために hasUI と setWidget の捕獲だけ足りない。
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify() {},
			setWidget(_key, lines) {
				widgets.push(lines);
			},
		},
		sessionManager: {
			getSessionId: () => SID,
			getSessionName: () => undefined,
			getEntries: () => [],
			getCwd: () => otherDir,
		},
	};

	check("前提: 別ディレクトリの slug は実行 cwd の slug と違う", () =>
		assert.notEqual(OTHER, SLUG, `OTHER=${OTHER} SLUG=${SLUG}（同じならこのテストは空振り）`),
	);
	// 実行 cwd のボードは空。旧実装はこれを読んで「DOING 無し」になる。
	seedBoard(PROJECT_BOARD, { cards: [], nextId: 1 });
	handlers.get("session_start")({ type: "session_start" }, ctx);
	// session_start の後で置く: poll の snapshot 短絡に入らず、footer まで描かせる。
	seedBoard(OTHER_BOARD, {
		cards: [{ id: 7, text: "elsewhere", col: "doing", movedBy: SID }],
		nextId: 8,
	});
	// モードは書き手と同じキー（slug）に置く。sid に置くと「不在 = ON」の既定頼みになる。
	writeFileSync(MODES, JSON.stringify({ PROJECT: { [OTHER]: { doingLoop: true, autoPick: false } }, GLOBAL: {} }));

	t.poll();
	check("ctx の cwd のボードから wake が 1 件（process.cwd を見ると 0 件）", () =>
		assert.equal(sent.length, 1, `sent=${sent.length}（実行 cwd の空ボードを読んでいる）`),
	);
	check("wake は ctx cwd のボードの DOING カード", () =>
		assert.match(sent[0] ?? "", /DOING #7 "elsewhere"/),
	);
	const footer = widgets.at(-1) ?? [];
	check("footer 2行目が ctx cwd のボードを名乗る", () =>
		assert.equal(
			footer[1]?.startsWith(`PROJECT: ${OTHER}:`),
			true,
			`footer=${JSON.stringify(footer)}`,
		),
	);
	// 件数もキーで変わる（旧実装は空ボードを読んで "0 todo / 0 doing" と描いた）。
	check("footer 2行目が ctx cwd のボードの件数を出す", () =>
		assert.ok(footer[1]?.includes("0 todo / 1 doing"), `footer=${JSON.stringify(footer)}`),
	);
	rmSync(otherDir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
