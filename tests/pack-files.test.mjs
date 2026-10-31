// #82x: 配布物（npm pack の files）から相対 import の先が抜けると、
// インストール直後に extension が読込み時点で落ちる（実行して初めて分かる）。
// extensions/*.ts の `from "./x"` が package.json の files に載っているかを静的に突き合わせる。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const files = JSON.parse(read("package.json")).files;

test("extensions の相対 import はすべて package.json の files に入っている", () => {
	const missing = [];
	for (const name of readdirSync(new URL("extensions/", ROOT))) {
		if (!name.endsWith(".ts")) continue;
		const src = read(`extensions/${name}`);
		for (const [, target] of src.matchAll(/from "\.\/([^"]+)"/g)) {
			const rel = `extensions/${target}`;
			if (!files.includes(rel)) missing.push(`${name} -> ${rel}`);
		}
	}
	assert.deepEqual(missing, [], `配布物から欠けている import 先: ${missing.join(", ")}`);
});
