// #53: カード添付（複数 / html プレビュー / 上限 / 削除掃除）の自己検証。
// フレームワーク無しで `node tests/kanban-media-html.test.mjs`。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-media-html-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = process.env.HOME;
// #53 要件4: 上限は env で上書きできる。1MB に下げて 413 を踏む（読み込み時に確定するので
// モジュール import より前に置く）。
const LIMIT = 1024 * 1024;
process.env.KANBAN_MEDIA_MAX_BYTES = String(LIMIT);

const PORT = await new Promise((resolve) => {
	const s = netServer();
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

const MEDIA = `${HOME_DIR}/.pi/kanban/media`;
const boardFile = `${HOME_DIR}/.pi/kanban/projects/${mod.projectSlugOf(process.cwd())}.json`;
const readCards = () => readBoardAt(boardFile).cards;
const imgOf = (id) => readCards().find((c) => c.id === id)?.img;
const mediaNames = () => readdirSync(MEDIA).filter((n) => !n.startsWith(".")).sort();
seedBoard(boardFile, { cards: [{ id: 5, text: "a", col: "todo" }], nextId: 90 });

const commands = new Map();
const tools = new Map();
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${base}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const upload = (query, body) => tf(`${base}/api/upload?scope=project&${query}`, { method: "POST", body });

// --- 1: 同一カードへの複数添付は「追加」になる (#53) --------------------------
{
	const a = await upload("id=5&ext=png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const afterA = imgOf(5);
	check("#53 1枚目の upload が card.img に入る", () => {
		assert.equal(a.status, 200);
		assert.match(afterA, /^5-[0-9a-f]{8}\.png$/);
	});
	const b = await upload("id=5&ext=png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const afterB = imgOf(5);
	check("#53 2枚目の upload は置換ではなく追記 (a.png,b.png)", () => {
		assert.equal(b.status, 200);
		const names = afterB.split(",");
		assert.equal(names.length, 2);
		assert.equal(names[0], afterA);
		assert.match(names[1], /^5-[0-9a-f]{8}\.png$/);
	});
	check("#53 追記後も1枚目は media に残っている", () => assert.ok(existsSync(`${MEDIA}/${afterA}`)));
}

// --- 2: .html 添付は sandbox CSP つきで配信される ------------------------------
{
	const a = await upload("id=5&ext=html", Buffer.from("<!doctype html><h1>three</h1>"));
	const card = readCards().find((c) => c.id === 5);
	const name = card.img.split(",").pop();
	check("#53 html upload が card.img の末尾に載る", () => assert.match(name, /^5-[0-9a-f]{8}\.html$/));
	const res = await tf(`${base}/api/media/${name}`);
	const body = await res.text();
	check("#53 /api/media/<x>.html は text/html + inline + CSP sandbox", () => {
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
		assert.equal(res.headers.get("content-disposition"), "inline");
		// #53: the load-bearing guard. allow-same-origin is deliberately absent, and the
		// page must stay frameable (no X-Frame-Options) or the lightbox iframe goes blank.
		assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-forms");
		assert.equal(res.headers.get("x-frame-options"), null);
		assert.match(body, /three/);
	});
	const pngRes = await upload("id=5&ext=png", Buffer.from([0x89]));
	const pngName = readCards().find((c) => c.id === 5).img.split(",").pop();
	const pngGet = await tf(`${base}/api/media/${pngName}`);
	check("#53 png には CSP sandbox を付けない", () => {
		assert.equal(pngRes.status, 200);
		assert.equal(pngGet.headers.get("content-security-policy"), null);
	});
}

// --- 3: 上限は KANBAN_MEDIA_MAX_BYTES で上書きできる --------------------------
{
	const before = imgOf(5);
	const over = await upload("id=5&ext=png", Buffer.alloc(LIMIT + 1, 0x41));
	const body = await over.text();
	check("#53 上限超過は 413", () => {
		assert.equal(over.status, 413, `status=${over.status} body=${body}`);
	});
	check("#53 413 のときカードも media も変えない", () => {
		assert.equal(imgOf(5), before);
		assert.ok(!mediaNames().includes("over.png"));
	});
	const ok = await upload("id=5&ext=png", Buffer.alloc(LIMIT - 1024, 0x42));
	check("#53 上限未満は通る", () => assert.equal(ok.status, 200, `status=${ok.status}`));
}

// --- 4: カード削除で添付が掃除される（.trash へ移動） --------------------------
{
	const before = (imgOf(5) ?? "").split(",").filter(Boolean);
	check("#53 削除前に複数添付がある", () => assert.ok(before.length >= 3, before.join(",")));
	const res = await tf(`${base}/api/remove?scope=project&id=5`);
	check("#53 カード削除は成功する", () => assert.equal(res.status, 200, `status=${res.status}`));
	check("#53 削除で media/ から全部消える（trash へ）", () => {
		const live = mediaNames();
		for (const n of before) assert.ok(!live.includes(n), `${n} が media/ に残っている`);
	});
	check("#53 消えたファイルは .trash に退避されている", () => {
		const trash = readdirSync(`${MEDIA}/.trash`);
		for (const n of before) assert.ok(trash.some((t) => t.endsWith(`-${n}`)), `.trash に ${n} が無い`);
	});
}

// --- 5: ツール記述（serve の説明が消え、img に html が載る） --------------------
{
	const kanban = tools.get("kanban");
	const desc = kanban?.description ?? "";
	check("#53 kanban ツール記述に serve の機能説明が残っていない", () => {
		assert.ok(desc.length > 0, "kanban ツールが未登録");
		assert.doesNotMatch(desc, /board\/serve\/media/);
	});
	check("#53 kanban ツール記述の img が html プレビューに触れている", () => {
		assert.match(desc, /\.html/);
		assert.match(desc, /iframe/);
	});
	check("#53 serve ツールは登録されていない", () => assert.equal(tools.has("serve"), false));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
// The 8789 listener keeps the loop alive; close it by hand like the other HTTP tests.
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
