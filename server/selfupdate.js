// Keeps the app up to date with GitHub while it runs, without cutting off Claude's work.
//
// Two ways, by computer:
//   laptop (Windows)  this file pulls, installs what changed and exits with code 75. The
//                     start script (deploy/windows/run.cmd, start.cmd) starts the app again
//                     on that code; if the new version does not start, it goes back to the
//                     one before (update-prev.txt), and this leaves that version alone until
//                     GitHub changes again.
//   Pi (systemd)      deploy/update.sh pulls and restarts, from its timer and when this file
//                     asks for it (`systemctl --user start app-ai-update`). This file only
//                     notices a new version, for the line on the page, and asks.
//
// When nothing is running, a new version is taken at once. While Claude works, the app no
// longer waits an hour and then cuts the turn off (Florian, 23-11-2026). The page shows a
// line that a new version is there, and he decides:
//   Lock for update  gate.js: what runs finishes, everything new waits, and the app
//                    updates as soon as nothing runs; after the restart what waited starts.
//   Update now       at once. A turn cut off by it carries on by itself after the restart
//                    (runner.retryInterrupted).
//
// A new version is noticed right after a thread merged into the app's own repo
// (noteMerged); the regular check every few minutes catches anything else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, log } from './config.js';
import { git, gitOk } from './git.js';
import { ROOT } from './util.js';
import { report } from './repair.js';
import { events } from './store.js';
import * as gate from './gate.js';

export const RESTART_CODE = 75;
const PREV = path.join(DATA_DIR, 'update-prev.txt'); // the version to go back to
const BAD = path.join(DATA_DIR, 'update-bad.txt'); // a version that did not start
// update.sh's own folder on the Pi: its "did not start" mark, and the "update now" flag.
const PI_STATE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'app-ai-update');

let config;
let isBusy = () => false;
let mode = 'off'; // self (laptop) | service (Pi) | fake (the tests' stand-in) | off
let running = false;
let startedAt = ''; // the commit this process started from
let drainTimer = null;
let soonTimer = null;
const status = {
  enabled: false,
  mode: 'off',
  checkedAt: 0,
  available: '', // the new version, short, while one is there and not taken yet
  subject: '', // its commit subject
  applying: false, // taking it now: the app restarts in a moment
  note: '', // why the last lock ended without an update
  error: '',
};
export const updateStatus = () => ({ ...status, waiting: status.available, lock: gate.status() });
const changed = () => events.emit('update', updateStatus());

function setAvailable(sha, subject = '') {
  const short = sha ? sha.slice(0, 7) : '';
  if (status.available === short && status.subject === subject) return;
  status.available = short;
  status.subject = subject;
  changed();
}

function npmInstall() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, shell: process.platform === 'win32', windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`))));
  });
}

const readFirstLine = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function restartSoon() {
  status.applying = true;
  changed();
  setTimeout(() => process.exit(RESTART_CODE), 300);
}

// Returns what happened: 'current', 'updating', 'waiting' (Claude is working; the page
// shows the line), 'offline', 'skipped' (a version that did not start before), 'busy' (a
// check is already running), 'not-restarted' (the Pi's script did not restart the app),
// 'error' or 'off'. `force` updates even while Claude is working: that turn is cut off.
async function check({ force = false } = {}) {
  if (mode === 'off') return 'off';
  if (running) return 'busy';
  running = true;
  try {
    if (mode === 'fake') return fakeCheck({ force });
    const branch = (await git(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const head = (await git(ROOT, ['rev-parse', 'HEAD'])).trim();
    if (mode === 'service') return await checkService({ branch, head, force });
    if (!(await gitOk(ROOT, ['fetch', '--quiet', 'origin', branch]))) return offline();
    status.checkedAt = Date.now();
    status.error = '';
    // Someone pulled by hand while the app ran: the code on disk is newer than what runs.
    startedAt ||= head;
    if (head !== startedAt) {
      setAvailable(head, await subjectOf(head));
      if (isBusy() && !force) return 'waiting';
      log(`update: the code on disk is ${head.slice(0, 7)}, this runs ${startedAt.slice(0, 7)}; restarting`);
      restartSoon();
      return 'updating';
    }
    const next = (await git(ROOT, ['rev-parse', `origin/${branch}`])).trim();
    if (head === next || !(await gitOk(ROOT, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]))) { setAvailable(''); return 'current'; }
    if (readFirstLine(BAD) === next && !force) { setAvailable(''); return 'skipped'; }
    setAvailable(next, await subjectOf(next));
    if (isBusy() && !force) return 'waiting';
    const lockBefore = await git(ROOT, ['rev-parse', 'HEAD:package-lock.json']).catch(() => '');
    await git(ROOT, ['merge', '--ff-only', '--quiet', `origin/${branch}`]);
    const lockAfter = await git(ROOT, ['rev-parse', 'HEAD:package-lock.json']).catch(() => '');
    if (lockBefore !== lockAfter) await npmInstall();
    fs.writeFileSync(PREV, head);
    log(`update: ${head.slice(0, 7)} → ${next.slice(0, 7)}${force ? ' (by hand)' : ''}; restarting`);
    restartSoon();
    return 'updating';
  } catch (err) {
    status.error = err.message;
    log(`update: ${err.message}`);
    report('the app updating itself', err.message);
    return 'error';
  } finally {
    running = false;
  }
}

function offline() {
  if (status.error !== 'GitHub is not reachable.') log('update: GitHub is not reachable; trying again later');
  status.error = 'GitHub is not reachable.';
  return 'offline';
}

const subjectOf = (sha) => git(ROOT, ['log', '-1', '--format=%s', sha]).then((s) => s.trim()).catch(() => '');

// The Pi: only looks (the working copy is update.sh's), and asks update.sh to update.
async function checkService({ branch, head, force }) {
  let next = '';
  try { next = (await git(ROOT, ['ls-remote', 'origin', `refs/heads/${branch}`])).trim().split(/\s+/)[0] || ''; } catch { return offline(); }
  status.checkedAt = Date.now();
  status.error = '';
  if (!next || next === head) { setAvailable(''); return 'current'; }
  if (readFirstLine(path.join(PI_STATE, 'bad')) === next && !force) { setAvailable(''); return 'skipped'; }
  // The subject is only known once fetched; update.sh fetches anyway.
  setAvailable(next, status.available === next.slice(0, 7) ? status.subject : '');
  if (isBusy() && !force) return 'waiting';
  if (force) { try { fs.mkdirSync(PI_STATE, { recursive: true }); fs.writeFileSync(path.join(PI_STATE, 'force'), `${Date.now()}\n`); } catch { /* it then waits for Claude */ } }
  log(`update: asking update.sh for ${next.slice(0, 7)}${force ? ' (by hand)' : ''}`);
  status.applying = true;
  changed();
  // update.sh restarts this app, which ends this process here. Still here afterwards: it did not.
  const code = await new Promise((resolve) => {
    const child = spawn('systemctl', ['--user', 'start', 'app-ai-update.service'], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c));
  });
  status.applying = false;
  changed();
  if (code !== 0) { status.error = `systemctl answered ${code}; see ~/.local/state/app-ai-update/update.log`; return 'error'; }
  return 'not-restarted';
}

// The tests' stand-in: a new version is there when a test says so (fakeAvailable), and
// taking it is a restart in name only: the lock ends, and what waited starts.
function fakeCheck({ force }) {
  if (!status.available) return 'current';
  if (isBusy() && !force) return 'waiting';
  log(`update: (stand-in) taking ${status.available} and restarting`);
  status.applying = true;
  changed();
  setTimeout(() => {
    status.applying = false;
    setAvailable('');
    gate.unlock();
  }, 200);
  return 'updating';
}
export function fakeAvailable(sha, subject = '') { if (mode === 'fake') setAvailable(String(sha || ''), String(subject || '')); return updateStatus(); }

const NOTES = {
  current: 'There was no new version after all.',
  skipped: 'The new version did not start last time, so the app stays on this one.',
  offline: 'GitHub is not reachable, so the app could not update.',
  'not-restarted': "The Pi's update script did not restart the app (see its update.log).",
};

// "Lock for update": nothing new starts; as soon as nothing runs, the app updates.
export function lockForUpdate() {
  if (mode === 'off') return { outcome: 'off', status: updateStatus() };
  gate.lockFor('update');
  status.note = '';
  log('update: locked; nothing new starts until the app has updated');
  changed();
  drain();
  return { outcome: 'locked', status: updateStatus() };
}

export function unlockUpdate() {
  clearInterval(drainTimer);
  if (gate.status().reason === 'update') { gate.unlock(); log('update: unlocked by hand'); }
  changed();
  return { outcome: 'unlocked', status: updateStatus() };
}

function drain() {
  clearInterval(drainTimer);
  drainTimer = setInterval(async () => {
    if (gate.status().reason !== 'update') { clearInterval(drainTimer); return; }
    if (running || status.applying || isBusy()) return;
    clearInterval(drainTimer);
    const outcome = await check();
    if (outcome === 'updating') return;
    // Another check ran at that moment: look again on the next round.
    if (outcome === 'busy' || outcome === 'waiting') { drain(); return; }
    gate.unlock();
    status.note = NOTES[outcome] || `The update did not work: ${status.error || outcome}.`;
    log(`update: the lock ended without an update (${outcome})`);
    changed();
  }, Math.max(200, Number(config?.updateDrainMs) || 1500));
  drainTimer.unref?.();
}

// A thread merged into the app's own repo: a new version is on GitHub now.
export function noteMerged(repo) {
  if (mode === 'off') return;
  const own = String(config?.repair?.repo || 'fburgerdev/app-ai').toLowerCase();
  if (String(repo || '').toLowerCase() !== own) return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => check().catch(() => {}), 2000);
  soonTimer.unref?.();
}

export function startSelfUpdate(cfg, { busy }) {
  config = cfg;
  isBusy = busy;
  // It started: whatever the version before was, this one works.
  setTimeout(() => { try { fs.rmSync(PREV, { force: true }); } catch { /* fine */ } }, 60_000).unref?.();
  const hasGit = fs.existsSync(path.join(ROOT, '.git'));
  if (config.fake) mode = 'fake';
  else if (!hasGit || config.selfUpdate === false) mode = 'off';
  else if (config.selfUpdate === true || process.platform === 'win32') mode = 'self';
  else if (process.platform === 'linux' && fs.existsSync('/run/systemd/system')) mode = 'service';
  status.mode = mode;
  status.enabled = mode !== 'off';
  if (mode === 'off' || mode === 'fake') return;
  git(ROOT, ['rev-parse', 'HEAD']).then((h) => { startedAt = h.trim(); }).catch(() => {});
  const every = Math.max(1, Number(config.selfUpdateMinutes) || 10) * 60_000;
  setTimeout(check, 30_000).unref?.();
  setInterval(check, every).unref?.();
}

// "Check for updates" in the settings, and "Update now" on the line at the top.
export async function checkNow({ force = false } = {}) {
  if (!status.enabled) return { outcome: 'off', status: updateStatus() };
  const outcome = await check({ force });
  return { outcome, status: updateStatus() };
}
