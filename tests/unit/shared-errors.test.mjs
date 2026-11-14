import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail, DomainError } from '../../src/shared/errors.ts';

test('ok/fail envelopes', () => {
  assert.deepEqual(ok({x:1}), {ok:true,data:{x:1}});
  const f = fail('NOT_FOUND','nope');
  assert.equal(f.ok,false);
  assert.equal(f.error.code,'NOT_FOUND');
});

test('DomainError', () => {
  const e = new DomainError('CONFLICT','boom',{a:1});
  assert.equal(e.code,'CONFLICT');
  assert.equal(e.message,'boom');
  assert.deepEqual(e.details,{a:1});
});
