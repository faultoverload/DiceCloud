import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, fromEjson } from '../../src/tree.mjs';

const LIB = 'libraryAAAAAAAAAA';
const lib = { id: LIB, collection: 'libraries' };
const v2 = (id, order, parentId, extra = {}) => ({
  _id: id, type: 'folder', name: id, order,
  parent: parentId ? { id: parentId, collection: 'libraryNodes' } : lib,
  ancestors: parentId ? [lib, { id: parentId, collection: 'libraryNodes' }] : [lib],
  ...extra,
});
const shape = (docs) => docs.map((d) => `${d._id}:${d.left}-${d.right}${d.parentId ? `<${d.parentId}` : ''}`).join(' ');

test('version 2 layout becomes nested sets numbered from 1 in order', () => {
  const { docs, stats } = buildTree(LIB, [v2('b', 2), v2('a', 1), v2('a2', 5, 'a'), v2('a1', 3, 'a'), v2('a1x', 0, 'a1')]);
  assert.equal(shape(docs), 'a:1-8 a1:2-5<a a1x:3-4<a1 a2:6-7<a b:9-10');
  assert.deepEqual(stats, { removedSkipped: 0, orphans: 0, wrongRoot: 0, cycles: 0 });
  assert.ok(docs.every((d) => d.root.id === LIB && d.root.collection === 'libraries'));
  assert.ok(!('parentId' in docs[0]), 'top-level nodes have no parentId key');
  assert.deepEqual(docs[1].parent, { id: 'a', collection: 'libraryNodes' }, 'old fields are kept');
});

test('soft-removed nodes are dropped and their children move to the top level', () => {
  const { docs, stats } = buildTree(LIB, [v2('a', 1), v2('gone', 2, null, { removed: true }), v2('child', 3, 'gone')]);
  assert.equal(shape(docs), 'a:1-2 child:3-4');
  assert.equal(stats.removedSkipped, 1);
  assert.equal(stats.orphans, 1);
});

test('a node that is its own parent is moved to the top level with its subtree intact', () => {
  const { docs, stats } = buildTree(LIB, [
    v2('a', 1),
    { ...v2('loop', 2, 'loop'), ancestors: [lib] },
    { ...v2('under', 1, 'loop'), ancestors: [lib, { id: 'loop' }] },
    { ...v2('deeper', 1, 'under'), ancestors: [lib, { id: 'loop' }, { id: 'under' }] },
  ]);
  assert.equal(shape(docs), 'a:1-2 loop:3-8 under:4-7<loop deeper:5-6<under');
  assert.equal(stats.cycles, 1, 'one loop, not one per node under it');
});

test('version 3 documents keep their order', () => {
  const { docs } = buildTree(LIB, [
    { _id: 'second', type: 'folder', root: lib, left: 30, right: 31 },
    { _id: 'first', type: 'folder', root: lib, left: 10, right: 21 },
    { _id: 'inner', type: 'folder', root: lib, parentId: 'first', left: 11, right: 20 },
  ]);
  assert.equal(shape(docs), 'first:1-4 inner:2-3<first second:5-6');
});

test('a node filed under another library is counted', () => {
  const other = { id: 'libraryBBBBBBBBBB', collection: 'libraries' };
  assert.equal(buildTree(LIB, [{ ...v2('a', 1), ancestors: [other], parent: other }]).stats.wrongRoot, 1);
});

test('EJSON dates become dates, everything else is left alone', () => {
  const out = fromEjson({ at: { $date: 1700000000000 }, list: [{ when: { $date: 5 } }], odd: { $date: 'text' }, n: 1, s: 'x', nil: null });
  assert.ok(out.at instanceof Date && out.at.getTime() === 1700000000000);
  assert.ok(out.list[0].when instanceof Date);
  assert.deepEqual(out.odd, { $date: 'text' });
  assert.deepEqual([out.n, out.s, out.nil], [1, 'x', null]);
  const { docs } = buildTree(LIB, [v2('a', 1, null, { createdAt: { $date: 42 } })]);
  assert.ok(docs[0].createdAt instanceof Date);
});
