// #55: ダッシュボードのペースト添付。クリップボードの画像は POST する File ではなく
// dataURL として /api/upload2 の query に乗る（/api/ehr と同じ理由 — iframe 由来の
// 小さな payload を 1 リクエストで済ませる）。よってここで固める契約は 5 つ:
//   base64 dataURL だけ受ける / 128KB で 413 / MIME と ext の食い違いは 415 /
//   カードが無ければ 404 / 書けたら media に実体 + card.img に追記（置換しない）。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-paste-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME.
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
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);
useMigrate(mod);
await settleMigration();

const commands = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
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

const SLUG = mod.projectSlugOf(process.cwd());
const boardFile = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const MEDIA = `${HOME_DIR}/.pi/kanban/media`;
const imgOf = (id) => readBoardAt(boardFile).cards.find((c) => c.id === id).img;
seedBoard(boardFile, {
	cards: [
		{ id: 3, text: "既存添付あり", col: "todo", img: "3-old.png" },
		{ id: 4, text: "添付なし", col: "doing" },
	],
	nextId: 90,
});

// 1x1 png（中身の正しさは見ない。「書いたバイトがそのまま戻る」ことだけ見る）。
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAAABgAB/0FQ8wAAAABJRU5ErkJggg==",
	"base64",
);
const dataUrlOf = (bytes, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;
const u2 = (params) => `http://127.0.0.1:${PORT}/api/upload2?${new URLSearchParams(params)}`;
const post = (params, init) => tf(u2(params), init);

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

// --- 0: 正常系 ----------------------------------------------------------------
{
	const before = readdirSync(MEDIA).length;
	const r = await post({ p: SLUG, id: 3, data: dataUrlOf(PNG) });
	const body = await r.json();
	check("正常系: 200 / ok / card.id=3", () => {
		assert.equal(r.status, 200);
		assert.equal(body.ok, true);
		assert.equal(body.card.id, 3);
	});
	const img = imgOf(3);
	check("正常系: card.img は既存を残して csv 追記", () => assert.match(img, /^3-old\.png,3-[0-9a-f]{8}\.png$/));
	check("正常系: media に実体がありバイト一致", () => {
		const name = img.split(",")[1];
		assert.equal(existsSync(`${MEDIA}/${name}`), true);
		assert.deepEqual(readFileSync(`${MEDIA}/${name}`), PNG);
	});
	check("正常系: media は 1 ファイルだけ増えた", () => assert.equal(readdirSync(MEDIA).length, before + 1));
	check("正常系: 他のカードは触らない (#4)", () => assert.equal(imgOf(4), undefined));
}

// --- 1: 128KB cap --------------------------------------------------------------
{
	// dataURL 長が上限を超える最小構成（base64 は 4/3 に膨らむ）。
	const big = dataUrlOf(Buffer.alloc(100 * 1024, 7));
	const r = await post({ p: SLUG, id: 4, data: big });
	const body = await r.json();
	check("413: dataURL が 128KB 超", () => {
		assert.ok(big.length > 131072, `len=${big.length}`);
		assert.equal(r.status, 413);
		assert.match(body.error, /too large/);
	});
	check("413: 断られたら card.img は付かない", () => assert.equal(imgOf(4), undefined));
}

// --- 2: MIME / ext ------------------------------------------------------------
{
	const r = await post({ p: SLUG, id: 4, data: dataUrlOf(PNG), ext: "webp" });
	const body = await r.json();
	check("415: ext が dataURL の MIME と食い違う", () => {
		assert.equal(r.status, 415);
		assert.match(body.error, /does not match/);
	});
	const r2 = await post({ p: SLUG, id: 4, data: dataUrlOf(PNG, "image/svg+xml") });
	check("415: OK_EXTS 外の MIME (svg)", () => assert.equal(r2.status, 415));
	const r3 = await post({ p: SLUG, id: 4, data: "hello" });
	check("400: dataURL でない data", () => assert.equal(r3.status, 400));
	check("415/400: どちらも card.img は付かない", () => assert.equal(imgOf(4), undefined));
}

// --- 3: 対象カード ------------------------------------------------------------
{
	const r = await post({ p: SLUG, id: 999, data: dataUrlOf(PNG) });
	const body = await r.json();
	check("404: id 不在", () => {
		assert.equal(r.status, 404);
		assert.match(body.error, /no card with id 999/);
	});
	const r2 = await tf(u2({ p: SLUG, data: dataUrlOf(PNG) }));
	check("400: id 無し", () => assert.equal(r2.status, 400));
}

// --- 4: ゲート ----------------------------------------------------------------
{
	// cookie 無しは 401（書き込み面なので当然）。
	const r = await fetch(u2({ p: SLUG, id: 3, data: dataUrlOf(PNG) }));
	check("401: トークン無しは書けない", () => assert.equal(r.status, 401));
	check("401: card.img は変わらない", () => assert.match(imgOf(3), /^3-old\.png,3-[0-9a-f]{8}\.png$/));
	// POST は受けない（/api/upload が本体で、こちらは GET+query 専用）。
	const r2 = await post({ p: SLUG, id: 3, data: dataUrlOf(PNG) }, { method: "POST" });
	check("405: POST は受けない", () => assert.equal(r2.status, 405));
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`passed=${passed} failed=${failures.length}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
