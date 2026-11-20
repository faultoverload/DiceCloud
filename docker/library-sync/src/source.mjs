// Reads libraries from a DiceCloud server the way the web client does: over DDP publications.
// Nothing here writes to the source.
import { DDP, LoginError, errorText } from './ddp.mjs';

const NODES_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SAMPLES_PER_LIBRARY = 6;
const CLEAN_SAMPLES_PER_TYPE = 30; // stop checking a node type after this many clean comparisons
const MAX_KEY_REFETCH = 3;
const CONNECT_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Source {
  /**
   * @param {object} options
   * @param {string[]} options.keys field names to ask `libraryNodes` for (schema-keys.json)
   * @param {Record<string, {types: string[], atVersion: number}>} [options.discovered] keys found by earlier runs
   * @param {(discovered: object) => Promise<void>} [options.onDiscover] called when a new key is found
   */
  constructor({ url, username, password, throttleMs, keys, discovered = {}, onDiscover, log = () => {}, retryDelayMs = 15000 }) {
    Object.assign(this, { url, username, password, throttleMs, discovered, onDiscover, log, retryDelayMs });
    this.keySet = new Set([...keys, ...Object.keys(discovered)]);
    this.cleanSamples = {};
    this.subscriptions = 0;
  }

  keysVersion() { return Object.keys(this.discovered).length; }

  /** Connects and logs in. Network failures are retried; refused credentials are not. */
  async connect() {
    this.close();
    for (let attempt = 1; ; attempt++) {
      const ddp = new DDP(this.url);
      try {
        await ddp.connect();
        await ddp.login(this.username, this.password);
        this.ddp = ddp;
        return;
      } catch (e) {
        ddp.close();
        if (e instanceof LoginError || attempt >= CONNECT_ATTEMPTS) throw e;
        this.log(`connecting to ${this.url} failed (${e.message}), retry ${attempt}/${CONNECT_ATTEMPTS - 1} in ${Math.round(attempt * this.retryDelayMs / 1000)}s`);
        await sleep(attempt * this.retryDelayMs);
      }
    }
  }

  close() { this.ddp?.close(); this.ddp = undefined; }

  async sub(name, params, timeoutMs) {
    await sleep(this.throttleMs);
    this.subscriptions++;
    return this.ddp.sub(name, params, timeoutMs);
  }

  clear(...names) { names.forEach((name) => this.ddp.col(name).clear()); }

  /** Everything on the community libraries page: public libraries and collections shown in the market. */
  async browse() {
    this.clear('libraries', 'libraryCollections');
    const r = await this.sub('browseLibraries', []);
    if (!r.ok) throw new Error(`browseLibraries failed: ${errorText(r.error)}`);
    const libraries = [...this.ddp.col('libraries').values()].map((doc) => ({ ...doc }));
    const collections = [...this.ddp.col('libraryCollections').values()].map((doc) => ({ ...doc }));
    await this.ddp.unsub(r.id);
    this.clear('libraries', 'libraryCollections');
    return { libraries, collections };
  }

  /** One collection by id, or null when it doesn't exist or this account may not view it. */
  async collection(id) {
    this.clear('libraries', 'libraryCollections', 'users');
    const r = await this.sub('libraryCollection', [id]);
    if (!r.ok) return null;
    const doc = this.ddp.col('libraryCollections').get(id);
    await this.ddp.unsub(r.id);
    this.clear('libraries', 'libraryCollections', 'users');
    return doc ? { ...doc } : null;
  }

  /**
   * One library with all of its nodes.
   * @returns {Promise<{status: 'ok', meta: object, nodes: object[], keysVersion: number, keysAdded: string[]}
   *   | {status: 'inaccessible', error: string}>}
   */
  async fetchLibrary(id) {
    this.clear('libraries', 'users');
    const lr = await this.sub('library', [id]);
    if (!lr.ok) return { status: 'inaccessible', error: errorText(lr.error) };
    const meta = this.ddp.col('libraries').get(id);
    await this.ddp.unsub(lr.id);
    this.clear('libraries', 'users');
    if (!meta) return { status: 'inaccessible', error: 'no library document published' };

    const keysAdded = [];
    for (let refetches = 0; ; refetches++) {
      this.clear('libraryNodes');
      // `libraryNodes` returns the tree fields plus only the fields named here
      const nr = await this.sub('libraryNodes', [id, [...this.keySet]], NODES_TIMEOUT_MS);
      if (!nr.ok) throw new Error(`libraryNodes failed: ${errorText(nr.error)}`);
      const nodes = [...this.ddp.col('libraryNodes').values()].map((node) => ({ ...node }));
      await this.ddp.unsub(nr.id);
      const newKeys = await this.findMissingKeys(nodes);
      if (!newKeys.length) return { status: 'ok', meta: { ...meta }, nodes, keysVersion: this.keysVersion(), keysAdded };
      keysAdded.push(...newKeys);
      this.log(`   found fields the request did not name (${newKeys.join(', ')}); fetching ${id} again`);
      if (refetches >= MAX_KEY_REFETCH) throw new Error('kept finding new fields');
    }
  }

  /**
   * Proves the field list is complete: fetches a few nodes in full with `libraryNode`, which
   * applies no field filter, and compares. New field names are remembered and returned.
   */
  async findMissingKeys(nodes) {
    const byType = {};
    for (const node of nodes) (byType[node.type || '?'] ||= []).push(node);
    const samples = Object.keys(byType)
      .filter((type) => (this.cleanSamples[type] || 0) < CLEAN_SAMPLES_PER_TYPE)
      .sort((a, b) => (this.cleanSamples[a] || 0) - (this.cleanSamples[b] || 0))
      .slice(0, MAX_SAMPLES_PER_LIBRARY)
      .map((type) => byType[type][Math.floor(Math.random() * byType[type].length)]);
    const missing = {};
    for (const node of samples) {
      this.clear('libraryNodes');
      const r = await this.sub('libraryNode', [node._id]);
      if (!r.ok) continue; // the node went away between the two requests; not a field problem
      const full = this.ddp.col('libraryNodes').get(node._id);
      const extra = full ? Object.keys(full).filter((key) => !(key in node)) : [];
      if (extra.length) extra.forEach((key) => (missing[key] ||= new Set()).add(node.type));
      else this.cleanSamples[node.type] = (this.cleanSamples[node.type] || 0) + 1;
      await this.ddp.unsub(r.id);
    }
    this.clear('libraryNodes');
    const newKeys = Object.keys(missing).filter((key) => !this.keySet.has(key));
    if (!newKeys.length) return [];
    const atVersion = this.keysVersion() + 1;
    for (const key of newKeys) {
      this.keySet.add(key);
      this.discovered[key] = { types: [...missing[key]], atVersion };
    }
    await this.onDiscover?.(this.discovered);
    return newKeys;
  }

  /** True when a field was discovered, after this library was fetched, for a node type it contains. */
  isStale({ keysVersion, types }) {
    return Object.values(this.discovered).some((d) => d.atVersion > keysVersion && d.types.some((type) => types.has(type)));
  }
}
