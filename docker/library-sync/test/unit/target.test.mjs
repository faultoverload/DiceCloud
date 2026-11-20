import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, planChanges } from '../../src/target.mjs';

test('canonical ignores key order and treats a date like its EJSON form', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), canonical({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  assert.equal(canonical({ at: new Date(5) }), '{"at":{"$date":5}}');
  assert.equal(canonical({ a: 1, gone: undefined }), canonical({ a: 1 }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }), 'array order matters');
  assert.notEqual(canonical({ a: 1 }), canonical({ a: '1' }));
});

test('planChanges sorts documents into added, changed, removed and unchanged', () => {
  const existing = [{ _id: 'same', n: 1, t: new Date(9) }, { _id: 'edit', n: 1 }, { _id: 'drop', n: 1 }];
  const wanted = [{ t: new Date(9), n: 1, _id: 'same' }, { _id: 'edit', n: 2 }, { _id: 'fresh', n: 1 }];
  const plan = planChanges(existing, wanted);
  assert.deepEqual([plan.added, plan.changed, plan.removed, plan.unchanged], [1, 1, 1, 1]);
  assert.deepEqual(plan.upserts.map((d) => d._id), ['edit', 'fresh']);
  assert.deepEqual(plan.deletes, ['drop']);
});

test('nothing to do when the database already matches', () => {
  const docs = [{ _id: 'a', left: 1, right: 2 }, { _id: 'b', left: 3, right: 4 }];
  const plan = planChanges(docs, docs.map((d) => ({ ...d })));
  assert.deepEqual([plan.upserts.length, plan.deletes.length, plan.unchanged], [0, 0, 2]);
  assert.deepEqual(planChanges([], []), { upserts: [], deletes: [], added: 0, changed: 0, removed: 0, unchanged: 0 });
});
