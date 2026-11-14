import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCid, parseCid, cid, sameCid } from '../../src/shared/ids.ts';

test('format/parse composite id', () => {
  assert.equal(formatCid({ projectId: 'proj', id: 7 }), 'proj#7');
  const p = parseCid('proj#7');
  assert.equal(p.projectId, 'proj');
  assert.equal(p.id, 7);
});

test('cid and sameCid', () => {
  assert.deepEqual(cid('p', 3), { projectId: 'p', id: 3 });
  assert.ok(sameCid({projectId:'p',id:1},{projectId:'p',id:1}));
  assert.ok(!sameCid({projectId:'p',id:1},{projectId:'p',id:2}));
  assert.ok(!sameCid({projectId:'a',id:1},{projectId:'b',id:1}));
});

test('parseCid/cid validate', () => {
  assert.throws(() => parseCid('nohash'));
  assert.throws(() => cid('', 1));
  assert.throws(() => cid('p', 0));
});
