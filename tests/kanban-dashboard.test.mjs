// 管理ダッシュボードのバックエンド自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban, removeBoard } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/media`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
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
const PORT = process.env.KANBAN_PORT;
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

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
		if ((await tf(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const card = (id, text, col) => ({ id, text, col });
const writeBoard = (path, cards) =>
	seedBoard(path, { cards, nextId: cards.length + 1 });

// --- 対象データを用意する -----------------------------------------------------
// GLOBAL: todo 2 / doing 1 / done 1
writeBoard(`${KB}/global.json`, [
	card(1, "g-todo-1", "todo"),
	card(2, "g-todo-2", "todo"),
	card(3, "g-doing", "doing"),
	card(4, "g-done", "done"),
]);
// #17: ボードは project だけ。ダッシュボードが見せるのは「このプロセスの project ボード」
// 1 枚と、全 project ボードの集約（global）。cwd の slug は pi-kanban-board。
const PROJECT_PATH = `${KB}/projects/pi-kanban-board.json`;
// 自 project: todo 1 / doing 1
writeBoard(PROJECT_PATH, [
	card(1, "p-todo", "todo"),
	card(2, "p-doing", "doing"),
]);
// 隣の project ボード: done 2（global の集約にだけ出る）
writeBoard(`${KB}/projects/aaaa1111.json`, [
	card(1, "o-done-1", "done"),
	card(2, "o-done-2", "done"),
]);
// media: 2 files + 1 subdir (subdir は数えない)
writeFileSync(`${KB}/media/one.png`, "x");
writeFileSync(`${KB}/media/two.mp4`, "y");
mkdirSync(`${KB}/media/sub`, { recursive: true });
// serve: 生きているパス 1 + 消えたパス 1。exists を区別できること。
const LIVE_PATH = `${HOME_DIR}/workspace`;
const GONE_PATH = `${HOME_DIR}/workspace/gone`;
const LIVE_ID = "0123456789abcdef";
const GONE_ID = "fedcba9876543210";
writeFileSync(
	`${KB}/serve.json`,
	JSON.stringify({
		entries: [
			{ id: LIVE_ID, path: LIVE_PATH, title: "配信テスト用", createdAt: "2026-01-02T03:04:05.000Z" },
			{ id: GONE_ID, path: GONE_PATH },
		],
	}),
);

// --- 1. レスポンス形 ----------------------------------------------------------
const res = await tf(`${BASE}/api/dashboard`);
const data = await res.json();

check("200 + application/json", () => {
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});
// #68: ACAO is decided per caller now, so the wildcard is gone. A request without an
// Origin has no one to allow — the header must be absent, not "*" and not "null".
check("Origin 無しのリクエストには ACAO を付けない", () =>
	assert.equal(res.headers.get("access-control-allow-origin"), null));
check("Origin 無しでも Allow-Methods / Allow-Headers は従来どおり", () => {
	assert.match(res.headers.get("access-control-allow-methods") ?? "", /GET, POST/);
	assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type");
});
{
	const same = await tf(`${BASE}/api/dashboard`, { headers: { Origin: BASE } });
	check("same-host の Origin は reflect する", () => {
		assert.equal(same.headers.get("access-control-allow-origin"), BASE);
		assert.match(same.headers.get("vary") ?? "", /Origin/i);
	});
}
{
	const evil = await tf(`${BASE}/api/dashboard`, { headers: { Origin: "http://evil.example" } });
	check("別ホストの Origin には ACAO を付けない", () => {
		assert.equal(evil.headers.get("access-control-allow-origin"), null);
	});
}
check("host は非空文字列", () => {
	assert.equal(typeof data.host, "string");
	assert.ok(data.host.length > 0, `host=${data.host}`);
});
check("now は ISO 8601", () => {
	assert.equal(typeof data.now, "string");
	assert.ok(!Number.isNaN(Date.parse(data.now)), data.now);
});
check("stats は 5 キーだけ（sessions / active は消えた）", () => {
	assert.deepEqual(Object.keys(data.stats).sort(), ["doing", "done", "media", "serve", "todo"]);
	for (const k of Object.keys(data.stats)) assert.equal(typeof data.stats[k], "number", `stats.${k}`);
});
check("global は counts と cards（GLOBAL 残行 + 全 project ボードの集約）", () => {
	assert.deepEqual(data.global.counts, { todo: 3, doing: 2, done: 3 });
	assert.equal(data.global.cards.length, 8);
});
check("project / global が必要キーを持ち、session 系のキーは無い", () => {
	assert.equal("sessions" in data, false, "sessions が残っている");
	assert.equal("sessionId" in data, false, "sessionId が残っている");
	for (const [name, board] of [["project", data.project], ["global", data.global]]) {
		for (const k of ["counts", "cards", "modes", "loops", "halted"]) {
			assert.ok(k in board, `${name} に ${k} が無い`);
		}
		assert.equal(typeof board.loops, "number", `${name}.loops`);
		assert.equal(typeof board.halted, "boolean", `${name}.halted`);
		assert.deepEqual(Object.keys(board.counts).sort(), ["doing", "done", "todo"]);
		assert.ok(Array.isArray(board.cards));
		// #17: modes はボード 1 枚分のフラットな ModePair（入れ子の session/global は無い）。
		for (const k of ["doingLoop", "autoPick"]) assert.ok(k in board.modes, `${name}.modes.${k}`);
		for (const k of ["session", "global", "project"]) {
			assert.equal(k in board.modes, false, `${name}.modes.${k} が残っている`);
		}
	}
	assert.equal(data.project.id, "pi-kanban-board");
});
check("serve は空でなく配列", () => assert.ok(Array.isArray(data.serve) && data.serve.length === 2));

// --- 2. stats 合算（全セッション + GLOBAL） -----------------------------------
check("stats.todo = 2+1+0", () => assert.equal(data.stats.todo, 3));
check("stats.doing = 1+1+0", () => assert.equal(data.stats.doing, 2));
check("stats.done = 1+0+2", () => assert.equal(data.stats.done, 3));
check("stats.media はファイルのみ数える (subdir 除く)", () => assert.equal(data.stats.media, 2));
check("project.counts は自分のボードのみ（隣のボードは混ざらない）", () => {
	assert.deepEqual(data.project.counts, { todo: 1, doing: 1, done: 0 });
	assert.equal(data.project.cards.length, 2);
});
check("global のカードは sid でボードを名乗る（自ボード + 隣のボード）", () => {
	const slugs = new Set(data.global.cards.map((c) => c.sid));
	assert.ok(slugs.has(""), "GLOBAL 残行の sid が空でない");
	assert.ok(slugs.has("aaaa1111"), "隣の project ボードのカードが集約に無い");
	assert.ok(slugs.has("pi-kanban-board"), "自 project ボードのカードが集約に無い");
});

// --- 3. serve 一覧 + 存在しないパス ------------------------------------------
check("stats.serve = 登録数", () => assert.equal(data.stats.serve, 2));

// --- #11: 設定タブの保存データ（db）/ ---
check("db はファイル名・サイズ・件数を返す", () => {
	assert.ok(data.db, "db が無い");
	assert.equal(data.db.file, "boards.sqlite");
	assert.equal(typeof data.db.bytes, "number");
	assert.ok(data.db.bytes > 0, `bytes=${data.db.bytes}`);
	assert.equal(data.db.cards, data.stats.todo + data.stats.doing + data.stats.done);
	assert.ok(data.db.boards >= 1, `boards=${data.db.boards}`);
	assert.equal(typeof data.db.projects, "number");
	assert.equal(typeof data.db.decisions, "number");
});
check("db に絶対パスを載せない (#80-⑦)", () =>
	assert.ok(!JSON.stringify(data.db).includes(HOME_DIR), "db に絶対パスが漏れている"));
check("exists=true のエントリ", () => {
	const e = data.serve.find((x) => x.id === LIVE_ID);
	assert.ok(e, "live entry が無い");
	// #80-⑦: 以前は絶対パス (e.path) を payload に載せていた。同一ホスト別ポートのページが
	// 「列挙して取得」の2リクエストで済むので、いまは name（最終セグメント）だけを返す。
	// 意図（サーバのファイル構造を外部に見せない）を固定するために反転させている。
	assert.equal(e.path, undefined, "絶対パスが payload に戻っている");
	assert.equal(e.name, "workspace");
	assert.equal(e.exists, true);
	assert.match(e.url, new RegExp(`/serve/${LIVE_ID}/$`));
	assert.match(e.url, /^https?:\/\//);
	assert.equal(e.createdAt, "2026-01-02T03:04:05.000Z");
	// #50: エージェントが付けた表示名が payload に乗る
	assert.equal(e.title, "配信テスト用");
});
check("一覧の応答本文に絶対パスが含まれない (#80-⑦)", () =>
	assert.ok(!JSON.stringify(data.serve).includes(HOME_DIR), "serve 一覧に絶対パスが漏れている"));
check("exists=false のエントリも一覧に残る", () => {
	const e = data.serve.find((x) => x.id === GONE_ID);
	assert.ok(e, "gone entry が消えている");
	assert.equal(e.path, undefined);
	assert.equal(e.name, "gone"); // 存在しなくても最後のセグメントは出る
	assert.equal(e.exists, false);
	assert.equal(typeof e.createdAt, "string");
	assert.equal(e.createdAt, "");
	// #50: title 未設定は空文字（undefined ではなく）で返す
	assert.equal(e.title, "");
});

// --- 4. / は DASHBOARD_HTML を返す -------------------------------------------
{
	const root = await tf(`${BASE}/`);
	const html = await root.text();
	check("GET / = 200 text/html", () => {
		assert.equal(root.status, 200);
		assert.match(root.headers.get("content-type") ?? "", /text\/html; charset=utf-8/);
		assert.match(html, /^<!doctype html>/i);
	});
	check("GET / は /api/dashboard を参照する", () => assert.match(html, /\/api\/dashboard/));
	check("GET / はダッシュボード本体（stats/board/global/serve）", () => {
		for (const id of ['id="stats"', 'id="pane-board"', 'id="global"', 'id="serve"']) {
			assert.ok(html.includes(id), `${id} が無い`);
		}
		// 埋め込み時にバックスラッシュエスケープが二重化されていること。
		assert.ok(html.includes("\\uD83D\\uDDBC"), "サムネイルマーカーのエスケープが壊れている");
	});
}

// --- 4b. 失敗時バックオフ -----------------------------------------------------
{
	const html2 = await (await tf(`${BASE}/`)).text();
	const scripts = [...html2.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	check("dashboard のポーリング JS を抽出できる", () => assert.ok(apiScript));

	const makeEl = () => {
		const e = {
			children: [],
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
			style: {},
			dataset: {},
			appendChild(c) { e.children.push(c); return c; },
			setAttribute() {},
			getAttribute: () => null,
			addEventListener() {},
			removeEventListener() {},
			textContent: "",
			innerHTML: "",
			className: "",
			title: "",
			href: "",
		};
		return e;
	};
	const byId = {};
	const timers = [];
	let nextId = 1;
	const clock = { fail: true };
	const sandbox = {
		document: {
			getElementById: (id) => byId[id] || (byId[id] = makeEl()),
			createElement: () => makeEl(),
			documentElement: makeEl(),
		},
		window: {},
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: () =>
			clock.fail
				? Promise.reject(new Error("down"))
				: Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ stats: {} }) }),
		setTimeout(fn, ms) { const id = nextId++; timers.push({ id, fn, ms }); return id; },
		clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);

	const flush = () => new Promise((r) => setImmediate(r));
	const fire = async () => {
		const t = timers.shift();
		assert.ok(t, "タイマーが予約されていない");
		t.fn();
		await flush();
		return peek();
	};
	const peek = () => timers[0] && timers[0].ms;

	await flush();
	check("初回失敗 → 1s で再試行", () => assert.equal(peek(), 1000));
	const seq = [await fire(), await fire(), await fire()];
	check("失敗が続くと 2s/4s/8s と倍々", () => assert.deepEqual(seq, [2000, 4000, 8000]));
	let long = 0;
	for (let i = 0; i < 8; i++) long = await fire();
	check("バックオフの上限は 30s", () => assert.equal(long, 30000));
	clock.fail = false;
	await fire();
	check("成功で間隔がリセット (次は通常の 5s)", () => assert.equal(peek(), 5000));
	clock.fail = true;
	await fire();
	check("成功後の失敗は 1s からやり直す", () => assert.equal(peek(), 1000));
}

// --- 5. 全空状態 --------------------------------------------------------------
removeBoard(`${KB}/global.json`);
removeBoard(PROJECT_PATH);
removeBoard(`${KB}/projects/aaaa1111.json`);
rmSync(`${KB}/serve.json`, { force: true });
rmSync(`${KB}/media/one.png`, { force: true });
rmSync(`${KB}/media/two.mp4`, { force: true });
{
	const empty = await (await tf(`${BASE}/api/dashboard`)).json();
	check("空でも配列を返す (null にしない)", () => {
		assert.deepEqual(empty.global.cards, []);
		assert.deepEqual(empty.project.cards, []);
		assert.deepEqual(empty.serve, []);
		assert.deepEqual(empty.global.counts, { todo: 0, doing: 0, done: 0 });
	});
	check("空状態の stats は全て 0", () => {
		assert.deepEqual(empty.stats, {
			todo: 0,
			doing: 0,
			done: 0,
			serve: 0,
			media: 0,
		});
	});
}

// --- 結果 ---------------------------------------------------------------------
console.log(`kanban-dashboard: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
