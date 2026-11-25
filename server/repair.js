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
//   the turn ends with commits, the app tests and merges the fix like any thread's work
//   (ship.js) and closes the thread; the self-update then takes it, and goes back if the
//   new version does not start. If the tests do not pass, the thread waits in the inbox.
//
// One repair thread per kind of error per day, so a failing fix cannot loop.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, LOG_FILE, log } from './config.js';
import * as store from './store.js';
import { readPrompt } from './util.js';

const SEEN = path.join(DATA_DIR, 'repairs.json');
const NETWORK = /could not resolve host|failed to connect|could not connect|connection (timed out|reset|refused)|timed out|network is unreachable|unable to access .*(resolve|connect)|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|is not reachable/i;
export const isNetworkError = (message) => NETWORK.test(String(message || ''));
// A git step that talks to GitHub and was stopped by its timeout (git.js sets `timedOut`)
// is the same trouble: the laptop slept in the middle of it, or woke before the network did.
export const isAway = (err) => err?.timedOut === true || isNetworkError(err?.message);

// Failures no change to the code can fix: Claude's usage limit ("You've hit your 5-hour
// limit", which opened a repair thread on 16-11-2026), the service being overloaded, not
// being signed in.
export const isNotCode = (message) => /usage limit|rate.?limit|hit your .*limit|limit reached|out of (extra )?usage|overloaded|not logged in|\/login|API key/i.test(String(message || ''));

let config;
let deps = { send: null, mayRun: () => true };

export function initRepair(cfg, d) { config = cfg; deps = { ...deps, ...d }; }

const signature = (source, message) => crypto.createHash('sha1')
  .update(`${source}:${String(message).replace(/[0-9a-f]{7,40}/gi, '#').replace(/\d+/g, 'N').slice(0, 300)}`).digest('hex').slice(0, 12);

function seen() { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch { return {}; } }

// Something failed. `source` says where ("brain update", "cards", "saving", "a turn").
export function report(source, message) {
  try {
    if (!message || isNetworkError(message) || config?.repair?.auto === false) return null;
    if (isNotCode(message)) return null; // nothing code can fix
    if (!deps.mayRun()) return null;
    const sig = signature(source, message);
    const all = seen();
    if (all[sig] && Date.now() - all[sig] < 24 * 3600_000) return null;
    all[sig] = Date.now();
    fs.writeFileSync(SEEN, JSON.stringify(all));
    let tail = '';
    try { tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-60).join('\n'); } catch { /* no log */ }
    const thread = store.createThread({ title: `Repair: ${source}`.slice(0, 100), kind: 'repair' });
    store.updateThread(thread.id, { projectGuessed: true, repo: config.repair?.repo || 'fburgerdev/app-ai', repoSet: true, keepTier: 'high' });
    deps.send(thread.id, readPrompt('repair.md', { source, message: String(message).slice(0, 3000), log: tail, repo: config.repair?.repo || 'fburgerdev/app-ai' }), { auto: true });
    log(`repair: opened a thread for "${source}": ${String(message).slice(0, 160)}`);
    return thread.id;
  } catch (err) {
    log(`repair: could not open a thread: ${err.message}`);
    return null;
  }
}
