// #101: 別プロセス（並列に走らせた人形・別端末の pi）が同じボードに同時に書いても
// カードが消えないことの回帰テスト。実測では writeBoard の deleteStaleCards が、
// 読んだ時点の id 集合に無い＝他プロセスが入れた行を巻き添えにしていた。
// 待ち時間で誤魔化さない: 子は mutateBoard のコールバック内で少し眠る（ロックが read と
// write の両方を覆っていなければ、その窓で他プロセスが同じ盤面を読む）。
// 4 プロセスが直列化するので、全体が短くても全員がロックを持ち回る。長く眠ると
// CPU 競合下で busy_timeout(3000ms) に届いて「database is locked」で落ちるだけになる。
// 2 周 × 4 本の理由: スイート全体を走らせた時の子プロセス数（各子が Node を 1 本立てる）を抑える。
// open の不変条件は下のロックテストが決定論的に見る。
// 検証も子プロセスでやる — 親が readBoard すると sqlite のハンドルが残り、
// Windows では最後の rmSync が EPERM になる。
// 既知（この管轄外）: この suite を回すと 4 回に 1 回ほど、全テスト pass の後に
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76` でプロセスが落ちる。
// nodejs/node#56645 / #64322 の Windows シャットダウンレースで、#61999（2026-07-24 merged）が修正。
// 24.20.0 と 26.7.0 に入り、25.x は EOL で入らない（v25.2.1 の node_platform.cc にガード無し）。
// 子プロセス spawn は窓を広げるだけで原因ではない。根治は Node を 24.20+ / 26.7+ へ上げること。
// 決定（2026-11）: Node は上げない。偽の失敗が煩い時は npm run test:stable（13s -> 62s）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME_DIR = "/tmp/kb-parallel-home";
rmSync(HOME_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/projects`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = HOME_DIR;
const ENV = { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR };

const EXT = pathToFileURL(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url))).href;
const DB_EXT = pathToFileURL(fileURLToPath(new URL("../extensions/db.ts", import.meta.url))).href;
const N = 4;
const ROUNDS = 2;

const CHILD = `${HOME_DIR}/child.mjs`;
writeFileSync(
	CHILD,
	`const [ext, path, name, sleepMs] = process.argv.slice(2);
const { mutateBoard } = await import(ext);
const err = mutateBoard(path, (b) => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(sleepMs));
	b.cards.push({ id: b.nextId++, text: name, col: "todo" });
});
process.stdout.write(JSON.stringify({ name, err }));
`,
);

const READER = `${HOME_DIR}/reader.mjs`;
writeFileSync(
	READER,
	`const [ext, path] = process.argv.slice(2);
const { readBoard } = await import(ext);
const b = readBoard(path);
process.stdout.write(JSON.stringify(b.cards.map((c) => [c.id, c.text])));
`,
);

// #101: 健康な WAL 盤面の open が書き込みロックを取らないことの回帰テスト。open が
// BEGIN IMMEDIATE を無条件に取るようになると（アップロードが 3 秒ロックを握っている間など）、
// 新しい pi プロセスが盤面を開けなくなる。押さえるのは経過時間ではなく順序:
// ホルダが解放する時刻（released）より先に open が終わっていること。
const HOLDER = `${HOME_DIR}/holder.mjs`;
writeFileSync(
	HOLDER,
	`import { DatabaseSync } from "node:sqlite";
const [dbExt, file, holdMs] = process.argv.slice(2);
const { openKanbanDb } = await import(dbExt);
// WAL + 完全なスキーマの盤面を作ってから、別接続で排他ロックを握る。
openKanbanDb(file).writeBoard({ scope: "project", sid: "seed" }, { cards: [], nextId: 1 });
const lock = new DatabaseSync(file);
lock.exec("BEGIN EXCLUSIVE");
process.stdout.write("locked\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
lock.exec("ROLLBACK");
`,
);

const OPENER = `${HOME_DIR}/opener.mjs`;
writeFileSync(
	OPENER,
	`const [dbExt, file] = process.argv.slice(2);
const { openKanbanDb } = await import(dbExt);
const t0 = Date.now();
try {
	openKanbanDb(file);
	process.stdout.write(JSON.stringify({ err: null, t0, t1: Date.now() }));
} catch (err) {
	process.stdout.write(JSON.stringify({ err: String(err?.message ?? err), t0, t1: Date.now() }));
}
`,
);

const exec = (script, args, timeoutMs = 30_000) =>
	new Promise((resolve, reject) => {
		const p = spawn(process.execPath, [script, ...args], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let errText = "";
		const killer = setTimeout(() => {
			p.kill("SIGKILL");
			reject(new Error("timeout " + timeoutMs + "ms"));
		}, timeoutMs);
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (errText += d));
		p.on("error", reject);
		p.on("close", (code) => {
			clearTimeout(killer);
			if (code !== 0) reject(new Error(`exit ${code}: ${errText.slice(-800)}`));
			else resolve({ out: JSON.parse(out), errText });
		});
	});

// #101: 健康な WAL 盤面の open が書き込みロックを取らないことの回帰テスト。open が
// BEGIN IMMEDIATE を無条件に取るようになると（アップロードがロックを握っている間など）新しい
// pi プロセスが盤面を開けなくなる。押さえるのは順序だけ: ホルダが 8 秒ロックを握ったまま open を
// 走らせ、open が書き込みロックを待つ実装なら busy_timeout(3 秒) で必ず失敗する。時刻の比較は
// 置かない（子プロセスの起動負荷で偽の赤になるだけで、検出力は上がらない）。
const holdAndOpen = (file, holdMs) =>
	new Promise((resolve, reject) => {
		const holder = spawn(process.execPath, [HOLDER, DB_EXT, file, String(holdMs)], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let errText = "";
		let opening = false;
		const done = new Promise((r) => holder.on("close", r));
		holder.stdout.on("data", async (d) => {
			out += d;
			if (opening || !out.includes("locked\n")) return;
			opening = true;
			try {
				resolve({ opened: await exec(OPENER, [DB_EXT, file]), done, errText: () => errText });
			} catch (err) {
				holder.kill("SIGKILL");
				reject(err);
			}
		});
		holder.stderr.on("data", (d) => (errText += d));
		holder.on("error", reject);
	});

try {
	// 新規ファイルの初回 open はスキーマ作成で書き込みロックを取る。それを round 0 の
	// 同時 open に持ち込むと、測りたい「書き込みの直列化」ではなくスキーマ競争を測る。
	await exec(READER, [EXT, KB + "/projects/warm.json"]);
	for (let round = 0; round < ROUNDS; round++) {
		const proj = `${KB}/projects/parallel${round}.json`;
		const results = await Promise.all(Array.from({ length: N }, (_, i) => exec(CHILD, [EXT, proj, `p${i}`, "40"])));
		// 子の stderr には失敗時の stack が入る（kanban.ts の mutateBoard が書く）。
		for (const r of results) {
			assert.equal(r.out.err, null, `${r.out.name} の mutateBoard が失敗した: ${r.out.err}\n${r.errText}`);
		}

		const cards = (await exec(READER, [EXT, proj])).out;
		assert.deepEqual(
			cards.map(([id]) => id).sort((x, y) => x - y),
			Array.from({ length: N }, (_, i) => i + 1),
			`round ${round} でカードが消えた: ${JSON.stringify(cards)}`,
		);
		assert.equal(new Set(cards.map(([, text]) => text)).size, N);
	}

	// open が返るまでホルダは 8 秒ロックを握っている。待つ実装なら busy_timeout で落ちる。
	const run = await holdAndOpen(KB + "/projects/locked.json", 8000);
	const opened = await run.opened;
	await run.done;
	assert.equal(opened.out.err, null, "ロック中の open が失敗した: " + opened.out.err + "\n" + opened.errText);
} finally {
	rmSync(HOME_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`parallel ok: ${ROUNDS} rounds x ${N} processes, ids 1..${N}, and open never waits out an exclusive lock`);
