// カード本文の Markdown 記法 (md) の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-md.test.mjs`。
// KANBAN_MD_JS はブラウザ側と同じ関数ソースなので、それを評価して純関数として検査する。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-md-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// モジュールは import 時に KANBAN_PORT を読むので、空きポートを先に確保する。
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

const { createJiti } = createRequire(import.meta.url)(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

// ブラウザが受け取るのと同じソースを評価する (バッククォート無し / ${無し なので new Function で安全)。
const { md } = new Function(`${mod.KANBAN_MD_JS}\nreturn { esc: esc, md: md };`)();

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

// --- 記法 (仕様どおり出力) ---------------------------------------------------
check("**太字** → <strong>", () => assert.equal(md("**太字**"), "<strong>太字</strong>"));
check("`x` → <code>", () => assert.equal(md("`x`"), "<code>x</code>"));
check("[a](https://e.com) → <a ...>a</a>", () =>
	assert.equal(
		md("[a](https://e.com)"),
		'<a href="https://e.com" target="_blank" rel="noopener noreferrer">a</a>',
	));
check("改行 → <br>", () => assert.equal(md("a\nb"), "a<br>b"));
check("- a\\n- b → <ul><li>a</li><li>b</li></ul>", () =>
	assert.equal(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>"));

// --- セキュリティ (エスケープ優先・URL スキーム制限) -------------------------
check("[a](javascript:alert(1)) はリンクにならない", () => {
	const out = md("[a](javascript:alert(1))");
	assert.ok(!out.includes("<a"), out);
});
check("[a](data:...) はリンクにならない", () => {
	const out = md("[a](data:text/html;base64,PHN2Zz4=)");
	assert.ok(!out.includes("<a"), out);
});
check("<script> はタグとして出ない", () => {
	const out = md("<script>alert(1)</script>");
	assert.ok(!out.includes("<script"), out);
	assert.equal(out, "&lt;script&gt;alert(1)&lt;/script&gt;");
});
check("link label 内のタグもエスケープ", () => {
	const out = md("[<img src=x onerror=alert(1)>](https://e.com)");
	assert.ok(!out.includes("<img"), out);
});
check("太字内のタグもエスケープ", () => assert.equal(md("**<b>**"), "<strong>&lt;b&gt;</strong>"));
check("http:// も許可", () => assert.ok(md("[a](http://e.com)").includes('<a href="http://e.com"')));
check("生の HTML は常にエスケープ (< が残らない)", () => {
	const out = md('<a href="https://e.com">x</a>');
	assert.ok(!out.includes("<a href"), out);
});

// --- 適用範囲 (dashboard だけが md を使う / esc(c.text) は消えている) -----------
const SRC = readFileSync(new URL("../extensions/kanban.ts", import.meta.url).pathname, "utf8");
check("カード本文は md(c.text) （#84: テンプレートは dashboard のみ）", () => {
	assert.equal((SRC.match(/md\(c\.text\)/g) || []).length, 1);
	assert.ok(!SRC.includes("esc(c.text)"));
});
check("md() の定義は KANBAN_MD_JS の 1 箇所だけ", () => {
	assert.equal((SRC.match(/function md\(s\)/g) || []).length, 1);
	assert.equal((SRC.match(/KANBAN_MD_JS/g) || []).length, 2); // 定義1 + 注入1
});

if (failures.length) {
	console.error(`FAIL ${failures.length} / pass ${passed}`);
	for (const f of failures) console.error(" -", f);
	process.exit(1);
}
console.log(`ok ${passed} pass`);
