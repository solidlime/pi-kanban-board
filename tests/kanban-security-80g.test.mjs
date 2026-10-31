// #80-⑥: GET 経由の書き込みを 405 にする。書き込み系 11 経路 (+ /api/serve, /api/upload,
// /api/host, /api/selftest) は GET + クエリで状態を変える。すると unfurl bot / URL スキャナ /
// proxy の prefetch が、ユーザーが貼っただけの URL を踏んでカードを書き換える。#85 のトークンは
// Cookie を送らない相手を 401 で止めるが、(a) ログイン済みブラウザがリンクを踏む経路と
// (b) `?token=` を URL に含む共有リンクを bot が踏む経路は残る。
//
// 判定は Sec-Fetch-Site が「存在する」時だけ厳格: none (アドレスバー/ブックマーク) /
// cross-site / same-site からの書き込み GET は 405。same-origin は従来どおり通す
// (壊すと #38 の GUI が全滅する)。ヘッダ無しは暫定受理 — curl / 古いブラウザ / 別 pi を
// 壊さないため。フレームワーク無しで `node tests/kanban-security-80g.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { tokenHeader } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb80g/home";
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

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

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

// Sec-Fetch-Site を送るには生の http.request が要る（fetch は forbidden header なので
// 上書きできない = 実ブラウザと同じ制約）。未認証の実測も同じ経路で行う。
function send(path, { method = "GET", headers = {}, noToken = false, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const base = { Host: `127.0.0.1:${PORT}`, ...(noToken ? {} : { Cookie: tokenHeader() }), ...headers };
		const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: base }, (res) => {
			let raw = "";
			res.on("data", (c) => (raw += c));
			res.on("end", () => resolve({ status: res.statusCode, body: raw, allow: res.headers.allow }));
		});
		req.on("error", reject);
		if (body !== null) req.write(body);
		req.end();
	});
}

const refused = (res) => {
	assert.equal(res.status, 405, `${res.status} ${res.body}`);
	assert.deepEqual(JSON.parse(res.body), { ok: false, error: "method not allowed" });
};

// --- 実測表（そのまま固定する） ------------------------------------------------
await check("Sec-Fetch-Site: same-origin の GET /api/add は 200（従来どおり）", async () => {
	const res = await send("/api/add?scope=global&text=sameorigin", { headers: { "Sec-Fetch-Site": "same-origin" } });
	assert.equal(res.status, 200, `${res.status} ${res.body}`);
	assert.equal(JSON.parse(res.body).ok, true);
});

await check("Sec-Fetch-Site: none の GET /api/add は 405", async () => {
	refused(await send("/api/add?scope=global&text=none", { headers: { "Sec-Fetch-Site": "none" } }));
});

await check("Sec-Fetch-Site: cross-site の GET /api/add は 405", async () => {
	refused(await send("/api/add?scope=global&text=xsite", { headers: { "Sec-Fetch-Site": "cross-site" } }));
});

// same-site は #68 のゲートが 403 で通していた（右パネルの別ポートを想定）。GET 書き込みに
// 関しては 405 が新しい答え。same-origin だけが「そのページ自身の操作」。
await check("Sec-Fetch-Site: same-site の GET /api/add は 405", async () => {
	refused(await send("/api/add?scope=global&text=xsite2", { headers: { "Sec-Fetch-Site": "same-site" } }));
});

// 暫定受理: Sec-Fetch-Site を送らない相手はブラウザではない（curl / 古いブラウザ / 別 pi）。
// ここを 405 にすると、この文書化された逃げ道ごと壊れる。
await check("ヘッダ無しの GET /api/add は 200（暫定受理）", async () => {
	const res = await send("/api/add?scope=global&text=nofetch");
	assert.equal(res.status, 200, `${res.status} ${res.body}`);
	assert.equal(JSON.parse(res.body).ok, true);
});

// 仕様書の表は「POST /api/add は 200（従来どおり）」だが、実測は 405。#71 以前からの
// ディスパッチは POST を /api/host, /api/selftest, /api/upload にしか通さない（POST で
// カードを足す経路は存在しない）。この変更で POST の答えが動いていないことを固定する。
await check("POST /api/add は 405 のまま（この変更で POST の意味は変わらない）", async () => {
	const res = await send("/api/add?scope=global&text=post", { method: "POST" });
	assert.equal(res.status, 405, `${res.status} ${res.body}`);
});

await check("Sec-Fetch-Site: none の読み取り GET /api/kanban は 200（405 にしない）", async () => {
	const res = await send("/api/kanban", { headers: { "Sec-Fetch-Site": "none" } });
	assert.equal(res.status, 200, `${res.status} ${res.body}`);
	assert.equal(JSON.parse(res.body).ok, true);
});

await check("Sec-Fetch-Site: none のダッシュボード GET / は 200（既存動作）", async () => {
	const res = await send("/", { headers: { "Sec-Fetch-Site": "none" } });
	assert.equal(res.status, 200, `${res.status} ${res.body.slice(0, 80)}`);
	assert.match(res.body, /<html/i);
});

// 認証との順序: 未認証は 401 が先。405 を先に返すと「この経路は書き込みだ」という
// 情報をトークン無しの相手に渡し、既存の 401 契約も変わる。
await check("トークン無しの GET /api/add は 405 ではなく 401（認証が先）", async () => {
	const res = await send("/api/add?scope=global&text=nokey", { headers: { "Sec-Fetch-Site": "none" }, noToken: true });
	assert.equal(res.status, 401, `${res.status} ${res.body}`);
	assert.deepEqual(JSON.parse(res.body), { ok: false, error: "unauthorized" });
});

// --- 書き込み面の全数（GET で書ける経路 × Sec-Fetch-Site: none） ---------------
const WRITE_GET_ROUTES = [
	"add?text=x&col=todo&scope=global",
	"move?id=1&col=done&scope=global",
	"remove?id=1&scope=global",
	"rename?id=1&text=x&scope=global",
	"modes?key=doingLoop&value=on&scope=global",
	"interval?min=30&scope=global",
	"stuck?n=3&scope=global",
	"maxloops?n=5&scope=global",
	"resume?scope=global",
	"priority?id=1&n=2&scope=global",
	"schedule?id=1&at=2030-01-01T00:00:00Z&scope=global",
	"serve?id=deadbeef&action=remove",
	// 普段は POST 専用。GET では元々 400/404 だったが、書き込み面として 405 に揃える。
	"upload?scope=global&col=todo&ext=png",
	"host",
	"selftest",
];
for (const route of WRITE_GET_ROUTES) {
	const name = route.split("?")[0];
	await check(`GET /api/${name} + Sec-Fetch-Site: none は 405`, async () => {
		refused(await send(`/api/${route}`, { headers: { "Sec-Fetch-Site": "none" } }));
	});
	await check(`GET /api/${name} + Sec-Fetch-Site: same-origin は 405 にしない`, async () => {
		const res = await send(`/api/${route}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
		assert.notEqual(res.status, 405, `${res.status} ${res.body}`);
	});
	// 暫定受理は書き込み面の全経路で一貫していること（ヘッダ無し = 従来どおり dispatch へ）。
	await check(`GET /api/${name} ヘッダ無しは 405 にしない`, async () => {
		const res = await send(`/api/${route}`);
		assert.notEqual(res.status, 405, `${res.status} ${res.body}`);
	});
}

// 405 に Allow: GET を付けない（GET は同じ資源で認められている。断っているのは呼び出し元の
// 種類なので Allow は嘘になる）。ヘッダが増えていないことを固定する。
await check("405 に Allow ヘッダを付けない（判定は method ではなく caller）", async () => {
	const res = await send("/api/add?text=x&scope=global", { headers: { "Sec-Fetch-Site": "none" } });
	assert.equal(res.status, 405);
	assert.equal(res.allow, undefined, `allow=${res.allow}`);
});

// --- 対象外の経路 --------------------------------------------------------------
await check("GET /serve/ + none は 405 にしない（読み取り専用の配信）", async () => {
	const res = await send("/serve/", { headers: { "Sec-Fetch-Site": "none" } });
	assert.equal(res.status, 200, `${res.status} ${res.body.slice(0, 80)}`);
});

await check("GET /api/dashboard + none は 200（読み取り）", async () => {
	const res = await send("/api/dashboard", { headers: { "Sec-Fetch-Site": "none" } });
	assert.equal(res.status, 200, `${res.status} ${res.body.slice(0, 80)}`);
});

await check("GET /api/media/ + none は 405 にしない（読み取り）", async () => {
	const res = await send("/api/media/nothing.png", { headers: { "Sec-Fetch-Site": "none" } });
	assert.notEqual(res.status, 405, `${res.status} ${res.body}`);
});

// #68 の既存ゲートは POST については手を入れていない: cross-site は 403 のまま。
await check("POST /api/upload + cross-site は従来どおり 403", async () => {
	const res = await send("/api/upload?scope=global&col=todo&ext=png", {
		method: "POST",
		headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/octet-stream" },
		body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
	});
	assert.equal(res.status, 403, `${res.status} ${res.body}`);
});

await check("POST /api/upload + same-origin は通る（405 にしない）", async () => {
	const res = await send("/api/upload?scope=global&col=todo&ext=png", {
		method: "POST",
		headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/octet-stream" },
		body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
	});
	assert.notEqual(res.status, 405, `${res.status} ${res.body}`);
});

console.log(`kanban-security-80g: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
