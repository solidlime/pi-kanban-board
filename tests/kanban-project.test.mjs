// Phase 0: カードの「プロジェクト次元」(Card.project = slug)。
// フレームワーク無しで `node tests/kanban-project.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// 契約: project は書き込み境界で normalizeProject を通す（小文字・[a-z0-9._-] 以外除去・24 文字）。
// 空 = 無所属 = キーごと削除。ループ（autoPick / 注入）には一切影響しない。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";

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
const boardOf = (sid = SID) => JSON.parse(readFileSync(`${KANBAN}/sessions/${sid}.json`, "utf8"));
const cardNamed = (text, sid = SID) => boardOf(sid).cards.find((c) => c.text === text);

// --- 1. 純関数 -----------------------------------------------------------------
await check("normalizeProject: trim / 小文字化 / 不正文字除去 / 24 文字切捨て / 非文字列は \"\"", () => {
	assert.equal(mod.PROJECT_MAX, 24);
	assert.equal(mod.normalizeProject("  Foo  "), "foo");
	assert.equal(mod.normalizeProject("My Project!!/../x"), "myproject..x");
	assert.equal(mod.normalizeProject("Mixed_Case.9-x"), "mixed_case.9-x");
	assert.equal(mod.normalizeProject("a".repeat(30)), "a".repeat(24));
	assert.equal(mod.normalizeProject("日本語"), "");
	for (const v of [undefined, null, 42, {}, [], true]) {
		assert.equal(mod.normalizeProject(v), "", `${JSON.stringify(v)} が空にならない`);
	}
});

// --- 2. 書き込み経路（HTTP） -----------------------------------------------------

await check("/api/add?project=Foo → ボードに project: \"foo\"", async () => {
	const r = await tf(`${BASE}/api/add?scope=session&sid=${SID}&text=with+project&project=Foo`);
	assert.equal(r.status, 200);
	assert.equal(cardNamed("with project").project, "foo");
});

await check("/api/add（project なし）→ project キーが存在しない（後方互換）", async () => {
	const r = await tf(`${BASE}/api/add?scope=session&sid=${SID}&text=no+project`);
	assert.equal(r.status, 200);
	const c = cardNamed("no project");
	assert.ok(!("project" in c), "project キーが生えた");
});

const fooId = () => cardNamed("with project").id;

await check("/api/schedule?id&project=bar → 設定できる（at/blocked なしでも 400 にしない）", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=session&sid=${SID}&id=${fooId()}&project=bar`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.equal(cardNamed("with project").project, "bar");
});

await check("/api/add?project=<正規化不能> → 400（無言で捨てない）", async () => {
	const r = await tf(BASE + "/api/add?scope=session&sid=" + SID + "&text=bad+slug&project=" + encodeURIComponent("日本語"));
	assert.equal(r.status, 400, "status " + r.status);
	assert.match(String((await r.json()).error ?? ""), /project/, "400 の理由が project でない");
	assert.equal(cardNamed("bad slug"), undefined, "不正 project のカードが作られた");
});

await check("/api/schedule?project=<空白のみ> → 400 かつラベルは消えない", async () => {
	const id = cardNamed("with project").id;
	const before = cardNamed("with project").project;
	const r = await tf(BASE + "/api/schedule?scope=session&sid=" + SID + "&id=" + id + "&project=" + encodeURIComponent("   "));
	assert.equal(r.status, 400, "status " + r.status);
	assert.equal(cardNamed("with project").project, before, "400 なのにラベルが消えた");
});

await check("?fields=project → project だけが返る", async () => {
	const r = await tf(`${BASE}/api/kanban?scope=session&sid=${SID}&fields=project`);
	assert.equal(r.status, 200);
	const j = await r.json();
	const withP = j.session.cards.filter((c) => c.project === "bar");
	assert.equal(withP.length, 1, "project が射影から落ちている");
	assert.deepEqual(Object.keys(withP[0]), ["project"], "射影が project 以外も返している");
	assert.equal(j.session.cards.length, boardOf().cards.length, "射影でカードが減った");
});

await check("/api/schedule?project=（空）→ project キーが消える", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=session&sid=${SID}&id=${fooId()}&project=`);
	assert.equal(r.status, 200);
	assert.ok(!("project" in cardNamed("with project")), "空指定で project が残った");
});

	// 400 はディスク書き込みより前に返るので、in-memory の検証順序は HTTP では観測できない。
	// このテストが固定するのは「不正な組み合わせでは at が永続化されない」というディスク状態の契約だけ。
	await check("/api/schedule?at=<有効>&project=<不正> → 400 かつ at が適用されない", async () => {
	const id = fooId();
	const first = await tf(BASE + "/api/schedule?scope=session&sid=" + SID + "&id=" + id + "&at=2030-01-01T00:00:00Z");
	assert.equal(first.status, 200, "at だけの設定で status " + first.status);
	const armed = cardNamed("with project").nextFireAt;
	// + must stay encoded: a bare +1h decodes to a space and 400s on "at must be ISO" — that would pass for the wrong reason.
	const r = await tf(BASE + "/api/schedule?scope=session&sid=" + SID + "&id=" + id + "&at=2031-01-01T00:00:00Z&project=" + encodeURIComponent("日本語"));
	assert.equal(r.status, 400, "status " + r.status);
	assert.equal(cardNamed("with project").nextFireAt, armed, "400 なのに at が適用された");
});

await check("/api/upload?project=<不正> → 400 かつカードも media も増えない", async () => {
	const cardsBefore = boardOf().cards.length;
	const mediaDir = KANBAN + "/media";
	const mediaBefore = existsSync(mediaDir) ? readdirSync(mediaDir).length : 0;
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	const r = await tf(BASE + "/api/upload?scope=session&sid=" + SID + "&ext=png&project=" + encodeURIComponent("日本語"), {
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
	const legacy = { cards: [{ id: 1, text: "legacy", col: "todo", movedBy: "old" }], nextId: 2 };
	writeFileSync(`${KANBAN}/sessions/legacy-session.json`, JSON.stringify(legacy));
	const r = await tf(`${BASE}/api/kanban?scope=session&sid=legacy-session`);
	assert.equal(r.status, 200);
	const j = await r.json();
	assert.equal(j.session.cards[0].text, "legacy");
	assert.ok(!("project" in j.session.cards[0]), "legacy カードに project が生えた");
	// ダッシュボード側の集計も落ちない（project を読むのは表示だけ）
	const dash = await tf(`${BASE}/api/dashboard`);
	assert.equal(dash.status, 200);
});


await check("tool add/edit: project を正規化して付け、text を消さずに付け替えられる", async () => {
	const tool = tools.kanban;
	assert.ok(tool, "kanban tool が登録されていない");
	const ctx = { sessionManager: { getSessionId: () => SID } };
	writeFileSync(KANBAN + "/global.json", JSON.stringify({ cards: [], nextId: 1 }));
	const add = await tool.execute("c1", { action: "add", scope: "global", text: "tool alpha", project: "Gamma" }, null, null, ctx);
	assert.ok(!JSON.stringify(add).includes("error"), JSON.stringify(add).slice(0, 300));
	const gb = JSON.parse(readFileSync(KANBAN + "/global.json", "utf8"));
	const card = gb.cards.find((c) => c.text === "tool alpha");
	assert.ok(card, "tool add でカードが作られていない");
	assert.equal(card.project, "gamma", "tool add が project を正規化していない");
	const edit = await tool.execute("c2", { action: "edit", scope: "global", id: card.id, project: "delta" }, null, null, ctx);
	assert.ok(!JSON.stringify(edit).includes("error"), JSON.stringify(edit).slice(0, 300));
	const after = JSON.parse(readFileSync(KANBAN + "/global.json", "utf8")).cards.find((c) => c.id === card.id);
	assert.equal(after.project, "delta", "tool edit で付け替えられない");
	assert.equal(after.text, "tool alpha", "project だけの edit で text が消えた");
});

await check("tool add/edit: 正規化不能な project は fail（無言で無視しない）", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const count = () => JSON.parse(readFileSync(KANBAN + "/global.json", "utf8")).cards.length;
	const before = count();
	const add = await tool.execute("c3", { action: "add", scope: "global", text: "bad tool", project: "日本語" }, null, null, ctx);
	assert.equal(add.isError, true, "fail なのに isError でない: " + JSON.stringify(add).slice(0, 200));
	assert.ok(JSON.stringify(add).includes("must match"), "理由が返っていない");
	assert.equal(count(), before, "fail なのにカードが増えた");
});

// --- 3. ダッシュボード ----------------------------------------------------------
const html = await (await tf(`${BASE}/`)).text();

await check("ダッシュボード: #proj セレクト / .proj バッジ / projPick が uiSig に入る", () => {
	assert.ok(html.includes('<select id="proj" class="q"'), "プロジェクト絞り込みの select が無い");
	assert.ok(html.includes(".card .proj{"), ".proj の CSS が無い");
	assert.ok(html.includes('el("span", "proj", c.project)'), "project バッジを出す JS が無い");
	assert.ok(html.includes('var projPick = "";'), "projPick が無い");
	assert.ok(html.includes('"\\u0000"'), "無所属の番兵が無い");
	assert.ok(!html.includes("\u0000"), "生成 HTML に実 NUL が入っている（テンプレートのエスケープ漏れ）");
	assert.match(
		html,
		/function uiSig\(\)\{ return JSON\.stringify\(\[sessOpen, gOpen, collapsed, query, projPick\]\)/,
		"uiSig に projPick が入っていない",
	);
});

// --- 4. ブラウザ側 JS を vm で走らせて絞り込みと新規作成を確認 --------------------
{
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));

	const makeEl = () => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			get innerHTML() { return this._html || ""; },
			set innerHTML(v) { this._html = String(v); if (v === "") this.children.length = 0; },
			textContent: "",
			title: "",
			href: "",
			target: "",
			rel: "",
			type: "",
			value: "",
			placeholder: "",
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
		stats: { sessions: 1, active: 1, todo: 3, doing: 0, done: 0, serve: 0, media: 0 },
		global: {
			counts: { todo: 2, doing: 0, done: 0 },
			cards: [
				{ id: 10, text: "g alpha", col: "todo", project: "alpha" },
				{ id: 11, text: "g beta", col: "todo", project: "beta" },
			],
		},
		sessions: [
			{
				id: "s1",
				name: "kotomi",
				cwd: "/tmp",
				isActive: true,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: {}, global: {} },
				counts: { todo: 3, doing: 0, done: 0 },
				cards: [
					{ id: 1, text: "alpha card", col: "todo", project: "alpha" },
					{ id: 2, text: "beta card", col: "todo", project: "beta" },
					{ id: 3, text: "orphan card", col: "todo" },
				],
			},
		],
		serve: [],
	};
	const urls = [];
	const sandbox = {
		document,
		window: {},
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
	const textOf = (root, txt) => walk(root).some((n) => n.textContent === txt || String(n.innerHTML || '') === txt);
	// Counters read "TODO 1/3 ・ 更新 …", so the two count assertions need a substring match; everything else stays exact.
	const textIncludes = (root, txt) => walk(root).some((n) => (n.textContent && String(n.textContent).includes(txt)) || String(n.innerHTML || '').includes(txt));
	const addIn = () => walk(byId["sessions"]).find((n) => n.className === "addin");
	const pick = (v) => {
		byId["proj"].value = v;
		byId["proj"]._lis.change.forEach((fn) => fn({}));
	};

	await check("vm: select の選択肢は 全部 / (無所属) / 実在する slug", () => {
		const values = new Set(byId["proj"].children.map((o) => o.value));
		assert.deepEqual([...values].sort(), ["", "\u0000", "alpha", "beta"]);
		assert.ok(textOf(byId["proj"], "alpha"), "slug の選択肢ラベルが alpha でない");
		assert.ok(textOf(byId["proj"], "(無所属)"), "無所属の選択肢が無い");
		assert.equal(byId["proj"].value, "", "初期選択が全部でない");
	});

	await check("vm: slug を選ぶとそのプロジェクトのカードだけ残る", () => {
		pick("alpha");
		assert.equal(byId["proj"].value, "alpha", "選択値が失われた");
		assert.ok(textOf(byId["sessions"], "alpha card"), "alpha card が出ていない");
		assert.ok(!textOf(byId["sessions"], "beta card"), "beta card が残っている");
		assert.ok(!textOf(byId["sessions"], "orphan card"), "無所属カードが残っている");
	});

	await check("vm: (無所属) は project を持たないカードだけ残る", () => {
		pick("\u0000");
		assert.ok(textOf(byId["sessions"], "orphan card"), "無所属カードが出ていない");
		assert.ok(!textOf(byId["sessions"], "alpha card"), "alpha card が残っている");
	});

	await check("vm: 絞り込み中の新規作成は project を載せる（要の UX）", () => {
		pick("alpha");
		urls.length = 0;
		const inp = addIn();
		assert.ok(inp, "追加 input が無い");
		inp.value = "new under alpha";
		inp._lis.keydown.forEach((fn) => fn({ key: "Enter", preventDefault() {} }));
		const add = urls.find((u) => u.includes("/api/add"));
		assert.ok(add, "/api/add が呼ばれていない");
		assert.ok(add.includes("project=alpha"), `project が載っていない: ${add}`);
	});

	await check("vm: 全部（\"\"）と (無所属) の新規作成は project を載せない", () => {
		for (const v of ["", "\u0000"]) {
			pick(v);
			urls.length = 0;
			const inp = addIn();
			inp.value = "tenantless";
			inp._lis.keydown.forEach((fn) => fn({ key: "Enter", preventDefault() {} }));
			const add = urls.find((u) => u.includes("/api/add"));
			assert.ok(add, `${v}: /api/add が呼ばれていない`);
			assert.ok(!add.includes("project="), `${v}: project が載った: ${add}`);
		}
	});


	await check("vm: project 絞り込みは畳んだ GLOBAL を強制展開する（旧実装では空のまま）", () => {
		pick("");
		const gh = walk(byId["global"]).find((n) => n.className === "sess-hd" && n._lis && n._lis.click.length > 0);
		assert.ok(gh, "GLOBAL ヘッダの click ハンドラが見つからない");
		gh._lis.click[0]({});
		assert.ok(!textOf(byId["global"], "g alpha"), "畳んだのにカードが見えている");
		pick("alpha");
		assert.ok(textOf(byId["global"], "g alpha"), "project 絞り込みで強制展開されていない");
		assert.ok(!textOf(byId["global"], "g beta"), "GLOBAL に beta カードが残っている");
	});

	await check("vm: 絞り込み中の SESSIONS 件数が「表示/全体」になる", () => {
		pick("alpha");
		assert.ok(textIncludes(byId["sessions"], "TODO 1/3"), "SESSIONS の件数が絞り込み後の値になっていない");
	});

	await check("vm: 絞り込み中の GLOBAL 件数が「表示/全体」になる", () => {
		pick("alpha");
		assert.ok(textIncludes(byId["global"], "TODO 1/2"), "GLOBAL の件数が絞り込み後の値になっていない");
	});

	await check("vm: 消えた slug を選んでいたら全部に戻る", () => {
		pick("gamma"); // payload に無い slug
		assert.equal(byId["proj"].value, "", "存在しない slug が選択されたまま");
	});
}

// --- 結果 -----------------------------------------------------------------------
if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-project)`);
// サーバは extension のプロセス内で listen したまま。テストは終わったので明示的に落とす。
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
