// #90: the tool a fresh agent meets must say what it is before it says how. The description is
// four blocks (what it is / actions / deliverables-are-not-cards / which board) and every
// parameter carries its own description, so the normalization rules stopped being a wall of text.
// Same style as tests/kanban-global-readonly.test.mjs: the schema is read out of the source, so
// no server and no jiti load is needed to pin it.
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)), "utf8");

const START = SOURCE.indexOf("parameters: Type.Object({");
const END = SOURCE.indexOf("async execute(", START);
if (START < 0 || END < 0) throw new Error("kanban ツールの parameters が見つからない");
const PARAMS = SOURCE.slice(START, END);

const DESC_START = SOURCE.indexOf('label: "Kanban board"');
const DESC_END = SOURCE.indexOf("parameters: Type.Object({", DESC_START);
const DESC = SOURCE.slice(DESC_START, DESC_END);

/** `\t\t\tname: ...` の並びから、各パラメータの宣言テキストを取り出す。 */
const paramBlocks = () => {
	const heads = [...PARAMS.matchAll(/^\t{3}(\w+):/gm)];
	return heads.map((m, i) => ({
		name: m[1],
		body: PARAMS.slice(m.index, heads[i + 1]?.index ?? PARAMS.length),
	}));
};

test("#90 ツール説明は 4 ブロック構成のまま", () => {
	for (const marker of ["Shared kanban board for this project", "Actions:", "A deliverable is not a card", "scope picks the board:"])
		assert.ok(DESC.includes(marker), `説明に "${marker}" が無い`);
	assert.match(DESC, /\.html opens in a sandboxed iframe/, "添付の説明が消えた");
});

test("#90 ツール説明は存在しない session ボードを案内しない（#17 で廃止）", () => {
	assert.doesNotMatch(DESC, /'session' \(this conversation/, "session ボードを有効値として案内している");
	assert.match(DESC, /There is no per-session board/, "session が無いことを書いていない");
	// スキーマも 2 値のまま: 400 SESSION_SCOPE_GONE を返す HTTP と食い違わせない。
	assert.match(PARAMS, /Type\.Union\(\[Type\.Literal\("global"\), Type\.Literal\("project"\)\]/, "scope の Union が project/global でない");
	assert.doesNotMatch(PARAMS, /Type\.Literal\("session"\)/, "scope に session が生えている");
});

test("#90 すべてのパラメータに description がある", () => {
	const blocks = paramBlocks();
	assert.equal(blocks.length, 12, `パラメータが ${blocks.length} 個（切り出しが壊れている）`);
	for (const { name, body } of blocks) assert.ok(body.includes("description:"), `${name} に description が無い`);
});
