// #30/#31 ダッシュボードのカード操作と設定 UI の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-cards.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-cards-home";
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

// --- 1. 文字列レベル: #30 カード操作 ------------------------------------------
await check("#30 発火予定を表示し、相対ボタンで /api/schedule を叩く", () => {
	assert.ok(html.includes('"発火 " + shortFire(c.nextFireAt)'), "発火予定の表示が無い");
	assert.ok(html.includes('act("/api/schedule", { id: c.id, at: at }'), "相対発火の書き込みが無い");
	assert.ok(html.includes('fire("+5m", "+5m"'), "+5m ボタンが無い");
	assert.ok(html.includes('fire("+1h", "+1h"'), "+1h ボタンが無い");
	assert.ok(html.includes('fire("", "解除"'), "解除ボタンが無い");
	assert.ok(html.includes("明日9時"), "明日9時 ボタンが無い");
	assert.ok(html.includes("setHours(9, 0, 0, 0)"), "明日9時の時刻計算が無い");
	// dt → ISO にして渡す（サーバは ISO か +Nm/+Nh/+Nd のみ受ける）
	assert.ok(html.includes("d.toISOString()"), "ISO 変換が無い");
});

await check("#30 D&D は 1 つの board() にあり、GLOBAL と SESSION の両方に効く", () => {
	assert.ok(html.includes('card.setAttribute("draggable", "true")'), "draggable が無い");
	assert.ok(html.includes('addEventListener("dragstart"'), "dragstart が無い");
	assert.ok(html.includes('addEventListener("dragover"'), "dragover が無い");
	assert.ok(html.includes('addEventListener("drop"'), "drop が無い");
	assert.ok(html.includes('act("/api/move", { id: d.id, col: key }, ctx)'), "move の呼び出しが無い");
	// 別ボードへのドロップを弾く（scope+sid 一致必須）
	assert.ok(html.includes("d.scope !== ctx.scope || d.sid !== ctx.sid"), "ボード間ドロップのガードが無い");
	// 同じ board() が GLOBAL と各セッションの両方から呼ばれる
	assert.ok(html.includes("box.appendChild(board(cards, nowMs, ctx))"), "GLOBAL に board() が無い");
	// #48: セッション側は検索で絞った cards を渡す（名前だけ変わり、同じ board() を通る）
	assert.ok(html.includes("art.appendChild(board(cards, nowMs, ctx))"), "セッション看板に board() が無い");
});

await check("#30 優先度は表示・変更でき、大きいほど先（降順）が維持される", () => {
	assert.ok(html.includes('el("span", "prio", "P" + prioOf(c))'), "優先度バッジが無い");
	assert.ok(html.includes('act("/api/priority", { id: c.id, n: prioOf(c) + 1 }'), "▲ が無い");
	assert.ok(html.includes('act("/api/priority", { id: c.id, n: prioOf(c) - 1 }'), "▼ が無い");
	// サーバ側の並び順（priority 降順 → id 昇順）は既存のまま
	const ordered = mod.orderTodos([
		{ id: 1, text: "a", col: "todo", priority: 1 },
		{ id: 2, text: "b", col: "todo", priority: 9 },
		{ id: 3, text: "c", col: "todo" },
	]);
	assert.deepEqual(ordered.map((c) => c.id), [2, 1, 3], "priority 降順が壊れた");
});

// --- 2. 文字列レベル: #31 設定 UI --------------------------------------------
await check("#31 ループ/ピックは /api/modes、間隔は /api/interval を叩く", () => {
	assert.ok(html.includes('act("/api/modes", { key: key, value: on ? "off" : "on" }, ctx)'), "modes が無い");
	assert.ok(html.includes('sw("doingLoop", "ループ")'), "doingLoop トグルが無い");
	assert.ok(html.includes('sw("autoPick", "ピック")'), "autoPick トグルが無い");
	assert.ok(html.includes('act("/api/interval", { min: Math.round(v) }, ctx)'), "interval が無い");
	assert.ok(html.includes('iv.type = "number"'), "分入力が number でない");
	// 既定 5 分（AUTO_TICK_MS 相当）
	assert.ok(html.includes("return (typeof v === \"number\" && isFinite(v) && v > 0) ? v : 5"), "間隔の既定値が無い");
});

await check("#31 GLOBAL は scope=global、セッションは scope=session + sid", () => {
	assert.ok(html.includes('boardCtx("global", sid, true)'), "GLOBAL の ctx が無い");
	// #55: session ボードも active を落とさない（boardCtx の既定で true）。
	assert.ok(html.includes('boardCtx("session", s.id)'), "SESSION の ctx が無い");
	assert.ok(!html.includes('boardCtx("session", s.id, s.isActive)'), "isActive をまだ渡している");
	assert.ok(html.includes('if (ctx.sid) params.sid = ctx.sid;'), "sid の付与経路が無い");
	assert.ok(html.includes('params = { scope: ctx.scope }'), "scope の付与経路が無い");
});

await check("#31 DOING 全停止は blocked を再利用する（新状態なし）", () => {
	assert.ok(html.includes("DOING 全停止"), "DOING 全停止が無い");
	assert.ok(
		html.includes('act("/api/schedule", { id: c.id, blocked: "一時停止" }, ctx)'),
		"blocked 経由の停止が無い",
	);
	assert.ok(!html.includes("/api/stop"), "新しい停止端点を発明している");
});

await check("#31 serve の停止は /api/serve を使い、削除は HTTP に無い", () => {
	assert.ok(html.includes('act("/api/serve", { action: "remove", id: v.id }, sctx)'), "停止が無い");
	// #66-security: GET で unlink できてしまうため、ダッシュボードからはファイルを消さない。
	assert.ok(!html.includes('del: "1"'), "削除（del=1）がまだ UI に残っている");
	assert.ok(html.includes('btn(gone ? "登録解除" : "停止"'), "ボタンの出し分けが無い");
});

await check("CSS は既存トークンのみ（新色を発明していない）", () => {
	const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
	const added = css.slice(css.indexOf("#30 card ops"));
	for (const m of added.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
		assert.ok(m[0].toLowerCase().startsWith("#0"), `新色らしきリテラル: ${m[0]}`);
	}
	assert.ok(added.includes("var(--") || added.includes("button.mini"), "既存トークン未使用");
});

// --- 3. ブラウザ側 JS を vm で走らせ、クリックで飛ぶ URL を機械的に検査 ----------
{
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));

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
			type: "",
			value: "",
			disabled: false,
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
			focus() {},
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
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: 2, active: 1, todo: 2, doing: 2, done: 0, serve: 1, media: 0 },
		global: {
			counts: { todo: 1, doing: 0, done: 0 },
			modes: { doingLoop: true, autoPick: false, intervalMin: 7 },
			cards: [{ id: 11, text: "g", col: "todo", priority: 3, nextFireAt: "2026-01-01T00:05:00.000Z" }],
		},
		sessions: [
			{
				id: "s1",
				name: "kotomi",
				cwd: "/tmp",
				isActive: true,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: { doingLoop: false, autoPick: true, intervalMin: 10 }, global: {} },
				counts: { todo: 1, doing: 2, done: 0 },
				cards: [
					{ id: 1, text: "a", col: "todo", priority: 5 },
					{ id: 2, text: "b", col: "doing", blocked: "既に停止" },
					{ id: 4, text: "d", col: "doing" },
				],
			},
			{
				id: "s2",
				name: "other",
				cwd: "/tmp",
				isActive: false,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: { doingLoop: true, autoPick: true }, global: {} },
				counts: { todo: 0, doing: 1, done: 0 },
				cards: [{ id: 3, text: "c", col: "doing" }],
			},
		],
		serve: [
			{
				id: "abcdef0123456789",
				url: "http://127.0.0.1:8789/serve/abcdef0123456789/",
				path: `${HOME_DIR}/workspace/live.html`,
				createdAt: "2026-01-01T00:00:00.000Z",
				exists: true,
			},
		],
	};
	const urls = [];
	const sandbox = {
		document,
		window: { confirm: () => true },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			urls.push(u);
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
		},
		setTimeout: () => 0,
		clearTimeout() {},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);
	for (let i = 0; i < 4; i++) await flush();

	function walk(node, out) {
		out = out || [];
		if (!node) return out;
		out.push(node);
		(node.children || []).forEach((c) => walk(c, out));
		return out;
	}
	const buttonsOf = (id) =>
		walk(byId[id]).filter(
			(n) =>
				n._lis.click &&
				n._lis.click.length &&
				(n.className.includes("mini") || n.className.includes("sw")),
		);
	const textOf = (root, txt) => walk(root).some((n) => n.textContent === txt);
	const doingCards = () =>
		walk(byId["sessions"]).filter((n) => n.getAttribute && n.getAttribute("data-col") === "doing");

	await check("vm: カードに発火予定と優先度が出る（無いカードは —）", () => {
		assert.ok(textOf(byId["global"], "P3"), "GLOBAL に P3 が無い");
		assert.ok(textOf(byId["sessions"], "P5"), "s1 に P5 が無い");
		// 短い書式 (MM/DD HH:MM) 固定幅列に入るようにした。TZ 非依存の形で見る。
		assert.ok(
			walk(byId["global"]).some((n) => n.textContent && /^発火 \d{2}\/\d{2} \d{2}:\d{2}$/.test(n.textContent)),
			"発火時刻（短書式）が無い",
		);
		assert.ok(textOf(byId["sessions"], "発火 —"), "未設定が — になっていない");
		assert.ok(textOf(byId["sessions"], "停止中"), "blocked の表示が無い");
	});

	await check("vm: 全セッションの操作ボタンが enabled（#55: 書き込みロック無し）", () => {
		const ctls = walk(byId["sessions"]).filter((n) => n.className.includes("ctl"));
		assert.equal(ctls.length, 2, `ctl=${ctls.length}`);
		const sw = walk(ctls[1]).find((n) => n.className.includes("sw"));
		assert.ok(sw, "s2 のトグルが無い");
		assert.equal(sw.disabled, false, "s2 のトグルが無効のまま");
		assert.ok(sw._lis.click && sw._lis.click.length, "s2 のトグルにハンドラが無い");
	});

	// 全ボタンを 1 回ずつ押して、飛んだ URL を集める
	const all = [
		...buttonsOf("global"),
		...buttonsOf("sessions"),
		...buttonsOf("serve"),
	];
	for (const b of all) {
		b._lis.click[0]();
		await flush();
	}
	const writes = urls.filter((u) => !u.startsWith("/api/dashboard"));
	if (process.env.KB_DEBUG) console.log(writes.join("\n"));

	await check("vm: 書き込み fetch はすべて scope= と sid= を載せる", () => {
		assert.ok(writes.length >= 10, `書き込みが少なすぎる: ${writes.length}`);
		for (const u of writes) {
			assert.ok(u.includes("scope="), `scope が無い: ${u}`);
			assert.ok(/[?&]sid=[^&]+/.test(u), `sid が無い: ${u}`);
		}
		assert.ok(writes.some((u) => u.includes("sid=s2")), "s2 のボードに書き込む経路が無い");
		// #55: s2 の書き込みは s2 自身の sid を使う（driver の sid を使い回さない）。
		for (const u of writes.filter((x) => x.includes("sid=s2"))) assert.ok(u.includes("scope=session"), u);
	});

	await check("vm: 各操作が正しい既存 API を叩く", () => {
		const has = (...frags) => writes.some((u) => frags.every((f) => u.includes(f)));
		assert.ok(has("/api/schedule?", "&id=1&", "at=%2B5m", "scope=session", "sid=s1"), "schedule +5m が無い");
		assert.ok(has("/api/schedule?", "&id=1&", "at=%2B1h"), "schedule +1h が無い");
		assert.ok(has("/api/schedule?", "&id=1&", "at="), "明日9時（ISO）が無い");
		assert.ok(has("/api/modes?", "key=doingLoop", "value=on", "scope=session", "sid=s1"), "modes トグルが無い");
		assert.ok(has("/api/interval?", "min=10", "scope=session", "sid=s1"), "interval が無い");
		assert.ok(has("/api/priority?", "&id=1&", "n=6", "scope=session", "sid=s1"), "priority ▲ が無い");
		assert.ok(has("/api/priority?", "&id=1&", "n=4", "scope=session", "sid=s1"), "priority ▼ が無い");
		assert.ok(has("/api/schedule?", "&id=4&", "blocked=%E4%B8%80%E6%99%82%E5%81%9C%E6%AD%A2", "scope=session", "sid=s1"), "DOING 全停止が無い");
		assert.ok(has("/api/modes?", "key=autoPick", "value=on", "scope=global", "sid=s1"), "GLOBAL のモードが global スコープでない");
		assert.ok(has("/api/serve", "action=remove", "id=abcdef0123456789", "scope=global", "sid=s1"), "serve 停止が無い");
		// #66-security: 元は del=1 (実ファイル削除) も飛ばしていた。削除経路は撤去済み。
		assert.ok(!writes.some((u) => u.includes("del=1")), "del=1 を飛ばす操作が残っている");
	});

	await check("vm: 既に blocked の DOING は全停止の対象から外れる", () => {
		// #55: s2 の操作ボタンも押しているので、s1 と s2 の 1 枚ずつが対象。
		const stopUrls = writes.filter((u) => u.includes("blocked="));
		assert.equal(stopUrls.length, 2, `停止対象は 2 枚のはず: ${stopUrls.join(", ")}`);
		const s1 = stopUrls.filter((u) => u.includes("sid=s1"));
		const s2 = stopUrls.filter((u) => u.includes("sid=s2"));
		assert.equal(s1.length, 1, `s1 の停止は 1 枚のはず: ${s1.join(", ")}`);
		assert.equal(s2.length, 1, `s2 の停止は 1 枚のはず: ${s2.join(", ")}`);
		assert.ok(s1[0].includes("id=4"), "s1 で停止したのが別のカード");
		assert.ok(s2[0].includes("id=3"), "s2 で停止したのが別のカード");
		assert.ok(doingCards().length > 0, "doing 列が描画されていない（D&D 先が無い）");
	});
}

// --- 4. writeBoardHtml が出す実ファイル + 新端点 -------------------------------
await flush();
await check("writeBoardHtml の dashboard.html に #30/#31 の UI が全部ある", () => {
	const out = `${HOME_DIR}/.pi/kanban/dashboard.html`;
	assert.ok(existsSync(out), `${out} が無い`);
	const disk = readFileSync(out, "utf8");
	for (const [label, frag] of [
		["発火予定表示", '"発火 "'],
		["+5m", 'fire("+5m"'],
		["+1h", 'fire("+1h"'],
		["明日9時", "明日9時"],
		["D&D draggable", 'card.setAttribute("draggable"'],
		["D&D drop", 'addEventListener("drop"'],
		["優先度バッジ", '"P" + prioOf(c)'],
		["ループトグル", 'sw("doingLoop"'],
		["ピックトグル", 'sw("autoPick"'],
		["間隔入力", 'iv.type = "number"'],
		["DOING 全停止", "DOING 全停止"],
		["serve 停止", '"停止"'],
		// #66-security: "削除" ボタンは撤去した（GET で unlink できる穴）。
	]) {
		assert.ok(disk.includes(frag), `${label} が実ファイルに無い (${frag})`);
	}
});

// 実サーバ: /api/serve の停止 / 削除
const live = `${HOME_DIR}/workspace/live.html`;
const keep = `${HOME_DIR}/workspace/keep.html`;
writeFileSync(live, "<h1>live</h1>");
writeFileSync(keep, "<h1>keep</h1>");
writeFileSync(
	`${HOME_DIR}/.pi/kanban/serve.json`,
	JSON.stringify({
		entries: [
			{ id: "abcdef0123456789", path: live, createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "fedcba9876543210", path: keep, createdAt: "2026-01-01T00:00:00.000Z" },
		],
	}),
);

const status = async (qs) => (await tf(`${BASE}/api/serve?${qs}`)).status;
const entries = () => JSON.parse(readFileSync(`${HOME_DIR}/.pi/kanban/serve.json`, "utf8")).entries;

await check("/api/serve action=remove は登録を外すがファイルは残す", async () => {
	assert.equal(await status("action=remove&id=fedcba9876543210"), 200);
	assert.ok(!entries().some((e) => e.id === "fedcba9876543210"), "登録が残っている");
	assert.ok(existsSync(keep), "ファイルを消してしまった");
});

await check("/api/serve del=1 は登録を外すがファイルは残す（HTTP に unlink は無い）", async () => {
	assert.equal(await status("action=remove&id=abcdef0123456789&del=1"), 200);
	assert.ok(!entries().some((e) => e.id === "abcdef0123456789"), "登録が残っている");
	assert.ok(existsSync(live), "HTTP 経由でファイルが消えた");
});

await check("/api/serve は id 無し・不正アクションを 400 で弾く", async () => {
	assert.equal(await status("action=remove"), 400);
	assert.equal(await status("id=abcdef0123456789"), 400);
	assert.equal(await status("action=nuke&id=abcdef0123456789"), 400);
	assert.equal(await status("action=remove&id=deadbeefdeadbeef"), 404);
});

for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`kanban-dashboard-cards: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
