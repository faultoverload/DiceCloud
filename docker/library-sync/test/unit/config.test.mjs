import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseInterval, extractId, ConfigError } from '../../src/config.mjs';

const BASE = `
source:
  username: someone
  password: secret
target:
  mongo_url: mongodb://db:27017/meteor
libraries: all
`;

test('a minimal config gets the defaults', () => {
  const c = loadConfig(BASE);
  assert.deepEqual(c.source, { url: 'wss://dicecloud.com/websocket', username: 'someone', password: 'secret', throttleMs: 400 });
  assert.equal(c.target.mongoUrl, 'mongodb://db:27017/meteor');
  assert.equal(c.selection, 'all');
  assert.equal(c.intervalMs, 0);
  assert.equal(c.dryRun, false);
});

test('environment variables win over the file', () => {
  const c = loadConfig(BASE, { DICECLOUD_USERNAME: 'envuser', DICECLOUD_PASSWORD: 'envpass', MONGO_URL: 'mongodb://other/db', DICECLOUD_URL: 'ws://localhost:1/websocket' });
  assert.equal(c.source.username, 'envuser');
  assert.equal(c.source.password, 'envpass');
  assert.equal(c.source.url, 'ws://localhost:1/websocket');
  assert.equal(c.target.mongoUrl, 'mongodb://other/db');
});

test('credentials may come from the environment alone', () => {
  const c = loadConfig('libraries: all\n', { DICECLOUD_USERNAME: 'u', DICECLOUD_PASSWORD: 'p', MONGO_URL: 'mongodb://db/meteor' });
  assert.equal(c.source.username, 'u');
});

test('a list accepts ids and links, and drops duplicates', () => {
  const c = loadConfig(BASE.replace('libraries: all', `libraries:
  - jp6xTaHDZK4ELYzvN   # a collection
  - https://dicecloud.com/library/hAQmc87ty6DbWwZ42
  - https://dicecloud.com/library-collection/jp6xTaHDZK4ELYzvN/
`));
  assert.deepEqual(c.selection, ['jp6xTaHDZK4ELYzvN', 'hAQmc87ty6DbWwZ42']);
});

test('extractId refuses things that are not ids', () => {
  assert.equal(extractId(' hAQmc87ty6DbWwZ42 '), 'hAQmc87ty6DbWwZ42');
  assert.equal(extractId('https://dicecloud.com/library/hAQmc87ty6DbWwZ42?x=1'), 'hAQmc87ty6DbWwZ42');
  for (const bad of ['', 'Libraries of Vexus', 'short', 'https://dicecloud.com/library/', 12]) assert.throws(() => extractId(bad), ConfigError);
});

test('intervals', () => {
  assert.equal(parseInterval('7d'), 7 * 86400e3);
  assert.equal(parseInterval('12h'), 12 * 3600e3);
  assert.equal(parseInterval('90m'), 90 * 60e3);
  assert.equal(parseInterval('2W'), 14 * 86400e3);
  for (const once of [undefined, null, '', 0, '0', false]) assert.equal(parseInterval(once), 0);
  for (const bad of ['weekly', '7', '7 days', '-1d', '10m', '59m']) assert.throws(() => parseInterval(bad), ConfigError, String(bad));
  assert.equal(loadConfig(`${BASE}schedule:\n  interval: 7d\n`).intervalMs, 7 * 86400e3);
});

test('what is missing or wrong is named', () => {
  const expectError = (text, pattern, env) => assert.throws(() => loadConfig(text, env), (e) => e instanceof ConfigError && pattern.test(e.message));
  expectError(BASE.replace('  password: secret\n', ''), /source\.password/);
  expectError(BASE.replace('  username: someone\n', ''), /source\.username/);
  expectError(BASE.replace('  mongo_url: mongodb://db:27017/meteor\n', '  other: 1\n'), /target\.mongo_url/);
  expectError(BASE.replace('mongodb://db:27017/meteor', 'db:27017'), /mongodb:\/\//);
  expectError(BASE.replace('libraries: all', 'libraries: everything'), /libraries must be/);
  expectError(BASE.replace('libraries: all', 'libraries: []'), /libraries must be/);
  expectError(BASE.replace('libraries: all', 'libraries:\n  - not-an-id'), /not a library or collection id/);
  expectError(`${BASE}schedule:\n  interval: soon\n`, /schedule\.interval/);
  expectError(BASE.replace('  password: secret', '  password: secret\n  throttle_ms: 50'), /throttle_ms/);
  expectError(BASE.replace('  password: secret', '  password: secret\n  url: https://dicecloud.com'), /ws:\/\//);
  expectError('just text', /mapping/);
  expectError('a: [1,', /not valid YAML/);
});

test('the hash follows what a run depends on and does not contain the password', () => {
  const a = loadConfig(BASE);
  assert.equal(a.hash, loadConfig(`# a comment\n${BASE}`).hash);
  assert.notEqual(a.hash, loadConfig(BASE.replace('secret', 'changed')).hash);
  assert.notEqual(a.hash, loadConfig(BASE.replace('libraries: all', 'libraries: [hAQmc87ty6DbWwZ42]')).hash);
  assert.notEqual(a.hash, loadConfig(`${BASE}schedule:\n  interval: 7d\n`).hash);
  assert.ok(!JSON.stringify(a.hash).includes('secret'));
  assert.equal(loadConfig(`${BASE}dry_run: true\n`).dryRun, true);
});
