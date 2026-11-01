// #34 / #35: slug はディレクトリ名を継承する（大小を潰さない）が、照合は大小無視。
// フレームワーク無しで `node tests/kanban-slug-case.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// 契約:
//   - normalizeProject は case を保ち、[A-Za-z0-9._-] 以外だけ落とす
//   - board.sid の照合は COLLATE NOCASE（同じディレクトリが 2 枚のボードに分かれない）
//   - 保存される表記は最初に書いたもの（後から別 case で書いても増えない）
//   - GET /api/kanban?p=<slug> は cwd と無関係にそのボードを返し、不正な p は 400
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-slug-case-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KANBAN = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KANBAN}/sessions`, { recursive: true });
mkdirSync(`${KANBAN}/projects`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
// sessionInfoById() の源泉。 /api/modes は sid の cwd をここから引く。
// PI_CODING_AGENT_DIR があると getAgentDir() が HOME を無視する。
const AGENT_SESSIONS = `${HOME_DIR}/.pi/agent/sessions/encoded-elsewhere`;
mkdirSync(AGENT_SESSIONS, { recursive: true });
delete process.env.PI_CODING_AGENT_DIR;
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

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(
	process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)),
);
useKanban(mod);
// 起動時の scope reset は fire-and-forget。seed より先に消化しないと seed が消されうる。
useMigrate(mod);
await settleMigration();

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

const handlers = new Map();
const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 100; i++) {
	try {
		if ((await tf(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// ボードは boardPath(scope, sid) と同じ形で置く（sid = basename なので case がそのまま残る）。
const mixedPath = `${KANBAN}/projects/Pi-Kanban-Board.json`;
const lowerPath = `${KANBAN}/projects/pi-kanban-board.json`;
const CARDS = [
	{ id: 1, text: "one", col: "todo" },
	{ id: 2, text: "two", col: "doing" },
	{ id: 3, text: "three", col: "done" },
];
// #34: modes のキーは保存表記。cwd だけ大文字を混ぜたボードを作る。
// sessionInfoById() は 30 秒キャッシュなので、最初の /api/dashboard より前に置く。
const CASE_STORED = "modes-case-target";
const CASE_SID = "modes-case-sid";
const CASE_CWD = `${HOME_DIR}/Modes-Case-Target`;
writeFileSync(
	`${AGENT_SESSIONS}/${CASE_SID}.jsonl`,
	`${JSON.stringify({ type: "session", version: 3, id: CASE_SID, timestamp: "2026-01-01T00:00:00.000Z", cwd: CASE_CWD })}\n`,
);

// --- 1. 純関数: 大小を保つ ---------------------------------------------------------
await check("normalizeProject は case を保つ（#34）", () => {
	assert.equal(mod.normalizeProject("Pi-Kanban-Board"), "Pi-Kanban-Board");
	assert.equal(mod.normalizeProject("  Foo  "), "Foo");
	assert.equal(mod.normalizeProject("Mixed_Case.9-x"), "Mixed_Case.9-x");
});

await check("normalizeProject は大小以外の不正文字を落とし、24 文字で切る", () => {
	assert.equal(mod.normalizeProject("My Project!"), "MyProject");
	assert.equal(mod.normalizeProject("My Project!!/../x"), "MyProject..x");
	assert.equal(mod.normalizeProject("a".repeat(30)), "a".repeat(mod.PROJECT_MAX));
	assert.equal(mod.normalizeProject("日本語"), "");
	for (const v of [undefined, null, 42, {}, [], true]) {
		assert.equal(mod.normalizeProject(v), "", `${JSON.stringify(v)} が空にならない`);
	}
});

// --- 2. NOCASE 往復 -----------------------------------------------------------------
await check("大小違いの slug で書いても読める（NOCASE 往復）", () => {
	seedBoard(mixedPath, { cards: CARDS, nextId: 4 });
	const back = readBoardAt(lowerPath);
	assert.equal(back.cards.length, 3);
	assert.deepEqual(
		back.cards.map((c) => c.text),
		["one", "two", "three"],
	);
	// 逆方向（小文字で書いたボードを大文字で読む）
	seedBoard(`${KANBAN}/projects/Other-Board.json`, { cards: [{ id: 5, text: "other", col: "todo" }], nextId: 6 });
	assert.deepEqual(
		readBoardAt(`${KANBAN}/projects/OTHER-BOARD.json`).cards.map((c) => c.text),
		["other"],
	);
});

await check("別 case で書いても同じボードを更新し、保存表記は最初のまま", () => {
	seedBoard(lowerPath, { cards: [CARDS[0]], nextId: 9 });
	// 混在 case で書いた内容が、混在 case で読み戻せる（1 枚に減っている = 同じ行を更新した）
	assert.equal(readBoardAt(mixedPath).cards.length, 1);
	assert.equal(readBoardAt(lowerPath).cards.length, 1);
});

await check("listProjectBoards に大小違いの重複が出ない", async () => {
	// 別 case で書いた board は 1 行しか無いので、列挙も 1 件でなければならない。
	const d = await (await tf(`${BASE}/api/dashboard`)).json();
	const sids = (d.global.cards || []).map((c) => c.sid).filter((s) => typeof s === "string" && s !== "");
	const want = sids.filter((s) => s.toLowerCase() === "pi-kanban-board");
	assert.equal(want.length, 1, `大小違いが ${want.length} 件: ${JSON.stringify(want)}`);
	assert.equal(want[0], "Pi-Kanban-Board"); // 最初に書いた表記が残る
	assert.equal(sids.filter((s) => s.toLowerCase() === "other-board").length, 1);
});

// --- 3. GET /api/kanban?p=<slug>（#35） ---------------------------------------------
await check("?p=<slug> は cwd と無関係にそのボードを返す", async () => {
	const r = await tf(`${BASE}/api/kanban?p=pi-kanban-board`);
	assert.equal(r.status, 200);
	const d = await r.json();
	assert.equal(d.ok, true);
	assert.equal(d.projectId, "Pi-Kanban-Board"); // 入力表記ではなく保存表記（#36）
	assert.equal(d.project.cards.length, 1);
});

await check("?p= は大小無視で同じボードを返す（NOCASE）", async () => {
	const lower = await (await tf(`${BASE}/api/kanban?p=pi-kanban-board`)).json();
	const mixed = await (await tf(`${BASE}/api/kanban?p=Pi-Kanban-Board`)).json();
	assert.deepEqual(
		mixed.project.cards.map((c) => c.id),
		lower.project.cards.map((c) => c.id),
	);
});

// #36: projectId は入力表記ではなくボードの保存表記。UI はこれを global.cards[].sid と
// 突き合わせるので、両者が同じ文字列でなければボードを選んでもカードが「該当なし」になる。
await check("?p= は大小どちらの表記でも保存表記の projectId を返し、card.sid と一致する", async () => {
	const lower = await (await tf(`${BASE}/api/kanban?p=pi-kanban-board`)).json();
	const mixed = await (await tf(`${BASE}/api/kanban?p=Pi-Kanban-Board`)).json();
	assert.equal(lower.projectId, mixed.projectId, "大小で projectId が変わる");
	assert.equal(lower.projectId, "Pi-Kanban-Board");
	const d = await (await tf(`${BASE}/api/dashboard`)).json();
	const sids = (d.global.cards || []).map((c) => c.sid);
	assert.ok(sids.includes(lower.projectId), `projectId が card.sid に無い: ${JSON.stringify(sids)}`);
});

await check("?p=!! は 400（黙って cwd に落ちない）", async () => {
	const r = await tf(`${BASE}/api/kanban?p=!!`);
	assert.equal(r.status, 400);
	const d = await r.json();
	assert.equal(d.ok, false);
	assert.match(d.error, /p must match/);
});

await check("?p= が空文字なら従来どおり cwd 解決（200）", async () => {
	const r = await tf(`${BASE}/api/kanban?p=`);
	assert.equal(r.status, 200);
	const d = await r.json();
	assert.equal(d.projectId.toLowerCase(), mod.projectSlugOf(process.cwd()).toLowerCase());
});

// --- 4. UI のプロジェクト選択が slug を拾える形で返っている -------------------------
// ダッシュボードの syncProjOptions()/projOk() は card.sid を見て slug を選ぶ。
// API が card.sid を落とすと選択肢が「全部/(無所属)」だけに戻り、ボードを選んでも
// 全カードが「該当なし」になる（ブラウザ実機で踏んだ回帰）。
await check("global.cards の各カードが sid を持つ（UI の選択肢の源）", async () => {
	const d = await (await tf(`${BASE}/api/dashboard`)).json();
	const cards = (d.global && d.global.cards) || [];
	assert.ok(cards.length > 0, "global.cards が空");
	for (const c of cards) {
		assert.equal(typeof c.sid, "string", "sid の無いカード: " + JSON.stringify(c));
		assert.notEqual(c.sid, "");
	}
});

await check("?p= で選んだボードのカードは sid を持たない（global 側で引き当てる）", async () => {
	const d = await (await tf(`${BASE}/api/kanban?p=Other-Board`)).json();
	assert.equal(d.projectId, "Other-Board");
	assert.equal(d.project.cards.length, 1);
	assert.equal(d.project.cards[0].project, undefined);
});

// --- 5. modes のキーは保存表記（ループの読み = GUI の書き #34/#36） ------------------
// modes.json は JS のオブジェクトなので大小を区別するが、DB の sid 照合は COLLATE NOCASE。
// 既存のボードは保存表記で seed しているので、cwd 表記とのズレはここでしか作れない。
await check("保存表記と cwd 表記が違っても modes は保存表記のキーに 1 つだけ載り、footer の読みも同じキーを引く", async () => {
	const storedKey = CASE_STORED;
	const cwdDir = CASE_CWD;
	const SID = CASE_SID;
	seedBoard(`${KANBAN}/projects/${storedKey}.json`, { cards: [{ id: 1, text: "s", col: "todo" }], nextId: 2 });
	assert.equal(mod.projectSlugOf(cwdDir), "Modes-Case-Target", "cwd 表記が保存表記と同じになっている");
	// キャッシュを温める（sid の既知判定はここを見る）。
	assert.equal((await tf(`${BASE}/api/dashboard`)).status, 200);
	const r = await tf(`${BASE}/api/modes?scope=project&sid=${SID}&key=doingLoop&value=off`);
	assert.equal(r.status, 200);
	const keys = Object.keys(JSON.parse(readFileSync(`${KANBAN}/modes.json`, "utf8")).PROJECT ?? {}).filter(
		(k) => k.toLowerCase() === storedKey,
	);
	assert.deepEqual(keys, [storedKey], `modes.json のキーが保存表記でない: ${JSON.stringify(keys)}`);
	// 読み手: session_start -> refresh() は boardKeyFor でキーを決める（poll と同じ規則）。
	let footer = null;
	handlers.get("session_start")(
		{},
		{
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify() {},
				setWidget(_key, lines) {
					footer = lines[1];
				},
			},
			sessionManager: { getSessionId: () => SID, getCwd: () => cwdDir, getEntries: () => [] },
		},
	);
	assert.match(String(footer), /^PROJECT: modes-case-target: /, `footer が保存表記のボードを引いていない: ${footer}`);	assert.ok(!/ loop\b/.test(String(footer)), `OFF にしたループが footer で ON のまま: ${footer}`);
	// ダッシュボードも同じキーを読む（project.id は ?p= の projectId と同じ表記）。
	const d = await (await tf(`${BASE}/api/dashboard`)).json();
	assert.equal(d.project.id, storedKey);
	assert.equal(d.project.modes.doingLoop, false);
});

// /api/maxloops だけが cwd 表記（projectKeyOfWrite）で書いていた。読み手の poll / ダッシュボードは
// boardKeyFor = 保存表記を引くので、cwd と保存表記が違うボードでは上限が効かなかった（#34）。
await check("/api/maxloops も modes のキーを保存表記に寄せる（読み手と同じキーに載る）", async () => {
	const storedKey = CASE_STORED;
	const r = await tf(`${BASE}/api/maxloops?scope=project&sid=${CASE_SID}&n=4`);
	assert.equal(r.status, 200);
	const PROJ = JSON.parse(readFileSync(`${KANBAN}/modes.json`, "utf8")).PROJECT ?? {};
	const keys = Object.keys(PROJ).filter((k) => k.toLowerCase() === storedKey);
	assert.deepEqual(keys, [storedKey], `modes.json のキーが保存表記でない: ${JSON.stringify(keys)}`);
	assert.equal(PROJ[storedKey].maxLoops, 4);
});

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`passed=${passed} failed=${failures.length}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
