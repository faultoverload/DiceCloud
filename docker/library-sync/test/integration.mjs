// End-to-end test: runs the sync (as `node src/sync.mjs`, or as a container when IMAGE is set)
// against a fake dicecloud.com and a real MongoDB, and checks the database after each run.
//
//   MONGO_URL=mongodb://127.0.0.1:27017/meteor [IMAGE=dicecloud-library-sync:ci] node test/integration.mjs
//
// test/run.sh starts the MongoDB and calls this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { startFakeDiceCloud } from './fake-dicecloud.mjs';

const MONGO_URL = process.env.MONGO_URL;
const IMAGE = process.env.IMAGE;
if (!MONGO_URL) { console.error('set MONGO_URL'); process.exit(2); }
const HERE = path.dirname(new URL(import.meta.url).pathname);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').slice(0, 12).join('\n     ')}`);
  }
}

// ── the fake source ─────────────────────────────────────────────────────────
const id = (name) => name.padEnd(17, 'A').slice(0, 17);
const [A, B, D, E, F, G, P, X, Z, L] = ['libAlpha', 'libBravo', 'libDelta', 'libEcho', 'libFoxtrot', 'libGolf', 'libPrivate', 'libDeleted', 'libZulu', 'libLocal'].map(id);
const [C, N] = ['colCharlie', 'colNovember'].map(id);
const fake = await startFakeDiceCloud({ username: 'tester', password: 'correct horse' });
const libraryDoc = (libraryId, name, extra = {}) => ({ _id: libraryId, name, owner: 'remoteOwnerId', readers: [], writers: [], public: true, subscriberCount: 7, ...extra });
const nodeV2 = (libraryId, nodeId, order, parentId, extra = {}) => {
  const lib = { id: libraryId, collection: 'libraries' };
  const parent = parentId ? { id: parentId, collection: 'libraryNodes' } : lib;
  return { _id: nodeId, type: 'folder', name: nodeId, order, parent, ancestors: parentId ? [lib, parent] : [lib], tags: [], ...extra };
};
const { libraries, nodes, collections } = fake.data;
libraries.set(A, libraryDoc(A, 'Alpha', { showInMarket: true }));
nodes.set(A, [
  nodeV2(A, 'a_folder', 1),
  // castingTime is only returned when asked for by name; mysteryField is in no schema
  nodeV2(A, 'a_spell', 1, 'a_folder', { type: 'spell', castingTime: 'action', mysteryField: 'only in the full document' }),
  nodeV2(A, 'a_removed', 2, 'a_folder', { removed: true, removedAt: { $date: 1700000000000 } }),
  nodeV2(A, 'a_ref', 2, null, { type: 'reference', ref: { id: 'b_item', collection: 'libraryNodes' } }),
  nodeV2(A, 'a_dated', 3, null, { type: 'note', removedAt: { $date: 1600000000000 } }),
]);
libraries.set(B, libraryDoc(B, 'Bravo', { showInMarket: true }));
nodes.set(B, [nodeV2(B, 'b_item', 1, null, { type: 'item', name: 'Item, current name' })]);
libraries.set(D, libraryDoc(D, 'Delta'));
nodes.set(D, [nodeV2(D, 'd_feature', 1, null, { type: 'feature' })]);
libraries.set(P, libraryDoc(P, 'Private', { public: false }));
nodes.set(P, [nodeV2(P, 'p_secret', 1)]);
libraries.set(E, libraryDoc(E, 'Echo'));
nodes.set(E, [nodeV2(E, 'e_class', 1, null, { type: 'class' })]);
libraries.set(Z, libraryDoc(Z, 'Zulu'));
nodes.set(Z, [nodeV2(Z, 'z_note', 1, null, { type: 'note' })]);
collections.set(C, { _id: C, name: 'Collection Charlie', owner: 'remoteOwnerId', readers: [], writers: [], public: true, showInMarket: true, subscriberCount: 3, libraries: [A, D, P, X] });
collections.set(N, { _id: N, name: 'Collection November', owner: 'remoteOwnerId', readers: [], writers: [], public: true, subscriberCount: 1, libraries: [E] });

// ── the database, with what a real instance already holds ───────────────────
const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db();
await db.dropDatabase();
const localRoot = { id: L, collection: 'libraries' };
await db.collection('migrations').insertOne({ _id: 'control', version: 3, locked: false });
await db.collection('libraries').insertMany([
  { _id: L, name: 'Made on this server', owner: 'localUser', readers: [], writers: [], public: false },
  // An older copy of Bravo: one node has since been renamed, one deleted
  { ...libraryDoc(B, 'Bravo', { showInMarket: true }), subscriberCount: 99 },
]);
await db.collection('libraryNodes').insertMany([
  { _id: 'l_one', type: 'folder', name: 'Local folder', root: localRoot, left: 1, right: 4 },
  { _id: 'l_two', type: 'note', name: 'Local note', root: localRoot, parentId: 'l_one', left: 2, right: 3 },
  { _id: 'b_item', type: 'item', name: 'Item, old name', root: { id: B, collection: 'libraries' }, left: 1, right: 2, tags: [] },
  { _id: 'b_stale', type: 'item', name: 'Deleted upstream', root: { id: B, collection: 'libraries' }, left: 3, right: 4, tags: [] },
]);
await db.collection('users').insertOne({ _id: 'localUser', username: 'local', subscribedLibraries: [B], subscribedLibraryCollections: [C] });
await db.collection('creatures').insertOne({ _id: 'creature1', name: 'A character', owner: 'localUser' });
await db.collection('creatureProperties').insertMany([
  { _id: 'prop1', type: 'item', name: 'Copied from Bravo earlier', libraryNodeId: 'b_item', root: { id: 'creature1', collection: 'creatures' }, left: 1, right: 2 },
  { _id: 'prop2', type: 'note', root: { id: 'creature1', collection: 'creatures' }, left: 3, right: 4 },
]);
const dump = async (names) => JSON.stringify(await Promise.all(names.map((name) => db.collection(name).find().sort({ _id: 1 }).toArray())));
const NOT_OURS = ['users', 'creatures', 'creatureProperties', 'migrations'];
const LIBRARY_DATA = ['libraries', 'libraryNodes', 'libraryCollections'];
const notOursBefore = await dump(NOT_OURS);
const localLibrary = async () => JSON.stringify([await db.collection('libraries').findOne({ _id: L }), await db.collection('libraryNodes').find({ 'root.id': L }).sort({ left: 1 }).toArray()]);
const localLibraryBefore = await localLibrary();

// ── running the sync ────────────────────────────────────────────────────────
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-sync-test-'));
fs.chmodSync(workDir, 0o755);
function writeConfig({ librariesYaml = 'all', password = 'correct horse', extra = '' } = {}) {
  fs.writeFileSync(path.join(workDir, 'config.yml'), [
    'source:', `  url: ${fake.url}`, '  username: tester', `  password: ${password}`, '  throttle_ms: 250',
    'target:', `  mongo_url: ${MONGO_URL}`, `libraries: ${librariesYaml}`, extra, '',
  ].join('\n'), { mode: 0o644 });
}
let containerSeq = 0;
function startSync(args) {
  let child; let stop;
  if (IMAGE) {
    const name = `library-sync-test-${process.pid}-${++containerSeq}`;
    child = spawn('docker', ['run', '--rm', '--name', name, '--network', 'host', '-v', `${workDir}:/config:ro`, IMAGE, '--config', '/config/config.yml', ...args]);
    stop = () => spawn('docker', ['stop', '-t', '10', name], { stdio: 'ignore' });
  } else {
    child = spawn(process.execPath, [path.join(HERE, '../src/sync.mjs'), '--config', path.join(workDir, 'config.yml'), ...args]);
    stop = () => child.kill('SIGTERM');
  }
  const run = { out: '', code: undefined, stop };
  child.stdout.on('data', (chunk) => { run.out += chunk; });
  child.stderr.on('data', (chunk) => { run.out += chunk; });
  run.exited = new Promise((resolve) => child.on('close', (code) => { run.code = code; resolve(run); }));
  return run;
}
const sync = (...args) => startSync(args).exited;
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
};
const lastRun = async () => (await db.collection('librarySyncState').findOne({ _id: 'state' }))?.lastRun;
const nodesOf = (libraryId) => db.collection('libraryNodes').find({ 'root.id': libraryId }).sort({ left: 1 }).toArray();
const shape = (docs) => docs.map((d) => `${d._id}:${d.left}-${d.right}${d.parentId ? `<${d.parentId}` : ''}`).join(' ');
const libraryIds = async () => (await db.collection('libraries').find().project({ _id: 1 }).toArray()).map((d) => d._id).sort();

try {
  // ── run 1: everything on the community page, into a database that has an old copy of Bravo
  writeConfig();
  let run = await sync('--once');
  let summary = await lastRun();
  await check('run 1: exits 0 and logs in once', () => {
    assert.equal(run.code, 0, run.out);
    assert.equal(fake.stats.loginAttempts, 1);
  });
  await check('run 1: copies market libraries and every library a market collection lists, and nothing else', async () => {
    assert.deepEqual(await libraryIds(), [A, B, D, L].sort());
    assert.deepEqual(summary.libraries, { selected: 5, new: 2, updated: 1, unchanged: 0, inaccessible: 2, failed: 0 });
  });
  await check('run 1: the old tree layout is converted to nested sets and removed nodes are left out', async () => {
    const docs = await nodesOf(A);
    assert.equal(shape(docs), 'a_folder:1-4 a_spell:2-3<a_folder a_ref:5-6 a_dated:7-8');
    assert.ok(docs.every((d) => d.root.id === A && d.root.collection === 'libraries'));
    assert.deepEqual(docs[1].parent, { id: 'a_folder', collection: 'libraryNodes' });
  });
  await check('run 1: fields outside the tree fields arrive, including one that no schema lists', async () => {
    const spell = await db.collection('libraryNodes').findOne({ _id: 'a_spell' });
    assert.equal(spell.castingTime, 'action');
    assert.equal(spell.mysteryField, 'only in the full document');
    assert.deepEqual((await db.collection('libraryNodes').findOne({ _id: 'a_ref' })).ref, { id: 'b_item', collection: 'libraryNodes' });
    assert.deepEqual(summary.discoveredKeys, ['mysteryField']);
    assert.deepEqual(Object.keys((await db.collection('librarySyncState').findOne({ _id: 'state' })).discoveredKeys), ['mysteryField']);
  });
  await check('run 1: dates are stored as dates', async () => {
    assert.equal(await db.collection('libraryNodes').countDocuments({ _id: 'a_dated', removedAt: { $type: 'date' } }), 1);
  });
  await check('run 1: an existing copy is brought up to date (renamed node, node deleted upstream), keeping its local subscriber count', async () => {
    assert.equal(shape(await nodesOf(B)), 'b_item:1-2');
    assert.equal((await db.collection('libraryNodes').findOne({ _id: 'b_item' })).name, 'Item, current name');
    assert.equal((await db.collection('libraries').findOne({ _id: B })).subscriberCount, 99);
    assert.equal((await db.collection('libraries').findOne({ _id: A })).subscriberCount, 7);
    assert.deepEqual(summary.changedLibraries.find((l) => l.id === B), { id: B, name: 'Bravo', status: 'updated', added: 0, changed: 1, removed: 1 });
  });
  await check('run 1: collections are copied; private and deleted members are reported, by collection', async () => {
    assert.deepEqual((await db.collection('libraryCollections').findOne({ _id: C })).libraries, [A, D, P, X]);
    assert.equal(await db.collection('libraryCollections').countDocuments(), 1, 'the collection that is not on the community page is not copied');
    const byId = Object.fromEntries(summary.inaccessibleLibraries.map((l) => [l.id, l]));
    assert.match(byId[P].error, /View permission denied/);
    assert.match(byId[X].error, /No such document exists/);
    assert.deepEqual(byId[P].collections, ['Collection Charlie']);
    assert.deepEqual(summary.collectionsWithGaps, [{ id: C, name: 'Collection Charlie', libraries: 4, missing: 2 }]);
    assert.equal(await db.collection('libraryNodes').countDocuments({ _id: 'p_secret' }), 0);
  });
  const untouched = async (label) => check(`${label}: users, characters and libraries made on this server are untouched`, async () => {
    assert.equal(await dump(NOT_OURS), notOursBefore);
    assert.equal(await localLibrary(), localLibraryBefore);
  });
  await untouched('run 1');

  // ── run 2: nothing changed at the source
  let before = await dump(LIBRARY_DATA);
  run = await sync('--once');
  summary = await lastRun();
  await check('run 2: with nothing new at the source, nothing is written', async () => {
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(summary.libraries, { selected: 5, new: 0, updated: 0, unchanged: 3, inaccessible: 2, failed: 0 });
    assert.deepEqual(summary.nodes, { added: 0, changed: 0, removed: 0, total: 6 });
    assert.deepEqual(summary.collections, { selected: 1, new: 0, updated: 0, unchanged: 1 });
    assert.equal(await dump(LIBRARY_DATA), before);
  });

  // ── run 3: the source changed
  nodes.get(A).find((n) => n._id === 'a_spell').name = 'Renamed spell';
  nodes.get(A).push(nodeV2(A, 'a_new', 0, 'a_folder', { type: 'feature' }));
  nodes.set(A, nodes.get(A).filter((n) => n._id !== 'a_ref'));
  libraries.get(B).public = false; // leaves the community page, and is in no collection
  libraries.get(D).public = false; // still listed by Collection Charlie
  libraries.set(F, libraryDoc(F, 'Foxtrot', { showInMarket: true }));
  nodes.set(F, [nodeV2(F, 'f_item', 1, null, { type: 'item' })]);
  collections.get(C).libraries.push(F);
  run = await sync('--once');
  summary = await lastRun();
  await check('run 3: an update adds, changes and deletes nodes and renumbers the tree', async () => {
    assert.equal(run.code, 0, run.out);
    assert.equal(shape(await nodesOf(A)), 'a_folder:1-6 a_new:2-3<a_folder a_spell:4-5<a_folder a_dated:7-8');
    assert.equal((await db.collection('libraryNodes').findOne({ _id: 'a_spell' })).name, 'Renamed spell');
    assert.equal(await db.collection('libraryNodes').countDocuments({ _id: 'a_ref' }), 0);
    assert.deepEqual(summary.changedLibraries.find((l) => l.id === A), { id: A, name: 'Alpha', status: 'updated', added: 1, changed: 2, removed: 1 });
  });
  await check('run 3: a library new to the community page is copied and the changed collection updated', async () => {
    assert.equal(shape(await nodesOf(F)), 'f_item:1-2');
    assert.deepEqual((await db.collection('libraryCollections').findOne({ _id: C })).libraries, [A, D, P, X, F]);
    assert.deepEqual(summary.collections, { selected: 1, new: 0, updated: 1, unchanged: 0 });
  });
  await check('run 3: libraries that turned private keep their local copies; the one a collection still lists is reported', async () => {
    assert.equal(shape(await nodesOf(B)), 'b_item:1-2');
    assert.equal(shape(await nodesOf(D)), 'd_feature:1-2');
    assert.equal(await db.collection('libraries').countDocuments({ _id: { $in: [B, D] } }), 2);
    assert.deepEqual(summary.libraries, { selected: 5, new: 1, updated: 1, unchanged: 0, inaccessible: 3, failed: 0 });
    assert.equal(summary.inaccessibleLibraries.find((l) => l.id === D).keptLocalCopy, true);
    assert.equal(summary.inaccessibleLibraries.find((l) => l.id === P).keptLocalCopy, false);
    assert.deepEqual(summary.collectionsWithGaps, [{ id: C, name: 'Collection Charlie', libraries: 5, missing: 2 }], 'only members with no local copy count as gaps');
  });
  await untouched('run 3');

  // ── run 4: dry run
  nodes.set(A, nodes.get(A).filter((n) => n._id !== 'a_dated'));
  libraries.set(G, libraryDoc(G, 'Golf', { showInMarket: true }));
  nodes.set(G, [nodeV2(G, 'g_item', 1)]);
  before = await dump([...LIBRARY_DATA, 'librarySyncState']);
  run = await sync('--once', '--dry-run');
  await check('run 4: a dry run reports what would change and writes nothing, not even its own state', async () => {
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /done \(dry run\): 6 libraries selected, 1 new, 1 updated, 1 unchanged, 3 not viewable, 0 failed; nodes \+1 ~0 -1;/);
    assert.equal(await dump([...LIBRARY_DATA, 'librarySyncState']), before);
  });

  // ── run 5: a list instead of "all"
  const subsBefore = fake.stats.subParams.length;
  const bogus = id('noSuchThing');
  writeConfig({ librariesYaml: `\n  - https://dicecloud.com/library-collection/${N}\n  - ${Z}   # a single library\n  - ${bogus}` });
  before = JSON.stringify([await nodesOf(A), await db.collection('libraries').findOne({ _id: A })]);
  run = await sync('--once');
  summary = await lastRun();
  await check('run 5: a list copies exactly the collections and libraries it names', async () => {
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(await libraryIds(), [A, B, D, E, F, L, Z].sort());
    assert.equal(shape(await nodesOf(E)), 'e_class:1-2');
    assert.equal(shape(await nodesOf(Z)), 'z_note:1-2');
    assert.deepEqual((await db.collection('libraryCollections').findOne({ _id: N })).libraries, [E]);
    assert.deepEqual(summary.libraries, { selected: 3, new: 2, updated: 0, unchanged: 0, inaccessible: 1, failed: 0 });
    assert.equal(JSON.stringify([await nodesOf(A), await db.collection('libraries').findOne({ _id: A })]), before, 'libraries outside the list are not touched');
    const asked = fake.stats.subParams.slice(subsBefore).filter(([name]) => name === 'library' || name === 'libraryNodes').map(([, libraryId]) => libraryId);
    assert.ok(!asked.includes(A) && !asked.includes(G), 'libraries outside the list are not requested');
  });
  await check('run 5: an id in the list that cannot be viewed is called out', async () => {
    assert.deepEqual(summary.notViewableFromConfig, [bogus]);
    assert.match(run.out, new RegExp(`WARNING: ${bogus} from the config file`));
  });
  await untouched('run 5');

  // ── run 6: wrong password
  const attempts = fake.stats.loginAttempts;
  writeConfig({ password: 'wrong' });
  before = await dump(LIBRARY_DATA);
  run = await sync('--once');
  await check('run 6: a refused login fails the run after one attempt and changes nothing', async () => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /login failed: 403 Incorrect password/);
    assert.equal(fake.stats.loginAttempts, attempts + 1);
    assert.equal(await dump(LIBRARY_DATA), before);
    assert.equal((await lastRun()).ok, false);
  });

  // ── run 6b: the connection drops part-way through a library
  writeConfig({ librariesYaml: `[${Z}]` });
  fake.control.dropOn = 'libraryNodes';
  const logins = fake.stats.logins;
  run = await sync('--once');
  summary = await lastRun();
  await check('run 6b: a dropped connection is retried after logging in again', async () => {
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /attempt 1\/3 failed: socket closed/);
    assert.equal(fake.stats.logins, logins + 2);
    assert.deepEqual(summary.libraries, { selected: 1, new: 0, updated: 0, unchanged: 1, inaccessible: 0, failed: 0 });
    assert.equal(shape(await nodesOf(Z)), 'z_note:1-2');
  });

  // ── run 6c: a database at another version
  await db.collection('migrations').updateOne({ _id: 'control' }, { $set: { version: 2 } });
  before = await dump(LIBRARY_DATA);
  const connectionsBefore = fake.stats.connections;
  run = await sync('--once');
  await db.collection('migrations').updateOne({ _id: 'control' }, { $set: { version: 3 } });
  await check('run 6c: a database that is not at version 3 is refused before the source is contacted', async () => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /database is at version 2; this tool writes version 3 documents/);
    assert.equal(fake.stats.connections, connectionsBefore);
    assert.equal(await dump(LIBRARY_DATA), before);
  });

  // ── run 7: scheduled
  writeConfig({ librariesYaml: `[${Z}]`, extra: 'schedule:\n  interval: 1h' });
  let connections = fake.stats.connections;
  let scheduled = startSync([]);
  await check('run 7: with an interval it syncs at start, then stays running until the next one is due', async () => {
    await Promise.race([until(() => /next sync at/.test(scheduled.out), 60000, '"next sync at"'), scheduled.exited.then(() => { throw new Error(`exited early:\n${scheduled.out}`); })]);
    assert.match(scheduled.out, /syncing every 1 hours/);
    assert.match(scheduled.out, /done: 1 libraries selected, 0 new, 0 updated, 1 unchanged/);
    assert.equal(fake.stats.connections, connections + 1);
    await sleep(1500);
    assert.equal(scheduled.code, undefined, 'still running');
  });
  await check('run 7: it stops cleanly when told to', async () => {
    scheduled.stop();
    await Promise.race([scheduled.exited, sleep(20000).then(() => { throw new Error('did not stop within 20s'); })]);
    assert.equal(scheduled.code, 0, scheduled.out);
    assert.match(scheduled.out, /stopped/);
  });
  connections = fake.stats.connections;
  scheduled = startSync([]);
  await check('run 7: restarted before the interval has passed, it waits instead of contacting the source again', async () => {
    await Promise.race([until(() => /next sync at/.test(scheduled.out), 30000, '"next sync at"'), scheduled.exited.then(() => { throw new Error(`exited early:\n${scheduled.out}`); })]);
    await sleep(1000);
    assert.equal(fake.stats.connections, connections);
    assert.doesNotMatch(scheduled.out, /logged in/);
  });
  // a restart loop on a bad password must not become a stream of logins
  scheduled.stop(); await scheduled.exited;
  writeConfig({ librariesYaml: `[${Z}]`, password: 'wrong', extra: 'schedule:\n  interval: 1h' });
  const attemptsBefore = fake.stats.loginAttempts;
  scheduled = startSync([]);
  await check('run 7: a refused login in scheduled mode does not exit, and is not retried until the next interval', async () => {
    await Promise.race([until(() => /next sync at/.test(scheduled.out), 30000, '"next sync at"'), scheduled.exited.then(() => { throw new Error(`exited early:\n${scheduled.out}`); })]);
    assert.match(scheduled.out, /login failed/);
    assert.equal(fake.stats.loginAttempts, attemptsBefore + 1);
    assert.equal(scheduled.code, undefined, 'still running');
  });
  scheduled.stop(); await scheduled.exited;
  connections = fake.stats.connections;
  scheduled = startSync([]);
  await check('run 7: nor after a restart', async () => {
    await Promise.race([until(() => /next sync at/.test(scheduled.out), 30000, '"next sync at"'), scheduled.exited.then(() => { throw new Error(`exited early:\n${scheduled.out}`); })]);
    assert.equal(fake.stats.connections, connections);
    assert.equal(fake.stats.loginAttempts, attemptsBefore + 1);
  });
  scheduled.stop(); await scheduled.exited;
  await untouched('at the end');
} finally {
  await client.close();
  await fake.close();
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log(`\nALL CHECKS PASSED (${IMAGE ? `image ${IMAGE}` : 'node src/sync.mjs'})`);
