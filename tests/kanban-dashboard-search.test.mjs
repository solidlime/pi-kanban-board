// #21 全ボード横断のカード検索の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-search.test.mjs`。
// 静的マークアップ検査だけだと「cardHit が text しか見ない」退行を検知できないので、
// web/dashboard.html から cardHit を抜き出して new Function で評価し、挙動を直接見る。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-search-home";
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
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const html = await (await tf(`${BASE}/`)).text();

// 波括弧の対応を数えて関数の終わりを探す。cardHit は入れ子の関数を持たないので単純なカウンタで足りる。
function extractFn(src, name) {
	const at = src.indexOf("function " + name + "(");
	assert.ok(at >= 0, name + " が無い");
	let i = src.indexOf("{", at);
	const from = i;
	let depth = 0;
	for (; i < src.length; i += 1) {
		if (src[i] === "{") depth += 1;
		else if (src[i] === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	assert.ok(i > from, name + " の終わりが見つからない");
	return new Function(src.slice(at, i + 1) + "\nreturn " + name + ";")();
}

const cardHit = extractFn(html, "cardHit");
// 呼び出し側は query を trim + toLowerCase 済みで渡す（:1990 相当）。
const hit = (c, q) => cardHit(c, String(q).trim().toLowerCase());

// --- 1. 空クエリは全カードを通す -------------------------------------------
check("q === \"\" は全カードを通す（早期 return）", () => {
	assert.equal(hit({ id: 1, col: "todo", text: "りんご" }, ""), true);
	assert.equal(hit({ id: 2, col: "done" }, ""), true);
	assert.equal(hit({}, ""), true);
});

// --- 2. 本文の部分一致（大小無視） -----------------------------------------
check("text の部分一致（大小無視）", () => {
	const c = { id: 1, col: "todo", text: "Fix Login Flow" };
	assert.equal(hit(c, "login"), true);
	assert.equal(hit(c, "LOGIN"), true);
	assert.equal(hit(c, "in fl"), true);
	assert.equal(hit(c, "りんご"), false);
	assert.equal(hit({ id: 2, col: "todo" }, "x"), false, "text 無しで落ちてはいけない");
});

// --- 3. id は完全一致のみ（"7" が 17 に当たらない） -------------------------
check("id は \"7\" と \"#7\" の完全一致のみ", () => {
	const c7 = { id: 7, col: "todo", text: "aaa" };
	const c17 = { id: 17, col: "todo", text: "bbb" };
	const c27 = { id: 27, col: "todo", text: "ccc" };
	assert.equal(hit(c7, "7"), true);
	assert.equal(hit(c7, "#7"), true);
	assert.equal(hit(c17, "7"), false, "\"7\" が id 17 に当たっている");
	assert.equal(hit(c27, "7"), false, "\"7\" が id 27 に当たっている");
	assert.equal(hit(c17, "17"), true);
	assert.equal(hit(c17, "#17"), true);
	assert.equal(hit(c17, "#1"), false, "#1 が #17 に当たっている");
	assert.equal(hit(c7, "#"), false, "\"#\" 単独で全カードに当たっている");
});

// --- 4. text 以外の語彙で引ける ---------------------------------------------
check("project / sid / sessionId / commit / blocked / labels で引ける", () => {
	const c = {
		id: 3,
		col: "todo",
		text: "本文",
		project: "pi-kanban-board",
		sid: "cwd:abc123",
		sessionId: "sess-xyz",
		commit: "a1b2c3d",
		blocked: "認証トークン待ち",
		labels: ["bug", "調査"],
	};
	assert.equal(hit(c, "kanban"), true);
	assert.equal(hit(c, "cwd:abc"), true);
	assert.equal(hit(c, "sess-xy"), true);
	assert.equal(hit(c, "a1b2c3d"), true);
	assert.equal(hit(c, "認証トークン"), true);
	assert.equal(hit(c, "bug"), true, "labels で引けない");
	assert.equal(hit(c, "調査"), true, "日本語ラベルで引けない");
	assert.equal(hit(c, "nope"), false);
});

// --- 5. commit は小文字保存 + query 小文字化で大文字クエリでも当たる -------
check("commit は大文字クエリでも当たる（query 側が小文字化済み）", () => {
	const c = { id: 4, col: "done", text: "t", commit: "a1b2c3d" };
	assert.equal(hit(c, "A1B2C3D"), true);
	assert.equal(hit(c, "a1b2"), true);
});

// --- 6. 内部値は検索対象外 -------------------------------------------------
check("img / estimate / col / blocks / priority / movedBy では引けない", () => {
	const c = {
		id: 5,
		col: "doing",
		text: "本文",
		img: "shot.png",
		estimate: "3h",
		blocks: [6],
		priority: "high",
		movedBy: "agent-042",
	};
	assert.equal(hit(c, "doing"), false, "col で引けている");
	assert.equal(hit(c, "shot.png"), false, "img で引けている");
	assert.equal(hit(c, "3h"), false, "estimate で引けている");
	assert.equal(hit(c, "high"), false, "priority で引けている");
	assert.equal(hit(c, "6"), false, "blocks で引けている");
	assert.equal(hit(c, "agent-0"), false, "movedBy（UI に出ない内部値）で引けている");
});

// --- 7. カードを描く板（renderProject）が cardHit を通る -------------------
check("cardHit(x, query) は renderProject から呼ばれる", () => {
	assert.equal((html.match(/cardHit\(x, query\)/g) || []).length, 1);
	const pAt = html.indexOf("function renderProject(");
	assert.ok(pAt >= 0, "renderProject が無い");
	// センチネル未検査だと slice(pAt, -1) が末尾 1 文字を落とすだけで静かに全文へ広がる。
	const pEnd = html.indexOf("function serveLeft(", pAt);
	assert.ok(pEnd > pAt, "serveLeft のセンチネルが無い");
	const p = html.slice(pAt, pEnd);
	assert.match(p, /cardFilterOk\(x, all\) && \(!search \|\| cardHit\(x, query\)\)/);
	// 旧述語（text だけ見る実装）が残っていないこと。
	assert.doesNotMatch(html, /String\(x\.text \|\| ""\)\.toLowerCase\(\)/);
});

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-dashboard-search: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
