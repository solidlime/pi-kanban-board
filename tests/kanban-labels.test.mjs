// #22: カードのラベル（bug / feature / chore / 調査）。
// フレームワーク無しで `node tests/kanban-labels.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// 契約: 語彙は固定 4 種。書き込み境界で照合し、未知の語は 400（黙って捨てない）。
// null / "" は「何も指定しない」、空白のみ（" "）は typo なので 400（#20 の ?commit=%20%20 の轍）。
// /api/schedule は全置換（labels=bug で 調査 が消える）。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-labels-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = HOME_DIR;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);
const PORT = process.env.KANBAN_PORT;
const BASE = `http://127.0.0.1:${PORT}`;

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(
	process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)),
);
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

const tools = {};
const pi = {
	registerCommand() {},
	registerTool(t) {
		tools[t.name] = t;
	},
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

const SID = "labels-session";
const KANBAN = `${HOME_DIR}/.pi/kanban`;
const PROJ_BOARD = `${KANBAN}/projects/${mod.projectSlugOf(process.cwd())}.json`;
const boardOf = () => readBoardAt(PROJ_BOARD);
const cardNamed = (text) => boardOf().cards.find((c) => c.text === text);

// --- 1. 純関数 -----------------------------------------------------------------
await check("parseLabels: 語彙・trim・重複・空・空白のみ", () => {
	assert.deepEqual(mod.LABELS, ["bug", "feature", "chore", "調査"]);
	assert.deepEqual(mod.parseLabels("bug,調査"), ["bug", "調査"]);
	assert.deepEqual(mod.parseLabels("bug,bug"), ["bug"]);
	// trim してから照合する（?labels=%20bug%20 は bug）
	assert.deepEqual(mod.parseLabels("  bug  "), ["bug"]);
	assert.deepEqual(mod.parseLabels("bug , 調査"), ["bug", "調査"]);
	// null / "" は「指定なし」
	assert.deepEqual(mod.parseLabels(null), []);
	assert.deepEqual(mod.parseLabels(""), []);
	// 空白のみは typo（#20 の ?commit=%20%20）
	assert.equal(mod.parseLabels("  "), null);
	// 未知の語・空要素は reject
	assert.equal(mod.parseLabels("BOGUS"), null);
	assert.equal(mod.parseLabels("bug,nope"), null);
	assert.equal(mod.parseLabels("bug,"), null);
});

// --- 2. 書き込み経路（HTTP） -----------------------------------------------------

await check("/api/add?labels=bug,調査 → 2 つ付き、順序が保たれる", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=two+labels&labels=bug,%E8%AA%BF%E6%9F%BB`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.deepEqual(cardNamed("two labels").labels, ["bug", "調査"]);
});

await check("/api/add?labels=BOGUS → 400 かつカードが作られない", async () => {
	const before = boardOf().cards.length;
	const r = await tf(`${BASE}/api/add?scope=project&text=bogus+label&labels=BOGUS`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /labels/, "400 の理由が labels でない");
	assert.equal(boardOf().cards.length, before, "400 なのにカードが増えた");
	assert.equal(cardNamed("bogus label"), undefined, "不正ラベルのカードが作られた");
});

await check("/api/add?labels=（空）→ 400 にならず labels キーが無い", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=no+label&labels=`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.ok(!("labels" in cardNamed("no label")), "空指定で labels が生えた");
});

await check("/api/add?labels=%20 → 400（空白のみは clear ではなく typo）", async () => {
	const before = boardOf().cards.length;
	const r = await tf(`${BASE}/api/add?scope=project&text=blank+label&labels=%20`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.equal(boardOf().cards.length, before, "400 なのにカードが増えた");
});

await check("/api/add?labels=%20bug%20 → trim して bug", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=trim+label&labels=%20bug%20`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.deepEqual(cardNamed("trim label").labels, ["bug"]);
});

await check("/api/add?labels=bug,bug → 重複しない", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=dup+label&labels=bug,bug`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.deepEqual(cardNamed("dup label").labels, ["bug"]);
});

await check("/api/schedule?labels=feature → 全置換（調査 が消える）", async () => {
	const r0 = await tf(`${BASE}/api/add?scope=project&text=replaced&labels=bug,%E8%AA%BF%E6%9F%BB`);
	assert.equal(r0.status, 200);
	const id = cardNamed("replaced").id;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=feature`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.deepEqual(cardNamed("replaced").labels, ["feature"], "全置換になっていない");
});

await check("/api/schedule?labels= → クリア（キーごと消える）", async () => {
	const id = cardNamed("replaced").id;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.ok(!("labels" in cardNamed("replaced")), "空指定で labels が残った");
});

await check("/api/schedule?labels=BOGUS → 400 かつ labels が変わらない", async () => {
	const id = cardNamed("replaced").id;
	await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=chore`);
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=BOGUS`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.deepEqual(cardNamed("replaced").labels, ["chore"], "400 なのに書き換わった");
});

await check("/api/schedule?labels=%20 → 400（空白のみはクリアではない）", async () => {
	const id = cardNamed("replaced").id;
	await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=chore`);
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=%20`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.deepEqual(cardNamed("replaced").labels, ["chore"], "400 なのに書き換わった");
});

await check("/api/schedule: labels も他も無し → 400（必須の言い回しに labels が入る）", async () => {
	const id = cardNamed("replaced").id;
	const before = cardNamed("replaced").labels;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /labels/, "必須の理由に labels が無い");
	assert.deepEqual(cardNamed("replaced").labels, before, "400 なのに書き換わった");
});

await check("/api/schedule?labels=bug,調査（URL エンコード）→ 2 つ付く", async () => {
	const id = cardNamed("replaced").id;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}&labels=bug,%E8%AA%BF%E6%9F%BB`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.deepEqual(cardNamed("replaced").labels, ["bug", "調査"]);
});

await check("/api/schedule?at=（labels なし）→ 200 でラベルは変わらない", async () => {
	// 「未指定」と「不正な値」を同じ null で兼ねると、labels を渡さない全呼び出しが 400 になる。
	const id = cardNamed("replaced").id;
	const before = cardNamed("replaced").labels;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${id}&at=%2B1d`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.deepEqual(cardNamed("replaced").labels, before, "labels を渡していないのに変わった");
});

await check("?fields=id,labels に labels が含まれる（CARD_FIELDS の漏れ検出）", async () => {
	const r = await tf(`${BASE}/api/kanban?scope=project&fields=id,labels`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const cards = (await r.json()).project.cards;
	const c = cards.find((x) => x.id === cardNamed("replaced").id);
	assert.ok(c, "対象カードが fields 応答に無い");
	assert.deepEqual(c.labels, ["bug", "調査"], "?fields= で labels が落ちている");
	assert.deepEqual(Object.keys(c).sort(), ["id", "labels"], "射影が他のキーも返している");
});

// --- 3. ツール -------------------------------------------------------------------
await check("tool add: labels を付けて保存し、formatCard にも出る", async () => {
	const tool = tools.kanban;
	assert.ok(tool, "kanban tool が登録されていない");
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const add = await tool.execute("c1", { action: "add", scope: "project", text: "tool labels", labels: "bug" }, null, null, ctx);
	assert.ok(!add.isError, JSON.stringify(add).slice(0, 300));
	const card = readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool labels");
	assert.ok(card, "tool add でカードが作られていない");
	assert.deepEqual(card.labels, ["bug"]);
	assert.ok(add.content[0].text.includes("bug "), `formatCard に labels が無い: ${add.content[0].text}`);
});

await check("tool add: labels を渡さなければ labels キーが生えない", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const add = await tool.execute("c2", { action: "add", scope: "project", text: "tool no labels" }, null, null, ctx);
	assert.ok(!add.isError, JSON.stringify(add).slice(0, 300));
	assert.ok(!("labels" in readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool no labels")), "labels が生えた");
});

await check("tool edit: labels だけの edit が通り、text は消えない", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const id = readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool labels").id;
	const edit = await tool.execute("c3", { action: "edit", scope: "project", id, labels: "feature,調査" }, null, null, ctx);
	assert.ok(!edit.isError, JSON.stringify(edit).slice(0, 300));
	const after = readBoardAt(PROJ_BOARD).cards.find((c) => c.id === id);
	assert.deepEqual(after.labels, ["feature", "調査"]);
	assert.equal(after.text, "tool labels", "labels だけの edit で text が消えた");
});

await check("tool edit: labels='' は削除、labels=' ' は fail で消えない", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const id = readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool labels").id;
	const blank = await tool.execute("c4", { action: "edit", scope: "project", id, labels: " " }, null, null, ctx);
	assert.equal(blank.isError, true, "空白のみの labels が通った");
	assert.ok(JSON.stringify(blank).includes("labels must be"), "理由が返っていない");
	assert.deepEqual(readBoardAt(PROJ_BOARD).cards.find((c) => c.id === id).labels, ["feature", "調査"], "fail なのに消えた");
	const cleared = await tool.execute("c5", { action: "edit", scope: "project", id, labels: "" }, null, null, ctx);
	assert.ok(!cleared.isError, JSON.stringify(cleared).slice(0, 300));
	assert.ok(!("labels" in readBoardAt(PROJ_BOARD).cards.find((c) => c.id === id)), "空指定で labels が残った");
});

await check("tool add/edit: 未知のラベルは fail（無言で無視しない）", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const before = readBoardAt(PROJ_BOARD).cards.length;
	const add = await tool.execute("c6", { action: "add", scope: "project", text: "bad tool label", labels: "nope" }, null, null, ctx);
	assert.equal(add.isError, true, "fail なのに isError でない");
	assert.ok(JSON.stringify(add).includes("labels must be"), "理由が返っていない");
	assert.equal(readBoardAt(PROJ_BOARD).cards.length, before, "fail なのにカードが増えた");
});

// --- 結果 -----------------------------------------------------------------------
if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-labels)`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
