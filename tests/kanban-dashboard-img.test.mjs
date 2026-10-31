// #53 ダッシュボードのサムネイル描画の自己検証 (#011)。
// DASHBOARD_HTML の画像付きカードが実サムネ（img/video）を出すことを固定する。
// #84: 右パネルのテンプレートは廃止され、この経路の回帰は消えた。
// フレームワーク無しで `node tests/kanban-dashboard-img.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-img-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));

const failures = [];
let passed = 0;
const check = (name, fn) => {
	try {
		const r = fn();
		if (r && typeof r.then === "function")
			return r.then(
				() => {
					passed += 1;
				},
				(err) => {
					failures.push(`${name}: ${err.message}`);
				},
			);
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
	return undefined;
};
const flush = () => new Promise((r) => setImmediate(r));

// --- サーバ起動 (このテスト専用ポート) ----------------------------------------
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
const dashboardHtml = await (await tf(`${BASE}/`)).text();

// --- 最小 DOM（className / classList 連動、parentNode / replaceChild 付き） ----
function makeEl(tag) {
	const cls = new Set();
	const e = {
		tagName: tag,
		children: [],
		parentNode: null,
		style: {},
		dataset: {},
		_attrs: {},
		_lis: {},
		_html: "",
		textContent: "",
		value: "",
		title: "",
		placeholder: "",
		type: "",
		src: "",
		alt: "",
		onerror: null,
		controls: false,
		preload: "",
		hidden: false,
		tabIndex: 0,
		get className() {
			return [...cls].join(" ");
		},
		set className(v) {
			cls.clear();
			String(v)
				.split(/\s+/)
				.filter((x) => x.length > 0)
				.forEach((x) => cls.add(x));
		},
		get innerHTML() {
			return e._html;
		},
		get firstChild() {
			return e.children[0] || null;
		},
		set innerHTML(v) {
			e._html = String(v);
			e.children.length = 0;
			// 実 DOM と同じく、先頭のタグ 1 つ分だけ子要素を作る
			// （`tmp.innerHTML = '<video ...>'` 経由の生成を観測するため）。
			const m = /^<([a-zA-Z]+)/.exec(e._html);
			if (m) e.appendChild(makeEl(m[1].toLowerCase()));
		},
		classList: {
			add: (...c) => c.forEach((x) => cls.add(x)),
			remove: (...c) => c.forEach((x) => cls.delete(x)),
			toggle: (x) => (cls.has(x) ? cls.delete(x) : cls.add(x)),
			contains: (x) => cls.has(x),
		},
		appendChild(c) {
			c.parentNode = e;
			e.children.push(c);
			return c;
		},
		replaceChild(n, o) {
			const i = e.children.indexOf(o);
			if (i >= 0) e.children[i] = n;
			n.parentNode = e;
			o.parentNode = null;
		},
		removeChild(c) {
			const i = e.children.indexOf(c);
			if (i >= 0) e.children.splice(i, 1);
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
		querySelector: () => null,
		querySelectorAll: () => [],
		closest: () => null,
		focus() {},
	};
	return e;
}

function walk(node, out = []) {
	if (!node) return out;
	out.push(node);
	for (const c of node.children || []) walk(c, out);
	return out;
}

/** テンプレートから本体スクリプトを取り出して vm で走らせ、byId を返す。 */
async function run(html, marker, payloadFor) {
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes(marker));
	assert.ok(apiScript, `本体スクリプトが見つからない (${marker})`);
	const byId = {};
	const document = {
		baseURI: `${BASE}/`,
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		documentElement: makeEl("html"),
		querySelectorAll: () => [],
	};
	const sandbox = {
		document,
		window: { confirm: () => true },
		location: { protocol: "http:", hostname: "127.0.0.1", reload() {} },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payloadFor(String(u))) }),
		setInterval: () => 0,
		clearInterval() {},
		setTimeout: () => 0,
		clearTimeout() {},
		Date,
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);
	for (let i = 0; i < 8; i++) await flush();
	return byId;
}

const PNG = "shot 1.png";
const MP4 = "clip.mp4";
const WEBM = "clip.webm";
const cards = [
	{ id: 1, text: "png card", col: "todo", img: PNG },
	{ id: 2, text: "mp4 card", col: "todo", img: MP4 },
	{ id: 3, text: "webm card", col: "todo", img: WEBM },
	{ id: 4, text: "plain card", col: "todo" },
];
const cardById = (root) => walk(root).filter((n) => n.className.split(" ").includes("card"));
const mediaIn = (card) => walk(card).filter((n) => n.tagName === "img" || n.tagName === "video");

// 期待する src。ダッシュボードの MEDIA は相対 URL。
const EXPECT_DASH = `/api/media/${encodeURIComponent(PNG)}`;

// ===========================================================================
// DASHBOARD_HTML
// ===========================================================================
{
	const byId = await run(dashboardHtml, 'var API = "/api/dashboard"', (u) => {
		if (!u.startsWith("/api/dashboard")) return { ok: true };
		return {
			host: "test-host",
			now: "2026-01-01T00:00:00.000Z",
			stats: { sessions: 1, active: 1, todo: 4, doing: 0, done: 0, serve: 0, media: 1 },
			global: {
				counts: { todo: 4, doing: 0, done: 0 },
				modes: { doingLoop: true, autoPick: false, intervalMin: 5 },
				cards,
			},
			sessions: [],
			serve: [],
		};
	});
	const root = byId["global"];
	const cs = cardById(root);

	await check("dashboard: 画像付きカードは実サムネを持つ（🖼 の目印だけではない）", () => {
		assert.ok(cs.length >= 4, `カードが描画されていない: ${cs.length}`);
		assert.equal(mediaIn(cs[0]).length, 1, "png カードに img/video が無い");
		assert.equal(mediaIn(cs[0])[0].tagName, "img", "png が img でない");
		// 描画結果に「絵文字だけ」の痕跡が残っていない
		assert.ok(!walk(root).some((n) => n.textContent === "🖼"), "旧 🖼 マーカーが残っている");
	});

	await check("dashboard: src は /api/media/<urlencoded>", () => {
		assert.equal(mediaIn(cs[0])[0].src, EXPECT_DASH, `src が違う: ${mediaIn(cs[0])[0].src}`);
	});

	await check("dashboard: .mp4 / .webm は video、.png は img", () => {
		assert.equal(mediaIn(cs[1])[0].tagName, "video", "mp4 が video でない");
		assert.equal(mediaIn(cs[1])[0].src, `/api/media/${encodeURIComponent(MP4)}`);
		assert.equal(mediaIn(cs[2])[0].tagName, "video", "webm が video でない");
		assert.equal(mediaIn(cs[2])[0].src, `/api/media/${encodeURIComponent(WEBM)}`);
		assert.equal(mediaIn(cs[0])[0].tagName, "img", "png が img でない");
	});

	await check("dashboard: img 無しカードには img/video を作らない", () => {
		assert.equal(mediaIn(cs[3]).length, 0, "img 無しカードにメディア要素が付いた");
	});

	await check("dashboard: onerror で .badimg / 🖼? に差し替わる", () => {
		const im = mediaIn(cs[0])[0];
		assert.equal(typeof im.onerror, "function", "onerror が無い");
		const box = im.parentNode;
		im.onerror();
		const bad = walk(root).find((n) => n.className.split(" ").includes("badimg"));
		assert.ok(bad, ".badimg に差し替わっていない");
		assert.equal(bad.textContent, "🖼?", `差し替え文言が違う: ${bad.textContent}`);
		assert.ok(!box.children.includes(im), "元の img が残っている");
	});

	await check("dashboard: CSS にサムネ用ルールがある（既存トークンのみ）", () => {
		assert.ok(
			dashboardHtml.includes(".card img,.card video{flex-basis:100%;"),
			"ダッシュボードに .card img,video のレイアウト規則が無い",
		);
		assert.ok(dashboardHtml.includes(".card .badimg{"), ".card .badimg の規則が無い");
		const rule = dashboardHtml.slice(
			dashboardHtml.indexOf(".card img,.card video{"),
			dashboardHtml.indexOf("}", dashboardHtml.indexOf(".card img,.card video{")),
		);
		assert.ok(rule.includes("var(--") || !/#[0-9a-fA-F]{3,8}\b/.test(rule), "新しい色を発明している");
	});
}

// --- 集計 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-dashboard-img: ${passed} passed, ${failures.length} failed`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
