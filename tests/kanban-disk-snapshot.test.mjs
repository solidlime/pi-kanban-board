// #84: poll の変化検知は板を読み直さず stat の mtimeNs+size+ino で比べる。
// 危険なのは唯一「同一ミリ秒ティック内の2回の書き込み」なので、そこだけを実測で固定する。
// `node tests/kanban-disk-snapshot.test.mjs`（フレームワーク無し、既存テストと同じ流儀）。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-disksig-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う（既存テストと同じ経路）。
const require = createRequire(import.meta.url);
const { createJiti } = require(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const SRC = new URL("../extensions/kanban.ts", import.meta.url).pathname;
const mod = await jiti.import(SRC);
const SOURCE = readFileSync(SRC, "utf8");

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

const T_MS = 1_700_000_000_000; // 固定した mtime。ms 精度しか無い utimes で同じティックを作る
const T = new Date(T_MS);
const stat = (p) => statSync(p, { bigint: true });

// --- 1: 同一 mtime・同一 size の2ファイルでも ino が違えば別署名 ----------------
check("mtimeNs と size が完全一致しても fileSig は別物を返す（ino が効いている）", () => {
	const a = `${HOME_DIR}/sig-a.json`;
	const b = `${HOME_DIR}/sig-b.json`;
	writeFileSync(a, '{"v":1}');
	writeFileSync(b, '{"v":1}');
	utimesSync(a, T, T);
	utimesSync(b, T, T);
	assert.equal(stat(a).mtimeNs, stat(b).mtimeNs, "mtimeNs が揃っていない（テスト前提の崩れ）");
	assert.equal(stat(a).size, stat(b).size, "size が揃っていない（テスト前提の崩れ）");
	assert.notEqual(mod.fileSig(a), mod.fileSig(b), "同一 mtime・同一 size で衝突した");
});

// --- 2: 同一パスへ同一ミリ秒内に2回書いても検知できる（決定的に再現） -----------
// 本番の書き込みは writeBoard / writeModesFile / writeServeFile すべて tmp+rename。
// rename は tmp の mtime を引き継ぐので、utimes で mtime を固定すれば
// 「同じ mtime・同じ size・同じパスへの2回の書き込み」を意図的に作れる。
check("同じ mtime に固定した tmp+rename を2回 → 2回目も別署名（取りこぼさない）", () => {
	const f = `${HOME_DIR}/same-tick.json`;
	const tmp = `${HOME_DIR}/same-tick.json.tmp`;
	const atomicWrite = (n) => {
		writeFileSync(tmp, JSON.stringify({ cards: [], nextId: n }));
		utimesSync(tmp, T, T);
		renameSync(tmp, f);
	};
	atomicWrite(1);
	const first = mod.fileSig(f);
	atomicWrite(2);
	const second = mod.fileSig(f);
	assert.equal(stat(f).mtimeNs, BigInt(T_MS) * 1_000_000n, "rename が mtime を引き継いでいない");
	assert.equal(stat(f).size, BigInt(Buffer.byteLength(JSON.stringify({ cards: [], nextId: 1 }))), "size が同じでない");
	assert.notEqual(first, second, "同一ティックの2回目の書き込みを取りこぼした");
});

// --- 3: 実時間の連続書き込みでも取りこぼさない（実測値も出す） -------------------
check("実時間の tmp+rename 連続書き込みで署名の衝突が 0 件", () => {
	const f = `${HOME_DIR}/loop.json`;
	const tmp = `${HOME_DIR}/loop.json.tmp`;
	const sigs = new Set();
	let sameMtimePairs = 0;
	let prev = null;
	const N = 300;
	for (let i = 0; i < N; i++) {
		writeFileSync(tmp, `{"nextId":${i},"pad":"${"x".repeat(16)}"}`);
		renameSync(tmp, f);
		const s = stat(f);
		if (prev !== null && prev === s.mtimeNs) sameMtimePairs += 1;
		prev = s.mtimeNs;
		sigs.add(mod.fileSig(f));
	}
	assert.equal(sigs.size, N, `${N} 回中 ${N - sigs.size} 回が衝突した`);
	// mtimeNs が同値だった隣接ペア = mtime だけの比較なら見逃していた回数（情報として出す）
	console.log(
		`  [実測] ${N} 回の連続書き込み: mtimeNs が前回と同一だったペア ${sameMtimePairs} 件 / ` +
			`mtimeNs 単独なら取りこぼし ${sameMtimePairs} 件 → 署名は 0 件`,
	);
});

// --- 4: 契約（ソース） ---------------------------------------------------------
check("diskSnapshot は readRaw ではなく stat 署名を使う", () => {
	assert.match(SOURCE, /const diskSnapshot = \(sessionId: string\): string =>[\s\S]{0,400}?fileSig\(/);
	assert.doesNotMatch(SOURCE, /const diskSnapshot = [\s\S]{0,300}?readRaw\(/, "diskSnapshot がまだ readRaw を呼ぶ");
});
// 署名が ino を見る以上、ino の変わらない in-place 書き込みは対象外になる。
// modes.json だけがそれだったので、tmp+rename に揃っていることを固定する。
check("writeModesFile も tmp+rename（ino が変わる = 署名が効く）", () => {
	const body = SOURCE.match(/function writeModesFile\(f: ModesFile\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.ok(body.length > 0, "writeModesFile が見つからない");
	assert.match(body, /renameSync\(tmp, MODES_JSON\)/, "writeModesFile が rename していない");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
