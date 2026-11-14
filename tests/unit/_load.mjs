// Test-side module hook for the v2 TypeScript sources.
//
// Node 26 strips types but does not rewrite specifiers, so the NodeNext-style
// `./foo.js` imports inside src/**/*.ts would fail to resolve. This hook maps a
// relative `*.js` specifier to the sibling `*.ts` file when the .js one is missing.
// Register it by importing this module BEFORE dynamically importing any .ts file.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
        const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsUrl.href, context);
      }
      throw err;
    }
  },
});

/** Loads the frozen shared contracts (types only, so usually for `DomainError`). */
export function loadShared() {
  return import("../../src/shared/index.ts");
}

/** Loads the whole public domain API. */
export function loadCore() {
  return import("../../src/core/index.ts");
}
