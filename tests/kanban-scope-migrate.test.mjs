// phase0 自己検証: 一度きりの scope 移行（plans/phase0-cwd-scope.md の受け入れ条件 3〜5）。
// フレームワーク無しで `node tests/kanban-scope-migrate.test.mjs`。
// 対象: migrateScopeOnce / mergeBoardInto（id の振り直し・blocks の remap・重複の保持）、
// meta.scope_migrated による冪等、事前バックアップ、board 行の削除。
// HOME を差し替えるので本番の ~/.pi/kanban には触れない。サーバは立てない（移行関数を直接呼ぶ）。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { boardExists, readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-scope-migrate-home";
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
assert.equal(typeof mod.migrateScopeOnce, "function", "migrateScopeOnce が export されていない");

const HOME = `${HOME_DIR}/.pi/kanban`;
const sessionPath = (sid) => `${HOME}/sessions/${sid}.json`;
const projectPath = (slug) => `${HOME}/projects/${slug}.json`;
const BACKUP = `${HOME}/boards.sqlite.pre-scope-migration`;

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

const INBOX = "_inbox";
const inbox = () => readBoardAt(projectPath(INBOX));
/** Every project board this fixture can produce - the total is what must not change. */
const SLUGS = [INBOX, "kb-core"];
const allProjectCards = () => SLUGS.flatMap((slug) => readBoardAt(projectPath(slug)).cards);

// --- シード: session 2 枚 x 2 ボード + global 3 枚（合計 7 枚） ----------------------
// 移行時 cwd が引けない sid（テストの HOME にはセッションが無い）は _inbox 行き。
seedBoard(sessionPath("mig-a"), {
	cards: [
		{ id: 1, text: "a-first", col: "todo" },
		// 2 は 1 を待つ: 移行後も「同じボードに実在するカード」を指していること。
		{ id: 2, text: "a-second", col: "todo", blocks: [1] },
	],
	nextId: 3,
});
seedBoard(sessionPath("mig-b"), {
	cards: [
		{ id: 1, text: "b-first", col: "doing" },
		{ id: 2, text: "b-second", col: "done" },
	],
	nextId: 3,
});
seedBoard(`${HOME}/global.json`, {
	cards: [
		// project 指定あり -> projects/kb-core.json
		{ id: 1, text: "g-core", col: "todo", project: "kb-core" },
		{ id: 2, text: "g-loose-1", col: "todo" },
		{ id: 3, text: "g-loose-2", col: "doing" },
	],
	nextId: 4,
});

assert.equal(allProjectCards().length, 0, "シード時点で project ボードは空のはず");
assert.equal(existsSync(BACKUP), false, "移行前からバックアップがある");

await mod.migrateScopeOnce();

// --- 1. 合計枚数が一致（カードを 1 枚も落としていない） ---------------------------
await check("移行後もプロジェクト全体で 7 枚", () => {
	assert.equal(allProjectCards().length, 7, JSON.stringify(allProjectCards().map((c) => c.text)));
});

await check("_inbox に 6 枚、kb-core に 1 枚（card.project が尊重される）", () => {
	assert.deepEqual(
		inbox().cards.map((c) => c.text).sort(),
		["a-first", "a-second", "b-first", "b-second", "g-loose-1", "g-loose-2"],
	);
	assert.deepEqual(
		readBoardAt(projectPath("kb-core")).cards.map((c) => c.text),
		["g-core"],
	);
});

// --- 2. board 行が減っている -------------------------------------------------------
await check("session / global の board 行が消えている", () => {
	for (const sid of ["mig-a", "mig-b"]) {
		assert.equal(boardExists(sessionPath(sid)), false, `session ボードが残っている: ${sid}`);
	}
	assert.equal(boardExists(`${HOME}/global.json`), false, "global ボードが残っている");
});

// --- 3. blocks の remap ------------------------------------------------------------
await check("blocks は移行後もボード内の実在カードを指す", () => {
	const cards = inbox().cards;
	const second = cards.find((c) => c.text === "a-second");
	assert.ok(second, "a-second が _inbox に無い");
	assert.ok(Array.isArray(second.blocks) && second.blocks.length === 1, JSON.stringify(second));
	const first = cards.find((c) => c.id === second.blocks[0]);
	assert.ok(first, `blocks=${second.blocks[0]} の参照先がボードに無い`);
	assert.equal(first.text, "a-first", `参照先が別のカード: ${first.text}`);
});

await check("id は移行先で振り直され、重複しない", () => {
	const ids = inbox().cards.map((c) => c.id);
	assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
	assert.ok(
		inbox().cards.every((c) => c.id < inbox().nextId),
		`nextId=${inbox().nextId} が id より小さい`,
	);
});

// --- 4. バックアップ ---------------------------------------------------------------
await check("boards.sqlite.pre-scope-migration が作られている", () => {
	assert.ok(existsSync(BACKUP), `${BACKUP} が無い`);
});

// --- 5. 冪等（meta.scope_migrated で 2 回目は即 return） ----------------------------
await check("2 回目は何もしない（新しい session ボードも畳まれない）", async () => {
	// 移行後にできたボードは「2 回目」の対象になってはいけない。存在を残すことで確かめる。
	seedBoard(sessionPath("mig-after"), { cards: [{ id: 1, text: "later", col: "todo" }], nextId: 2 });
	await mod.migrateScopeOnce();
	assert.equal(allProjectCards().length, 7, JSON.stringify(allProjectCards().map((c) => c.text)));
	assert.equal(boardExists(sessionPath("mig-after")), true, "2 回目が session ボードを消した");
});

// --- 6. mergeBoardInto 単体: 重複は残す / 範囲外の blocks は落とす -------------------
await check("mergeBoardInto は重複を残し、外部参照 blocks を落とす", () => {
	const dst = { cards: [{ id: 1, text: "dup", col: "todo" }], nextId: 2 };
	mod.mergeBoardInto(dst, {
		cards: [
			{ id: 5, text: "dup", col: "todo", blocks: [5] },
			{ id: 6, text: "tail", col: "todo", blocks: [99] },
		],
		nextId: 7,
	});
	assert.deepEqual(
		dst.cards.map((c) => [c.id, c.text]),
		[
			[1, "dup"],
			[2, "dup"],
			[3, "tail"],
		],
	);
	assert.deepEqual(dst.cards[1].blocks, [2], "自己参照が新しい自分の id になっていない");
	assert.equal(dst.cards[2].blocks, undefined, "存在しない id への参照が残っている");
	assert.equal(dst.nextId, 4);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
