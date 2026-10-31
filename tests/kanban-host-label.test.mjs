// #94: the board title must agree with the /serve URLs it hands out.
//
// The title used `os.hostname()` directly, so on a container whose /etc/hostname is a
// docker id the page read "KANBAN - 0ac4a588fea8" while every serve URL said "nas".
// `serve-host.json` is where the learned, browser-facing name lives; the title has to
// read it too.
//
// The label is resolved once at import time, so the fixture has to exist before the
// import. Each test file runs in its own process, so this does not disturb the other
// tests' isolated HOME.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-host-label-home";
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
const BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;

// The learned host, as the board page would have persisted it after being opened at
// http://nas:8789/.
writeFileSync(
	`${HOME_DIR}/.pi/kanban/serve-host.json`,
	JSON.stringify({ host: "nas", at: new Date().toISOString() }),
);

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

// A stand-in for the extension API: enough to make the factory start the HTTP server.
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
		// not listening yet
	}
	await new Promise((r) => setTimeout(r, 100));
}

const failures = [];
let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ok ${name}`);
	} catch (e) {
		failures.push(`${name}: ${e.message}`);
		console.log(`  FAIL ${name}: ${e.message}`);
	}
}

const html = await (await tf(`${BASE}/`)).text();
check("#94 学習済みホストが <title> に入る", () => {
	assert.ok(html.includes("<title>KANBAN - nas</title>"), "タイトルが nas になっていない");
});

check("#94 学習済みホストが h1 にも入る", () => {
	assert.ok(html.includes('KANBAN - nas <span id="conn"'), "h1 が nas になっていない");
});

check("#94 コンテナ id がタイトルに漏れない", () => {
	assert.ok(!html.includes(`KANBAN - ${hostname()}`), "os.hostname() がそのまま出ている");
});

check("#94 プレースホルダが残らない", () => {
	assert.ok(!html.includes("__KB_HOST__"), "置換されていない");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const f of failures) console.error(`  FAIL ${f}`);
}
// The extension keeps the HTTP server open; exiting is how the other suites end too.
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
