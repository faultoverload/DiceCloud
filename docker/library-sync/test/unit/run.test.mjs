import test from 'node:test';
import assert from 'node:assert/strict';
import { msUntilDue, resolveSelection } from '../../src/run.mjs';

const HOUR = 3600e3;
const NOW = Date.UTC(2026, 0, 10);

test('the next run is counted from the last attempt', () => {
  assert.equal(msUntilDue({}, 'h', 24 * HOUR, NOW), 0, 'never ran');
  assert.equal(msUntilDue(undefined, 'h', 24 * HOUR, NOW), 0);
  assert.equal(msUntilDue({ lastAttemptAt: new Date(NOW - 5 * HOUR), configHash: 'h' }, 'h', 24 * HOUR, NOW), 19 * HOUR);
  assert.equal(msUntilDue({ lastAttemptAt: new Date(NOW - 30 * HOUR), configHash: 'h' }, 'h', 24 * HOUR, NOW), 0, 'overdue');
  assert.equal(msUntilDue({ lastAttemptAt: new Date(NOW - 1000).toISOString(), configHash: 'h' }, 'h', 24 * HOUR, NOW), 24 * HOUR - 1000, 'a date stored as text');
});

test('a changed configuration runs at once', () => {
  assert.equal(msUntilDue({ lastAttemptAt: new Date(NOW - HOUR), configHash: 'old' }, 'new', 24 * HOUR, NOW), 0);
});

const fakeSource = () => {
  const asked = [];
  return {
    asked,
    browse: async () => ({
      libraries: [{ _id: 'marketLib1' }, { _id: 'marketLib2' }],
      collections: [{ _id: 'marketCol', name: 'Market collection', libraries: ['marketLib1', 'hiddenLib', 'privateLib'] }],
    }),
    collection: async (id) => { asked.push(id); return id === 'unlistedCol' ? { _id: id, name: 'Unlisted', libraries: ['hiddenLib', 'otherLib'] } : null; },
  };
};

test('"all" is the community page plus every library its collections list', async () => {
  const source = fakeSource();
  const wanted = await resolveSelection(source, 'all');
  assert.deepEqual(wanted.libraryIds.sort(), ['hiddenLib', 'marketLib1', 'marketLib2', 'privateLib']);
  assert.deepEqual(wanted.collections.map((c) => c._id), ['marketCol']);
  assert.deepEqual(wanted.memberOf.get('hiddenLib'), ['Market collection']);
  assert.deepEqual(wanted.market, { libraries: 2, collections: 1 });
  assert.deepEqual(source.asked, [], 'no extra requests');
});

test('a list may name collections on or off the community page, and single libraries', async () => {
  const source = fakeSource();
  const wanted = await resolveSelection(source, ['marketCol', 'unlistedCol', 'marketLib2', 'someLibrary']);
  assert.deepEqual(wanted.libraryIds.sort(), ['hiddenLib', 'marketLib1', 'marketLib2', 'otherLib', 'privateLib', 'someLibrary']);
  assert.deepEqual(wanted.collections.map((c) => c._id), ['marketCol', 'unlistedCol']);
  assert.deepEqual(wanted.memberOf.get('hiddenLib'), ['Market collection', 'Unlisted']);
  assert.deepEqual(source.asked, ['unlistedCol', 'someLibrary'], 'ids already known from the community page are not asked for again');
});
