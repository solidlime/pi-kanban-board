// #92: 成果物を「カード」として投稿してしまう事故を、道具の形で断つ。
// `deliverable` は card を増やさない / deliv id が同番号の card を汚さない（id 空間が別）/
// remove の trash 規則は card と deliv の両方を見る / global は読み取り専用。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// ボードは cards_*.mjs の流儀どおり seedBoard/readBoardAt で読み書きする（サーバを経由しない）。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const HOME_DIR = "/tmp/kb-deliv-tool-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
const MEDIA = `${KB}/media`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(MEDIA, { recursive: true });
mkdirSync(`${KB}/projects`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
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
await settleMigration();

const tools = {};
const pi = {
	registerCommand() {},
	// #92: 登録順も固定する（kanban が先。tests/kanban-tool-schema.test.mjs が
	// ファイル内「最初の」parameters を kanban として切り出すため）。
	registerTool(def) {
		tools[def.name] = def;
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
assert.ok(tools.kanban, "kanban ツールが登録されている");
assert.ok(tools.deliverable, "deliverable ツールが登録されている");

// The project board the tool writes: boardPath("project", projectSlugOf(cwd)).
const SLUG = mod.projectSlugOf(process.cwd());
const BOARD = `${KB}/projects/${SLUG}.json`;

const SID = "deliv-tool-session";
const ctx = {
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => SID, getEntries: () => [] },
};
const run = (params) => tools.deliverable.execute("c", { scope: "project", ...params }, undefined, undefined, ctx);
const textOf = (r) => r.content.map((c) => c.text).join("\n");

// 画像は中身を見ない（拡張子とサイズだけ）。実体のあるファイルならよい。
const SHOT = `${HOME_DIR}/shot.png`;
writeFileSync(SHOT, Buffer.alloc(64));

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

// --- 1. add は deliv 行を作り、card は増えない ---------------------------------
await check("add: deliv 行が 1 本でき、card は 0 枚のまま", async () => {
	const r = await run({ action: "add", text: "report.pdf" });
	assert.notEqual(r.isError, true, textOf(r));
	assert.match(textOf(r), /deliverable #1/, textOf(r));
	const b = readBoardAt(BOARD);
	assert.equal(b.deliverables.length, 1, JSON.stringify(b.deliverables));
	assert.equal(b.cards.length, 0, `card が増えている: ${JSON.stringify(b.cards)}`);
	assert.equal(b.deliverables[0].text, "report.pdf");
	assert.equal(typeof b.deliverables[0].at, "number", "at が入っていない（band が並べられない）");
});

// --- 2. edit は text だけ差し替える ---------------------------------------------
await check("edit: text だけ替わり at は据え置き", async () => {
	const before = readBoardAt(BOARD).deliverables[0];
	const r = await run({ action: "edit", id: 1, text: "report-v2.pdf" });
	assert.notEqual(r.isError, true, textOf(r));
	const after = readBoardAt(BOARD).deliverables[0];
	assert.equal(after.text, "report-v2.pdf");
	assert.equal(after.at, before.at, "at が書き換わっている");
});

await check("edit: 空 text は書かない", async () => {
	const r = await run({ action: "edit", id: 1, text: "  " });
	assert.equal(r.isError, true);
	assert.match(textOf(r), /non-empty text/);
	assert.equal(readBoardAt(BOARD).deliverables[0].text, "report-v2.pdf");
});

// --- 3. id 空間の罠: 同番号の card があっても deliv 側にだけ付く -----------------
// ここが今回の核心。attachImage(b, delivId, …) を流用すると card #1 に静かに付いていた。
await check("card #1 を先に作る（deliv #1 と同番号）", async () => {
	const r = await tools.kanban.execute("c", { action: "add", scope: "project", text: "work I owe" }, undefined, undefined, ctx);
	assert.notEqual(r.isError, true, textOf(r));
	const b = readBoardAt(BOARD);
	assert.equal(b.cards.length, 1);
	assert.equal(b.cards[0].id, 1);
});

await check("img: deliv #1 にだけ付き、同番号の card #1 は汚れない", async () => {
	const r = await run({ action: "img", id: 1, image: SHOT });
	assert.notEqual(r.isError, true, textOf(r));
	assert.match(textOf(r), /to deliverable #1/, textOf(r));
	const b = readBoardAt(BOARD);
	assert.equal(b.cards[0].img, undefined, `card #1 に付いている: ${b.cards[0].img}`);
	assert.match(b.deliverables[0].img ?? "", /^1-[0-9a-f]{8}\.png$/, `deliv #1: ${b.deliverables[0].img}`);
	assert.equal(existsSync(`${MEDIA}/${b.deliverables[0].img}`), true, "media/ に実体が無い");
});

await check("ref: allowlist 内なら deliv 側に file:<abs>（card は汚れない）", async () => {
	mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
	const view = `${HOME_DIR}/workspace/view.md`;
	writeFileSync(view, "# ok\n");
	const r = await run({ action: "ref", id: 1, image: view });
	assert.notEqual(r.isError, true, textOf(r));
	const b = readBoardAt(BOARD);
	assert.match(b.deliverables[0].img ?? "", /,file:.*view\.md$/, `deliv #1: ${b.deliverables[0].img}`);
	assert.equal(b.cards[0].img, undefined, `card #1 に付いている: ${b.cards[0].img}`);
});

await check("ref: allowlist の外は書かない（帯が永久 403 になる path を残さない）", async () => {
	const r = await run({ action: "ref", id: 1, image: SHOT });
	assert.equal(r.isError, true);
	assert.match(textOf(r), /allowlist/);
	assert.doesNotMatch(readBoardAt(BOARD).deliverables[0].img ?? "", /shot\.png/, "拒否した path が入っている");
});

// --- 4. list: global は <slug>/<id> で出す --------------------------------------
await check("list global: slug/id で並び、project の list は #id", async () => {
	const g = await run({ action: "list", scope: "global" });
	assert.notEqual(g.isError, true, textOf(g));
	assert.match(textOf(g), new RegExp(`${SLUG}/1\\s+report-v2\\.pdf`), textOf(g));
	const p = await run({ action: "list" });
	assert.match(textOf(p), /#1\s+report-v2\.pdf/, textOf(p));
	// カードは成果物の一覧に出ない（2 つの空間は混ざらない）。
	assert.doesNotMatch(textOf(g), /work I owe/, textOf(g));
});

await check("global への書き込みは拒否", async () => {
	for (const params of [{ action: "add", text: "x" }, { action: "remove", id: 1 }, { action: "img", id: 1, image: SHOT }]) {
		const r = await run({ ...params, scope: "global" });
		assert.equal(r.isError, true, `${params.action} が通ってしまう`);
		assert.match(textOf(r), /global board is read-only/);
	}
});

// --- 5. remove の trash 規則: card と deliv の両方が見る ------------------------
// media/shared.png は card #1 と deliv #1 の両方が表示している。
// media/own.png は deliv #2 だけ。deliv #1 を消しても shared.png は残り、
// deliv #2 を消すと own.png は .trash へ移る。
writeFileSync(`${MEDIA}/shared.png`, "shared");
writeFileSync(`${MEDIA}/own.png`, "own");
seedBoard(BOARD, {
	cards: [{ id: 1, text: "work I owe", col: "todo", img: "shared.png" }],
	nextId: 2,
	deliverables: [
		{ id: 1, text: "kept by the card", at: 1, img: "shared.png" },
		{ id: 2, text: "gone", at: 2, img: "own.png" },
	],
	delivNextId: 3,
});
const trashed = () => {
	try {
		return readdirSync(`${MEDIA}/.trash`);
	} catch {
		return [];
	}
};

await check("remove: 別 owner（card）がまだ見ている media は消えない", async () => {
	const r = await run({ action: "remove", id: 1 });
	assert.notEqual(r.isError, true, textOf(r));
	const b = readBoardAt(BOARD);
	assert.deepEqual(b.deliverables.map((d) => d.id), [2], JSON.stringify(b.deliverables));
	assert.equal(existsSync(`${MEDIA}/shared.png`), true, "card #1 がまだ見ているのに消えた");
	assert.deepEqual(trashed(), [], "まだ見られている media が .trash に移った");
});

await check("remove: 誰も見ていない media は .trash に移る", async () => {
	const r = await run({ action: "remove", id: 2 });
	assert.notEqual(r.isError, true, textOf(r));
	assert.equal(existsSync(`${MEDIA}/own.png`), false, "media/ に残っている");
	assert.equal(trashed().some((n) => n.endsWith("own.png")), true, `.trash: ${trashed().join(",")}`);
	assert.equal(readBoardAt(BOARD).deliverables.length, 0);
});

await check("remove: 無い id は 404 相当で、他を消さない", async () => {
	const r = await run({ action: "remove", id: 99 });
	assert.equal(r.isError, true);
	assert.match(textOf(r), /no deliverable with id 99/);
	assert.equal(existsSync(`${MEDIA}/shared.png`), true);
});

// --- 6. ツール本体の最小限の説明（初見で出力用と分かる） -----------------------
await check("#90 の流儀: deliverable の description は 4 ブロック + 全パラメータに description", () => {
	const desc = tools.deliverable.description;
	for (const marker of ["Output you want the user to see", "Actions:", "A deliverable is a deliv row, not a card", "scope picks the board:"]) {
		assert.ok(desc.includes(marker), `説明に "${marker}" が無い`);
	}
	assert.match(desc, /do not create a TODO card for output/);
});

for (const f of failures) console.error(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
// HTTP サーバはモジュール読み込みで listen している。明示終了（他のテストと同じ）。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
