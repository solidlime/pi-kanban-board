// #63/#64: a paint demo posts a canvas PNG (dataURL ~15-30KB) through /api/ehr, so the 128KB
// cap has to hold end to end: the value rides in the request LINE, which node's 16KB header
// default would answer with 431. One POST + one readback is the whole contract.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-quiz-big-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = process.env.HOME;

const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"));
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);
useMigrate(mod);
await settleMigration();

const commands = new Map();
const tools = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
});
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const base = `http://127.0.0.1:${PORT}/api/ehr`;
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

// 640x360 相当の png を模した 90KB のバイト列 → dataURL は ~120KB（128KB cap 内）。
const bytes = Buffer.alloc(90 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
const dataURL = `data:image/png;base64,${bytes.toString("base64")}`;
check("前提: dataURL は 100KB 超・128KB 以下", () => {
	assert.ok(dataURL.length > 100 * 1024, `len=${dataURL.length}`);
	assert.ok(dataURL.length <= 131072, `len=${dataURL.length}`);
});

const r = await tf(`${base}?id=64&key=paint&value=${encodeURIComponent(dataURL)}`, { method: "POST" });
const body = await r.json();
check("128KB POST: 200 / ok / count", () => {
	assert.equal(r.status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.count, 1);
});

const rows = await (await tf(`${base}?id=64&key=paint`)).json();
check("readback: 1 件・value は dataURL そのまま", () => {
	assert.equal(rows.length, 1);
	assert.equal(rows[0].value, dataURL);
});
check("readback: atob で元の png バイト列に戻る", () => {
	const b64 = rows[0].value.replace(/^data:image\/png;base64,/, "");
	assert.equal(Buffer.from(atob(b64), "binary").equals(bytes), true);
});

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`passed=${passed} failed=${failures.length}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
