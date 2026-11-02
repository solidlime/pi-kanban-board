// Phase 0: カードの「プロジェクト次元」(Card.project = slug)。
// フレームワーク無しで `node tests/kanban-project.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// 契約: project は書き込み境界で normalizeProject を通す（大小は保つ・[A-Za-z0-9._-] 以外除去・24 文字）。
// 空 = 無所属 = キーごと削除。ループ（autoPick / 注入）には一切影響しない。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-project-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
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
const PORT = process.env.KANBAN_PORT;
const BASE = `http://127.0.0.1:${PORT}`;

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ??
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
const flush = () => new Promise((r) => setImmediate(r));

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

const SID = "proj-session";
const KANBAN = `${HOME_DIR}/.pi/kanban`;
// ツールの書き込み先: 既定 scope=project はこのプロセスの cwd の slug。
const PROJ_BOARD = `${KANBAN}/projects/${mod.projectSlugOf(process.cwd())}.json`;
const boardOf = () => readBoardAt(PROJ_BOARD);
const cardNamed = (text) => boardOf().cards.find((c) => c.text === text);

// --- 1. 純関数 -----------------------------------------------------------------
await check("normalizeProject: trim / 大小保持 / 不正文字除去 / 24 文字切捨て / 非文字列は \"\"", () => {
	assert.equal(mod.PROJECT_MAX, 24);
	assert.equal(mod.normalizeProject("  Foo  "), "Foo");
	assert.equal(mod.normalizeProject("My Project!!/../x"), "MyProject..x");
	assert.equal(mod.normalizeProject("Mixed_Case.9-x"), "Mixed_Case.9-x");
	assert.equal(mod.normalizeProject("a".repeat(30)), "a".repeat(24));
	assert.equal(mod.normalizeProject("日本語"), "");
	for (const v of [undefined, null, 42, {}, [], true]) {
		assert.equal(mod.normalizeProject(v), "", `${JSON.stringify(v)} が空にならない`);
	}
});

// --- 2. 書き込み経路（HTTP） -----------------------------------------------------

await check("/api/add?project=Foo → ボードに project: \"Foo\"（大小を保つ）", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=with+project&project=Foo`);
	assert.equal(r.status, 200);
	assert.equal(cardNamed("with project").project, "Foo");
});

await check("/api/add（project なし）→ project キーが存在しない（後方互換）", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=no+project`);
	assert.equal(r.status, 200);
	const c = cardNamed("no project");
	assert.ok(!("project" in c), "project キーが生えた");
});

const fooId = () => cardNamed("with project").id;

await check("/api/schedule?id&project=bar → 設定できる（at/blocked なしでも 400 にしない）", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${fooId()}&project=bar`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.equal(cardNamed("with project").project, "bar");
});

await check("/api/add?project=<正規化不能> → 400（無言で捨てない）", async () => {
	const r = await tf(BASE + "/api/add?scope=project&text=bad+slug&project=" + encodeURIComponent("日本語"));
	assert.equal(r.status, 400, "status " + r.status);
	assert.match(String((await r.json()).error ?? ""), /project/, "400 の理由が project でない");
	assert.equal(cardNamed("bad slug"), undefined, "不正 project のカードが作られた");
});

await check("/api/schedule?project=<空白のみ> → 400 かつラベルは消えない", async () => {
	const id = cardNamed("with project").id;
	const before = cardNamed("with project").project;
	const r = await tf(BASE + "/api/schedule?scope=project&id=" + id + "&project=" + encodeURIComponent("   "));
	assert.equal(r.status, 400, "status " + r.status);
	assert.equal(cardNamed("with project").project, before, "400 なのにラベルが消えた");
});

await check("?fields=project → project だけが返る", async () => {
	const r = await tf(`${BASE}/api/kanban?scope=project&fields=project`);
	assert.equal(r.status, 200);
	const j = await r.json();
	const withP = j.project.cards.filter((c) => c.project === "bar");
	assert.equal(withP.length, 1, "project が射影から落ちている");
	assert.deepEqual(Object.keys(withP[0]), ["project"], "射影が project 以外も返している");
	assert.equal(j.project.cards.length, boardOf().cards.length, "射影でカードが減った");
});

await check("/api/schedule?project=（空）→ project キーが消える", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${fooId()}&project=`);
	assert.equal(r.status, 200);
	assert.ok(!("project" in cardNamed("with project")), "空指定で project が残った");
});

	// 400 はディスク書き込みより前に返るので、in-memory の検証順序は HTTP では観測できない。
	// このテストが固定するのは「不正な組み合わせでは at が永続化されない」というディスク状態の契約だけ。
	await check("/api/schedule?at=<有効>&project=<不正> → 400 かつ at が適用されない", async () => {
	const id = fooId();
	const first = await tf(BASE + "/api/schedule?scope=project&id=" + id + "&at=2030-01-01T00:00:00Z");
	assert.equal(first.status, 200, "at だけの設定で status " + first.status);
	const armed = cardNamed("with project").nextFireAt;
	// + must stay encoded: a bare +1h decodes to a space and 400s on "at must be ISO" — that would pass for the wrong reason.
	const r = await tf(BASE + "/api/schedule?scope=project&id=" + id + "&at=2031-01-01T00:00:00Z&project=" + encodeURIComponent("日本語"));
	assert.equal(r.status, 400, "status " + r.status);
	assert.equal(cardNamed("with project").nextFireAt, armed, "400 なのに at が適用された");
});

await check("/api/upload?project=<不正> → 400 かつカードも media も増えない", async () => {
	const cardsBefore = boardOf().cards.length;
	const mediaDir = KANBAN + "/media";
	const mediaBefore = existsSync(mediaDir) ? readdirSync(mediaDir).length : 0;
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	const r = await tf(BASE + "/api/upload?scope=project&ext=png&project=" + encodeURIComponent("日本語"), {
		method: "POST",
		body: png,
		headers: { "content-type": "image/png" },
	});
	assert.equal(r.status, 400, "status " + r.status);
	assert.match(String((await r.json()).error ?? ""), /project/, "400 の理由が project でない");
	assert.equal(boardOf().cards.length, cardsBefore, "400 なのにカードが増えた");
	assert.equal(existsSync(mediaDir) ? readdirSync(mediaDir).length : 0, mediaBefore, "400 なのに media が増えた");
});

await check("project 無しの既存カードが混ざったボードが壊れない", async () => {
	// 別リポジトリ（兄弟の project ボード）に古いカードを置く。このプロセスのボードは見ないが、
	// GLOBAL 集約とダッシュボードはそれを読む。
	const legacy = { cards: [{ id: 1, text: "legacy", col: "todo", movedBy: "old" }], nextId: 2 };
	seedBoard(`${KANBAN}/projects/legacy-session.json`, legacy);
	const r = await tf(`${BASE}/api/kanban?scope=project`);
	assert.equal(r.status, 200);
	const j = await r.json();
	const g = j.global.cards.find((c) => c.text === "legacy");
	assert.ok(g, "GLOBAL 集約に旧カードが出ていない");
	assert.ok(!("project" in g), "legacy カードに project が生えた");
	assert.equal(g.sid, "legacy-session", "集約が由来プロジェクトを名乗っていない");
	// ダッシュボード側の集計も落ちない（project を読むのは表示だけ）
	const dash = await tf(`${BASE}/api/dashboard`);
	assert.equal(dash.status, 200);
});


await check("tool add/edit (project scope): project を正規化して付け、text を消さずに付け替えられる", async () => {
	const tool = tools.kanban;
	assert.ok(tool, "kanban tool が登録されていない");
	const ctx = { sessionManager: { getSessionId: () => SID } };
	seedBoard(PROJ_BOARD, { cards: [], nextId: 1 });
	const add = await tool.execute("c1", { action: "add", scope: "project", text: "tool alpha", project: "Gamma" }, null, null, ctx);
	assert.ok(!JSON.stringify(add).includes("error"), JSON.stringify(add).slice(0, 300));
	const gb = readBoardAt(PROJ_BOARD);
	const card = gb.cards.find((c) => c.text === "tool alpha");
	assert.ok(card, "tool add でカードが作られていない");
	assert.equal(card.project, "Gamma", "tool add が project を正規化していない");
	const edit = await tool.execute("c2", { action: "edit", scope: "project", id: card.id, project: "delta" }, null, null, ctx);
	assert.ok(!JSON.stringify(edit).includes("error"), JSON.stringify(edit).slice(0, 300));
	const after = readBoardAt(PROJ_BOARD).cards.find((c) => c.id === card.id);
	assert.equal(after.project, "delta", "tool edit で付け替えられない");
	assert.equal(after.text, "tool alpha", "project だけの edit で text が消えた");
});

await check("tool add/edit (project scope): 正規化不能な project は fail（無言で無視しない）", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const count = () => readBoardAt(PROJ_BOARD).cards.length;
	const before = count();
	const add = await tool.execute("c3", { action: "add", scope: "project", text: "bad tool", project: "日本語" }, null, null, ctx);
	assert.equal(add.isError, true, "fail なのに isError でない: " + JSON.stringify(add).slice(0, 200));
	assert.ok(JSON.stringify(add).includes("must match"), "理由が返っていない");
	assert.equal(count(), before, "fail なのにカードが増えた");
});

// D5: global は読み取り専用の集約ビュー。ツール経由でも書き込みは通さない（HTTP は 400）。
await check("tool add scope=global は読み取り専用で fail", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const before = readBoardAt(KANBAN + "/global.json").cards.length;
	const add = await tool.execute("c4", { action: "add", scope: "global", text: "must not land" }, null, null, ctx);
	assert.equal(add.isError, true, "fail なのに isError でない: " + JSON.stringify(add).slice(0, 200));
	assert.ok(JSON.stringify(add).includes("read-only"), "理由が read-only でない: " + JSON.stringify(add).slice(0, 200));
	assert.equal(readBoardAt(KANBAN + "/global.json").cards.length, before, "fail なのに global に書けた");
});

// --- 3. ダッシュボード / 4. ブラウザ側 vm ---------------------------------------
// v2.5（#42）でプロジェクトの絞り込みは <select id="proj"> からタブ（#ptabs）へ移り、
// 旧 select / projPick / uiSig / clampable を前提にした vm 走査は対象を失った。
// タブ遷移と ?p= の再取得は tests/kanban-dashboard-v2.test.mjs と kanban-slug-case が見る。

// --- 結果 -----------------------------------------------------------------------
if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-project)`);
// サーバは extension のプロセス内で listen したまま。テストは終わったので明示的に落とす。
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
