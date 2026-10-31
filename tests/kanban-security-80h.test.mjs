// #80-⑨: Host allowlist。same-host Origin 判定は DNS rebinding に無力 (攻撃者のドメインが
// 127.0.0.1 に解決すれば、ブラウザから見て same-origin になり Host ヘッダでしか区別できない)。
// そこで Host ヘッダのホスト部を「このマシンが名乗る名前の有限集合」と照合し、外れたら 403。
// フレームワーク無しで `node tests/kanban-security-80h.test.mjs`。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { tokenHeader } from "./helpers/token.mjs";

const HOME_DIR = "/tmp/kb80h/home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;

const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

// このマシンの非ループバック IPv4 (無ければループバックで代用)。allowlist が
// os.networkInterfaces() から動的に拾えていることの実測に使う。
const LAN_IP = (() => {
	const all = Object.values(networkInterfaces()).flatMap((l) => l ?? []);
	return all.find((a) => a.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";
})();

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));

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
		const res = await fetch(`http://127.0.0.1:${PORT}/favicon.ico`, { headers: { Cookie: tokenHeader() } });
		if (res.status < 500) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// fetch は Host を差し替えられないので生の http.request で叩く（curl -H "Host: ..." 相当）。
function withHost(host, path = "/api/kanban") {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: host, Cookie: tokenHeader() } },
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

const forbidden = (res) => {
	assert.equal(res.status, 403, `${res.status} ${res.body}`);
	assert.deepEqual(JSON.parse(res.body), { ok: false, error: "host not allowed" });
};

// --- 通るべき 4 種 -------------------------------------------------------------
for (const host of ["127.0.0.1", "localhost", LAN_IP, hostname()]) {
	await check(`許可: Host: ${host}:${PORT}`, async () => {
		const res = await withHost(`${host}:${PORT}`);
		assert.equal(res.status, 200, `${res.status} ${res.body}`);
	});
}

// ポート無しでも通る（allowlist はホスト部だけを見る）
await check("許可: Host: localhost (ポート無し)", async () => {
	const res = await withHost("localhost");
	assert.equal(res.status, 200, `${res.status} ${res.body}`);
});

// 同一マシンの IPv6 ループバック
await check("許可: Host: [::1]:PORT", async () => {
	const res = await withHost(`[::1]:${PORT}`);
	assert.equal(res.status, 200, `${res.status} ${res.body}`);
});

// `/` も同じゲートの下（token gate は `/` を素通しするので、ここが唯一の防波堤）
await check("許可: Host: localhost:PORT で / は 200", async () => {
	const res = await withHost(`localhost:${PORT}`, "/");
	assert.equal(res.status, 200);
});

// --- 弾くべき 3 種 -------------------------------------------------------------
for (const host of [`evil.example:${PORT}`, "attacker.test", "192.0.2.7:8789"]) {
	await check(`拒否: Host: ${host}`, async () => {
		forbidden(await withHost(host));
	});
}

// DNS rebinding の模擬: 攻撃者ドメインが 127.0.0.1 に解決しても Host で落ちる
await check("DNS rebinding: Host: evil.example は / でも 403", async () => {
	forbidden(await withHost("evil.example", "/"));
});

// /service/* と /serve/* も同じゲート。Cookie を送らせる前に弾くので 401 ではなく 403。
await check("拒否: Host: evil.example は /serve/ でも 403 (401 より手前)", async () => {
	forbidden(await withHost("evil.example", "/serve/"));
});

// 学習済みホストは allowlist を汚染しない（serve-host.json は Host から学ぶ値なので、
// それを信じると allowlist が自己汚染する）。`nas` はデプロイ既定として静的に許可済みな
// ので、代表は NIC にも env にも無い名前を使う。
await check("Host: learned.example は 403 のまま (学習値は allowlist に入らない)", async () => {
	forbidden(await withHost("learned.example:8789", "/serve/"));
});

// --- KANBAN_HOSTS の逃げ道 -----------------------------------------------------
await check("KANBAN_HOSTS=myhost.ts.net で別名が通る", async () => {
	process.env.KANBAN_HOSTS = "myhost.ts.net:8789";
	try {
		const other = await withHost("myhost.ts.net:8789");
		assert.equal(other.status, 200, `${other.status} ${other.body}`);
		// 追加しても allowlist は広がらない
		forbidden(await withHost("evil.example:8789"));
	} finally {
		delete process.env.KANBAN_HOSTS;
	}
	// 消せば元に戻る（per-request 読みなので再起動不要）
	forbidden(await withHost("myhost.ts.net:8789"));
});

console.log(`kanban-security-80h: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
