// kanban #21 の自己検証: footer / GUI へ出るセッション名のサニタイズ。
// フレームワーク無しで `node tests/kanban-display-name.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-displayname-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
// Free port before the module reads KANBAN_PORT at import time.
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う。
const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
const { displayName } = mod;

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

// 1. <skill name="x"> のような生のタグ文字が消える。
check("山カッコと引用符が消える", () => {
	const out = displayName('<skill name="minimax-h3-creative-director">');
	assert.ok(!out.includes("<") && !out.includes(">") && !out.includes('"'), `残存: ${out}`);
	assert.equal(out, "skill name=minimax-h3-creative-director");
});

check("シングルクォートも消える", () => {
	assert.equal(displayName("it's a <b>name</b>"), "its a bname/b");
});

// 2. 改行・タブ・連続空白は 1 スペース、前後は trim。
check("改行/タブ/連続空白を 1 スペースへ", () => {
	assert.equal(displayName("  a\n\tb   c \r\n"), "a b c");
});

// 3. maxLen で切る。末尾に … を足さない。
check("長い名前は maxLen で切れる", () => {
	const out = displayName("x".repeat(100));
	assert.equal(out.length, 40);
	assert.equal(displayName("abcdef", 3), "abcdef".slice(0, 3));
	assert.ok(!displayName("x".repeat(100)).includes("…"), "末尾に … を足してはいけない");
	// 幅が足りない時に末尾が空白で終わらない（trim の後に切る）。
	assert.equal(displayName(`${"a".repeat(39)}   tail`), "a".repeat(39));
});

// 4. 空 / 空白のみ / 記号のみはフォールバック（空文字を返さない）。
check("空になったらフォールバック", () => {
	for (const raw of ["", "   \n\t ", "<>\"'"]) {
		const out = displayName(raw);
		assert.ok(out.length > 0, `空文字が返った: ${JSON.stringify(raw)}`);
		assert.equal(out, "(unnamed)");
	}
});

check("undefined 相当でも落ちない", () => {
	assert.equal(displayName("", 1), "(unnamed)");
});

// 5. footer の実経路: session_start -> refresh -> setWidget。
//    改行が 1 行に収まり、< を含まない 2 行固定。
const SESSION_NAME = '<skill name="minimax-h3-creative-director">\n\n  ';
const SID = "display-name-sid";
const widgetCalls = [];
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
const ctx = {
	hasUI: true,
	isIdle: () => true,
	ui: {
		notify() {},
		setWidget(_key, lines) {
			widgetCalls.push(lines);
		},
	},
	sessionManager: {
		getSessionId: () => SID,
		getSessionName: () => SESSION_NAME,
		getEntries: () => [],
	},
};
handlers.get("session_start")({}, ctx);

check("footer は 2 行固定", () => {
	assert.ok(widgetCalls.length > 0, "setWidget が呼ばれていない");
	const lines = widgetCalls[widgetCalls.length - 1];
	assert.equal(lines.length, 2, `lines=${JSON.stringify(lines)}`);
});

check("SESSION 行は 1 行・< 無し・サニタイズ済み", () => {
	const lines = widgetCalls[widgetCalls.length - 1];
	const sessionLine = lines[1];
	assert.ok(sessionLine.startsWith("SESSION:"), sessionLine);
	assert.ok(!sessionLine.includes("\n") && !sessionLine.includes("\r") && !sessionLine.includes("\t"), "改行/タブが残存");
	assert.ok(!sessionLine.includes("<") && !sessionLine.includes('"'), `タグ文字が残存: ${sessionLine}`);
	assert.match(sessionLine, /^SESSION: skill name=minimax-h3-creative-director: 0 todo \/ 0 doing/);
});

// 6. nudge / 注入に生のセッション名は入らない（= 注入側にサニタイズ対象は無い）。
check("nudge / 注入テキストに生のセッション名が入らない", () => {
	const marker = "minimax-h3-creative-director";
	const injection = mod.renderInjectionText({ cards: [{ id: 1, text: "todo", col: "todo" }] });
	const nudge = mod.continuationPrompt({ id: 1, text: "do it", col: "doing" }, "session");
	for (const [label, text] of [["injection", injection], ["nudge", nudge]]) {
		assert.ok(typeof text === "string" && text.length > 0, `${label} is empty`);
		assert.ok(!text.includes(marker), `${label} に生のセッション名が入っている`);
	}
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
