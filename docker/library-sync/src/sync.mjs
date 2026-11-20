#!/usr/bin/env node
// Copies libraries from a DiceCloud server (dicecloud.com) into a self-hosted DiceCloud
// database, and keeps them up to date. See README.md.
import fs from 'node:fs';
import { loadConfig, ConfigError } from './config.mjs';
import { runSync, msUntilDue } from './run.mjs';
import { Target } from './target.mjs';

const USAGE = `usage: sync.mjs [--config <file>] [--once] [--dry-run]

  --config <file>  configuration file (default /config/config.yml, or $CONFIG_FILE)
  --once           sync now and exit, whatever schedule.interval says
  --dry-run        fetch and compare, write nothing to the database
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); process.exit(0); }
const known = new Set(['--config', '--once', '--dry-run']);
const unknown = args.find((arg, i) => arg.startsWith('-') ? !known.has(arg) : args[i - 1] !== '--config');
if (unknown) { process.stderr.write(`unknown argument ${unknown}\n${USAGE}`); process.exit(2); }
const configFile = args.includes('--config') ? args[args.indexOf('--config') + 1] : (process.env.CONFIG_FILE || '/config/config.yml');

const log = (...parts) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...parts);
const HOUR = 3600e3;

let stop;
const stopped = new Promise((resolve) => { stop = resolve; });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; stop(); });
/** Sleeps in steps: one long timer would overflow past 24 days and drifts across suspends. */
async function sleepUntil(time) {
  while (!stopping && Date.now() < time) {
    let timer;
    await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, Math.min(HOUR, time - Date.now())); })]);
    clearTimeout(timer);
  }
}

let config;
try {
  if (!configFile) throw new ConfigError('--config needs a file name');
  config = loadConfig(fs.readFileSync(configFile, 'utf8'), process.env);
} catch (e) {
  process.stderr.write(`${e instanceof ConfigError ? e.message : `cannot read ${configFile}: ${e.message}`}\n`);
  process.exit(2);
}
const dryRun = config.dryRun || args.includes('--dry-run');

if (args.includes('--once') || !config.intervalMs) {
  const summary = await runSync(config, { log, dryRun });
  process.exit(summary.ok ? 0 : 1);
}

// Scheduled: stay running and sync every interval. Nothing here exits on a failed run, so a
// restart policy cannot turn a bad password into a stream of login attempts.
log(`syncing every ${config.intervalMs / HOUR} hours`);
while (!stopping) {
  let wait;
  try {
    const target = new Target(config.target.mongoUrl);
    try {
      await target.connect();
      wait = msUntilDue(await target.readState(), config.hash, config.intervalMs, Date.now());
    } finally { await target.close().catch(() => {}); }
  } catch (e) {
    // The source is not contacted until the database can say when the last attempt was
    log(`cannot reach the database (${e.message}); trying again in 60s`);
    await sleepUntil(Date.now() + 60e3);
    continue;
  }
  if (wait > 0) {
    log(`next sync at ${new Date(Date.now() + wait).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    await sleepUntil(Date.now() + wait);
    if (stopping) break;
  }
  const started = Date.now();
  await runSync(config, { log, dryRun });
  // A dry run records no attempt, so wait here instead of asking the database
  if (dryRun) await sleepUntil(started + config.intervalMs);
}
log('stopped');
process.exit(0);
