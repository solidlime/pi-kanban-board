// #29 タブ式ダッシュボードの自己検証 (#011, #36 で再構成)。
// フレームワーク無しで `node tests/kanban-dashboard-tabs.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-tabs-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
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

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));

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
const flush = () => new Promise((r) => setImmediate(r));

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

const html = await (await tf(`${BASE}/`)).text();
// ホスト名は実行環境で変わる: テンプレート埋め込みではなく生成時に置換される。
const HOST = hostname();

// --- 1. 文字列レベル: 2 タブ + 2 ペイン（#36: エージェントタブ廃止） -----------
check("タブは2つ（セッション/配信サーバー）でエージェントタブは無い", () => {
	for (const [id, label] of [
		["tab-sessions", "セッション"],
		["tab-serve", "配信サーバー"],
	]) {
		assert.ok(html.includes(`id="${id}"`), `${id} が無い`);
		assert.ok(new RegExp(`id="${id}"[^>]*>${label}<`).test(html), `${label} ラベルが無い`);
	}
	assert.ok(!html.includes("tab-agents"), "tab-agents が残っている");
	assert.ok(!html.includes("pane-agents"), "pane-agents が残っている");
	assert.equal((html.match(/role="tab"/g) || []).length, 2);
	assert.ok(html.includes('role="tablist"'));
});

check("タイトルは KANBAN - <マシン名>（title と h1 両方）", () => {
	assert.ok(html.includes(`<title>KANBAN - ${HOST}</title>`), "<title> にホスト名が無い");
	assert.ok(html.includes(`KANBAN - ${HOST} <span id="conn"`), "h1 にホスト名が無い");
	// 出力は既に置換済みなので、ここで見えるのは "KANBAN - <HOST>" のみ
	assert.ok(!html.includes("KANBAN DASHBOARD"), "旧タイトルが残っている");
});

check("タブは button で、ペインを hidden で切り替える（遷移しない）", () => {
	assert.equal((html.match(/<button class="tab/g) || []).length, 2);
	for (const id of ["pane-sessions", "pane-serve"]) {
		assert.ok(html.includes(`id="${id}"`), `${id} が無い`);
	}
	// 初期表示はセッションだけ。他は hidden。
	assert.doesNotMatch(html, /id="pane-sessions"[^>]*hidden/);
	assert.match(html, /id="pane-serve"[^>]*hidden/);
	assert.ok(html.includes(".pane[hidden]{display:none}"));
});

check("GLOBAL 看板はセッションタブの先頭にある", () => {
	const pane = html.slice(html.indexOf('id="pane-sessions"'), html.indexOf('id="pane-serve"'));
	assert.ok(pane.includes('id="global"'), "pane-sessions に global が無い");
	assert.ok(pane.includes('id="sessions"'), "pane-sessions に sessions が無い");
	assert.ok(pane.indexOf('id="global"') < pane.indexOf('id="sessions"'), "GLOBAL が先頭でない");
});

check("#36: STATS はセッションペインの上部（GLOBAL より上）に移動している", () => {
	const pane = html.slice(html.indexOf('id="pane-sessions"'), html.indexOf('id="pane-serve"'));
	assert.ok(pane.includes('id="statsec"'), "pane-sessions に statsec が無い");
	assert.ok(pane.indexOf('id="statsec"') < pane.indexOf('id="global"'), "STATS が GLOBAL より上に無い");
	assert.ok(pane.includes('id="stats"'), "stats 領域が無い");
});

check("既存要素は消えていない（stats/serve/conn/banner/theme）", () => {
	for (const id of [
		'id="stats"',
		'id="serve"',
		'id="sessions"',
		'id="global"',
		'id="conn"',
		'id="banner"',
		'id="theme"',
	]) {
		assert.ok(html.includes(id), `${id} が消えている`);
	}
});

check("activeTab を保持し、render() が復元する", () => {
	assert.ok(html.includes('var activeTab = "sessions"'));
	assert.match(html, /function selectTab\(name\)/);
	assert.match(html, /selectTab\(activeTab\);\s*\/\/ a poll re-render/);
});

check("タブは常に上部の横並び（#50 でサイドバー廃止）", () => {
	// #50 以前は .dash が row + .tabs が縦カラムで、640px 以下だけ column に切り替える形だった。
	// 今はベースが column でタブは常に横並びなので、メディアクエリではなくベースを見る。
	assert.match(html, /\.dash\{display:flex;flex-direction:column/);
	assert.match(html, /\.tabs\{display:flex;flex-direction:row/);
	assert.match(html, /@media \(max-width:640px\)\{/);
	const mq = html.slice(html.indexOf("@media (max-width:640px)"));
	assert.match(mq, /\.tabs\{flex-direction:row/);
});

check("tf( は 1 箇所のみ（#30/#31 の書き込みも共通の api() を通る）", () => {
	assert.equal((html.match(/\bfetch\(/g) || []).length, 1);
	assert.ok(html.includes("api(API)"), "ポーリングは api(API) を通る");
	assert.ok(html.includes("return fetch(u"), "唯一の fetch は api() の中");
});

// --- 2. ブラウザ側 JS を vm で走らせて挙動を確認 -----------------------------
{
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	check("dashboard のポーリング JS を抽出できる", () => assert.ok(apiScript));

	const makeEl = () => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			innerHTML: "",
			textContent: "",
			title: "",
			href: "",
			target: "",
			rel: "",
			style: {},
			dataset: {},
			_lis: {},
			_attrs: {},
			appendChild(c) {
				e.children.push(c);
				return c;
			},
			setAttribute(k, v) {
				e._attrs[k] = String(v);
			},
			getAttribute(k) {
				return k in e._attrs ? e._attrs[k] : null;
			},
			addEventListener(t, fn) {
				(e._lis[t] = e._lis[t] || []).push(fn);
			},
			removeEventListener() {},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		};
		return e;
	};
	const byId = {};
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = makeEl()),
		createElement: () => makeEl(),
		documentElement: makeEl(),
	};
	const hasText = (node, txt) =>
		!!node && (node.textContent === txt || node.children.some((c) => hasText(c, txt)));
	// 1 回目は全 0（#36: STATS ブロックごと畳む）、2 回目は todo>0（畳み解除）。
	const payload = (todo) => ({
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: 1, active: 1, todo, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo, doing: 0, done: 0 }, cards: [] },
		sessions: [
			{
				id: "s1",
				name: "kotomi",
				cwd: "/tmp",
				isActive: true,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: {}, global: {} },
				counts: { todo, doing: 0, done: 0 },
				cards: [],
			},
		],
		serve: [],
	});
	let call = 0;
	const timers = [];
	let nextId = 1;
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: () =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(payload(call++ === 0 ? 0 : 2)),
			}),
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.push({ id, fn, ms });
			return id;
		},
		clearTimeout(id) {
			const i = timers.findIndex((t) => t.id === id);
			if (i >= 0) timers.splice(i, 1);
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);

	// 初回 reload() の fetch を解決させる
	for (let i = 0; i < 4; i++) await flush();

	check("初期表示はセッションタブ（serve は hidden）", () => {
		assert.equal(byId["pane-sessions"].hidden, false);
		assert.equal(byId["pane-serve"].hidden, true);
		assert.equal(byId["tab-sessions"].className, "tab active");
		assert.equal(byId["tab-sessions"].getAttribute("aria-selected"), "true");
	});

	check("#36: 全 0 のときは STATS ブロックごと畳む", () => {
		assert.equal(byId["statsec"].hidden, true);
	});

	check("セッション（kotomi）は sessions タブ内に描画される", () => {
		assert.ok(hasText(byId["sessions"], "kotomi"), "kotomi セッションが描画されていない");
	});

	check("クリックで配信サーバータブに切り替わる（hidden の付け替えだけ）", () => {
		assert.ok(byId["tab-serve"]._lis.click && byId["tab-serve"]._lis.click.length);
		byId["tab-serve"]._lis.click[0]();
		assert.equal(byId["pane-serve"].hidden, false);
		assert.equal(byId["pane-sessions"].hidden, true);
		assert.equal(byId["tab-serve"].className, "tab active");
		assert.equal(byId["tab-sessions"].className, "tab");
	});

	// 再描画の検証だけは await が要るので check() の外で実行する。
	// data が変わる（todo 0→2）ので render() が走る。それでも pane-serve が選択されたまま。
	const polled = timers.shift();
	const pollMs = polled ? polled.ms : -1;
	if (polled) polled.fn();
	for (let i = 0; i < 4; i++) await flush();
	check("5秒ポーリングの再描画後も選択タブ（配信サーバー）が維持される", () => {
		assert.equal(pollMs, 5000);
		assert.equal(byId["pane-serve"].hidden, false);
		assert.equal(byId["pane-sessions"].hidden, true);
		assert.equal(byId["tab-serve"].className, "tab active");
	});
	check("#36: todo>0 になったら STATS ブロックが開く", () => {
		assert.equal(byId["statsec"].hidden, false);
	});
}

// --- 3. writeBoardHtml が出す実ファイル ---------------------------------------
{
	const { readFileSync, existsSync } = await import("node:fs");
	const out = `${HOME_DIR}/.pi/kanban/dashboard.html`;
	await flush();
	check("writeBoardHtml の dashboard.html にタブと既存領域が同居する", () => {
		assert.ok(existsSync(out), `${out} が無い`);
		const disk = readFileSync(out, "utf8");
		for (const id of ["tab-sessions", "tab-serve", "pane-sessions", "pane-serve"]) {
			assert.ok(disk.includes(`id="${id}"`), `${id} が実ファイルに無い`);
		}
		assert.ok(disk.includes(`KANBAN - ${HOST}`), "実ファイルのタイトルにホスト名が無い");
		assert.ok(disk.includes('id="sessions"'), "SESSIONS 領域が無い");
		assert.ok(disk.includes('id="serve"'), "SERVE 領域が無い");
		assert.ok(disk.includes('id="stats"'), "STATS 領域が無い");
	});
}

for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`kanban-dashboard-tabs: ${passed} passed, ${failures.length} failed`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
