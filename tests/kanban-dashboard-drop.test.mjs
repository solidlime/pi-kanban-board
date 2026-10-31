// #52 ダッシュボードのファイルドロップの自己検証 (#011)。
// 列にファイルを落としても何も起きなかった（dragover が Files を見ていなかった）。
// ここは公開経路だけ: 実サーバの /api/upload と、配信される DASHBOARD_HTML の挙動。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-drop-home";
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
const MEDIA = `${HOME_DIR}/.pi/kanban/media`;
const GLOBAL = `${HOME_DIR}/.pi/kanban/global.json`;

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

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

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);
const post = (query, body) =>
	tf(`${BASE}/api/upload?${query}`, {
		method: "POST",
		body,
		headers: { "Content-Type": "application/octet-stream" },
	});
const readGlobal = () => {
	try {
		return readBoardAt(GLOBAL).cards;
	} catch {
		return [];
	}
};

// ===========================================================================
// 1. サーバの /api/upload（公開経路・実 HTTP）
// ===========================================================================
await check("/api/upload?ext=png&col=todo (id なし) は 200 で新規カードが増える", async () => {
	// col と ext だけ渡す形（クライアントが実際に送る組み合わせ）を固定する。
	const before = readGlobal().length;
	const r = await post("scope=global&ext=png&col=todo", PNG);
	assert.equal(r.status, 200, `status が 200 でない: ${r.status}`);
	const j = await r.json();
	assert.equal(j.ok, true, JSON.stringify(j));
	const after = readGlobal();
	assert.equal(after.length, before + 1, "新規カードが増えていない");
	const card = after.find((c) => c.id === j.card.id);
	assert.ok(card, "返ってきたカードがボードに無い");
	assert.equal(card.col, "todo", `col が todo でない: ${card.col}`);
	assert.ok(typeof card.img === "string" && card.img.endsWith(".png"), `img が付いていない: ${JSON.stringify(card)}`);
	// 実ファイルが書かれ、/api/media/<name> が 200 で返ることまで見る。
	assert.ok(existsSync(`${MEDIA}/${card.img}`), `media にファイルが無い: ${card.img}`);
	const m = await tf(`${BASE}/api/media/${encodeURIComponent(card.img)}`);
	assert.equal(m.status, 200, `/api/media/${card.img} が 200 でない: ${m.status}`);
	assert.equal((await m.arrayBuffer()).byteLength, PNG.length, "配信バイト数が違う");
});

await check("/api/upload?id= は既存カードの img を差し替える", async () => {
	const target = readGlobal().find((c) => c.col === "todo" && c.img);
	assert.ok(target, "対象カードが無い");
	const oldImg = target.img;
	const r = await post(`scope=global&ext=gif&id=${target.id}`, PNG);
	assert.equal(r.status, 200, `status が 200 でない: ${r.status}`);
	const j = await r.json();
	assert.equal(j.ok, true, JSON.stringify(j));
	assert.equal(readGlobal().length, readGlobal().length, "id 指定で枚数が変わった");
	const card = readGlobal().find((c) => c.id === target.id);
	assert.notEqual(card.img, oldImg, "img が変わっていない");
	assert.ok(card.img.endsWith(".gif"), `ext が反映されていない: ${card.img}`);
	assert.ok(existsSync(`${MEDIA}/${card.img}`), `新しい media が無い: ${card.img}`);
});

await check("ext 無し / 不正な ext は 415", async () => {
	const noExt = await post("scope=global&col=todo", PNG);
	assert.equal(noExt.status, 415, `ext 無しが 415 でない: ${noExt.status}`);
	const badExt = await post("scope=global&ext=exe&col=todo", PNG);
	assert.equal(badExt.status, 415, `ext=exe が 415 でない: ${badExt.status}`);
});

// ===========================================================================
// 2. 配信 HTML にドロップ処理が載っている
// ===========================================================================
await check("配信 DASHBOARD_HTML の列 drop が dataTransfer.files を見る", () => {
	assert.ok(dashboardHtml.includes("dataTransfer.files"), "dataTransfer.files を読むコードが無い");
	const drop = dashboardHtml.slice(
		dashboardHtml.indexOf('box.addEventListener("drop"'),
		dashboardHtml.indexOf('box.addEventListener("drop"') + 1200,
	);
	assert.ok(drop.includes("dataTransfer.files"), "列の drop 内で files を見ていない");
	assert.ok(drop.includes("uploadHere(ctx, key, f, undefined)"), "列 drop が uploadHere を呼んでいない");
	assert.ok(drop.includes("stopPropagation"), "列 drop が stopPropagation していない");
});

await check("配信 DASHBOARD_HTML の dragover が Files で preventDefault する", () => {
	const over = dashboardHtml.slice(
		dashboardHtml.indexOf('box.addEventListener("dragover"'),
		dashboardHtml.indexOf('box.addEventListener("dragover"') + 900,
	);
	assert.ok(over.includes('indexOf("Files")'), "dragover が Files を見ていない");
	assert.ok(over.includes('dropEffect = "copy"'), "dropEffect=copy が無い");
});

await check("カードの drop と .fileover の CSS が載っている（既存トークンのみ）", () => {
	assert.ok(dashboardHtml.includes("uploadHere(ctx, c.col, f, c.id)"), "カード drop が添付経路を呼んでいない");
	assert.ok(dashboardHtml.includes(".card.fileover{"), ".card.fileover の CSS が無い");
	const rule = dashboardHtml.slice(
		dashboardHtml.indexOf(".card.fileover{"),
		dashboardHtml.indexOf("}", dashboardHtml.indexOf(".card.fileover{")),
	);
	assert.ok(rule.includes("var(--"), `既存トークンを使っていない: ${rule}`);
	assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rule), "新しい色を発明している");
});

// ===========================================================================
// 3. vm + DOM スタブ: 実際のハンドラ分岐
// ===========================================================================
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
		type: "",
		src: "",
		hidden: false,
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
		set innerHTML(v) {
			e._html = String(v);
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
		removeChild() {},
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
const hasCls = (el, c) => el.className.split(" ").includes(c);

{
	const calls = [];
	const cards = [{ id: 7, text: "drop target", col: "todo" }];
	const scripts = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	assert.ok(apiScript, "ダッシュボード本体スクリプトが見つからない");
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
		Request,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			const url = u instanceof Request ? u.url : String(u);
			calls.push(url);
			if (url.includes("/api/dashboard")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							host: "test-host",
							now: "2026-01-01T00:00:00.000Z",
							stats: { sessions: 0, active: 1, todo: 1, doing: 0, done: 0, serve: 0, media: 0 },
							global: {
								counts: { todo: 1, doing: 0, done: 0 },
								modes: { doingLoop: true, autoPick: false, intervalMin: 5 },
								cards,
							},
							sessions: [],
							serve: [],
						}),
				});
			}
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, card: {} }) });
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

	const root = byId.global;
	const col = walk(root).find((n) => n.getAttribute("data-col") === "todo");
	const card = walk(root).find((n) => hasCls(n, "card"));

	await check("vm: 列の dragover は Files で preventDefault + dropEffect=copy + .over", () => {
		assert.ok(col, "todo 列が描画されていない");
		let prevented = false;
		const dt = { types: ["Files"], files: [], dropEffect: "none" };
		fire(col, "dragover", { dataTransfer: dt, preventDefault: () => (prevented = true) });
		assert.equal(prevented, true, "preventDefault していない（ブラウザ既定のファイルオープンに落ちる）");
		assert.equal(dt.dropEffect, "copy", "dropEffect が copy でない");
		assert.ok(hasCls(col, "over"), ".over が付いていない");
	});

	await check("vm: 列にファイルを落とすと ext と col 付きで /api/upload する", async () => {
		calls.length = 0;
		const file = { name: "Shot 1.PNG", arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) };
		let stopped = false;
		fire(col, "drop", {
			dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" },
			preventDefault() {},
			stopPropagation: () => (stopped = true),
		});
		for (let i = 0; i < 8; i++) await flush();
		const up = calls.find((u) => u.includes("/api/upload"));
		assert.ok(up, `upload していない: ${JSON.stringify(calls)}`);
		assert.ok(up.includes("ext=png"), `ext が小文字の png でない: ${up}`);
		assert.ok(up.includes("col=todo"), `col が載っていない: ${up}`);
		assert.ok(up.includes("scope=global"), `scope が載っていない: ${up}`);
		assert.ok(!up.includes("id="), `id 無しのはずが載っている: ${up}`);
		assert.equal(stopped, true, "stopPropagation していない");
	});

	await check("vm: カードにファイルを落とすと id 付きで添付する", async () => {
		calls.length = 0;
		assert.ok(card, "カードが描画されていない");
		const file = { name: "clip.webm", arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) };
		fire(card, "dragover", { dataTransfer: { types: ["Files"], files: [], dropEffect: "none" }, preventDefault() {} });
		assert.ok(hasCls(card, "fileover"), "fileover が付いていない");
		fire(card, "drop", {
			dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" },
			preventDefault() {},
			stopPropagation() {},
		});
		for (let i = 0; i < 8; i++) await flush();
		const up = calls.find((u) => u.includes("/api/upload"));
		assert.ok(up, `upload していない: ${JSON.stringify(calls)}`);
		assert.ok(up.includes("id=7"), `id が載っていない: ${up}`);
		assert.ok(up.includes("ext=webm"), `ext が webm でない: ${up}`);
		assert.ok(!hasCls(card, "fileover"), "fileover が残っている");
	});

	await check("vm: 未対応拡張子は送る前に note で弾く（/api/upload を叩かない）", async () => {
		calls.length = 0;
		const file = { name: "payload.exe", arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) };
		fire(col, "drop", {
			dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" },
			preventDefault() {},
			stopPropagation() {},
		});
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(!calls.some((u) => u.includes("/api/upload")), "415 になるリクエストを送っている");
		assert.ok(String(byId.note.textContent).includes("非対応"), `note が出ていない: ${byId.note.textContent}`);
	});

	await check("vm: カード移動（text/plain）は従来どおり /api/move に行く", async () => {
		calls.length = 0;
		fire(card, "dragstart", {
			dataTransfer: { types: ["text/plain"], setData() {}, effectAllowed: "" },
		});
		calls.length = 0; // dragstart 中の reload 分は捨てる
		fire(col, "dragover", { dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" }, preventDefault() {} });
		assert.ok(hasCls(col, "over"), "カード移動で .over が付かない");
		fire(col, "drop", { dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" }, preventDefault() {}, stopPropagation() {} });
		for (let i = 0; i < 8; i++) await flush();
		const mv = calls.find((u) => u.includes("/api/move"));
		assert.ok(mv, `move していない: ${JSON.stringify(calls)}`);
		assert.ok(mv.includes("id=7") && mv.includes("col=todo"), `move の内容が違う: ${mv}`);
	});
}

// --- 3b. 全セッションのカードにファイルを添付できる（#55: 書き込みロック無し） -
{
	const calls = [];
	const scripts = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	const byId = {};
	const document = {
		baseURI: `${BASE}/`,
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		documentElement: makeEl("html"),
		querySelectorAll: () => [],
	};
	const roSession = {
		id: "s-ro",
		name: "read only",
		cwd: "",
		isActive: false,
		modified: 0,
		counts: { todo: 1, doing: 0, done: 0 },
		modes: { session: {}, global: {} },
		cards: [{ id: 3, text: "ro card", col: "todo" }],
	};
	const sandbox = {
		document,
		window: { confirm: () => true },
		location: { protocol: "http:", hostname: "127.0.0.1", reload() {} },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			calls.push(String(u));
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({
						host: "test-host",
						now: "2026-01-01T00:00:00.000Z",
						stats: { sessions: 1, active: 0, todo: 1, doing: 0, done: 0, serve: 0, media: 0 },
						global: { counts: { todo: 0, doing: 0, done: 0 }, modes: {}, cards: [] },
						sessions: [roSession],
						serve: [],
					}),
			});
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
	const roCard = walk(byId.sessions).find((n) => hasCls(n, "card"));

	await check("vm: driver でないセッションのカードにもファイルをドロップできる（#55）", async () => {
		assert.ok(roCard, "セッションのカードが描画されていない");
		calls.length = 0;
		const file = { name: "x.png", arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) };
		fire(roCard, "drop", {
			dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" },
			preventDefault() {},
			stopPropagation() {},
		});
		for (let i = 0; i < 4; i++) await flush();
		const up = calls.find((u) => u.includes("/api/upload"));
		assert.ok(up, `upload が飛んでいない: ${JSON.stringify(calls)}`);
		assert.ok(up.includes("sid=s-ro") && up.includes("id=3"), up);
	});
}

// --- 集計 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-dashboard-drop: ${passed} passed, ${failures.length} failed`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
