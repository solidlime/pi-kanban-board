// #71 回帰の自己検証 (#011)。`#71` は新挙動を入れたが、既存 48 件は act() 3 引数の
// 前提で書かれていて btn() 側に寄せたため、新しい振る舞いは 1 件も固定されていない。
//   (a) loopRestLine(cap, used): 無制限 / 上限 / 残り / 範囲外入力の復帰 / 戻り値の文字数
//   (b) flightGate: 押下中は再押下できない（二重送信の防止）／同期ハンドラで固まらない
//   (c) maxLoopsRequest: scope/sid/n の規則（文言と分岐が同じ所から出ている）
//   (d) HTTP: GET /api/maxloops を scope の各パターンで実際に叩く
// (a)(b) はブラウザ無しで叩けるよう、配信 HTML から関数定義を切り出して評価する
// （tests/kanban-isediting.test.mjs と同じ手口）。DOM は要らない。
// フレームワーク無しで `node tests/kanban-maxloops.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-maxloops-home";
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

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

const failures = [];
let passed = 0;
const check = (name, fn) => {
	try {
		const r = fn();
		if (r && typeof r.then === "function")
			return r.then(
				() => {
					passed += 1;
				},
				(err) => {
					failures.push(`${name}: ${err.message}`);
				},
			);
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
	return undefined;
};

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
// activeSessionId はプロセス最初の session_start で固定される（#40）。
const ACTIVE = "maxloops-active";
const ctxFor = (sid) => ({
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => sid, getEntries: () => [] },
});
handlers.get("session_start")({ type: "session_start" }, ctxFor(ACTIVE));
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}
const dashboardHtml = await (await tf(`${BASE}/`)).text();
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const get = async (path) => {
	const res = await tf(`${BASE}${path}`);
	return { status: res.status, body: await res.json().catch(() => null) };
};
const readModesRaw = () => JSON.parse(readFileSync(`${KB}/modes.json`, "utf8"));

// ---------------------------------------------------------------------------
// 配信 HTML から関数定義を 1 つ切り出す（ブラウザと同じソースを評価する）
// ---------------------------------------------------------------------------
// 修正前は flightGate が無い（btn が直接 disabled を立てる）ので、抽出できなくても
// 止めない: 赤を「クラッシュ」ではなく「失敗」として出すため、埋め草を返す。
const grab = (src, name) => {
	const m = (src ?? "").match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`));
	return m === null ? `function ${name}(){ throw new Error("${name} is not shipped"); }` : m[0];
};
const evalFns = (src, names) =>
	new Function(`${names.map((n) => grab(src, n)).join("\n")}\nreturn { ${names.join(", ")} };`)();

const dashScript = scriptsOf(dashboardHtml).find((s) => s.includes("function loopRestLine("));
const flightScript = scriptsOf(dashboardHtml).find((s) => s.includes("function flightGate("));

await check("#71 loopRestLine / flightGate はダッシュボードに配信されている", () => {
	assert.ok(dashScript, "loopRestLine が配信スクリプトに無い");
	assert.ok(flightScript, "flightGate が配信スクリプトに無い");
});

const { loopRestLine } = evalFns(dashScript, ["loopRestLine"]);
const { flightGate } = evalFns(flightScript, ["flightGate"]);

// ---------------------------------------------------------------------------
// (a) loopRestLine
// ---------------------------------------------------------------------------
await check("#71 loopRestLine: cap=0 は「無制限」を表す", () => {
	assert.equal(loopRestLine(0, 0), "残り 0 / 無制限");
	assert.equal(loopRestLine(0, 3), "残り 3 / 無制限");
});

await check("#71 loopRestLine: 正の上限は「上限 N」と残りを出す", () => {
	assert.equal(loopRestLine(10, 3), "残り 7 / 10");
	assert.equal(loopRestLine(2, 0), "残り 2 / 2");
	assert.equal(loopRestLine(1000, 999), "残り 1 / 1000");
});

await check("#71 loopRestLine: 使い切りは 0 で止まる（負にしない）", () => {
	assert.equal(loopRestLine(10, 10), "残り 0 / 10");
	assert.equal(loopRestLine(2, 30), "残り 0 / 2");
});

await check("#71 loopRestLine: 範囲外の cap は例外を投げず無制限に落ちる", () => {
	for (const cap of [-5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.doesNotThrow(() => loopRestLine(cap, 3));
		assert.equal(loopRestLine(cap, 3), "残り 3 / 無制限", `cap=${cap}`);
	}
	// Number() を通していない生値（モードファイルは手で編集されうる）
	for (const cap of ["7", "", true, {}, [], new Date(0)]) {
		assert.doesNotThrow(() => loopRestLine(cap, 3));
		assert.equal(loopRestLine(cap, 3), "残り 3 / 無制限", `cap=${JSON.stringify(cap)}`);
	}
});

await check("#71 loopRestLine: null / undefined の cap は既定（無制限）に落ちる", () => {
	assert.doesNotThrow(() => loopRestLine(null, 3));
	assert.doesNotThrow(() => loopRestLine(undefined, 3));
	assert.equal(loopRestLine(null, 3), "残り 3 / 無制限");
	assert.equal(loopRestLine(undefined, 3), "残り 3 / 無制限");
});

await check("#71 loopRestLine: 範囲外の used は 0 に落ちる（NaN を出さない）", () => {
	for (const used of [Number.NaN, -2, Number.POSITIVE_INFINITY, "3", null, undefined, {}]) {
		assert.doesNotThrow(() => loopRestLine(10, used));
		assert.equal(loopRestLine(10, used), "残り 10 / 10", `used=${JSON.stringify(used)}`);
		assert.equal(loopRestLine(0, used), "残り 0 / 無制限", `cap=0 used=${JSON.stringify(used)}`);
	}
	// 端数は切り捨て（回数は整数でしか意味を持たない）
	assert.equal(loopRestLine(10, 2.7), "残り 8 / 10");
});

await check("#71 loopRestLine: 文字列長を固定する（CSS の折返しに効く）", () => {
	// 390px で折返すかの判断材料。文言を変えるなら CSS も一緒に見ること。
	assert.equal("上限（無制限）".length, 7, "無制限ラベルの文字数が変わった");
	assert.equal("上限".length, 2);
	assert.equal(loopRestLine(0, 0).length, 10, loopRestLine(0, 0));
	assert.equal(loopRestLine(0, 12).length, 11, loopRestLine(0, 12));
	assert.equal(loopRestLine(10, 3).length, 9, loopRestLine(10, 3));
	assert.equal(loopRestLine(1000, 999).length, 11, loopRestLine(1000, 999));
	// ラベルは両テンプレートで同じ表記（片方だけ直る事故を防ぐ）
	assert.ok(dashboardHtml.includes('"上限（無制限）"'), "ダッシュボードの無制限ラベルが無い");
	// 無制限ラベルの「無制限」と残り行の「無制限」は同じ語
	assert.ok(loopRestLine(0, 1).includes("無制限"));
});

// ---------------------------------------------------------------------------
// (b) flightGate: 押下中は再押下できない
// ---------------------------------------------------------------------------
await check("#71 flightGate: 押下中（in flight）は 2 回目を実行しない", async () => {
	let calls = 0;
	let release;
	const run = flightGate(() => {
		calls += 1;
		return new Promise((r) => {
			release = r;
		});
	});
	const first = run();
	assert.ok(first, "1 回目が始まらない");
	assert.equal(run.isBusy(), true, "1 回目が進行中になっていない");
	assert.equal(run(), null, "2 回目が実行された（二重送信）");
	assert.equal(run(), null, "3 回目が実行された（二重送信）");
	assert.equal(calls, 1, `ハンドラが ${calls} 回呼ばれた`);
	release("ok");
	assert.equal(await first, "ok");
	assert.equal(run.isBusy(), false, "完了後も進行中のまま");
	// 完了後はもう一度押せる
	let second = 0;
	const run2 = flightGate(() => {
		second += 1;
		return Promise.resolve();
	});
	await run2();
	assert.equal(second, 1);
});

await check("#71 flightGate: 失敗しても固まらない（拒否で解除）", async () => {
	let calls = 0;
	const run = flightGate(() => {
		calls += 1;
		return Promise.reject(new Error("write rejected"));
	});
	await assert.rejects(() => run(), /write rejected/);
	assert.equal(run.isBusy(), false, "失敗後に進行中のまま（ボタンが死ぬ）");
	await assert.rejects(() => run(), /write rejected/);
	assert.equal(calls, 2, "失敗後にもう一度押せない");
});

await check("#71 flightGate: 同期ハンドラは null を返し busy にしない", () => {
	let calls = 0;
	const run = flightGate(() => {
		calls += 1;
		return undefined; // reload() のような素の動作
	});
	assert.equal(run(), null);
	assert.equal(run.isBusy(), false);
	assert.equal(calls, 1);
	// 2 回目も普通に走る（同期動作を 1 回で殺さない）
	assert.equal(run(), null);
	assert.equal(calls, 2);
});

await check("#71 btn は flightGate 経由で disabled を立てる（配線の確認）", () => {
	assert.ok(
		/flightGate\(fn\)[\s\S]{0,400}?b\.disabled = true/.test(dashScript),
		"btn() が flightGate の戻りで disabled にしていない",
	);
	assert.ok(/p\.then\(release, release\)/.test(dashScript), "成功・失敗の両方で解除していない");
});

// ---------------------------------------------------------------------------
// (c) maxLoopsRequest: scope/sid/n の規則
// ---------------------------------------------------------------------------
const SID = "maxloops-target";
const req = (q) => mod.maxLoopsRequest(q);

await check("#71 maxLoopsRequest: scope=global は sid 無しでも通る（active で補う）", () => {
	const p = req({ scope: "global", sid: null, n: "7" });
	assert.equal(p.kind, "ok", JSON.stringify(p));
	assert.equal(p.scope, "global");
	assert.equal(p.sid, ACTIVE, "アクティブセッションで補っていない");
	assert.equal(p.n, 7);
});

await check("#71 maxLoopsRequest: scope=global + sid 明示はそのまま使う", () => {
	const p = req({ scope: "global", sid: SID, n: "7" });
	assert.equal(p.kind, "ok");
	assert.equal(p.sid, SID);
});

await check("#71 maxLoopsRequest: scope=session は sid 必須", () => {
	assert.equal(req({ scope: "session", sid: SID, n: "3" }).kind, "ok");
	const bad = req({ scope: "session", sid: null, n: "3" });
	assert.equal(bad.kind, "error");
	assert.equal(bad.error, "scope=session requires sid");
	assert.equal(req({ scope: "session", sid: "", n: "3" }).error, "scope=session requires sid");
});

await check("#71 maxLoopsRequest: 不正な scope は専用の文言で拒否", () => {
	for (const scope of ["foo", "SESSION", "Global", "globals", " "]) {
		const p = req({ scope, sid: SID, n: "3" });
		assert.equal(p.kind, "error", `scope=${JSON.stringify(scope)}`);
		assert.equal(p.error, "scope must be global or session", `scope=${JSON.stringify(scope)}`);
	}
});

await check("#71 maxLoopsRequest: scope 省略は session 扱い（parseScope と同じ読み方）", () => {
	const p = req({ sid: SID, n: "5" });
	assert.equal(p.kind, "ok");
	assert.equal(p.scope, "session");
	assert.equal(req({ n: "5" }).error, "scope=session requires sid");
});

// ---------------------------------------------------------------------------
// (d) HTTP: 実際に叩く
// ---------------------------------------------------------------------------
{
	const real = "maxloops-real-session";
	const cases = [
		["?scope=global&n=7", 200, "global は sid 無しで通る"],
		["?scope=session&n=5", 400, "session は sid 必須（文言も session 用）"],
		[`?scope=session&sid=${real}&n=6`, 200, "session + sid は保存できる"],
		["?scope=foo&n=5", 400, "不正な scope は 400"],
		["?scope=&n=5", 400, "空 scope は session 扱い = sid 必須"],
	];
	for (const [qs, want, why] of cases) {
		await check(`#71 GET /api/maxloops${qs} → ${want}（${why}）`, async () => {
			const r = await get(`/api/maxloops${qs}`);
			assert.equal(r.status, want, `${r.status} ${JSON.stringify(r.body)}`);
			return r;
		});
	}
	await check("#71 scope=global は GLOBAL 層に active セッションで書く", () => {
		const raw = readModesRaw();
		assert.equal(raw.GLOBAL[ACTIVE]?.maxLoops, 7, JSON.stringify(raw.GLOBAL));
	});
	await check("#71 不正 scope の文言はセッション用ではない", async () => {
		const r = await get("/api/maxloops?scope=foo&n=5");
		assert.equal(r.body.error, "scope must be global or session", JSON.stringify(r.body));
	});
	await check("#71 session + sid の文言は従来どおり", async () => {
		const r = await get("/api/maxloops?scope=session&n=5");
		assert.equal(r.body.error, "scope=session requires sid", JSON.stringify(r.body));
	});
	await check("#71 範囲外の n は従来どおり 400", async () => {
		const r = await get(`/api/maxloops?scope=session&sid=${real}&n=1001`);
		assert.equal(r.status, 400, JSON.stringify(r.body));
	});
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------
if (failures.length) {
	console.error(`\n#71 maxloops: ${passed} pass / ${failures.length} fail`);
	for (const f of failures) console.error(`  FAIL ${f}`);
	// サーバが listen したままだと event loop が終わらないので、末尾で明示終了する。
}
if (!failures.length) console.log(`#71 maxloops: ${passed} pass / 0 fail`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
