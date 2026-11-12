// Keeps the app on the laptop up to date with GitHub while it runs.
//
// Every few minutes: is there a newer version on GitHub? Then, as soon as Claude is not
// working on anything (an hour at most), pull it, install what changed, and exit with
// code 75. The start script (deploy/windows/run.cmd, start.cmd) starts the app again on
// that code. If the new version does not start, the start script goes back to the one
// before (update-prev.txt) and this leaves that version alone until GitHub changes again.
//
// On the Pi, deploy/update.sh does this job from a systemd timer; there this is off.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, log } from './config.js';
import { git, gitOk } from './git.js';
import { ROOT } from './util.js';

export const RESTART_CODE = 75;
const PREV = path.join(DATA_DIR, 'update-prev.txt'); // the version to go back to
const BAD = path.join(DATA_DIR, 'update-bad.txt'); // a version that did not start

let config;
let isBusy = () => false;
let waitingSince = 0;
let running = false;
const status = { enabled: false, checkedAt: 0, waiting: '', error: '' };
export const updateStatus = () => ({ ...status });

function npmInstall() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, shell: process.platform === 'win32', windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`))));
  });
}

async function check() {
  if (running) return;
  running = true;
  try {
    const branch = (await git(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!(await gitOk(ROOT, ['fetch', '--quiet', 'origin', branch]))) { status.error = 'GitHub is not reachable.'; return; }
    status.checkedAt = Date.now();
    status.error = '';
    const head = (await git(ROOT, ['rev-parse', 'HEAD'])).trim();
    const next = (await git(ROOT, ['rev-parse', `origin/${branch}`])).trim();
    if (head === next || !(await gitOk(ROOT, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]))) { status.waiting = ''; waitingSince = 0; return; }
    let bad = '';
    try { bad = fs.readFileSync(BAD, 'utf8').trim(); } catch { /* none */ }
    if (bad === next) return;
    if (isBusy()) {
      waitingSince ||= Date.now();
      status.waiting = next.slice(0, 7);
      if (Date.now() - waitingSince < 60 * 60_000) return;
    }
    const lockBefore = await git(ROOT, ['rev-parse', 'HEAD:package-lock.json']).catch(() => '');
    await git(ROOT, ['merge', '--ff-only', '--quiet', `origin/${branch}`]);
    const lockAfter = await git(ROOT, ['rev-parse', 'HEAD:package-lock.json']).catch(() => '');
    if (lockBefore !== lockAfter) await npmInstall();
    fs.writeFileSync(PREV, head);
    log(`update: ${head.slice(0, 7)} → ${next.slice(0, 7)}; restarting`);
    setTimeout(() => process.exit(RESTART_CODE), 300);
  } catch (err) {
    status.error = err.message;
    log(`update: ${err.message}`);
  } finally {
    running = false;
  }
}

export function startSelfUpdate(cfg, { busy }) {
  config = cfg;
  isBusy = busy;
  // It started: whatever the version before was, this one works.
  setTimeout(() => { try { fs.rmSync(PREV, { force: true }); } catch { /* fine */ } }, 60_000).unref?.();
  const on = config.selfUpdate === true || (config.selfUpdate !== false && process.platform === 'win32' && !config.fake);
  if (!on || !fs.existsSync(path.join(ROOT, '.git'))) return;
  status.enabled = true;
  const every = Math.max(1, Number(config.selfUpdateMinutes) || 10) * 60_000;
  setTimeout(check, 30_000).unref?.();
  setInterval(check, every).unref?.();
}
