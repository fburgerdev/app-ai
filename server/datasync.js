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
// A second computer that starts with an empty data folder takes over what is on GitHub.
// Two computers running at once is not supported: the one that pushes second keeps its
// own state and reports that it could not push.

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
  '',
].join('\n');

let config;
let timer = null;
let busy = false;
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
    // A fresh data folder takes over what is already saved on GitHub.
    const threadsDir = path.join(DATA_DIR, 'threads');
    const fresh = !(await hasCommits()) && (!fs.existsSync(threadsDir) || fs.readdirSync(threadsDir).length === 0);
    const remoteHas = await gitOk(DATA_DIR, ['fetch', '--quiet', 'origin', branch]);
    if (fresh && remoteHas) {
      await git(DATA_DIR, ['reset', '--quiet', '--hard', `origin/${branch}`]);
      fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), IGNORE);
      log('app data restored from the data repo');
    }
  } catch (err) {
    status.error = `The app's state cannot be saved to GitHub: ${err.message}`;
    log(status.error);
  }
}

export function startDataSync() {
  if (!status.enabled || timer) return;
  const every = Math.max(1, Number(config.dataSyncMinutes) || 5) * 60_000;
  timer = setInterval(() => saveNow().catch(() => {}), every);
  timer.unref?.();
}

// Commits what changed and pushes. Safe to call at any time; overlapping calls are dropped.
export async function saveNow(reason = 'state') {
  if (!status.enabled || busy) return dataSyncStatus();
  busy = true;
  const branch = config.dataBranch;
  try {
    await git(DATA_DIR, ['add', '-A']);
    const changed = !(await gitOk(DATA_DIR, ['diff', '--cached', '--quiet']));
    if (changed) {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await git(DATA_DIR, ['commit', '--quiet', '-m', `${reason}: ${stamp}`]);
    }
    if (await hasCommits()) {
      const ahead = (await gitOk(DATA_DIR, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]))
        ? Number((await git(DATA_DIR, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim())
        : 1;
      if (ahead > 0) {
        await git(DATA_DIR, ['push', '--quiet', 'origin', `HEAD:${branch}`]);
        status.lastPush = Date.now();
      }
      status.commit = (await git(DATA_DIR, ['rev-parse', '--short', 'HEAD'])).trim();
    }
    if (status.error) { status.error = ''; events.emit('connections-changed'); }
  } catch (err) {
    const message = `The app's state could not be saved to GitHub: ${err.message}`;
    if (status.error !== message) { status.error = message; log(message); events.emit('connections-changed'); }
  } finally {
    busy = false;
  }
  return dataSyncStatus();
}
