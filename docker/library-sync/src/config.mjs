// Reads and checks the configuration file. Environment variables win over the file.
import crypto from 'node:crypto';
import { parse } from 'yaml';

export class ConfigError extends Error {}

const UNITS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
const MIN_INTERVAL_MS = 3600e3;
const MIN_THROTTLE_MS = 250; // the source allows 50 subscriptions per 10 seconds
const ID = /^[A-Za-z0-9]{17}$/;

/** "7d", "12h", "90m", "2w"; 0, "0", "", null or undefined mean "run once". Returns milliseconds. */
export function parseInterval(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0' || value === false) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(String(value).trim());
  if (!match) throw new ConfigError(`schedule.interval "${value}" is not understood; use a number and a unit, such as 12h, 7d or 2w`);
  const ms = Number(match[1]) * UNITS[match[2].toLowerCase()];
  if (ms < MIN_INTERVAL_MS) throw new ConfigError(`schedule.interval "${value}" is too short; the minimum is 1h`);
  return ms;
}

/** Accepts a bare id or a dicecloud.com link ending in one, e.g. https://dicecloud.com/library/<id> */
export function extractId(entry) {
  const text = String(entry ?? '').trim();
  const last = text.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  if (!ID.test(last)) throw new ConfigError(`"${text}" is not a library or collection id (17 letters and digits), nor a link ending in one`);
  return last;
}

/**
 * @param {string} text contents of the config file (YAML or JSON)
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(text, env = {}) {
  let raw;
  try { raw = parse(text) ?? {}; } catch (e) { throw new ConfigError(`config file is not valid YAML: ${e.message}`); }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config file must be a mapping with source, target and libraries');
  const source = raw.source ?? {};
  const target = raw.target ?? {};

  const url = env.DICECLOUD_URL || source.url || 'wss://dicecloud.com/websocket';
  if (!/^wss?:\/\//.test(url)) throw new ConfigError(`source.url must start with ws:// or wss:// (got "${url}")`);
  const username = env.DICECLOUD_USERNAME || source.username;
  const password = env.DICECLOUD_PASSWORD || source.password;
  if (!username) throw new ConfigError('source.username is missing (or set DICECLOUD_USERNAME)');
  if (!password) throw new ConfigError('source.password is missing (or set DICECLOUD_PASSWORD)');

  const mongoUrl = env.MONGO_URL || target.mongo_url;
  if (!mongoUrl) throw new ConfigError('target.mongo_url is missing (or set MONGO_URL)');
  if (!/^mongodb(\+srv)?:\/\//.test(mongoUrl)) throw new ConfigError('target.mongo_url must start with mongodb:// or mongodb+srv://');

  const throttleMs = source.throttle_ms === undefined ? 400 : Number(source.throttle_ms);
  if (!Number.isFinite(throttleMs) || throttleMs < MIN_THROTTLE_MS) {
    throw new ConfigError(`source.throttle_ms must be at least ${MIN_THROTTLE_MS}; the source limits how fast one client may subscribe`);
  }

  let selection;
  const wanted = raw.libraries;
  if (wanted === 'all') selection = 'all';
  else if (Array.isArray(wanted) && wanted.length) selection = [...new Set(wanted.map(extractId))];
  else throw new ConfigError('libraries must be the word "all" or a list of library and collection ids');

  const intervalMs = parseInterval(raw.schedule?.interval);
  const dryRun = raw.dry_run === true;
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  // Changes whenever something that affects a run changes, without containing the password
  const hash = digest(JSON.stringify({ url, username, password: digest(String(password)), mongoUrl: digest(mongoUrl), throttleMs, selection, intervalMs }));

  return { source: { url, username: String(username), password: String(password), throttleMs }, target: { mongoUrl }, selection, intervalMs, dryRun, hash };
}
