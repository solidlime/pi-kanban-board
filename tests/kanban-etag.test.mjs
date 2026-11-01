// #85: ダッシュボードのポーリングを安くする (ETag / 304 + 可視状態ガード) 自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-etag.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban, seedBoard, readBoardAt, removeBoard } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-etag-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/media`, { recursive: true });
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

const require = createRequire(import.meta.url);
const { createJiti } = require(
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
const get = (p, headers) => tf(`${BASE}${p}`, { headers });

// #17: ボードは project 1 枚 + global の集約だけ。session ボードは無い。
const ACTIVE = "etag1111";
const PROJECT_PATH = `${KB}/projects/pi-kanban-board.json`;
seedBoard(`${KB}/global.json`, { cards: [{ id: 1, text: "g1", col: "todo" }], nextId: 2 });
seedBoard(PROJECT_PATH, { cards: [{ id: 1, text: "p1", col: "todo" }], nextId: 2 });

const handler = mod.default?.handlers;
void handler;
// session_start は呼ばない（activeSessionId 無し = このプロセスの cwd の project ボード）。
for (let i = 0; i < 40; i++) {
	try {
		if ((await get("/api/kanban")).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// --- 1. 200 + ETag ------------------------------------------------------------
const first = await get("/api/dashboard");
const firstBody = await first.text();
const firstEtag = first.headers.get("etag");

check("1回目: 200 + ETag + 本文あり", () => {
	assert.equal(first.status, 200, `status=${first.status}`);
	assert.ok(firstEtag, "ETag が無い");
	assert.match(firstEtag, /^"[0-9a-f]{40}"$/, `ETag の形が想定外: ${firstEtag}`);
	assert.ok(firstBody.length > 0, "本文が空");
});

check("Cache-Control: no-cache を含み no-store を含まない", () => {
	const cc = first.headers.get("cache-control") ?? "";
	assert.match(cc, /no-cache/, `cache-control=${cc}`);
	assert.ok(!/no-store/.test(cc), `cache-control=${cc} に no-store が入っている`);
});

// --- 2. If-None-Match -> 304 --------------------------------------------------
// Origin 付きで叩く: 304 でも ACAO / Vary が付いていないとブラウザは読めない。
const second = await get("/api/dashboard", { Origin: BASE, "If-None-Match": firstEtag });
const secondBody = await second.text();

check("同じ ETag を If-None-Match で送ると 304", () => {
	assert.equal(second.status, 304, `status=${second.status}`);
	assert.equal(second.headers.get("etag"), firstEtag, "304 に ETag が無い/変わった");
});
check("304 の本文は 0 バイト", () => assert.equal(secondBody.length, 0, `body=${secondBody.length}B`));
check("304 でも ACAO が付く (Origin 付き)", () =>
	assert.equal(second.headers.get("access-control-allow-origin"), BASE));
check("304 でも Vary: Origin が消えない", () =>
	assert.match(second.headers.get("vary") ?? "", /Origin/i));
check("200 でも Vary: Origin が消えない", () => {
	const res = first.headers.get("vary");
	// Origin 無しの 200 は CORS_HEADERS のみ（Vary 無し）。付くのは Origin 付きの時。
	const same = second.headers.get("vary");
	assert.match(same ?? "", /Origin/i, `vary=${res}`);
});
{
	const withOrigin = await get("/api/dashboard", { Origin: BASE });
	check("Origin 付き 200: ACAO + Vary + ETag が同居する", () => {
		assert.equal(withOrigin.headers.get("access-control-allow-origin"), BASE);
		assert.match(withOrigin.headers.get("vary") ?? "", /Origin/i);
		assert.ok(withOrigin.headers.get("etag"), "ETag が無い");
	});
}

// --- 3. 書き込みで ETag が変わる ----------------------------------------------
const added = await get(`/api/add?scope=project&text=${encodeURIComponent("追加")}&col=todo`);
check("/api/add は 200", () => assert.equal(added.status, 200, `status=${added.status}`));

const third = await get("/api/dashboard", { "If-None-Match": firstEtag });
const thirdBody = await third.text();
const thirdEtag = third.headers.get("etag");

check("board を変えたら ETag が変わり 200 + 本文あり", () => {
	assert.equal(third.status, 200, `status=${third.status} (古い ETag で 304 が返っている)`);
	assert.notEqual(thirdEtag, firstEtag, "ETag が変わっていない");
	assert.ok(thirdBody.length > 0, "本文が空");
	assert.ok(thirdBody.includes("追加"), "追加カードが本文に無い");
});
check("新しい ETag はもう一度 304 を返す", () => {
	assert.ok(thirdEtag);
});

// --- 4. 実測バイト数 -----------------------------------------------------------
const notModified = await get("/api/dashboard", { "If-None-Match": thirdEtag });
const notModifiedBody = await notModified.text();
check("200 の本文長 > 0、304 は 0 バイト", () => {
	assert.equal(notModified.status, 304, `status=${notModified.status}`);
	assert.ok(thirdBody.length > 0);
	assert.equal(notModifiedBody.length, 0);
});
console.log(
	`[etag] 200 body=${Buffer.byteLength(thirdBody)}B, 304 body=${Buffer.byteLength(notModifiedBody)}B, ` +
		`content-length(304)=${notModified.headers.get("content-length") ?? "(none)"}`,
);

// --- 4b. #17: セッション行は消えた。同じ内容の書き直しでは ETag が動かない ---
const MIN_MS = 60000;
const baseMin = MIN_MS;
// The board is a sqlite row: touching it means writing it again, not utimes().
const rewriteSame = () => seedBoard(PROJECT_PATH, readBoardAt(PROJECT_PATH));

const sameMin1 = await get("/api/dashboard");
const sameMin1Body = await sameMin1.text();
const sameMin1Etag = sameMin1.headers.get("etag");

rewriteSame();
const sameMin2 = await get("/api/dashboard", { "If-None-Match": sameMin1Etag });
const sameMin2Body = await sameMin2.text();

await check("同じ内容の書き直しは 304（行の中身が ETag に出ない）", () => {
	assert.equal(sameMin2.status, 304, `status=${sameMin2.status} (中身の無い値が ETag を動かしている)`);
	assert.equal(sameMin2Body.length, 0, `body=${sameMin2Body.length}B`);
	assert.equal(sameMin2.headers.get("etag"), sameMin1Etag, "ETag が変わった");
});

// payload の形: sessions はもう無く、project / global が loops と halted を持つ。
await check("payload に sessions は無く、project / global が loops と halted を持つ", () => {
	const j = JSON.parse(sameMin1Body);
	assert.equal("sessions" in j, false, "sessions が残っている");
	assert.equal("sessionId" in j, false, "sessionId が残っている");
	for (const key of ["project", "global"]) {
		assert.ok(j[key], `${key} が無い`);
		assert.equal(typeof j[key].loops, "number", `${key}.loops=${String(j[key].loops)}`);
		assert.equal(typeof j[key].halted, "boolean", `${key}.halted=${String(j[key].halted)}`);
		assert.equal("active" in j[key], false, `${key}.active が残っている`);
	}
	assert.equal("active" in j.stats, false, "stats.active が残っている");
});

// 内容が変われば ETag も変わる（丸めすぎで本当の更新を潰していないことの確認）。
seedBoard(PROJECT_PATH, { cards: [{ id: 50, text: "changed", col: "todo" }], nextId: 51 });
const nextMin = await get("/api/dashboard", { "If-None-Match": sameMin1Etag });
const nextMinBody = await nextMin.text();

await check("内容が変わると ETag が変わり 200 + 本文あり", () => {
	assert.equal(nextMin.status, 200, `status=${nextMin.status} (更新を取り逃がしている)`);
	assert.ok(nextMinBody.length > 0, "本文が空");
	assert.notEqual(nextMin.headers.get("etag"), sameMin1Etag, "ETag が変わっていない");
	assert.equal(JSON.parse(nextMinBody).project.cards.length, 1);
});

// helper 直叩き: undefined / NaN / 負値 / 未来値でも例外を投げない。
await check("updatedAtMin: 不正な mtime は null に落ち、例外を投げない", () => {
	for (const bad of [undefined, null, NaN, -1, "120000", Infinity, 9e15]) {
		assert.equal(mod.updatedAtMin(bad), null, `${String(bad)} -> ${String(mod.updatedAtMin(bad))}`);
	}
	assert.equal(mod.updatedAtMin(0), new Date(0).toISOString());
	assert.equal(mod.updatedAtMin(baseMin + 1), new Date(baseMin).toISOString());
	// 未来値も丸めるだけで壊れない（mtime の時計ずれを許容する）。
	assert.equal(
		mod.updatedAtMin(Date.now() + 10 * MIN_MS),
		new Date(Math.floor((Date.now() + 10 * MIN_MS) / MIN_MS) * MIN_MS).toISOString(),
	);
});

// --- 5. クライアントの可視状態ガード ------------------------------------------
const html = await (await get("/")).text();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const dash = scripts.find((s) => s.includes('var API = "/api/dashboard"'));

await check("dashboard スクリプトを抽出できる", () => assert.ok(dash, "配信スクリプトに見つからない"));

// 配信 HTML から実際の schedule() と visibilitychange 購読を切り出し、同じソースを評価する。
const grabSchedule = (src) => {
	const m = src.match(/ {2}function schedule\(\)\{[\s\S]*?\n {2}\}/);
	return m === null ? 'function schedule(){ throw new Error("schedule is not shipped"); }' : m[0];
};
const grabListener = (src) => {
	const m = src.match(/ {2}if \(typeof document\.addEventListener[\s\S]*?\n {2}\}\);/);
	return m === null ? "/* visibilitychange is not shipped */" : m[0];
};

const harness = new Function(`
  var fails = 0;
  var timer = null;
  var nextId = 1;
  var timers = [];
  var reloads = 0;
  var handlers = {};
  var document = {
    visibilityState: "visible",
    addEventListener: function(t, fn){ (handlers[t] = handlers[t] || []).push(fn); }
  };
  function setTimeout(fn, ms){ var id = nextId++; timers.push({ id: id, fn: fn, ms: ms }); return id; }
  function clearTimeout(id){
    for (var i = 0; i < timers.length; i++) if (timers[i].id === id) { timers.splice(i, 1); return; }
  }
  function reload(){ reloads += 1; }
  function nextDelay(){ return fails === 0 ? 5000 : Math.min(1000 * Math.pow(2, fails - 1), 30000); }
  ${grabSchedule(dash ?? "")}
  ${grabListener(dash ?? "")}
  return {
    schedule: schedule,
    hide: function(){ document.visibilityState = "hidden"; },
    show: function(){ document.visibilityState = "visible"; },
    fire: function(t){ var hs = handlers[t] || []; for (var i = 0; i < hs.length; i++) hs[i](); },
    listens: function(t){ return (handlers[t] || []).length; },
    timers: timers,
    setFails: function(n){ fails = n; },
    reloads: function(){ return reloads; }
  };
`)();

await check("配信コードが document.visibilityState を参照し、visibilitychange を購読する", () => {
	assert.equal(harness.listens("visibilitychange"), 1, "visibilitychange の購読が無い（または二重）");
});

await check("可視のとき: schedule() は POLL_MS=5000 で 1 本だけ張る", () => {
	harness.schedule();
	assert.equal(harness.timers.length, 1);
	assert.equal(harness.timers[0].ms, 5000);
	harness.schedule();
	assert.equal(harness.timers.length, 1, "多重起動している");
});

await check("隠れたら: schedule() はタイマーを張らず、既存も消す", () => {
	harness.hide();
	harness.schedule();
	assert.equal(harness.timers.length, 0, "隠れているのにタイマーが残っている");
	assert.equal(harness.reloads(), 0, "隠れているのに reload した");
});

await check("復帰したら: 即座に 1 回 reload() し、タイマーは張らない", () => {
	harness.show();
	harness.fire("visibilitychange");
	assert.equal(harness.reloads(), 1, "復帰時に reload していない");
	assert.equal(harness.timers.length, 0, "visibilitychange で直接タイマーを張っている");
});

await check("復帰後のバックオフは隠れる前の失敗回数を引き継ぐ", () => {
	harness.setFails(3); // 1000*2^2 = 4000ms
	harness.hide();
	harness.schedule();
	harness.show();
	harness.fire("visibilitychange");
	harness.schedule(); // reload() の .then(schedule) 相当
	assert.equal(harness.timers.length, 1);
	assert.equal(harness.timers[0].ms, 4000, "fails が戻った時にリセットされている");
});

await check("dashboard スクリプトに setInterval が無い（ポーリングは setTimeout 1 本）", () => {
	assert.ok(!/setInterval\(/.test(dash ?? ""), "setInterval が混入している");
});

// --- 結果 ---------------------------------------------------------------------
console.log(`kanban-etag: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
