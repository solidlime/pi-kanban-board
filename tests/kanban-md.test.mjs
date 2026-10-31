// カード本文の Markdown 記法 (md) の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-md.test.mjs`。
// md() は web/md.js にあり、ビルドで dashboard にインライン化される。同じソースを評価して検査する。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-md-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
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
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
// md() now lives in web/md.js; the build inlines it into the dashboard literal.
const MD_JS = readFileSync(fileURLToPath(new URL("../web/md.js", import.meta.url)), "utf8");

// ブラウザが受け取るのと同じソースを評価する (バッククォート無し / ${無し なので new Function で安全)。
const { md } = new Function(`${MD_JS}\nreturn { esc: esc, md: md };`)();

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
const SRC = readFileSync(fileURLToPath(new URL("../web/dashboard.html", import.meta.url)), "utf8");
check("カード本文は md(c.text) （#84: テンプレートは dashboard のみ）", () => {
	assert.equal((SRC.match(/md\(c\.text\)/g) || []).length, 1);
	assert.ok(!SRC.includes("esc(c.text)"));
});
check("md() の定義は web/md.js の 1 箇所だけ", () => {
	assert.equal((MD_JS.match(/function md\(s\)/g) || []).length, 1, "md() の定義は web/md.js の 1 箇所");
	assert.equal((SRC.match(/__KB_MD_JS__/g) || []).length, 1, "dashboard への注入は 1 箇所");
	// 直書きの二枚目を許さない: プレースホルダを外した本文に md() は居ない
	assert.equal((SRC.replace("__KB_MD_JS__", "").match(/function md\(s\)/g) || []).length, 0, "dashboard に md() を直書きしている");
});

if (failures.length) {
	console.error(`FAIL ${failures.length} / pass ${passed}`);
	for (const f of failures) console.error(" -", f);
	setTimeout(() => process.exit(1), 100);
}
if (!failures.length) console.log(`ok ${passed} pass`);
