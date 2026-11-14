// Node runs .ts files by stripping types, but it does NOT rewrite `./x.js` → `./x.ts`,
// and NodeNext/tsc requires the .js spelling in source. This hook bridges the two so
// `node --test` can import src/**/*.ts directly without a build step.
// Import once, first, in any test that touches src/*.ts.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const asJs = fileURLToPath(url);
      if (!existsSync(asJs) && existsSync(`${asJs.slice(0, -3)}.ts`)) {
        return { url: pathToFileURL(`${asJs.slice(0, -3)}.ts`).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});
