// Saves the app's state to GitHub.
//
// The data folder is a git repository of its own. Every few minutes, if something
// changed, the app commits and pushes it to the data repo (app-ai-data). That covers
// threads and their files, water levels, pads, the mood line and what the queue has
// learned.
//
// Never committed: config.json and google-token.json (they hold secrets), the brain
// clone (it has its own repo), logs, and the working files of brain updates.
//
// Two computers (the laptop and the Pi) share this repo. Whoever pushes second first
// takes in what the other pushed and merges it: threads are folders of their own, so
// work on different threads never collides; a conversation changed on both sides keeps
// the lines of both (messages.jsonl is append-only); for any other file changed on both
// sides, what is already on GitHub wins. After taking something in, the app reads its
// data from disk again. See docs/laptop.md.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';
import { git, gitOk } from './git.js';
import { events } from './store.js';

const IGNORE = [
  '# Secrets and machine-local files. Never commit these.',
  'config.json',
  'google-token.json',
  '/brain/',
  'log.txt',
  'reads.jsonl',
  '*.tmp',
  '/extractions/*/transcripts/',
  '/cards/runs/',
  '/uploads-pending/',
  '/repos/',
  '',
].join('\n');

let config;
let timer = null;
let chain = Promise.resolve(); // one git operation on the data folder at a time
const reloaders = []; // what reads its data from disk again after a merge
const pushed = []; // told when something new went to GitHub
export const onPushed = (fn) => pushed.push(fn);

// Called with nothing; re-reads whatever a module keeps in memory.
export const onReload = (fn) => reloaders.push(fn);
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
const status = { enabled: false, lastPush: 0, error: '', commit: '' };

export const dataSyncStatus = () => ({ ...status, repo: config?.dataRepo || '' });

async function hasCommits() {
  return gitOk(DATA_DIR, ['rev-parse', '--verify', 'HEAD']);
}

export async function initDataSync(cfg) {
  config = cfg;
  fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), IGNORE);
  if (!config.dataRepo) return;
  status.enabled = true;
  const branch = config.dataBranch;
  try {
    if (!fs.existsSync(path.join(DATA_DIR, '.git'))) {
      await git(DATA_DIR, ['init', '--quiet', '-b', branch]);
      await git(DATA_DIR, ['remote', 'add', 'origin', config.dataRepo]);
    } else {
      await git(DATA_DIR, ['remote', 'set-url', 'origin', config.dataRepo]);
    }
    if (!(await gitOk(DATA_DIR, ['config', 'user.email']))) {
      await git(DATA_DIR, ['config', 'user.email', 'app-ai@localhost']);
      await git(DATA_DIR, ['config', 'user.name', 'Inbox app']);
    }
    // A conversation changed on two computers keeps both sides' lines.
    fs.mkdirSync(path.join(DATA_DIR, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, '.git', 'info', 'attributes'), '*.jsonl merge=union\n');
    // A fresh data folder takes over what is already saved on GitHub.
    const threadsDir = path.join(DATA_DIR, 'threads');
    const fresh = !(await hasCommits()) && (!fs.existsSync(threadsDir) || fs.readdirSync(threadsDir).length === 0);
    const remoteHas = await gitOk(DATA_DIR, ['fetch', '--quiet', 'origin', branch]);
    if (fresh && remoteHas) {
      await git(DATA_DIR, ['reset', '--quiet', '--hard', `origin/${branch}`]);
      fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), IGNORE);
      log('app data restored from the data repo');
    } else if (remoteHas) {
      // Not fresh: take in what the other computer saved while this one was off.
      await commitLocal('state');
      if (await mergeRemote()) log('app data: took in what the other computer saved');
    }
  } catch (err) {
    status.error = `The app's state cannot be saved to GitHub: ${err.message}`;
    log(status.error);
  }
}

export function startDataSync() {
  if (!status.enabled || timer) return;
  const every = Math.max(1, Number(config.dataSyncMinutes) || 5) * 60_000;
  // Both ways: what the other computer saved comes in, what changed here goes out.
  timer = setInterval(() => pullNow().catch(() => {}).then(() => saveNow()).catch(() => {}), every);
  timer.unref?.();
}

async function commitLocal(reason) {
  await git(DATA_DIR, ['add', '-A']);
  if (await gitOk(DATA_DIR, ['diff', '--cached', '--quiet'])) return false;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await git(DATA_DIR, ['commit', '--quiet', '-m', `${reason}: ${stamp}`]);
  return true;
}

// Merges what is fetched from GitHub into this folder. True when files changed here.
async function mergeRemote() {
  const branch = config.dataBranch;
  const theirs = `origin/${branch}`;
  if (!(await gitOk(DATA_DIR, ['rev-parse', '--verify', '--quiet', theirs]))) return false;
  if (!(await hasCommits())) { await git(DATA_DIR, ['reset', '--quiet', '--hard', theirs]); return true; }
  const behind = Number((await git(DATA_DIR, ['rev-list', '--count', `HEAD..${theirs}`])).trim());
  if (!behind) return false;
  try {
    await git(DATA_DIR, ['merge', '--quiet', '--no-edit', '--allow-unrelated-histories', '-m', 'merge what the other computer saved', theirs]);
  } catch (err) {
    // Changed on both sides. What is on GitHub wins, file by file.
    const unmerged = (await git(DATA_DIR, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    if (!unmerged.length) { await git(DATA_DIR, ['merge', '--abort']).catch(() => {}); throw err; }
    for (const file of unmerged) {
      if (await gitOk(DATA_DIR, ['checkout', '--theirs', '--', file])) await git(DATA_DIR, ['add', '--', file]);
      else await git(DATA_DIR, ['rm', '--quiet', '-f', '--', file]).catch(() => {});
    }
    await git(DATA_DIR, ['commit', '--quiet', '--no-edit', '-m', 'merge what the other computer saved']);
    log(`app data: ${unmerged.length} file(s) changed on both computers; kept the version on GitHub: ${unmerged.slice(0, 5).join(', ')}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), IGNORE);
  return true;
}

function reload() {
  for (const fn of reloaders) { try { fn(); } catch (err) { log(`app data: reload failed: ${err.message}`); } }
  events.emit('reloaded', {});
}

// Takes in what the other computer saved to GitHub. True when something came in.
export function pullNow() {
  if (!status.enabled) return Promise.resolve(false);
  return serial(async () => {
    await commitLocal('state');
    if (!(await gitOk(DATA_DIR, ['fetch', '--quiet', 'origin', config.dataBranch]))) throw new Error('GitHub is not reachable.');
    const changed = await mergeRemote();
    if (changed) reload();
    return changed;
  });
}

// Commits what changed and pushes. Safe to call at any time.
export function saveNow(reason = 'state') {
  if (!status.enabled) return Promise.resolve(dataSyncStatus());
  return serial(async () => {
    const branch = config.dataBranch;
    try {
      await commitLocal(reason);
      if (await hasCommits()) {
        const ahead = (await gitOk(DATA_DIR, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]))
          ? Number((await git(DATA_DIR, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim())
          : 1;
        if (ahead > 0) {
          const push = () => git(DATA_DIR, ['push', '--quiet', 'origin', `HEAD:${branch}`]);
          try { await push(); } catch (err) {
            // The other computer pushed in between: take that in, then push both.
            if (!(await gitOk(DATA_DIR, ['fetch', '--quiet', 'origin', branch]))) throw err;
            if (await mergeRemote()) reload();
            await push();
          }
          await git(DATA_DIR, ['fetch', '--quiet', 'origin', branch]).catch(() => {});
          status.lastPush = Date.now();
          for (const fn of pushed) { try { fn(); } catch { /* never in the way */ } }
        }
        status.commit = (await git(DATA_DIR, ['rev-parse', '--short', 'HEAD'])).trim();
      }
      if (status.error) { status.error = ''; events.emit('connections-changed'); }
    } catch (err) {
      const message = `The app's state could not be saved to GitHub: ${err.message}`;
      if (status.error !== message) { status.error = message; log(message); events.emit('connections-changed'); }
    }
    return dataSyncStatus();
  });
}
