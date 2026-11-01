// #17: 一度きりの scope リセット（session 廃止。boards は project のみ）。
// フレームワーク無しで `node tests/kanban-scope-migrate.test.mjs`。
// 対象: resetScopesOnce（project 以外の board 行の削除 / meta.scopes_reset による冪等 /
// 事前バックアップ）。HOME を差し替えるので本番の ~/.pi/kanban には触れない。
// サーバは立てない（リセット関数を直接呼ぶ）。
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
assert.equal(typeof mod.resetScopesOnce, "function", "resetScopesOnce が export されていない");

const HOME = `${HOME_DIR}/.pi/kanban`;
const DB_FILE = `${HOME}/boards.sqlite`;
const BACKUP = `${DB_FILE}.pre-scope-reset`;
const projectPath = (slug) => `${HOME}/projects/${slug}.json`;
const globalPath = `${HOME}/global.json`;

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

/** The raw rows, read without the board layer so a scope=global row is still visible. */
const raw = () => {
	const { DatabaseSync } = require("node:sqlite");
	const db = new DatabaseSync(DB_FILE);
	try {
		const boards = db.prepare("SELECT scope, sid FROM board ORDER BY scope, sid").all();
		const meta = db.prepare("SELECT v FROM meta WHERE k = 'scopes_reset'").get();
		return {
			// null-prototype rows from node:sqlite do not deepEqual plain objects.
			boards: boards.map((r) => `${r.scope}/${r.sid}`),
			meta: meta === undefined ? undefined : String(meta.v),
		};
	} finally {
		db.close();
	}
};

// --- シード: project 2 枚 + global 1 枚（リセットで消える側） -----------------------
seedBoard(projectPath("kb-core"), {
	cards: [{ id: 1, text: "p-core", col: "todo" }],
	nextId: 2,
});
seedBoard(projectPath("kb-other"), {
	cards: [{ id: 1, text: "p-other", col: "doing" }],
	nextId: 2,
});
seedBoard(globalPath, {
	cards: [{ id: 1, text: "g-one", col: "todo" }],
	nextId: 2,
});

assert.equal(raw().boards.length, 3, JSON.stringify(raw().boards));
assert.equal(existsSync(BACKUP), false, "リセット前からバックアップがある");
assert.equal(raw().meta, undefined, "リセット前から scopes_reset が立っている");

mod.resetScopesOnce();

// --- 1. project 行は残る -----------------------------------------------------------
await check("project の board 行とカードはそのまま残る", () => {
	assert.deepEqual(raw().boards, ["project/kb-core", "project/kb-other"]);
	assert.deepEqual(readBoardAt(projectPath("kb-core")).cards.map((c) => c.text), ["p-core"]);
	assert.deepEqual(readBoardAt(projectPath("kb-other")).cards.map((c) => c.text), ["p-other"]);
});

// --- 2. global / session 行は消える ------------------------------------------------
await check("global 行が消えている（project 以外は全部落とす）", () => {
	assert.equal(boardExists(globalPath), false, "global ボードが残っている");
	assert.ok(
		raw().boards.every((b) => b.startsWith("project/")),
		`project 以外の行が残っている: ${JSON.stringify(raw().boards)}`,
	);
});

// --- 3. meta.scopes_reset = "2" が立つ ---------------------------------------------
await check("meta.scopes_reset が \"2\" になる", () => {
	assert.equal(raw().meta, "2");
});

// --- 4. バックアップが作られる -----------------------------------------------------
await check("boards.sqlite.pre-scope-reset が作られている", () => {
	assert.ok(existsSync(BACKUP), `${BACKUP} が無い`);
});

// --- 5. 冪等: 2 回目は no-op（再 DELETE しない） -----------------------------------
await check("2 回目は no-op（リセット後にできた非 project 行も消さない）", () => {
	// 2 回目が走るならこの行は消える。残ることで「何もしなかった」を確かめる。
	seedBoard(globalPath, { cards: [{ id: 1, text: "g-later", col: "todo" }], nextId: 2 });
	mod.resetScopesOnce();
	assert.equal(raw().meta, "2", "marker が書き直されている");
	const rows = raw().boards;
	assert.ok(rows.some((b) => b === "global/"), `2 回目が global 行を消した: ${JSON.stringify(rows)}`);
	assert.equal(readBoardAt(globalPath).cards.length, 1, "2 回目が global ボードを空にした");
});

// --- 6. 失敗経路: DELETE が投げたら marker を立てない（次回起動で再試行できる） ---
// 「202/返り値だけ見て成功とみなす」穴を塞ぐ。マーカーは DELETE の後にしか立たない、
// を実測で固定する（3 つの DELETE が単一トランザクションでないのは許容: marker が立たないので
// 次の起動でまた同じリセットが走り、収束する）。
const BOOM = "injected delete failure";
const exec = (fn) => {
	const { DatabaseSync } = require("node:sqlite");
	const db = new DatabaseSync(DB_FILE);
	try {
		return fn(db);
	} finally {
		db.close();
	}
};
// 直前のチェックで marker="2" が立っているので、まず外して「次回起動」の状態にする。
exec((db) => db.prepare("DELETE FROM meta WHERE k = 'scopes_reset'").run());

await check("DELETE が throw すると marker を立てない（board 行も残る）", () => {
	exec((db) =>
		db.exec(
			`CREATE TRIGGER kb_boom BEFORE DELETE ON board BEGIN SELECT RAISE(ABORT, '${BOOM}'); END`,
		),
	);
	try {
		assert.throws(() => mod.resetScopesOnce(), (err) => String(err.message).includes(BOOM));
		assert.equal(raw().meta, undefined, "失敗したのに scopes_reset が立っている");
		assert.ok(
			raw().boards.some((b) => b === "global/"),
			`board 行が消えている: ${JSON.stringify(raw().boards)}`,
		);
	} finally {
		exec((db) => db.exec("DROP TRIGGER kb_boom"));
	}
});

// 同じ起動で「次回」を起こす: 障害が消えれば同じリセットが走って収束する。
await check("リトライ（次回起動相当）は成功して marker が立つ", () => {
	mod.resetScopesOnce();
	assert.equal(raw().meta, "2");
	assert.deepEqual(raw().boards, ["project/kb-core", "project/kb-other"]);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
