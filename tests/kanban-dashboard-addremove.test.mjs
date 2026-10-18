// #45 ダッシュボードからのカード追加・削除の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-addremove.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

const HOME_DIR = "/tmp/kb-dashboard-addremove-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
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
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

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
// #40: activeSessionId はプロセス最初の session_start で固定される。
// 書き込み可のセッションを先に起こし、読み取り専用は後から足す。
const ctxFor = (sid) => ({
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => sid, getEntries: () => [] },
});
const ACTIVE = "addremove-active";
const RO = "addremove-readonly";
handlers.get("session_start")({}, ctxFor(ACTIVE));
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const SRC = await (await fetch(`${BASE}/`)).text();

// --- 1. 配信 HTML の文字列レベル ---------------------------------------------
await check("DASHBOARD_HTML: 各列の + ボタン（addbtn）を持つ", () => {
	assert.ok(SRC.includes('el("button", "mini addbtn", "+")'), "addbtn クラスが無い");
	assert.ok(SRC.includes('el("button", "mini addbtn", "+")'), "+ の文字が無い");
	assert.ok(SRC.includes('addBtn.title = ctx.active ? "この列にカードを追加" : RO_TITLE'), "title が仕様と違う");
});

await check("DASHBOARD_HTML: + は /api/add を act() 経由で叩く", () => {
	assert.ok(SRC.includes('act("/api/add", { col: key, text: v }, ctx)'), "/api/add の呼び出しが無い");
	// 移植元 KANBAN_HTML の send() ではなく act() であること
	assert.ok(!SRC.includes('send(board, "add?col='), "KANBAN_HTML の send() が混ざっている");
});

await check("DASHBOARD_HTML: 入力欄は Enter / Escape / blur を扱う", () => {
	assert.ok(SRC.includes('el("input", "addin")'), "addin クラスが無い");
	const at = SRC.indexOf('el("input", "addin")');
	const h = SRC.slice(at, at + 2200);
	assert.ok(h.includes('if (e.key === "Escape")'), "Escape が無い");
	assert.ok(h.includes('e.key !== "Enter"'), "Enter が無い");
	assert.ok(h.includes('addEventListener("blur"'), "blur が無い");
	assert.ok(h.includes(".trim()"), "trim() が無い");
});

await check("DASHBOARD_HTML: 削除は × ボタン + /api/remove", () => {
	assert.ok(SRC.includes('act("/api/remove", { id: c.id }, ctx)'), "/api/remove の呼び出しが無い");
	// 移植元 kanban.ts:4043 の書き方（テンプレート内では \u00d7 と書く）
	assert.ok(SRC.includes('el("button", "mini del", "\\u00d7")'), "× ボタンが無い");
	assert.ok(SRC.includes('"mini del"'), "del クラスが無い");
	assert.ok(SRC.includes('"このカードを削除"'), "title が無い");
});

await check("DASHBOARD_HTML: 削除は confirm() で確認し、false なら何もしない", () => {
	// confirm は act より手前。ボタン生成からハンドラ全体を見る。
	const at = SRC.indexOf('el("button", "mini del"');
	assert.ok(at > 0, "× ボタンが無い");
	const h = SRC.slice(at, at + 700);
	assert.ok(
		h.includes('window.confirm("「" + String(c.text || "").slice(0, 40) + "」を削除しますか？")'),
		"確認文が仕様と違う",
	);
	assert.match(h, /if \(!window\.confirm\([\s\S]*?\)\) return;/, "confirm の早期 return が無い");
	assert.ok(h.includes('act("/api/remove", { id: c.id }, ctx)'), "remove が confirm の後に無い");
});

await check("DASHBOARD_HTML: 読み取り専用の分岐で note(RO_MSG) を呼ぶ（追加・削除）", () => {
	const add = SRC.indexOf('addBtn.addEventListener("click"');
	assert.ok(add > 0, "+ のハンドラが無い");
	assert.ok(
		/if \(!ctx\.active\) \{ note\(RO_MSG\); return; \}/.test(SRC.slice(add, add + 600)),
		"+ の読み取り専用分岐が無い",
	);
	const del = SRC.indexOf('el("button", "mini del"');
	assert.ok(del > 0, "× のハンドラが無い");
	assert.ok(
		/if \(!ctx\.active\) \{ note\(RO_MSG\); return; \}/.test(SRC.slice(del, del + 600)),
		"× の読み取り専用分岐が無い",
	);
	assert.ok(/RO_MSG = "この看板は読み取り専用/.test(SRC), "RO_MSG の文言が違う");
	assert.ok(/RO_TITLE = "読み取り専用（編集するにはセッションをアクティブに）"/.test(SRC), "RO_TITLE の文言が違う");
});

await check("DASHBOARD_HTML: 読み取り専用は aria-disabled + title", () => {
	// ネイティブ disabled だと click が発火せず、押せない理由を返せない。
	assert.ok(/addBtn\.setAttribute\("aria-disabled", ctx\.active \? "false" : "true"\)/.test(SRC), "+ が aria-disabled にならない");
	assert.ok(/addBtn\.title = ctx\.active \? "この列にカードを追加" : RO_TITLE/.test(SRC), "+ の title が RO_TITLE でない");
});

// --- 2. ブラウザ側 JS の構文検査 ---------------------------------------------
const scripts = [...SRC.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
await check("dashboard の JS を抽出できる", () => assert.ok(apiScript));
await check("dashboard の <script> は構文として妥当", () => {
	assert.doesNotThrow(() => new Function(apiScript));
});

// --- 3. 実 HTTP: /api/add と /api/remove ------------------------------------
const dash = async () => (await fetch(`${BASE}/api/dashboard`)).json();
const q = (s) => encodeURIComponent(s);

await check("/api/add: カードが増え、dashboard に出る", async () => {
	const res = await fetch(`${BASE}/api/add?scope=session&sid=${ACTIVE}&text=${q("テスト追加")}&col=todo`);
	assert.equal(res.status, 200, `status=${res.status}`);
	const d = await dash();
	const card = d.sessions.find((s) => s.id === ACTIVE)?.cards.find((c) => c.text === "テスト追加");
	assert.ok(card, "dashboard に追加カードが無い");
	assert.equal(card.col, "todo");
});

await check("/api/add: 空 text は 400", async () => {
	const res = await fetch(`${BASE}/api/add?scope=session&sid=${ACTIVE}&text=`);
	assert.equal(res.status, 400, `status=${res.status}`);
});

await check("/api/add: 読み取り専用セッションは 403", async () => {
	handlers.get("session_start")({}, ctxFor(RO)); // activeSessionId は #40 で固定なので ACTIVE のまま
	const res = await fetch(`${BASE}/api/add?scope=session&sid=${RO}&text=x`);
	assert.equal(res.status, 403, `status=${res.status}`);
});

await check("/api/remove: カードが消え、dashboard からも消える", async () => {
	const before = await dash();
	const card = before.sessions.find((s) => s.id === ACTIVE).cards.find((c) => c.text === "テスト追加");
	assert.ok(card, "対象カードが無い");
	const res = await fetch(`${BASE}/api/remove?scope=session&sid=${ACTIVE}&id=${card.id}`);
	assert.equal(res.status, 200, `status=${res.status}`);
	const after = await dash();
	assert.ok(
		!after.sessions.find((s) => s.id === ACTIVE).cards.some((c) => c.id === card.id),
		"dashboard にまだ残っている",
	);
});

await check("/api/remove: 存在しない id は 404", async () => {
	const res = await fetch(`${BASE}/api/remove?scope=session&sid=${ACTIVE}&id=999999`);
	assert.equal(res.status, 404, `status=${res.status}`);
});

// --- 4. vm: 実ハンドラを叩いて act() の引数まで見る --------------------------
{
	const created = [];
	const makeEl = () => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			innerHTML: "",
			textContent: "",
			title: "",
			type: "",
			value: "",
			disabled: false,
			style: {},
			attrs: {},
			lis: {},
			appendChild(c) {
				e.children.push(c);
				c.parentNode = e;
				return c;
			},
			replaceChild(n, o) {
				const i = e.children.indexOf(o);
				if (i >= 0) e.children[i] = n;
				n.parentNode = e;
				return o;
			},
			setAttribute(k, v) {
				e.attrs[k] = String(v);
			},
			getAttribute(k) {
				return k in e.attrs ? e.attrs[k] : null;
			},
			focus() {},
			addEventListener(t, fn) {
				(e.lis[t] = e.lis[t] || []).push(fn);
			},
			removeEventListener() {},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
			querySelector(sel) {
				const cls = sel.replace(/^\./, "");
				const walk = (n) => {
					for (const c of n.children) {
						if (String(c.className).split(/\s+/).includes(cls)) return c;
						const hit = walk(c);
						if (hit) return hit;
					}
					return null;
				};
				return walk(e);
			},
		};
		created.push(e);
		return e;
	};
	const byId = {};
	const noteEl = (byId.note = makeEl());
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = makeEl()),
		createElement: () => makeEl(),
		documentElement: makeEl(),
		querySelectorAll: () => [],
	};
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: 2, active: 1, todo: 2, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
		sessions: [
			{
				id: "01a1480c",
				name: "active-one",
				cwd: "/tmp",
				isActive: true,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: {}, global: {} },
				counts: { todo: 1, doing: 0, done: 0 },
				cards: [{ id: "7", col: "todo", text: "書けるカード" }],
			},
			{
				id: "01a1266c",
				name: "readonly-one",
				cwd: "/tmp",
				isActive: false,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: {}, global: {} },
				counts: { todo: 1, doing: 0, done: 0 },
				cards: [{ id: "8", col: "todo", text: "読むだけのカード" }],
			},
		],
		serve: [],
	};
	const timers = [];
	let nextId = 1;
	const urls = [];
	const sandbox = {
		document,
		window: { confirm: () => true },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			urls.push(String(u));
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
		},
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
	for (let i = 0; i < 8; i++) await flush();

	const els = () => created;
	const findBtn = (pred) => els().find((e) => e.tagName === undefined && pred(e));
	const addBtns = els().filter((e) => String(e.className).includes("addbtn"));
	const delBtns = els().filter((e) => String(e.className).includes("del"));
	const clearUrls = () => urls.splice(0, urls.length);

	await check("vm: 列ごとに + ボタンが出る（3 列 × 2 ボード）", () => {
		assert.equal(addBtns.length, 6, `addbtn=${addBtns.length}`);
		assert.ok(findBtn(() => true), "要素が作られていない");
	});

	// 読み取り専用は aria-disabled="true"（DOM の disabled は click を飲むため使わない）
	const roOf = (b) => b.attrs["aria-disabled"] === "true";
	const activeOf = (b) => b.attrs["aria-disabled"] !== "true";

	await check("vm: 読み取り専用の + は aria-disabled で title が RO_TITLE", () => {
		const ro = addBtns.filter(roOf);
		assert.equal(ro.length, 3, `読み取り専用の + が ${ro.length}`);
		for (const b of ro) assert.equal(b.title, "読み取り専用（編集するにはセッションをアクティブに）");
		const on = addBtns.filter(activeOf);
		assert.equal(on.length, 3, `有効な + が ${on.length}`);
		for (const b of on) assert.equal(b.title, "この列にカードを追加");
	});

	// + と input は同じ列ボックスに入る。クリックした列の input だけを見る。
	const inputOf = (b) =>
		els().find((e) => String(e.className).includes("addin") && e.parentNode === b.parentNode);
	// カードのある列の + を使う（todo 列）。列の順序は COLS 固定なので先頭。
	const activeAdd = addBtns.filter(activeOf)[0];

	await check("vm: + クリック → input.addin が出る", () => {
		activeAdd.lis.click[0]();
		const input = inputOf(activeAdd);
		assert.ok(input, "input.addin が作られていない");
		assert.equal(input.style.display, "");
		assert.equal(activeAdd.style.display, "none");
	});

	await check("vm: Enter で /api/add?col=&text= を叩く", async () => {
		clearUrls();
		const on = activeAdd;
		on.lis.click[0]();
		const input = inputOf(on);
		input.value = "  vm 追加  ";
		input.lis.keydown[0]({ key: "Enter", preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		const hit = urls.find((u) => u.includes("/api/add"));
		assert.ok(hit, `add が飛んでいない: ${JSON.stringify(urls)}`);
		assert.ok(hit.includes("col=todo"), hit);
		assert.ok(hit.includes(`text=${q("vm 追加")}`), hit);
		assert.ok(hit.includes("scope=session"), hit);
		assert.ok(hit.includes("sid=01a1480c"), hit);
	});

	await check("vm: 空文字 Enter は送らない（閉じるだけ）", async () => {
		clearUrls();
		const on = activeAdd;
		on.lis.click[0]();
		const input = inputOf(on);
		input.value = "   ";
		input.lis.keydown[0]({ key: "Enter", preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(!urls.some((u) => u.includes("/api/add")), `空文字で飛んだ: ${JSON.stringify(urls)}`);
	});

	await check("vm: Escape は閉じるだけで送らない", async () => {
		clearUrls();
		const on = activeAdd;
		on.lis.click[0]();
		const input = inputOf(on);
		input.value = "やめる";
		input.lis.keydown[0]({ key: "Escape", preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(!urls.some((u) => u.includes("/api/add")), `Escape で飛んだ: ${JSON.stringify(urls)}`);
	});

	await check("vm: blur は閉じるだけで送らない", async () => {
		clearUrls();
		const on = activeAdd;
		on.lis.click[0]();
		const input = inputOf(on);
		input.value = "やめる";
		input.lis.blur[0]();
		for (let i = 0; i < 4; i++) await flush();
		assert.equal(input.style.display, "none", "blur で閉じていない");
		assert.equal(on.style.display, "", "+ ボタンが戻っていない");
		assert.ok(!urls.some((u) => u.includes("/api/add")), `blur で飛んだ: ${JSON.stringify(urls)}`);
	});

	await check("vm: act 実行中（送信中）の blur では状態を変えない", async () => {
		const on = activeAdd;
		on.lis.click[0]();
		const input = inputOf(on);
		input.value = "送信中";
		clearUrls();
		// keydown 直後は sending === true（act の then はまだ走っていない）
		input.lis.keydown[0]({ key: "Enter", preventDefault() {} });
		const shownAtEnter = input.style.display;
		input.lis.blur[0]();
		assert.equal(input.style.display, shownAtEnter, "送信中に blur で表示が変わった");
		for (let i = 0; i < 4; i++) await flush();
	});

	await check("vm: × クリック → confirm → /api/remove?id=", async () => {
		clearUrls();
		const del = delBtns.find(activeOf);
		assert.ok(del, "有効な × が無い");
		del.lis.click[0]();
		for (let i = 0; i < 4; i++) await flush();
		const hit = urls.find((u) => u.includes("/api/remove"));
		assert.ok(hit, `remove が飛んでいない: ${JSON.stringify(urls)}`);
		assert.ok(hit.includes("id=7"), hit);
		assert.ok(hit.includes("scope=session") && hit.includes("sid=01a1480c"), hit);
	});

	await check("vm: × の confirm が false なら何もしない", async () => {
		clearUrls();
		sandbox.window.confirm = () => false;
		const del = delBtns.find(activeOf);
		del.lis.click[0]();
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(!urls.some((u) => u.includes("/api/remove")), `confirm 無視で飛んだ: ${JSON.stringify(urls)}`);
	});

	await check("vm: 読み取り専用の × は aria-disabled + title", () => {
		// カードは active 1 枚 + readonly 1 枚（GLOBAL は空）なので × は 2 つ。
		assert.equal(delBtns.length, 2, `del=${delBtns.length}`);
		const ro = delBtns.filter(roOf);
		assert.equal(ro.length, 1, `読み取り専用の × が ${ro.length}`);
		for (const b of ro) assert.equal(b.title, "読み取り専用（編集するにはセッションをアクティブに）");
	});

	await check("vm: 読み取り専用の × クリックで理由が出て、remove は飛ばない", async () => {
		clearUrls();
		const ro = delBtns.find(roOf);
		ro.lis.click[0]();
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(!urls.some((u) => u.includes("/api/remove")), `読み取り専用なのに飛んだ: ${JSON.stringify(urls)}`);
		assert.ok(noteEl && noteEl.textContent.includes("読み取り専用"), `note が出ていない: ${noteEl && noteEl.textContent}`);
	});
}

// --- 5. 集計 -----------------------------------------------------------------
for (const f of failures) console.error("FAIL", f);
console.log(`kanban-dashboard-addremove: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("OK");
process.exit(0);
