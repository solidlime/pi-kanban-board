#!/usr/bin/env node
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node strips types but does not rewrite NodeNext's `./x.js` specifiers onto the sibling
// `./x.ts`, so the CLI registers the same bridge the v2 tests use before importing src/.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const asJs = fileURLToPath(url);
      const asTs = `${asJs.slice(0, -3)}.ts`;
      if (!existsSync(asJs) && existsSync(asTs)) {
        return { url: pathToFileURL(asTs).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { runInit } = await import("../init-cli.ts");
runInit(process.argv.slice(2)).then(r=>{ if(r && r.ok===false) process.exitCode=2; }).catch(e=>{ console.error(e); process.exit(1); });
