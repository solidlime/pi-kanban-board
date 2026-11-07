// #82: 成果物は card ではなく deliv テーブル。/api/deliv/add|edit|remove の契約と、
// 添付の `deliv=` ターゲット、そして「カードを書き換えても deliv 行が消えない」ことを見る。
// フレームワーク無しで `node tests/kanban-deliv-store.test.mjs`。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-deliv-store-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR; // Windows: os.homedir() reads this
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);
const BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;

const mod = createRequire(import.meta.url)("../extensions/kanban.ts");
useKanban(mod);

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

const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const SLUG = mod.projectSlugOf(process.cwd());
const OTHER = mod.projectSlugOf(`${HOME_DIR}/workspace/other-repo`);
const BOARD = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const OTHER_BOARD = `${HOME_DIR}/.pi/kanban/projects/${OTHER}.json`;
const SID = "sid-session-a";

const seed = () =>
	seedBoard(BOARD, {
		nextId: 2,
		delivNextId: 1,
		cards: [{ id: 1, text: "カード", col: "todo", movedBy: SID, movedAt: 1 }],
		deliverables: [],
	});

const get = async (path, params) => {
	const q = new URLSearchParams(params);
	q.set("p", SLUG);
	return tf(`${BASE}${path}?${q}`);
};
const json = async (r) => {
	const b = await r.json();
	assert.ok(b, `body が空 (status ${r.status})`);
	return b;
};
const projectOf = async (slug = SLUG) => {
	const r = await tf(`${BASE}/api/kanban?p=${encodeURIComponent(slug)}`);
	assert.equal(r.status, 200, `status ${r.status}`);
	return (await r.json()).project;
};
// 本文を読むと fetch の本文が消費されるので、失敗した時だけ読む。
const ok200 = async (r) => {
	if (r.status !== 200) assert.fail(`status ${r.status} ${await r.text()}`);
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

// --- 1. add -------------------------------------------------------------------
await check("#82 /api/deliv/add は行を 1 本足す", async () => {
	seed();
	const r = await get("/api/deliv/add", { text: "最初の成果物" });
	await ok200(r);
	const b = await json(r);
	assert.equal(b.ok, true);
	assert.equal(b.deliverable.id, 1);
	assert.equal(b.deliverable.text, "最初の成果物");
	assert.equal(typeof b.deliverable.at, "number");
	const stored = readBoardAt(BOARD);
	assert.equal(stored.deliverables.length, 1, "board に書かれていない");
	assert.equal(stored.delivNextId, 2, "採番が進んでいない");
	assert.equal(stored.cards.length, 1, "カードが増減した");
});

await check("#82 空 text の add は 400 text required", async () => {
	const r = await get("/api/deliv/add", { text: "   " });
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.deepEqual(await json(r), { ok: false, error: "text required" });
	assert.equal(readBoardAt(BOARD).deliverables.length, 1, "空 text で行が増えた");
});

// --- 2. edit ------------------------------------------------------------------
await check("#82 /api/deliv/edit は本文だけ差し替える", async () => {
	const r = await get("/api/deliv/edit", { id: "1", text: "直した成果物" });
	await ok200(r);
	assert.equal((await json(r)).deliverable.text, "直した成果物");
	assert.equal(readBoardAt(BOARD).deliverables[0].text, "直した成果物");
});

await check("#82 edit の空 text は 400、未知 id は 404", async () => {
	const bad = await get("/api/deliv/edit", { id: "1", text: "" });
	assert.equal(bad.status, 400, `empty text: status ${bad.status}`);
	assert.deepEqual(await json(bad), { ok: false, error: "text required" });
	const gone = await get("/api/deliv/edit", { id: "99", text: "x" });
	assert.equal(gone.status, 404, `unknown id: status ${gone.status}`);
	assert.deepEqual(await json(gone), { ok: false, error: "no deliverable with id 99" });
});

// --- 3. remove ----------------------------------------------------------------
await check("#82 未知 id の remove は 404", async () => {
	const r = await get("/api/deliv/remove", { id: "42" });
	assert.equal(r.status, 404, `status ${r.status}`);
	assert.equal((await json(r)).error, "no deliverable with id 42");
});

// --- 4. deliv は card の書き込みで消えない --------------------------------------
await check("#82 カードを書き換えても（writeBoard）deliv 行は消えない", async () => {
	const r = await tf(`${BASE}/api/add?${new URLSearchParams({ p: SLUG, text: "新しいカード", col: "todo", sid: SID })}`);
	await ok200(r);
	const stored = readBoardAt(BOARD);
	assert.equal(stored.cards.length, 2, "カードが増えていない");
	assert.equal(stored.deliverables.length, 1, "deliv 行が消えた");
	assert.equal(stored.deliverables[0].text, "直した成果物", "deliv の中身が変わった");
});

// --- 5. payload ---------------------------------------------------------------
await check("#82 /api/kanban の project に deliverables / deliverableCount", async () => {
	const rep = await projectOf();
	assert.equal(rep.deliverableCount, 1, `deliverableCount=${rep.deliverableCount}`);
	assert.equal(rep.deliverables.length, 1);
	assert.deepEqual(Object.keys(rep.deliverables[0]).sort(), ["at", "id", "text"]);
	assert.deepEqual(Object.keys(rep.counts).sort(), ["doing", "done", "todo"], "counts は 3 キーのまま");
	assert.equal(rep.counts.todo, 2, JSON.stringify(rep.counts));
});

await check("#82 /api/dashboard の global.deliverables は sid 付きで全プロジェクト集約", async () => {
	seedBoard(OTHER_BOARD, {
		nextId: 1,
		delivNextId: 5,
		cards: [],
		deliverables: [{ id: 4, text: "他の盤の成果物", at: 7 }],
	});
	const r = await tf(`${BASE}/api/dashboard`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const d = await json(r);
	const list = d.global.deliverables;
	assert.ok(Array.isArray(list), "global.deliverables が無い");
	const mine = list.filter((x) => x.sid === SLUG);
	const theirs = list.filter((x) => x.sid === OTHER);
	assert.equal(mine.length, 1, JSON.stringify(list));
	assert.equal(theirs.length, 1, JSON.stringify(list));
	assert.equal(theirs[0].text, "他の盤の成果物");
	assert.equal(theirs[0].id, 4);
	assert.equal(d.global.cards.filter((c) => c.col === "deliverable").length, 0, "global.cards に旧 col が混ざった");
});

// --- 6. 添付（deliv= ターゲット） -----------------------------------------------
const upload = (params, body) =>
	tf(`${BASE}/api/upload?${new URLSearchParams({ p: SLUG, ...params })}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body,
	});

await check("#82 deliv= で添付できる（/api/upload）", async () => {
	const r = await upload({ deliv: "1", ext: "png" }, PNG);
	await ok200(r);
	const b = await json(r);
	assert.equal(b.ok, true);
	assert.equal(b.deliverable.id, 1);
	assert.match(b.deliverable.img, /^1-[0-9a-f]{8}\.png$/, `img=${b.deliverable.img}`);
	assert.equal(readBoardAt(BOARD).deliverables[0].img, b.deliverable.img);
});

await check("#82 deliv= の不明 id は 404（新規カードを作らない）", async () => {
	const before = readBoardAt(BOARD).cards.length;
	const up = await upload({ deliv: "77", ext: "png" }, PNG);
	assert.equal(up.status, 404, `upload: status ${up.status}`);
	assert.equal((await json(up)).error, "no deliverable with id 77");
	const up2 = await tf(`${BASE}/api/upload2?${new URLSearchParams({ p: SLUG, deliv: "77", data: "data:image/png;base64,iVBORw0KGgo=" })}`);
	assert.equal(up2.status, 404, `upload2: status ${up2.status}`);
	const del = await get("/api/attach/del", { deliv: "77", n: "0" });
	assert.equal(del.status, 404, `attach/del: status ${del.status}`);
	assert.equal(readBoardAt(BOARD).cards.length, before, "カードが増えた");
});

await check("#82 deliv= で 1 枚だけ外せる（/api/attach/del）", async () => {
	const r = await get("/api/attach/del", { deliv: "1", n: "0" });
	await ok200(r);
	assert.equal((await json(r)).ok, true);
	assert.equal(readBoardAt(BOARD).deliverables[0].img, undefined, "img が残った");
});

// --- 7. id は再発番しない -------------------------------------------------------
await check("#82 remove して add しても id は戻らない（delivNextId）", async () => {
	const rm = await get("/api/deliv/remove", { id: "1" });
	assert.equal(rm.status, 200, `remove: status ${rm.status}`);
	assert.equal((await json(rm)).ok, true);
	assert.equal(readBoardAt(BOARD).deliverables.length, 0, "行が消えていない");
	const add = await get("/api/deliv/add", { text: "2 本目" });
	assert.equal(add.status, 200, `add: status ${add.status}`);
	assert.equal((await json(add)).deliverable.id, 2, "消した id が再発番された");
	assert.equal(readBoardAt(BOARD).delivNextId, 3);
});

// --- 8. 旧 col 行は移動で退出できる ---------------------------------------------
await check("#82 col=deliverable への move は 400、旧行の退出は通る", async () => {
	seedBoard(BOARD, {
		nextId: 3,
		delivNextId: 3,
		cards: [
			{ id: 1, text: "カード", col: "todo", movedBy: SID, movedAt: 1 },
			{ id: 2, text: "旧形式の成果物", col: "deliverable", movedBy: SID, movedAt: 1 },
		],
		deliverables: [],
	});
	const into = await tf(`${BASE}/api/move?${new URLSearchParams({ p: SLUG, id: "1", col: "deliverable", sid: SID })}`);
	assert.equal(into.status, 400, `status ${into.status}`);
	assert.deepEqual(await json(into), { ok: false, error: "deliverable is not a phase" });
	const out = await tf(`${BASE}/api/move?${new URLSearchParams({ p: SLUG, id: "2", col: "done", sid: SID })}`);
	assert.equal(out.status, 200, `旧行の退出: status ${out.status} ${await out.text()}`);
	assert.equal(readBoardAt(BOARD).cards.find((c) => c.id === 2).col, "done");
});

if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-deliv-store)`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
