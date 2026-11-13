// The app looks after itself.
//
// Two kinds of trouble, two answers:
//
//   The network is away (the laptop just woke, GitHub cannot be reached): nothing is
//   wrong with the app. It tries again by itself, quietly, with growing pauses, and says
//   nothing unless it lasts longer than ten minutes.
//
//   Anything else that fails (a brain update, the card run, saving, a crash in a turn):
//   the app opens a repair thread by itself. Claude gets the error and the end of the log,
//   finds the cause, and if it is a bug in the app fixes it in the app's own repo. When
//   the turn ends with commits and the tests pass, the app merges and pushes the fix by
//   itself; the self-update then takes it, and goes back if the new version does not start.
//   If the tests do not pass, the thread waits in the inbox with its Merge button.
//
// One repair thread per kind of error per day, so a failing fix cannot loop.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, LOG_FILE, log } from './config.js';
import * as store from './store.js';
import { readPrompt } from './util.js';

const SEEN = path.join(DATA_DIR, 'repairs.json');
const NETWORK = /could not resolve host|failed to connect|could not connect|connection (timed out|reset|refused)|timed out|network is unreachable|unable to access .*(resolve|connect)|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|is not reachable/i;
export const isNetworkError = (message) => NETWORK.test(String(message || ''));

let config;
let deps = { send: null, mayRun: () => true, mergeThread: null, repoDirOf: null };

export function initRepair(cfg, d) { config = cfg; deps = { ...deps, ...d }; }

const signature = (source, message) => crypto.createHash('sha1')
  .update(`${source}:${String(message).replace(/[0-9a-f]{7,40}/gi, '#').replace(/\d+/g, 'N').slice(0, 300)}`).digest('hex').slice(0, 12);

function seen() { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch { return {}; } }

// Something failed. `source` says where ("brain update", "cards", "saving", "a turn").
export function report(source, message) {
  try {
    if (!message || isNetworkError(message) || config?.repair?.auto === false) return null;
    if (/usage limit|rate limit|overloaded|not logged in|\/login|API key/i.test(message)) return null; // nothing code can fix
    if (!deps.mayRun()) return null;
    const sig = signature(source, message);
    const all = seen();
    if (all[sig] && Date.now() - all[sig] < 24 * 3600_000) return null;
    all[sig] = Date.now();
    fs.writeFileSync(SEEN, JSON.stringify(all));
    let tail = '';
    try { tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-60).join('\n'); } catch { /* no log */ }
    const thread = store.createThread({ title: `Repair: ${source}`.slice(0, 100), kind: 'repair' });
    store.updateThread(thread.id, { projectGuessed: true, repo: config.repair?.repo || 'fburgerdev/app-ai', repoSet: true, tier: 'high' });
    deps.send(thread.id, readPrompt('repair.md', { source, message: String(message).slice(0, 3000), log: tail, repo: config.repair?.repo || 'fburgerdev/app-ai' }), { auto: true });
    log(`repair: opened a thread for "${source}": ${String(message).slice(0, 160)}`);
    return thread.id;
  } catch (err) {
    log(`repair: could not open a thread: ${err.message}`);
    return null;
  }
}

function run(cmd, args, cwd, ms) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d) => { out = (out + d).slice(-6000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), ms);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, out: err.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}

// A repair thread's turn ended. If it left commits and the tests pass: merge and push.
export async function afterTurn(threadId) {
  const thread = store.getThread(threadId);
  if (!thread || thread.kind !== 'repair' || !thread.repoBranch || config?.repair?.autoMerge === false) return;
  const dir = deps.repoDirOf(thread.repo);
  const note = (text) => store.appendMessage(threadId, { role: 'user', text: `[${text}]`, event: true });
  try {
    let result = { ok: true, out: '' };
    if (!config.fake) {
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], dir, 5 * 60_000);
      result = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], dir, 15 * 60_000);
    }
    if (!result.ok) {
      note('The app ran the tests on this fix and they did not pass, so it was not merged. It waits here: ask Claude to look again, or merge it yourself from the repo panel.');
      log(`repair: tests failed for "${thread.title}"; not merged`);
      return;
    }
    await deps.mergeThread(threadId);
    note('The app ran the tests on this fix, they passed, and it merged and pushed the fix by itself. The app updates itself with it within ten minutes.');
    store.updateThread(threadId, { state: 'done', doneAt: Date.now() });
    log(`repair: merged the fix of "${thread.title}"`);
  } catch (err) {
    note(`The app could not merge this fix by itself (${err.message}). It waits here with its Merge button.`);
  }
}
