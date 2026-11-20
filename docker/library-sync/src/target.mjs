// Writes libraries into the self-hosted DiceCloud database. Only `libraries`, `libraryNodes`,
// `libraryCollections` and this tool's own state collection are ever written, and within
// those only the libraries and collections a run was asked to copy.
import { MongoClient } from 'mongodb';

const STATE_COLLECTION = 'librarySyncState';
const STATE_ID = 'state';
const WRITE_BATCH = 500;
const DELETE_BATCH = 5000;
const SUPPORTED_DB_VERSION = 3;

/** A stable text form of a document: keys sorted, dates as `{ $date: ms }`. Used to compare. */
export function canonical(value) {
  return JSON.stringify(normalise(value));
}

function normalise(value) {
  if (value instanceof Date) return { $date: value.getTime() };
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function' && value._bsontype) return normalise(value.toJSON());
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = normalise(value[key]);
    return out;
  }
  return value;
}

/**
 * Compares the documents in the database with the documents that should be there.
 * @returns {{ upserts: object[], deletes: string[], added: number, changed: number, removed: number, unchanged: number }}
 */
export function planChanges(existing, wanted) {
  const current = new Map(existing.map((doc) => [doc._id, canonical(doc)]));
  const plan = { upserts: [], deletes: [], added: 0, changed: 0, removed: 0, unchanged: 0 };
  const keep = new Set();
  for (const doc of wanted) {
    keep.add(doc._id);
    const before = current.get(doc._id);
    if (before === undefined) { plan.added++; plan.upserts.push(doc); }
    else if (before !== canonical(doc)) { plan.changed++; plan.upserts.push(doc); }
    else plan.unchanged++;
  }
  for (const id of current.keys()) if (!keep.has(id)) { plan.removed++; plan.deletes.push(id); }
  return plan;
}

export class Target {
  constructor(mongoUrl) { this.mongoUrl = mongoUrl; }

  async connect() {
    this.client = new MongoClient(this.mongoUrl, { serverSelectionTimeoutMS: 15000 });
    await this.client.connect();
    this.db = this.client.db(); // the database named in the URL
    await this.db.command({ ping: 1 });
  }

  async close() { await this.client?.close(); this.client = undefined; }

  /**
   * The tree conversion writes the layout of database version 3. Refuse anything else.
   * A database the app has not started against yet has no version; the app sets it.
   */
  async checkVersion() {
    const control = await this.db.collection('migrations').findOne({ _id: 'control' });
    if (control && control.version !== SUPPORTED_DB_VERSION) {
      throw new Error(`the DiceCloud database is at version ${control.version}; this tool writes version ${SUPPORTED_DB_VERSION} documents`);
    }
    return control?.version;
  }

  async readState() {
    return (await this.db.collection(STATE_COLLECTION).findOne({ _id: STATE_ID })) || {};
  }

  async saveState(fields) {
    await this.db.collection(STATE_COLLECTION).updateOne({ _id: STATE_ID }, { $set: fields }, { upsert: true });
  }

  async hasLibrary(id) {
    return (await this.db.collection('libraries').countDocuments({ _id: id }, { limit: 1 })) > 0;
  }

  /**
   * Makes the library and its nodes match what the source has: new nodes are added, changed
   * ones replaced, nodes that are gone from the source deleted. Nothing is written for
   * documents that are already identical.
   */
  async applyLibrary(id, meta, docs, { dryRun = false } = {}) {
    const libraries = this.db.collection('libraries');
    const nodes = this.db.collection('libraryNodes');
    const before = await libraries.findOne({ _id: id });
    const library = { ...meta, _id: id };
    // Subscriber counts are kept by each server for its own users
    if (before && 'subscriberCount' in before) library.subscriberCount = before.subscriberCount;
    else if (before) delete library.subscriberCount;
    const metaChanged = !before || canonical(before) !== canonical(library);

    const existing = await nodes.find({ 'root.id': id }).toArray();
    const plan = planChanges(existing, docs);
    if (!dryRun) {
      for (let i = 0; i < plan.upserts.length; i += WRITE_BATCH) {
        await nodes.bulkWrite(
          plan.upserts.slice(i, i + WRITE_BATCH).map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
          { ordered: false },
        );
      }
      for (let i = 0; i < plan.deletes.length; i += DELETE_BATCH) {
        await nodes.deleteMany({ 'root.id': id, _id: { $in: plan.deletes.slice(i, i + DELETE_BATCH) } });
      }
      // The library document goes last: a library that exists has its nodes
      if (metaChanged) await libraries.replaceOne({ _id: id }, library, { upsert: true });
    }
    return { isNew: !before, metaChanged, added: plan.added, changed: plan.changed, removed: plan.removed, unchanged: plan.unchanged };
  }

  /** @returns {Promise<'new' | 'updated' | 'unchanged'>} */
  async applyCollection(doc, { dryRun = false } = {}) {
    const collections = this.db.collection('libraryCollections');
    const before = await collections.findOne({ _id: doc._id });
    const next = { ...doc };
    if (before && 'subscriberCount' in before) next.subscriberCount = before.subscriberCount;
    else if (before) delete next.subscriberCount;
    if (before && canonical(before) === canonical(next)) return 'unchanged';
    if (!dryRun) await collections.replaceOne({ _id: doc._id }, next, { upsert: true });
    return before ? 'updated' : 'new';
  }
}
