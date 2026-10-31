// #80-⑧: メディア実ファイルの削除を「猶予付き (.trash へ rename)」にする。誤操作・CSRF・
// バグで消えても 7 日以内なら `~/.pi/kanban/media/.trash/` から手で戻せる。ここは公開経路
// (/api/upload → /api/remove) と trashMedia のパス検証・配信の遮断を実測する。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import http from "node:http";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch, tokenHeader } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_ROOT = tmpdir();
const HOME_DIR = TMP_ROOT + "/kb80t/home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${join(HOME_DIR, ".pi/kanban/sessions")}`, { recursive: true });
mkdirSync(`${join(HOME_DIR, "workspace/site")}`, { recursive: true });
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
const BASE = `http://127.0.0.1:${PORT}`;

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
const api = mod.default({
	registerCommand() {},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
});
for (let i = 0; i < 60; i++) {
	try {
		const res = await fetch(`${BASE}/favicon.ico`, { headers: { Cookie: tokenHeader() } });
		if (res.status < 500) break;
	} catch {
		// まだ listen していない
	}
	await sleep(100);
}

const MEDIA = `${join(HOME_DIR, ".pi/kanban/media")}`;
const TRASH = `${join(MEDIA, ".trash")}`;
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);
const post = (query, body = PNG) =>
	tf(`${BASE}/api/upload?${query}`, {
		method: "POST",
		body,
		headers: { "Content-Type": "application/octet-stream" },
	});

/** Trashed twins of one original basename (`<epoch_ms>-<basename>`). */
const trashedAs = (name) => {
	try {
		return readdirSync(TRASH).filter((f) => f.endsWith(`-${name}`));
	} catch {
		return [];
	}
};

// 生パスをそのまま送る（fetch は `..` を正規化してしまうので比較にならない）。
const rawGet = (path) =>
	new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Cookie: tokenHeader() } },
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, body: raw }));
			},
		);
		req.on("error", reject);
		req.end();
	});

// --- 1. /api/remove は消さずに .trash へ移す ----------------------------------
let first;
await check("前提: /api/upload で実ファイルが出来る", async () => {
	const r = await post("scope=global&ext=png&col=todo");
	assert.equal(r.status, 200, `status=${r.status}`);
	const j = await r.json();
	first = j.card;
	assert.ok(existsSync(`${join(MEDIA, `${first.img}`)}`), `media にファイルが無い: ${first.img}`);
});

await check("/api/remove: MEDIA_DIR/<name> は消え、.trash/<epoch>-<name> が残る", async () => {
	const r = await tf(`${BASE}/api/remove?scope=global&id=${first.id}`);
	assert.equal(r.status, 200, `status=${r.status} ${await r.text()}`);
	assert.ok(!existsSync(`${join(MEDIA, `${first.img}`)}`), "実ファイルが残っている（消えていない）");
	const twins = trashedAs(first.img);
	assert.equal(twins.length, 1, `.trash に退避されていない: ${JSON.stringify(readdirSync(MEDIA))}`);
	assert.match(twins[0], new RegExp(`^\\d{13}-${first.img.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

// --- 2. TTL を超えた .trash のファイルは次の削除で消える -----------------------
let second;
await check("前提: 2 枚目をアップロード", async () => {
	const r = await post("scope=global&ext=png&col=todo");
	const j = await r.json();
	second = j.card;
	assert.ok(existsSync(`${join(MEDIA, `${second.img}`)}`), "2 枚目のファイルが無い");
});

await check("TTL 8 日超の .trash は掃除され、新しい退避ファイルは残る", async () => {
	mkdirSync(TRASH, { recursive: true });
	const dummy = `${TRASH}/0-expired-dummy.png`;
	writeFileSync(dummy, "old");
	const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	utimesSync(dummy, old, old);
	assert.ok(existsSync(dummy), "ダミーを置けていない");

	const r = await tf(`${BASE}/api/remove?scope=global&id=${second.id}`);
	assert.equal(r.status, 200, `status=${r.status}`);

	assert.ok(!existsSync(dummy), "TTL を超えたダミーが掃除されていない");
	const twins = trashedAs(second.img);
	assert.equal(twins.length, 1, `.trash に退避されていない: ${JSON.stringify(readdirSync(TRASH))}`);
	// 直前の 1 枚目の退避ファイルも TTL 内なので残っている。
	assert.equal(trashedAs(first.img).length, 1, "TTL 内の退避ファイルが消えている");
});

// --- 3. trashMedia は MEDIA_DIR の外を触らない --------------------------------
await check("trashMedia: MEDIA_DIR の外のパスは null を返し、ファイルは残る", async () => {
	const t = api.__test;
	const outside = `${join(HOME_DIR, "outside.txt")}`;
	writeFileSync(outside, "keep me");
	assert.equal(t.trashMedia(outside), null, "MEDIA_DIR 外なのに移動した");
	assert.ok(existsSync(outside), "MEDIA_DIR 外のファイルが消えた");

	// ../ での脱出（MEDIA_DIR の兄弟）
	const sibling = `${join(HOME_DIR, ".pi/kanban/sessions/sneak.json")}`;
	writeFileSync(sibling, "{}");
	assert.equal(t.trashMedia(`${join(MEDIA, "../sessions/sneak.json")}`), null, "../ で脱出できている");
	assert.ok(existsSync(sibling), "../ 経由で消えた");

	// 前方一致のなりすまし（/media と /media-evil）
	const lookalike = `${MEDIA}-evil/x.png`;
	mkdirSync(`${MEDIA}-evil`, { recursive: true });
	writeFileSync(lookalike, "x");
	assert.equal(t.trashMedia(lookalike), null, "接頭辞一致だけで通している");
	assert.ok(existsSync(lookalike), "なりすましディレクトリのファイルが消えた");
});

await check("trashMedia: MEDIA_DIR の中なら .trash へ移す（原子的 rename）", async () => {
	const name = "999-deadbeef.png";
	writeFileSync(`${join(MEDIA, `${name}`)}`, "bytes");
	const dest = api.__test.trashMedia(`${join(MEDIA, `${name}`)}`);
	assert.ok(dest && dest.startsWith(TRASH + sep), `戻り値が .trash のパスでない: ${dest}`);
	assert.ok(!existsSync(`${join(MEDIA, `${name}`)}`), "元ファイルが残っている");
	assert.ok(existsSync(dest), "退避先が無い");
});

await check("trashMedia: 古い mtime のファイルでも猶予の起点は「捨てた時刻」", async () => {
	// 8 日前にアップロードされたファイルを今捨てる。rename は mtime を引き継ぐので、
	// 起点を打ち直さないと次の削除で即座に掃除されてしまう。
	const name = "998-oldface.png";
	writeFileSync(`${join(MEDIA, `${name}`)}`, "bytes");
	const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	utimesSync(`${join(MEDIA, `${name}`)}`, old, old);
	const dest = api.__test.trashMedia(`${join(MEDIA, `${name}`)}`);
	assert.ok(dest && existsSync(dest), "退避できていない");

	// もう一度捨てる -> 掃除が走る。直前の退避分は TTL 内なので残ること。
	writeFileSync(`${join(MEDIA, "997-trigger.png")}`, "bytes");
	api.__test.trashMedia(`${join(MEDIA, "997-trigger.png")}`);
	assert.ok(existsSync(dest), "古い mtime を引き継いで即座に掃除されている");
});

// --- 4. .trash は配信されない -------------------------------------------------
await check("GET /api/media/.trash/<file> は取れない", async () => {
	const [victim] = trashedAs(first.img);
	assert.ok(victim, "退避ファイルが無い（前提が崩れている）");
	const res = await rawGet(`/api/media/.trash/${encodeURIComponent(victim)}`);
	// isSafeMediaName が "/" を弾く（名前は 1 セグメントだけ）。
	assert.equal(res.status, 400, `.trash が配信されている: ${res.status} ${res.body.slice(0, 120)}`);
});

await check("GET /api/media/../.trash/<file> は生パスでも取れない", async () => {
	const [victim] = trashedAs(first.img);
	const res = await rawGet(`/api/media/../.trash/${encodeURIComponent(victim)}`);
	// new URL() が `..` を畳んで /api/.trash/<file> にするので MEDIA_PREFIX に当たらず、
	// board gate（scope=session に sid 無し）で 400。実ファイルには届かない。
	assert.equal(res.status, 400, `.. 経由で配信されている: ${res.status} ${res.body.slice(0, 120)}`);
});

await check("GET /api/media/%2e%2e%2f.trash%2f<file> も取れない", async () => {
	const [victim] = trashedAs(first.img);
	const res = await rawGet(`/api/media/%2e%2e%2f.trash%2f${encodeURIComponent(victim)}`);
	// 復号すると "../.trash/<file>" -> "/" と ".." の両方で弾かれる。
	assert.equal(res.status, 400, `エンコード経由で配信されている: ${res.status} ${res.body.slice(0, 120)}`);
});

await check("GET /api/media/<通常ファイル> は今も 200（塞ぎすぎていない）", async () => {
	const r = await post("scope=global&ext=png&col=todo");
	const j = await r.json();
	const res = await tf(`${BASE}/api/media/${encodeURIComponent(j.card.img)}`);
	assert.equal(res.status, 200, `status=${res.status}`);
	// 後片付け: この経路も削除は .trash 経由になる
	await tf(`${BASE}/api/remove?scope=global&id=${j.card.id}`);
});

// --- 5. .trash もディスク総量に数える (#80-⑪ の mediaDirBytes) -----------------
// mediaDirBytes を呼ぶのは _inbox への POST だけなので、そちらで測る。
await check("総量計算は .trash を含む（1GiB を .trash に置くと _inbox POST が 413）", async () => {
	const add = await tools.get("serve").execute("t", { action: "add", path: `${join(HOME_DIR, "workspace/site")}` }, null, () => {});
	const sid = add.details.id;
	assert.ok(sid, `serve add が id を返す: ${JSON.stringify(add.details)}`);

	const okRes = await rawGet("/api/media/nope.png"); // 前提: サーバが生きている
	assert.ok(okRes.status < 500);

	mkdirSync(TRASH, { recursive: true });
	const hog = `${TRASH}/0-budget-hog.mp4`;
	writeFileSync(hog, "");
	truncateSync(hog, 1024 * 1024 * 1024);
	const r = await tf(`${BASE}/serve/${sid}/_inbox/over.json`, {
		method: "POST",
		body: "{}",
		headers: { "Content-Type": "application/json" },
	});
	const body = await r.text();
	rmSync(hog, { force: true });
	assert.equal(r.status, 413, `.trash が総量計算に入っていない: status=${r.status} ${body.slice(0, 200)}`);
	assert.ok(!existsSync(`${join(HOME_DIR, "workspace/site/_inbox/over.json")}`), "413 なのにファイルが出来ている");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
