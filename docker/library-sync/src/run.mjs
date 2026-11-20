// One sync run: work out which libraries are wanted, fetch each from the source, convert it
// and make the database match.
import fs from 'node:fs';
import { Source } from './source.mjs';
import { Target } from './target.mjs';
import { buildTree, fromEjson } from './tree.mjs';
import { LoginError } from './ddp.mjs';

const KEYS_FILE = new URL('../schema-keys.json', import.meta.url);
const FETCH_ATTEMPTS = 3;
const MAX_STALE_PASSES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before the next run, in milliseconds. Counted from the last attempt, not
 * the last success, so a run that keeps failing (or a container that keeps restarting) does
 * not hit the source more often than the interval. A changed configuration runs at once.
 */
export function msUntilDue(state, configHash, intervalMs, now) {
  if (!state?.lastAttemptAt || state.configHash !== configHash) return 0;
  return Math.max(0, new Date(state.lastAttemptAt).getTime() + intervalMs - now);
}

/**
 * Turns the `libraries` setting into the list of library ids to copy and collections to write.
 * A listed id may be a collection (all of its libraries are copied) or a single library.
 */
export async function resolveSelection(source, selection) {
  const { libraries: marketLibraries, collections: marketCollections } = await source.browse();
  const memberOf = new Map(); // library id -> names of the selected collections that list it
  const collections = [];
  const libraryIds = new Set();
  const addCollection = (doc) => {
    collections.push(doc);
    for (const id of doc.libraries || []) {
      libraryIds.add(id);
      if (!memberOf.has(id)) memberOf.set(id, []);
      memberOf.get(id).push(doc.name || doc._id);
    }
  };
  if (selection === 'all') {
    marketLibraries.forEach((library) => libraryIds.add(library._id));
    marketCollections.forEach(addCollection);
  } else {
    const marketCollectionById = new Map(marketCollections.map((doc) => [doc._id, doc]));
    const marketLibraryIds = new Set(marketLibraries.map((doc) => doc._id));
    for (const id of selection) {
      // Collections that aren't on the community page can still be public; ask for them by id
      const collection = marketCollectionById.get(id) || (marketLibraryIds.has(id) ? null : await source.collection(id));
      if (collection) addCollection(collection);
      else libraryIds.add(id); // a library; if it isn't one either, fetching it reports why
    }
  }
  return { libraryIds: [...libraryIds], collections, memberOf, market: { libraries: marketLibraries.length, collections: marketCollections.length } };
}

/**
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @returns {Promise<object>} a summary of the run; `ok` is false when something failed
 */
export async function runSync(config, { log = console.log, dryRun = config.dryRun } = {}) {
  const startedAt = new Date();
  const target = new Target(config.target.mongoUrl);
  let source;
  const results = new Map();
  const summary = {
    ok: false, dryRun, startedAt, finishedAt: null, error: null, selection: config.selection === 'all' ? 'all' : config.selection.length,
    libraries: { selected: 0, new: 0, updated: 0, unchanged: 0, inaccessible: 0, failed: 0 },
    nodes: { added: 0, changed: 0, removed: 0, total: 0 },
    collections: { selected: 0, new: 0, updated: 0, unchanged: 0 },
    changedLibraries: [], inaccessibleLibraries: [], failedLibraries: [], collectionsWithGaps: [], notViewableFromConfig: [],
    discoveredKeys: [], subscriptions: 0,
  };
  try {
    await target.connect().catch((e) => { throw new Error(`cannot reach the database: ${e.message}`); });
    const version = await target.checkVersion();
    if (version === undefined) log('the target database has no DiceCloud version yet (the app has not started against it); continuing');
    const state = await target.readState();
    // Recorded before the source is contacted: see msUntilDue
    if (!dryRun) await target.saveState({ lastAttemptAt: startedAt, configHash: config.hash });

    source = new Source({
      ...config.source,
      keys: JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')),
      discovered: state.discoveredKeys || {},
      onDiscover: async (discovered) => { if (!dryRun) await target.saveState({ discoveredKeys: discovered }); },
      log,
    });
    await source.connect().catch((e) => { throw e instanceof LoginError ? e : new Error(`cannot reach ${config.source.url}: ${e.message}`); });
    log(`logged in to ${config.source.url} as ${config.source.username}`);

    const wanted = await resolveSelection(source, config.selection);
    summary.libraries.selected = wanted.libraryIds.length;
    summary.collections.selected = wanted.collections.length;
    log(`community page: ${wanted.market.libraries} libraries, ${wanted.market.collections} collections; `
      + `copying ${wanted.libraryIds.length} libraries and ${wanted.collections.length} collections${dryRun ? ' (dry run, nothing will be written)' : ''}`);

    const syncOne = async (id, label) => {
      let result;
      for (let attempt = 1; attempt <= FETCH_ATTEMPTS && !result; attempt++) {
        try {
          const fetched = await source.fetchLibrary(id);
          if (fetched.status === 'inaccessible') {
            result = { id, status: 'inaccessible', error: fetched.error, keptLocalCopy: await target.hasLibrary(id), collections: wanted.memberOf.get(id) || [] };
          } else {
            const { docs, stats } = buildTree(id, fetched.nodes);
            const applied = await target.applyLibrary(id, fromEjson(fetched.meta), docs, { dryRun });
            const nodesChanged = applied.added + applied.changed + applied.removed;
            result = {
              id, name: fetched.meta.name, nodes: docs.length, ...applied, ...stats,
              status: applied.isNew ? 'new' : (nodesChanged || applied.metaChanged ? 'updated' : 'unchanged'),
              keysVersion: fetched.keysVersion, keysAdded: fetched.keysAdded, types: new Set(docs.map((doc) => doc.type)),
            };
          }
        } catch (e) {
          if (e instanceof LoginError) throw e;
          log(`   ${id} attempt ${attempt}/${FETCH_ATTEMPTS} failed: ${e.message}`);
          if (attempt === FETCH_ATTEMPTS) { result = { id, status: 'failed', error: e.message }; break; }
          await sleep(5000 * attempt);
          await source.connect();
        }
      }
      results.set(id, result);
      const detail = result.status === 'inaccessible' ? `${result.error}${result.keptLocalCopy ? ' (local copy kept)' : ''}`
        : result.status === 'failed' ? result.error
          : `${String(result.nodes).padStart(6)} nodes  +${result.added} ~${result.changed} -${result.removed}`;
      log(`[${label}] ${id} ${String(result.name || '').slice(0, 40).padEnd(40)} ${result.status.padEnd(12)} ${detail}`);
    };

    let position = 0;
    for (const id of wanted.libraryIds) await syncOne(id, `${String(++position).padStart(3)}/${wanted.libraryIds.length}`);
    // A field found part-way through means libraries fetched before it may lack that field
    for (let pass = 1; pass <= MAX_STALE_PASSES; pass++) {
      const stale = [...results.values()].filter((r) => r.types && source.isStale(r)).map((r) => r.id);
      if (!stale.length) break;
      log(`fetching ${stale.length} libraries again: a field was found after they were copied`);
      for (const id of stale) await syncOne(id, `again ${pass}`);
    }

    for (const doc of wanted.collections) {
      const outcome = await target.applyCollection(fromEjson(doc), { dryRun });
      summary.collections[outcome]++;
      const missing = (doc.libraries || []).filter((id) => results.get(id)?.status === 'inaccessible' && !results.get(id).keptLocalCopy).length;
      if (missing) summary.collectionsWithGaps.push({ id: doc._id, name: doc.name, libraries: (doc.libraries || []).length, missing });
      if (outcome !== 'unchanged') log(`collection ${doc._id} ${doc.name || ''}: ${outcome}`);
    }

    for (const r of results.values()) {
      summary.libraries[r.status]++;
      if (r.status === 'inaccessible') summary.inaccessibleLibraries.push({ id: r.id, error: r.error, keptLocalCopy: r.keptLocalCopy, collections: r.collections });
      else if (r.status === 'failed') summary.failedLibraries.push({ id: r.id, error: r.error });
      else {
        summary.nodes.total += r.nodes; summary.nodes.added += r.added; summary.nodes.changed += r.changed; summary.nodes.removed += r.removed;
        if (r.status !== 'unchanged') summary.changedLibraries.push({ id: r.id, name: r.name, status: r.status, added: r.added, changed: r.changed, removed: r.removed });
      }
    }
    if (config.selection !== 'all') {
      // An id typed into the config file that turns out to be neither a viewable library nor a collection
      summary.notViewableFromConfig = config.selection.filter((id) => results.get(id)?.status === 'inaccessible');
      for (const id of summary.notViewableFromConfig) log(`WARNING: ${id} from the config file is not a library or collection this account can view`);
    }
    summary.discoveredKeys = Object.keys(source.discovered);
    summary.ok = summary.libraries.failed === 0;
    if (!summary.ok) summary.error = `${summary.libraries.failed} libraries could not be copied`;
  } catch (e) {
    summary.error = e.message;
    log(`sync failed: ${e.message}`);
  } finally {
    summary.subscriptions = source?.subscriptions || 0;
    summary.finishedAt = new Date();
    source?.close();
    try {
      if (!dryRun && target.db) await target.saveState({ lastRun: summary });
    } catch (e) { log(`could not record the run: ${e.message}`); }
    await target.close().catch(() => {});
  }
  const l = summary.libraries;
  log(`${summary.ok ? 'done' : 'FAILED'}${dryRun ? ' (dry run)' : ''}: ${l.selected} libraries selected, ${l.new} new, ${l.updated} updated, ${l.unchanged} unchanged, `
    + `${l.inaccessible} not viewable, ${l.failed} failed; nodes +${summary.nodes.added} ~${summary.nodes.changed} -${summary.nodes.removed}; `
    + `collections ${summary.collections.new} new, ${summary.collections.updated} updated; `
    + `${Math.round((summary.finishedAt - startedAt) / 1000)}s, ${summary.subscriptions} requests to the source`);
  return summary;
}
