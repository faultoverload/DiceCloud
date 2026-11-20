// End-to-end check that copying library nodes onto a character works, and that the copied
// properties behave: point buys, and actions with triggers that remove a buff.
//
//   node smoke.mjs ws://host:port/websocket
//
// Talks to a running DiceCloud the way the web client does (DDP over a websocket), as a
// brand-new user on an empty database. Needs Node 22+ for the built-in WebSocket client.
// See README.md in this directory for what is covered.
import crypto from 'node:crypto';

const url = process.argv[2];
if (!url) { console.error('usage: node smoke.mjs ws://host:port/websocket'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

// ── minimal DDP client ───────────────────────────────────────────────────────
const ws = new WebSocket(url);
const pending = new Map();
const collections = new Map();
const col = (name) => { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); };
let seq = 0;
const send = (o) => ws.send(JSON.stringify(o));
const wait = (key, ms = 60000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { pending.delete(key); reject(new Error(`timed out waiting for ${key}`)); }, ms);
  pending.set(key, (v) => { clearTimeout(timer); pending.delete(key); resolve(v); });
});
ws.addEventListener('message', (event) => {
  const d = JSON.parse(event.data);
  if (d.msg === 'ping') send({ msg: 'pong', id: d.id });
  else if (d.msg === 'connected') pending.get('connected')?.();
  else if (d.msg === 'added') col(d.collection).set(d.id, { _id: d.id, ...d.fields });
  else if (d.msg === 'changed') {
    const doc = col(d.collection).get(d.id) || { _id: d.id };
    Object.assign(doc, d.fields || {});
    (d.cleared || []).forEach((k) => delete doc[k]);
    col(d.collection).set(d.id, doc);
  } else if (d.msg === 'removed') col(d.collection).delete(d.id);
  else if (d.msg === 'result') pending.get(`result${d.id}`)?.(d);
  else if (d.msg === 'updated') d.methods.forEach((id) => pending.get(`updated${id}`)?.());
  else if (d.msg === 'ready') d.subs.forEach((id) => pending.get(`sub${id}`)?.({ ok: true }));
  else if (d.msg === 'nosub') pending.get(`sub${d.id}`)?.({ ok: false, error: d.error });
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exit(1); });

/** Calls a method and waits until its writes have reached this connection. */
async function call(method, ...params) {
  const id = String(++seq);
  const result = wait(`result${id}`);
  const updated = wait(`updated${id}`);
  send({ msg: 'method', method, params, id });
  const r = await result;
  if (r.error) throw new Error(`${method}: ${r.error.reason || r.error.message || r.error.error}`);
  await updated;
  return r.result;
}
async function subscribe(name, ...params) {
  const id = String(++seq);
  const ready = wait(`sub${id}`);
  send({ msg: 'sub', id, name, params });
  const r = await ready;
  if (!r.ok) throw new Error(`subscription ${name} refused: ${r.error?.reason || r.error?.error}`);
}
/** Retries until fn() returns something truthy; observers poll, so writes can lag a few seconds. */
async function eventually(fn, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
}

// ── scenario ─────────────────────────────────────────────────────────────────
const connected = wait('connected');
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
send({ msg: 'connect', version: '1', support: ['1'] });
await connected;

const suffix = crypto.randomBytes(4).toString('hex');
await call('createUser', {
  username: `smoke${suffix}`,
  email: `smoke${suffix}@example.invalid`,
  password: { digest: crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex'), algorithm: 'sha-256' },
});

const libraryId = await call('libraries.insert', { name: 'Smoke test library' });
const inLibrary = { id: libraryId, collection: 'libraries' };
const under = (id) => ({ id, collection: 'libraryNodes' });
// libraryNodes.insert allows 5 calls per 5 seconds
const insertNode = async (libraryNode, parentRef) => {
  await sleep(1100);
  return call('libraryNodes.insert', { libraryNode, parentRef });
};

// A subtree that other nodes point at, itself containing a reference
const nested = await insertNode({ type: 'feature', name: 'Nested target' }, inLibrary);
const target = await insertNode({ type: 'folder', name: 'Shared target' }, inLibrary);
const targetChild = await insertNode({ type: 'feature', name: 'Target child' }, under(target));
await insertNode({ type: 'reference', ref: under(nested) }, under(target));
// A top-level reference, like the reference slot fillers the community libraries use
const topRef = await insertNode({ type: 'reference', ref: under(target) }, inLibrary);
// The only ruleset this user has, so creating a character inserts it automatically
const ruleset = await insertNode({ type: 'folder', name: 'Smoke ruleset', fillSlots: true, libraryTags: ['base'] }, inLibrary);
const direct = await insertNode({ type: 'feature', name: 'Direct child' }, under(ruleset));
await insertNode({ type: 'reference', ref: under(target) }, under(ruleset));

const creatureId = await call('creatures.insertCreature', { name: 'Smoke character', startingLevel: 0 });
await subscribe('singleCharacter', creatureId);
const props = () => [...col('creatureProperties').values()];
const copiesOf = (nodeId) => props().filter((p) => p.libraryNodeId === nodeId);
const slot = props().find((p) => p.type === 'propertySlot' && p.name === 'Ruleset');
if (!slot) { check(false, 'new character has a Ruleset slot'); process.exit(1); }

// 1. Ruleset inserted automatically when the character was created
const rulesetCopy = await eventually(() => copiesOf(ruleset)[0], 15000);
check(!!rulesetCopy, 'creating a character copies its ruleset onto the sheet',
  `no copy of the ruleset among the character's ${props().length} properties`);

// 2. The same call the "fill slot" and "insert from library" dialogs make
let explicitError;
try {
  await sleep(1100);
  await call('creatureProperties.insertPropertyFromLibraryNode',
    { nodeIds: [topRef], parentRef: { id: slot._id, collection: 'creatureProperties' } });
  await sleep(1100);
  await call('creatureProperties.insertPropertyFromLibraryNode',
    { nodeIds: [nested], parentRef: { id: creatureId, collection: 'creatures' } });
} catch (e) { explicitError = e.message; }
check(!explicitError, 'insertPropertyFromLibraryNode calls succeed', explicitError);

// Expected tree once everything has settled:
//   Ruleset slot
//   ├─ Smoke ruleset            (automatic)
//   │  ├─ Direct child
//   │  └─ Shared target         (reference replaced by its target)
//   │     ├─ Target child
//   │     └─ Nested target      (reference inside the target, replaced too)
//   └─ Shared target            (top-level reference inserted into the slot)
//      ├─ Target child
//      └─ Nested target
//   Nested target               (inserted at the character's root)
const byId = () => new Map(props().map((p) => [p._id, p]));
const childrenOf = (id, nodeId) => copiesOf(nodeId).filter((p) => p.parentId === id);
const structure = () => {
  const r = copiesOf(ruleset)[0];
  const targets = copiesOf(target);
  if (!r || targets.length !== 2) return null;
  const underRuleset = targets.find((t) => t.parentId === r._id);
  const underSlot = targets.find((t) => t.parentId === slot._id);
  if (!underRuleset || !underSlot) return null;
  const ok = r.parentId === slot._id
    && childrenOf(r._id, direct).length === 1
    && [underRuleset, underSlot].every((t) => childrenOf(t._id, targetChild).length === 1 && childrenOf(t._id, nested).length === 1)
    && copiesOf(nested).length === 3
    && copiesOf(nested).filter((p) => !p.parentId).length === 1;
  return ok ? { r, underRuleset, underSlot } : null;
};
const settled = await eventually(structure);
check(!!settled, 'copies hang off the right parents (slot → ruleset → children, references replaced in place)',
  JSON.stringify(props().filter((p) => p.libraryNodeId).map((p) => ({ name: p.name, type: p.type, parentId: p.parentId, root: p.root?.id }))));

check(props().every((p) => p.root?.id === creatureId && p.root?.collection === 'creatures'),
  'every property is rooted in the character');
check(props().filter((p) => p.libraryNodeId).length === 9, 'nine properties came from the library',
  `got ${props().filter((p) => p.libraryNodeId).length}`);
check(!props().some((p) => p.type === 'reference'), 'no unresolved reference nodes were copied');

// Nested-set numbering is rebuilt after the insert
const numbered = await eventually(() => {
  const all = props(); const index = byId();
  const numbers = all.flatMap((p) => [p.left, p.right]);
  return all.every((p) => p.left < p.right)
    && new Set(numbers).size === numbers.length
    && all.every((p) => !p.parentId || (index.has(p.parentId) && index.get(p.parentId).left < p.left && p.right < index.get(p.parentId).right));
});
check(!!numbered, 'tree numbering is consistent (left < right, children inside their parents)',
  JSON.stringify(props().map((p) => [p.name, p.left, p.right, p.parentId])));

// The sheet's own computation sees the slot as filled
const filled = await eventually(() => col('creatureProperties').get(slot._id)?.totalFilled >= 1);
check(!!filled, 'the Ruleset slot reports itself as filled',
  `totalFilled=${col('creatureProperties').get(slot._id)?.totalFilled}`);

// ── scenario 2: assigning ability scores ─────────────────────────────────────
// A point buy, and a cut-down copy of the "Standard Array" filler from the community libraries:
// an action sets a score from a list and moves an index along, and a trigger with a condition
// removes the whole buff once every score has been handed out.
const pointBuy = await insertNode({
  type: 'pointBuy', name: 'Smoke point buy',
  values: [
    { name: 'First', variableName: 'smokeFirst', value: 15 },
    { name: 'Second', variableName: 'smokeSecond', value: 8 },
    { name: 'Unset', variableName: 'smokeUnset' },
    { name: 'Fourth', variableName: 'smokeFourth', value: 14 },
  ],
  min: { calculation: '8' }, max: { calculation: '15' }, total: { calculation: '27' },
  cost: { calculation: 'max(value-8, 0) + max(value-13, 0)' },
}, inLibrary);
const score = await insertNode({
  type: 'attribute', name: 'Smoke score', variableName: 'smokeScore', attributeType: 'utility', ignoreUpperLimit: true,
}, inLibrary);
const buff = await insertNode({ type: 'buff', name: 'Smoke assign scores', target: 'self' }, inLibrary);
const index = await insertNode({
  type: 'attribute', name: 'Smoke index', variableName: 'smokeIndex', attributeType: 'stat',
  baseValue: { calculation: '1' }, ignoreUpperLimit: true,
}, under(buff));
const assign = await insertNode({ type: 'action', name: 'Smoke assign', actionType: 'event', target: 'singleTarget' }, under(buff));
await insertNode({
  type: 'adjustment', target: 'self', stat: 'smokeScore', operation: 'set', amount: { calculation: '[15, 14, 13][smokeIndex]' },
}, under(assign));
await insertNode({
  type: 'adjustment', target: 'self', stat: 'smokeIndex', operation: 'increment', amount: { calculation: '-1' }, silent: true,
}, under(assign));
const trigger = await insertNode({
  type: 'trigger', name: 'Smoke all assigned', event: 'damageProperty', timing: 'after', condition: { calculation: 'smokeIndex > 3' },
}, under(buff));
await insertNode({ type: 'buffRemover', target: 'target', targetParentBuff: true, removeAll: true }, under(trigger));

await sleep(1100);
await call('creatureProperties.insertPropertyFromLibraryNode',
  { nodeIds: [pointBuy, score, buff], parentRef: { id: creatureId, collection: 'creatures' } });
const copyOf = (nodeId) => copiesOf(nodeId)[0];

// Point buy: 15 costs 9, 8 costs nothing, a row without a value is skipped, 14 costs 7
const spent = await eventually(() => copyOf(pointBuy)?.spent === 16, 20000);
const pb = copyOf(pointBuy);
check(!!spent && pb.pointsLeft === 11 && pb.values.map((row) => row.spent).join() === '9,0,0,7',
  'a point buy works out what each row costs and how many points are left',
  `spent=${pb?.spent} pointsLeft=${pb?.pointsLeft} rows=${JSON.stringify(pb?.values?.map((row) => [row.value, row.spent]))}`);

// Each run of the action hands out the next score. The trigger is linked to the scores once the
// character has been computed, so wait for that before running anything.
await eventually(() => copyOf(score)?.damageTriggerIds?.after?.length && copyOf(index)?.value === 1, 20000);
const logOf = (actionId) => [...col('creatureLogs').values()].find((log) => log.actionId === actionId);
const logged = (actionId) => (logOf(actionId)?.content || []).map((c) => `${c.name || ''}${c.value ? `: ${c.value}` : ''}`);
async function runAssign() {
  await sleep(1100);   // actions.insertAction and actions.runAction are rate limited
  const actionId = await call('actions.insertAction', {
    action: { creatureId, task: { prop: copyOf(assign), targetIds: [] }, results: [], taskCount: 0 },
  });
  await call('actions.runAction', { actionId, decisions: [] });
  await eventually(() => logOf(actionId), 15000);
  return actionId;
}
const state = () => `score=${copyOf(score)?.value} index=${copyOf(index)?.value} buffRemoved=${!!copyOf(buff)?.removed}`;
let actionError;
const runs = [];
try {
  for (let i = 0; i < 3; i++) {
    const actionId = await runAssign();
    runs.push({ state: state(), log: logged(actionId) });
  }
} catch (e) { actionError = e.message; }
check(!actionError, 'the assign action runs three times', actionError);

check(runs[0]?.state === 'score=15 index=2 buffRemoved=false' && runs[1]?.state === 'score=14 index=3 buffRemoved=false',
  'each run sets the next score from the list and moves the index along', JSON.stringify(runs.map((r) => r.state)));
check(runs.length === 3 && runs.slice(0, 2).every((r) => !r.log.some((line) => line.startsWith('Smoke all assigned'))),
  'a trigger whose condition is false does not fire', JSON.stringify(runs.slice(0, 2).map((r) => r.log)));
check(!!runs[2]?.log.some((line) => line.startsWith('Smoke all assigned')) && runs[2].log.includes('Removed: Smoke assign scores'),
  'the trigger fires once its condition is true', JSON.stringify(runs[2]?.log));

// The buff and everything under it is gone from the sheet; the score it handed out stays
const underBuff = () => [index, assign, trigger].map(copyOf).concat(props().filter((p) => p.parentId === copyOf(assign)?._id || p.parentId === copyOf(trigger)?._id));
const removed = await eventually(() => copyOf(buff)?.removed === true && underBuff().length === 6 && underBuff().every((p) => p?.removed === true), 15000);
check(!!removed, 'the buff remover takes the buff and everything under it off the sheet',
  JSON.stringify([copyOf(buff), ...underBuff()].map((p) => [p?.type, p?.name, !!p?.removed])));
check(copyOf(score)?.value === 13 && !copyOf(score)?.removed, 'the last score handed out is kept', state());

// ── scenario 3: changing the same property several times in a row ────────────
// Three changes a couple of seconds apart, the way someone works down a column of sliders, sent
// with the same call the sheet makes. Every change has to be recomputed, not only the first, and
// the result has to reach the sheet without waiting for the server's next 10 second database poll.
const pointBuyId = copyOf(pointBuy)._id;
let editError;
let lastEdit;
for (const value of [9, 10, 11]) {
  if (lastEdit) await sleep(2000);
  try {
    await call('creatureProperties.update', { _id: pointBuyId, path: ['values', 1, 'value'], value });
  } catch (e) {
    editError = e.reason || e.message;
  }
  lastEdit = Date.now();
}
check(!editError, 'a point buy row can be changed three times', editError);
// 30 seconds is three polls: a result that is merely late still arrives, one that was never computed does not
const recomputed = await eventually(() => {
  const p = copyOf(pointBuy);
  return p?.values[1].spent === 3 && p.spent === 19 && p.pointsLeft === 8 && (Date.now() - lastEdit);
}, 30000);
const edited = copyOf(pointBuy);
const editedState = `rows=${JSON.stringify(edited?.values?.map((row) => [row.value, row.spent]))} spent=${edited?.spent} `
  + `pointsLeft=${edited?.pointsLeft} dirty=${edited?.dirty}`;
check(!!recomputed, 'the third change in a row is recomputed (11 costs 3, 19 spent, 8 left)', editedState);
check(!!recomputed && recomputed < 5000, 'the recomputed cost reaches the sheet within 5 seconds',
  recomputed ? `took ${recomputed} ms` : 'never arrived');

ws.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
