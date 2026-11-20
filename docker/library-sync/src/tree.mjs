// Converts library nodes as the source serves them into documents for a DiceCloud database
// at version 3 (nested sets).

/** DDP sends dates as EJSON `{ $date: ms }`; MongoDB needs real dates. */
export function fromEjson(value) {
  if (Array.isArray(value)) return value.map(fromEjson);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$date' && typeof value.$date === 'number') return new Date(value.$date);
    const out = {};
    for (const key of keys) out[key] = fromEjson(value[key]);
    return out;
  }
  return value;
}

/**
 * dicecloud.com still serves the version 2 tree layout (`ancestors` / `parent` / `order`).
 * This applies the same change as the app's own migration
 * (app/imports/migrations/server/dbv3/dbv3.ts):
 *   root       = the library
 *   parentId   = parent.id, when the parent is another library node
 *   left/right = nested set numbers from a depth-first walk in `order`, from 1, without gaps
 * The old fields are kept, as the migration leaves them. Soft-removed nodes are dropped.
 * If the source already serves version 3 fields, their order is kept.
 *
 * @returns {{ docs: object[], stats: { removedSkipped: number, orphans: number, wrongRoot: number, cycles: number } }}
 */
export function buildTree(libraryId, rawNodes) {
  const stats = { removedSkipped: 0, orphans: 0, wrongRoot: 0, cycles: 0 };
  const nodes = rawNodes.filter((node) => {
    if (node.removed === true) { stats.removedSkipped++; return false; }
    return true;
  });
  const byId = new Map(nodes.map((node) => [node._id, node]));
  const children = new Map(); // parent id, or null for the top level -> docs
  const out = new Map();
  for (const node of nodes) {
    const rootRef = node.root || node.ancestors?.[0];
    if (rootRef && rootRef.id !== libraryId) stats.wrongRoot++;
    let parentId = node.parentId ?? (node.parent?.collection === 'libraryNodes' ? node.parent.id : undefined);
    // A parent that isn't in the library: the node goes to the top level
    if (parentId && !byId.has(parentId)) { stats.orphans++; parentId = undefined; }
    const doc = { ...fromEjson(node), root: { id: libraryId, collection: 'libraries' } };
    if (parentId) doc.parentId = parentId; else delete doc.parentId;
    out.set(node._id, doc);
    const key = parentId || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(doc);
  }
  const orderOf = (doc) => doc.left ?? doc.order ?? 0;
  for (const list of children.values()) list.sort((a, b) => orderOf(a) - orderOf(b) || (a._id < b._id ? -1 : 1));

  let count = 1;
  const visited = new Set();
  const walk = (starts) => {
    const stack = starts.slice().reverse().map((doc) => ({ doc, entered: false }));
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!top.entered) {
        top.entered = true;
        visited.add(top.doc._id);
        top.doc.left = count++;
        const kids = children.get(top.doc._id) || [];
        for (let i = kids.length - 1; i >= 0; i--) if (!visited.has(kids[i]._id)) stack.push({ doc: kids[i], entered: false });
      } else {
        top.doc.right = count++;
        stack.pop();
      }
    }
  };
  walk(children.get(null) || []);
  // Anything not reached hangs off a parent loop (the source has nodes that are their own
  // parent). Break each loop at the node nearest the library, move that node to the top
  // level and keep the subtree under it.
  const depth = (doc) => doc.ancestors?.length ?? Infinity;
  for (;;) {
    const unreached = [...out.values()].filter((doc) => !visited.has(doc._id));
    if (!unreached.length) break;
    const head = unreached.sort((a, b) => depth(a) - depth(b) || orderOf(a) - orderOf(b))[0];
    stats.cycles++;
    delete head.parentId;
    walk([head]);
  }
  return { docs: [...out.values()].sort((a, b) => a.left - b.left), stats };
}
