// `/kanban img <id> <path>` の自己検証。フレームワーク無しで
// `node tests/kanban-img.test.mjs`。HOME と KANBAN_PORT を差し替えるので
// 本番の ~/.pi/kanban と 8789 には触れない。
// 画像は media/ にコピーされ `Card.img` には basename が入る（/api/upload と同じ規則）。
// ファイルが無い / 画像でない / 8MB 超は notify だけでボードに触らない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-img-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
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
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const SRC = fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(SRC);
const { parseKanbanArgs } = mod;

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

const SID = "img-session";
const boardFile = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
const MEDIA = `${HOME_DIR}/.pi/kanban/media`;
const readCards = () => JSON.parse(readFileSync(boardFile, "utf8")).cards;
const imgOf = (id) => readCards().find((c) => c.id === id).img;
const mediaNames = () => readdirSync(MEDIA).sort();
writeFileSync(
	boardFile,
	JSON.stringify(
		{ cards: [{ id: 3, text: "a", col: "todo" }, { id: 4, text: "b", col: "doing" }], nextId: 90 },
		null,
		2,
	),
);

// --- 0: parseKanbanArgs（純粋） ----------------------------------------------
check("parse: img 3 /tmp/x.png", () =>

eq(parseKanbanArgs(["img", "3", "/tmp/x.png"]), { kind: "img", id: 3, path: "/tmp/x.png" }),
);
check("parse: img 3（パス無し）は reject", () => eq(parseKanbanArgs(["img", "3"]).kind, "reject"));
check("parse: img だけは reject", () => eq(parseKanbanArgs(["img"]).kind, "reject"));
check("parse: img 0 は reject", () => eq(parseKanbanArgs(["img", "0", "/tmp/x.png"]).kind, "reject"));
check("parse: img abc は reject", () => eq(parseKanbanArgs(["img", "abc", "/tmp/x.png"]).kind, "reject"));

// --- サーバ起動（このテスト専用ポート） ---------------------------------------
const commands = new Map();
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const kbCmd = async (args) => {
	const notes = [];
	await commands.get("kanban").handler(args, {
		hasUI: false,
		isIdle: () => false,
		ui: { notify(m) { notes.push(m); }, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	});
	return notes.join("\n");
};

// --- 1: 正常系 ----------------------------------------------------------------
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SRC_IMG = "/tmp/kb-img-src.png";
writeFileSync(SRC_IMG, PNG);
{
	const before = mediaNames();
	const out = await kbCmd(`img 3 ${SRC_IMG}`);
	check("正常系: notify に添付先とファイル名", () => assert.match(out, /#3 に画像を添付: kb-img-src\.png/));
	const img = imgOf(3);
	check("正常系: card.img は <id>-<8hex>.png の basename", () => assert.match(img, /^3-[0-9a-f]{8}\.png$/));
	check("正常系: media/ に実体がコピーされバイト一致", () => {
		assert.equal(existsSync(`${MEDIA}/${img}`), true);
		assert.deepEqual(readFileSync(`${MEDIA}/${img}`), PNG);
	});
	check("正常系: 他のカードの img は増えない (#4)", () => assert.equal(imgOf(4), undefined));
	check("正常系: media は 1 ファイルだけ増えた", () => assert.equal(mediaNames().length, before.length + 1));
}

// --- 2: ファイル不在 ----------------------------------------------------------
{
	const before = mediaNames();
	const out = await kbCmd("img 3 /tmp/kb-img-does-not-exist.png");
	check("ファイル不在: notify のみ", () => assert.match(out, /ファイルが無い \/ 読めない/));
	check("ファイル不在: ボードは書かれない (旧 img 維持)", () => assert.match(imgOf(3), /^3-[0-9a-f]{8}\.png$/));
	check("ファイル不在: media は増えない", () => eq(mediaNames(), before));
}

// --- 3: 非画像 ----------------------------------------------------------------
{
	const TXT = "/tmp/kb-img-not-image.txt";
	writeFileSync(TXT, "hello");
	const out = await kbCmd(`img 3 ${TXT}`);
	const after = imgOf(3);
	check("非画像: notify のみ", () => assert.match(out, /画像ではない/));
	check("非画像: ボードは書かれない", () => assert.match(after, /^3-[0-9a-f]{8}\.png$/));
	check("非画像: media に txt を置かない", () => assert.equal(mediaNames().some((n) => n.endsWith(".txt")), false));
}

// --- 4: サイズ超過 (8MB) ------------------------------------------------------
{
	const BIG = "/tmp/kb-img-too-big.png";
	writeFileSync(BIG, Buffer.alloc(8 * 1024 * 1024 + 1, 0x7f));
	const before = mediaNames();
	const out = await kbCmd(`img 4 ${BIG}`);
	check("サイズ超過: notify のみ", () => assert.match(out, /大きすぎる/));
	check("サイズ超過: ボードは書かれない (#4 は img 無しのまま)", () => eq(imgOf(4), undefined));
	check("サイズ超過: media は増えない", () => eq(mediaNames(), before));
	rmSync(BIG, { force: true });
}

// --- 5: id が無い -------------------------------------------------------------
{
	const out = await kbCmd(`img 99 ${SRC_IMG}`);
	check("id が無い: notify のみ", () => assert.match(out, /その id は無い: #99/));
}

// --- 6: ~ 展開 ----------------------------------------------------------------
{
	const HOME_IMG = `${HOME_DIR}/kb-img-tilde.png`;
	writeFileSync(HOME_IMG, PNG);
	const out = await kbCmd("img 4 ~/kb-img-tilde.png");
	check("~ 展開: notify 成功", () => assert.match(out, /#4 に画像を添付: kb-img-tilde\.png/));
	check("~ 展開: card.img が入る", () => assert.match(imgOf(4), /^4-[0-9a-f]{8}\.png$/));
}

// --- 7: 置き換えで旧ファイルが消える -----------------------------------------
{
	const before = imgOf(3);
	const out = await kbCmd(`img 3 ${SRC_IMG}`);
	check("置き換え: 成功 notify", () => assert.match(out, /#3 に画像を添付/));
	check("置き換え: 旧 media は removeMedia で消える", () => assert.equal(existsSync(`${MEDIA}/${before}`), false));
	check("置き換え: 新 media は残る", () => assert.equal(existsSync(`${MEDIA}/${imgOf(3)}`), true));
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`passed=${passed} failed=${failures.length}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
