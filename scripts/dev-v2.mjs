// Dev server on a throwaway home, seeded with one board that exercises every v2 feature.
// Open the printed url; Ctrl-C stops it. Nothing here ever touches ~/.pi/kanban.
import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const asJs = fileURLToPath(url);
      const asTs = `${asJs.slice(0, -3)}.ts`;
      if (!existsSync(asJs) && existsSync(asTs)) return { url: pathToFileURL(asTs).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { planInit, executeInit } = await import('../src/persistence/init.ts');
const { startServer } = await import('../src/api/start.ts');

const root = process.env.KB_DEV_ROOT || mkdtempSync(join(tmpdir(), 'kbv2-dev-'));
const home = join(root, '.pi', 'kanban');
const port = Number(process.env.PORT || 8791);

if (!existsSync(join(home, 'state.sqlite'))) executeInit(planInit(new Date(), home), { confirmed: true, mode: 'backup' });

const run = await startServer({ home, port, host: '127.0.0.1', loop: { intervalMs: Number(process.env.KANBAN_LOOP_MS ?? 5000) } });
const headers = { authorization: `Bearer ${run.token}`, 'content-type': 'application/json' };
const base = `http://127.0.0.1:${run.port}`;
const j = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok || (d && d.ok === false)) throw new Error(`${method} ${path} ${r.status} ${t}`);
  return d.data ?? d;
};

const project = process.env.KB_DEV_PROJECT || 'demo';
const boards = await j('GET', '/api/projects');
if (!boards.projects.some((p) => p.slug === project)) {
  await j('POST', '/api/projects', { slug: project, name: 'Demo' });
  await j('PATCH', `/api/columns/${project}/doing`, { wipLimit: 1 }).catch(() => {});
  const created = await Promise.all([
    j('POST', '/api/cards', { project, title: 'Design the management layer', body: '- [x] API\n- [ ] UI', columnId: 'doing', priority: 60, owner: 'herta' }),
    j('POST', '/api/cards', { project, title: 'Attach screenshots', body: 'Drop a png on the card.', columnId: 'todo', blockedReason: 'needs the upload UI' }),
    j('POST', '/api/cards', { project, title: 'Ship v2 docs', columnId: 'todo', due: '2020-01-01' }),
    j('POST', '/api/cards', { project, title: 'Cut a release', columnId: 'todo' }),
  ]);
  const [a, b, c, d] = created.map((r) => r.card);
  await j('POST', '/api/dependencies', { project, fromCard: d.id, toCard: a.id, type: 'blocks' });
  await j('POST', '/api/dependencies', { project, fromCard: d.id, toCard: b.id, type: 'blocks' });
  await j('POST', '/api/dependencies', { project, fromCard: c.id, toCard: b.id, type: 'relates' });
  await j('POST', '/api/views', { project, name: 'いまやる', query: { columnId: 'doing' } });
  await j('POST', '/api/templates', { project, name: 'bug', title: 'bug: ', body: '## 再現\n## 期待' });
  // one real 1x1 png so the attachment strip has something to show
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${base}/api/attachments?project=${project}&cardId=${a.id}&name=shot.png`, { method: 'POST', headers: { authorization: `Bearer ${run.token}` }, body: png });
  if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
}

console.log(`home: ${home}`);
console.log(`open: ${base}/?token=${run.token}`);
