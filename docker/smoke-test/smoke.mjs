// End-to-end check that copying library nodes onto a character works.
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

ws.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
