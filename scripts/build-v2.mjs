import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

await mkdir('web/dist', { recursive: true });
await build({ entryPoints: ['web/src/app.ts'], outfile: 'web/dist/app.js', bundle: true, format: 'esm', platform: 'browser', sourcemap: false, target: ['es2022'] });
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kanban v2</title><link rel="icon" type="image/svg+xml" href="./favicon.svg"><link rel="stylesheet" href="./app.css"><script>/* Before the first paint: mount() runs after the module graph loads, which is already too late to keep a light user from seeing a dark frame. */try{if(localStorage.getItem("kb-theme")==="light")document.documentElement.dataset.theme="light";if(localStorage.getItem("kb-density")==="compact")document.documentElement.dataset.density="compact"}catch(e){}</script></head><body><div id="app">Loading…</div><script type="module" src="./app.js"></script></body></html>`;
await writeFile('web/dist/index.html', html);
await copyFile('docs/assets/logo.svg', 'web/dist/favicon.svg');
const js = await readFile('web/dist/app.js', 'utf8');
const css = await readFile('web/dist/app.css', 'utf8');
const hash = createHash('sha256').update(html + '\n' + css + '\n' + js).digest('hex').slice(0, 12);
// Same source of truth as the server: a stale literal here makes selftest disagree with the build.
const migrations = await readFile('src/persistence/migrations.ts', 'utf8');
const schemaVersion = Math.max(...[1, ...migrations.matchAll(/version:\s*(\d+),\s*name/g)].map((m) => Number(m[1] ?? 0)));
await writeFile('web/dist/meta.json', JSON.stringify({ buildHash: hash, schemaVersion }, null, 2));
console.log('v2 built', hash);
