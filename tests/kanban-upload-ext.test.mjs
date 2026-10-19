// #59 upload() が `file.type` だけを見て拡張子を決めていたため、type が空になる
// ドラッグ元（curl・一部 OS・一部ファイルマネージャ）で "unsupported media type" に
// 落ちていた問題の自己検証。#84 でテンプレートはダッシュボード 1 枚になったので、
// 不変条件（type だけで拡張子を決めない）は配信される DASHBOARD_HTML 側で固定する。
// フレームワーク無しで `node tests/kanban-upload-ext.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

const HOME_DIR = "/tmp/kb-upload-ext-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
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
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

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
		if ((await fetch(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}
const dashboardHtml = await (await fetch(`${BASE}/`)).text();

// --- 最小 DOM ------------------------------------------------------------------
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
		hidden: false,
		tabIndex: 0,
		disabled: false,
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

const fire = (el, type, ev) => (el._lis[type] || []).forEach((fn) => fn(ev));
const hasCls = (el, c) => String(el.className).split(" ").includes(c);

/** 配信されるダッシュボードの本体スクリプトを vm で走らせ、byId と fetch の URL 記録を返す。 */
async function runDashboard() {
	const scripts = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	assert.ok(apiScript, "dashboard の本体スクリプトが見つからない");
	const byId = {};
	const calls = [];
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
		fetch: (u) => {
			const url = String(u);
			calls.push(url);
			if (url.includes("/api/dashboard"))
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							host: "test-host",
							now: "2026-01-01T00:00:00.000Z",
							stats: { sessions: 1, active: 1, todo: 1, doing: 0, done: 0, serve: 0, media: 0 },
							global: {
								counts: { todo: 1, doing: 0, done: 0 },
								modes: { doingLoop: true, autoPick: false, intervalMin: 5 },
								cards: [{ id: 7, text: "global card", col: "todo" }],
							},
							sessions: [],
							serve: [],
						}),
				});
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
		},
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
	return { byId, calls };
}

const { byId, calls } = await runDashboard();

/** 指定カードへファイルを落とし、飛んだ /api/upload の URL を返す（無ければ null）。 */
async function dropOn(card, file) {
	calls.length = 0;
	fire(card, "drop", {
		dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" },
		preventDefault() {},
		stopPropagation() {},
	});
	for (let i = 0; i < 6; i++) await flush();
	return calls.find((u) => u.includes("/api/upload")) || null;
}

const mineCard = () => walk(byId["global"]).find((n) => hasCls(n, "card"));

await check("前提: カードが描画されている", () => {
	assert.ok(mineCard(), "GLOBAL 看板のカードが無い");
});

await check("#59 type が空でもファイル名から拡張子を引いて送る（x.png）", async () => {
	const up = await dropOn(mineCard(), {
		name: "x.png",
		type: "",
		arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
	});
	assert.ok(up, `upload が飛んでいない（unsupported media type で落ちた疑い）: ${JSON.stringify(calls)}`);
	assert.ok(up.includes("ext=png"), `ext=png が無い: ${up}`);
});

await check("#59 type が空でも大文字拡張子を小文字化する（Y.JPEG）", async () => {
	const up = await dropOn(mineCard(), {
		name: "Y.JPEG",
		type: "",
		arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
	});
	assert.ok(up, `upload が飛んでいない: ${JSON.stringify(calls)}`);
	assert.ok(up.includes("ext=jpg"), `ext=jpg が無い: ${up}`);
});

await check("#59 MIME が分かるならファイル名より MIME を優先する", async () => {
	const up = await dropOn(mineCard(), {
		name: "no-extension",
		type: "image/webp",
		arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
	});
	assert.ok(up, `upload が飛んでいない: ${JSON.stringify(calls)}`);
	assert.ok(up.includes("ext=webp"), `ext=webp が無い: ${up}`);
});

await check("#59 type も名前の拡張子も駄目なら送らずに理由を出す", async () => {
	const up = await dropOn(mineCard(), {
		name: "notes.txt",
		type: "",
		arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
	});
	assert.equal(up, null, `非対応拡張子なのに upload が飛んだ: ${up}`);
	const note = byId["note"];
	assert.ok(
		String(note && note.textContent).includes("非対応"),
		"非対応ファイルの理由が画面に出ていない（無言で失敗）",
	);
});

// --- 集計 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-upload-ext: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
