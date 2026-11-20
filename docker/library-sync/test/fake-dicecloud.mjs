// A stand-in for dicecloud.com: a DDP server with the library publications of the real app
// (app/imports/server/publications/library.js), serving whatever the test puts in `data`.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

// The fields `libraryNodes` always returns; everything else has to be asked for by name
const TREE_FIELDS = ['name', 'type', 'icon', 'color', 'order', 'parent', 'ancestors', 'parentId', 'left', 'right', 'root',
  'removed', 'removedAt', 'actionType', 'libraryTags', 'slotQuantityFilled', 'slotFillerType', 'slotFillerConditionNote',
  'slotFillerCondition', 'fillSlots', 'searchable', 'slotFillImage', 'operation', 'targetTags', 'stats', 'quantity', 'plural',
  'equipped', 'branchType', 'damageType', 'stat', 'amount', 'level', 'variableName', 'value', 'cache', 'dc'];
const DENIED = { error: 'View permission denied', reason: 'You do not have permission to view this document' };
const MISSING = { error: 'Permission denied', reason: 'Permission denied: No such document exists' };

export async function startFakeDiceCloud({ username, password }) {
  const data = {
    libraries: new Map(),   // id -> library document
    nodes: new Map(),       // library id -> node documents
    collections: new Map(), // id -> collection document
  };
  const stats = { connections: 0, loginAttempts: 0, logins: 0, subs: {}, subParams: [] };
  const control = { dropOn: null }; // set to a publication name to cut the connection, once, when it is next asked for
  const digest = crypto.createHash('sha256').update(password).digest('hex');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.on('listening', resolve));

  const publish = (name, params) => {
    const docs = []; // [collection, document]
    const fields = ({ _id, ...rest }) => rest;
    const library = (id) => {
      const doc = data.libraries.get(id);
      if (!doc) throw MISSING;
      if (!doc.public) throw DENIED;
      return doc;
    };
    switch (name) {
      case 'browseLibraries':
        for (const doc of data.libraries.values()) if (doc.public && doc.showInMarket) docs.push(['libraries', doc]);
        for (const doc of data.collections.values()) if (doc.public && doc.showInMarket) docs.push(['libraryCollections', doc]);
        break;
      case 'libraryCollection': {
        const doc = data.collections.get(params[0]);
        if (!doc?.public) break;
        docs.push(['libraryCollections', doc]);
        for (const id of doc.libraries) if (data.libraries.get(id)?.public) docs.push(['libraries', data.libraries.get(id)]);
        break;
      }
      case 'library': {
        const doc = library(params[0]);
        docs.push(['libraries', doc], ['users', { _id: doc.owner, username: `owner-of-${doc._id}` }]);
        break;
      }
      case 'libraryNodes': {
        library(params[0]);
        const wanted = new Set([...TREE_FIELDS, ...(params[1] || [])]);
        for (const node of data.nodes.get(params[0]) || []) {
          docs.push(['libraryNodes', Object.fromEntries(Object.entries(node).filter(([key]) => key === '_id' || wanted.has(key)))]);
        }
        break;
      }
      case 'libraryNode': {
        for (const [libraryId, nodes] of data.nodes) {
          const node = nodes.find((n) => n._id === params[0]);
          if (node) { library(libraryId); docs.push(['libraryNodes', node]); }
        }
        if (!docs.length) throw MISSING;
        break;
      }
      default:
        throw { error: 404, reason: `Subscription '${name}' not found` };
    }
    return docs.map(([collection, doc]) => ({ collection, id: doc._id, fields: fields(doc) }));
  };

  server.on('connection', (socket) => {
    stats.connections++;
    let loggedIn = false;
    const subs = new Map();
    const send = (o) => socket.send(JSON.stringify(o));
    socket.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.msg === 'connect') return send({ msg: 'connected', session: 'fake' });
      if (m.msg === 'method' && m.method === 'login') {
        stats.loginAttempts++;
        const [{ user, password: given }] = m.params;
        if ((user.username === username || user.email === username) && given.digest === digest && given.algorithm === 'sha-256') {
          loggedIn = true;
          stats.logins++;
          return send({ msg: 'result', id: m.id, result: { id: 'fakeUserId', token: 'fake' } });
        }
        return send({ msg: 'result', id: m.id, error: { error: 403, reason: 'Incorrect password' } });
      }
      if (m.msg === 'sub') {
        if (control.dropOn === m.name) { control.dropOn = null; return socket.terminate(); }
        stats.subs[m.name] = (stats.subs[m.name] || 0) + 1;
        stats.subParams.push([m.name, m.params[0]]);
        let docs = [];
        try { if (loggedIn) docs = publish(m.name, m.params); } catch (error) { return send({ msg: 'nosub', id: m.id, error }); }
        subs.set(m.id, docs);
        for (const doc of docs) send({ msg: 'added', ...doc });
        return send({ msg: 'ready', subs: [m.id] });
      }
      if (m.msg === 'unsub') {
        for (const doc of subs.get(m.id) || []) send({ msg: 'removed', collection: doc.collection, id: doc.id });
        subs.delete(m.id);
        return send({ msg: 'nosub', id: m.id });
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${server.address().port}/websocket`,
    data,
    stats,
    control,
    close: () => new Promise((resolve) => { for (const client of server.clients) client.terminate(); server.close(resolve); }),
  };
}
