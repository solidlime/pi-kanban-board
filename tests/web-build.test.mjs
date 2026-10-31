// web/ と生成物がずれていないことを固定する。
//
// pretest は `--check` で走るので、web/ を直して `npm run build` を忘れたまま
// commit すると npm test がここで落ちる（黙ってビルドし直して隠さない）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWeb, normalise } from "../scripts/build-web.mjs";

const GEN = new URL("../extensions/dashboard.generated.ts", import.meta.url);
const generated = () => readFileSync(GEN, "utf8");

test("dashboard.generated.ts は web/ のビルド結果そのもの", () => {
	assert.equal(normalise(generated()), normalise(buildWeb()));
});

test("生成物にプレースホルダは残っていない", () => {
	assert.ok(!/__KB_(MD_JS|MEMORY_JS)__/.test(generated()));
});
