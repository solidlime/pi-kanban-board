// #61: 成果物の「添付を外す」(旧: 帯タイルの ×) が叩く `/api/attach/del`。カードの `img` csv から 1 エントリだけ外す。
// 参照型（file:）は csv だけ落とし実ファイルは触らない。実体型（media 名）は .trash へ。
// 最後の 1 枚を消したら `card.img` 自体が消える（undefined）。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-attach-del-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = process.env.HOME;

const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"));
const jiti = createJiti(import.meta.url);
const SRC = fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(SRC);
useKanban(mod);
useMigrate(mod);
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
const eq = (a, b) => assert.deepEqual(a, b);

const SLUG = mod.projectSlugOf(process.cwd());
const boardFile = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const MEDIA = `${HOME_DIR}/.pi/kanban/media`;
const TRASH = `${MEDIA}/.trash`;
const REF_FILE = `${HOME_DIR}/workspace/del-ref.html`;
writeFileSync(REF_FILE, "<h1>ref</h1>");
for (const n of ["del-a.png", "del-b.png", "del-shared.png"]) writeFileSync(`${MEDIA}/${n}`, "png");
seedBoard(boardFile, {
	cards: [
		{ id: 1, text: "ref + media", col: "todo", img: `file:${REF_FILE},del-a.png` },
		{ id: 2, text: "shared", col: "todo", img: "del-shared.png" },
		{ id: 3, text: "again", col: "todo", img: "del-b.png,del-shared.png" },
		{ id: 4, text: "one", col: "todo", img: "del-b.png" },
	],
	nextId: 10,
});
const cardOf = (id) => readBoardAt(boardFile).cards.find((c) => c.id === id);

const commands = new Map();
const tools = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
});
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const del = (id, n, extra = "") =>
	tf(`http://127.0.0.1:${PORT}/api/attach/del?p=${SLUG}&id=${id}&n=${n}${extra}`);

// --- 1: 参照型は csv だけ落ちる -------------------------------------------------
{
	const r = await del(1, 0);
	const body = await r.json();
	check("参照型: 200 と ok/cards を返す", () => {
		assert.equal(r.status, 200);
		assert.equal(body.ok, true);
		assert.equal(Array.isArray(body.cards), true);
	});
	check("参照型: csv から外れる（del-a.png だけ残る）", () => eq(cardOf(1).img, "del-a.png"));
	check("参照型: 実ファイルは残る", () => assert.equal(existsSync(REF_FILE), true));
}

// --- 2: 実体型は .trash へ ------------------------------------------------------
{
	const r = await del(1, 0);
	check("実体型: 200", () => assert.equal(r.status, 200));
	check("実体型: media から消える", () => assert.equal(existsSync(`${MEDIA}/del-a.png`), false));
	check("実体型: .trash に実体が移る", () => {
		assert.equal(existsSync(TRASH), true);
		assert.equal(readdirSync(TRASH).some((n) => n.endsWith("del-a.png")), true);
	});
	check("実体型: 最終エントリなので card.img が undefined", () => eq(cardOf(1).img, undefined));
	check("実体型: JSON に img キーが残らない", () => {
		const raw = readBoardAt(boardFile).cards.find((c) => c.id === 1);
		assert.equal("img" in raw, false);
	});
}

// --- 3: 範囲外 n は 400 --------------------------------------------------------
{
	const r = await del(2, 3);
	check("範囲外: 400", () => assert.equal(r.status, 400));
	check("範囲外: ボードは不変", () => eq(cardOf(2).img, "del-shared.png"));
	const r2 = await del(2, "x");
	check("数値でない n: 400", () => assert.equal(r2.status, 400));
	const r3 = await del(2, "");
	check("空の n: 400（Number('')=0 に化けない）", () => assert.equal(r3.status, 400));
	const r4 = await del(99, 0);
	check("id 不在: 404", () => assert.equal(r4.status, 404));
}

// --- 4: 共有されている media は trash しない -----------------------------------
{
	const r = await del(3, 1);
	check("共有: 200", () => assert.equal(r.status, 200));
	check("共有: csv から外れる", () => eq(cardOf(3).img, "del-b.png"));
	check("共有: 他カードが使う del-shared.png は残る", () => {
		assert.equal(existsSync(`${MEDIA}/del-shared.png`), true);
		assert.equal(cardOf(2).img, "del-shared.png");
	});
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`passed=${passed} failed=${failures.length}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
