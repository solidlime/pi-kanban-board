// #24: /serve の Host から serve-host.json を学習するときの優先規則の自己検証。
// ループバック (127.0.0.1 / localhost / ::1 / ::ffff:127.0.0.1) は「ブラウザ」とも
// 「コンテナ内の機械的アクセス」とも読める弱い証拠。非ループバックは後者ではあり得ない
// ので強い証拠。弱い証拠が強い証拠を上書きしてはならない。
// フレームワーク無しで `node tests/kanban-host-priority.test.mjs`。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer as netServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-host-priority-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace/site`, { recursive: true });
process.env.HOME = HOME_DIR;

const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

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

// --- server 起動（このテスト専用ポート） --------------------------------------
const tools = new Map();
mod.default({
	registerCommand() {},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
});
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const serve = tools.get("serve");
assert.ok(serve, "serve ツールが registerTool されている");
const call = (args) => serve.execute("t", args, null, () => {});

const HOST_JSON = `${HOME_DIR}/.pi/kanban/serve-host.json`;
const SITE = `${HOME_DIR}/workspace/site`;
const readHost = () => {
	try {
		return JSON.parse(readFileSync(HOST_JSON, "utf8")).host;
	} catch {
		return null;
	}
};
const clearHost = () => rmSync(HOST_JSON, { force: true });

// Host を指定して /serve に投げる (fetch は Host を差し替えられない)
function hostRequest(path, host) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: host } },
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, body: raw }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}
const learn = async (host) => {
	const res = await hostRequest("/serve/", host);
	assert.equal(res.status, 200, `Host: ${host} -> ${res.status} ${res.body}`);
};

// --- 2: 既存が無ければループバックでも保存する (今の #22 の挙動) --------------
{
	clearHost();
	await learn("127.0.0.1:8789");
	check("2 既存無しの Host: 127.0.0.1 は保存される (ポートは落とす)", () => {
		assert.equal(readHost(), "127.0.0.1");
	});
}

// --- 3: ループバック -> 非ループバック は上書き (強い証拠が勝つ) --------------
{
	await learn("nas:8789");
	check("3 Host: 127.0.0.1 -> Host: nas は nas に更新される", () => {
		assert.equal(readHost(), "nas");
	});
}

// --- 1 / 6: 非ループバック -> ループバック は保持、発行 URL も nas のまま -----
{
	await learn("127.0.0.1:8789");
	check("1 Host: nas -> Host: 127.0.0.1 は nas のまま (上書きしない)", () => {
		assert.equal(readHost(), "nas");
	});
	const add = await call({ action: "add", path: SITE });
	check("6 保持された nas が serve add の URL ホストになる", () => {
		const url = new URL(add.content[0].text);
		assert.equal(url.hostname, "nas", add.content[0].text);
		assert.equal(url.port, String(PORT), add.content[0].text);
	});
}

// --- 4: ループバック同士は上書き可 ---------------------------------------------
{
	clearHost();
	await learn("localhost:8789");
	await learn("127.0.0.1:8789");
	check("4 Host: localhost -> Host: 127.0.0.1 は 127.0.0.1 に更新される", () => {
		assert.equal(readHost(), "127.0.0.1");
	});
}

// --- 5: 非ループバック同士は上書き ---------------------------------------------
{
	clearHost();
	await learn("nas:8789");
	await learn("otherhost:8789");
	check("5 Host: nas -> Host: otherhost は otherhost に更新される", () => {
		assert.equal(readHost(), "otherhost");
	});
}

// --- ipv6 のループバック綴りも同じ規則 (::1 / ::ffff:127.0.0.1) ----------------
{
	for (const v6 of ["[::1]:8789", "[::ffff:127.0.0.1]:8789"]) {
		clearHost();
		await learn("nas:8789");
		await learn(v6);
		check(`ipv6 ${v6} は nas を上書きしない`, () => {
			assert.equal(readHost(), "nas", `after ${v6}`);
		});
		clearHost();
		await learn(v6);
		check(`ipv6 ${v6} は既存無しなら保存される`, () => {
			assert.equal(readHost(), v6.slice(0, v6.indexOf("]") + 1), `after ${v6}`);
		});
	}
}

// --- 学習値が非ループバックでも、コンテナ ID は従来どおり拒否 (#22 は無傷) -----
{
	clearHost();
	await learn("nas:8789");
	const { hostname } = await import("node:os");
	await learn(hostname());
	check("コンテナ ID は優先規則に関係なく学習しない", () => {
		assert.equal(readHost(), "nas");
	});
}

// --- POST /api/host は優先規則の対象外 (#22 / 20-12 の挙動を維持) --------------
{
	clearHost();
	await learn("nas:8789");
	const report = await new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: PORT,
				path: "/api/host",
				method: "POST",
				headers: { "Content-Type": "application/json" },
			},
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, body: raw }));
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify({ host: "127.0.0.1" }));
	});
	check("POST /api/host は明示報告なのでループバックでも保存する (#22 維持)", () => {
		assert.equal(report.status, 200, report.body);
		assert.equal(readHost(), "127.0.0.1");
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
