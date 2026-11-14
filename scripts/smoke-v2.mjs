import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL) {
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

const { planInit, executeInit } = await import('../src/persistence/init.ts');
const { startServer } = await import('../src/api/start.ts');

const root = mkdtempSync(join(tmpdir(), 'kbv2-'));
const home = join(root, '.pi', 'kanban');
let run;
try {
  const plan = planInit(new Date(), home);
  const res = executeInit(plan, { confirmed: true, mode: 'backup' });
  console.log('init', res.schemaVersion, res.home);
  run = await startServer({ home, port: 0, host: '127.0.0.1' });
  console.log('url', run.url, 'token?', !!run.token);
  const base = `http://127.0.0.1:${run.port}`;
  const headers = { authorization: `Bearer ${run.token}`, 'content-type': 'application/json' };
  const j = async (method, path, body) => {
    const r = await fetch(base+path, { method, headers, body: body?JSON.stringify(body):undefined });
    const t = await r.text();
    let d; try{d=JSON.parse(t);}catch{d=t;}
    if(!r.ok || (d && d.ok===false)) throw new Error(method+' '+path+' '+r.status+' '+t);
    return d.data ?? d;
  };
  const meta = await j('GET','/api/meta');
  console.log('meta', meta.buildHash, meta.schemaVersion);
  const created = await j('POST','/api/projects', { slug:'demo', name:'Demo' });
  console.log('project', created.project.slug);
  const board0 = await j('GET','/api/board?project=demo');
  console.log('cols', board0.columns.map(c=>c.id).join(','), 'cards', board0.cards.length);
  const c1 = await j('POST','/api/cards', { project:'demo', title:'First', columnId:'todo' });
  console.log('card', c1.card.id, c1.card.columnId, c1.card.version);
  const moved = await j('POST', `/api/cards/demo/${c1.card.id}/move`, { columnId:'doing', version: c1.card.version });
  console.log('moved', moved.card.columnId, moved.card.version);
  const board1 = await j('GET','/api/board?project=demo');
  console.log('board cards', board1.cards.length, board1.cards[0].columnId);
  console.log('SMOKE_OK');
} finally {
  try { if (run) await run.close(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
