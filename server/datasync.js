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

import { isNetworkError, report } from './repair.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, THREADS_DIR, log } from './config.js';
import { redact, refreshSecrets, secretNames } from './secrets.js';
import { git, gitOk } from './git.js';
import { adoptRewritten, forgetOld, moveBranch, rewriteWithout, wasRewritten } from './purge.js';
import { events } from './store.js';

// The folders repos.js keeps in the data folder (clones, worktrees, the shared stores with
// gigabytes of video) are other repos' business and never saved here.
export const IGNORE = [
  '# Secrets and machine-local files. Never commit these.',
  'config.json',
  'google-token.json',
  '*.agekey',
  '/brain/',
  'log.txt',
  'reads.jsonl',
  '*.tmp',
  '/extractions/*/transcripts/',
  '/cards/runs/',
  '/cards/state.json',
  '/uploads-pending/',
  '/repos/',
  '/worktrees/',
  '/shared/',
  '/threads/*/work/',
  '/purge-history.json',
  '/link.json',
  '/prune-run.json',
  '/usage-sessions.json',
  '',
].join('\n');

let config;
let timer = null;
let netSince = 0;
let stalled = 0; // saves in a row in which a git step was stopped by its timeout
let chain = Promise.resolve(); // one git operation on the data folder at a time
const reloaders = []; // what reads its data from disk again after a merge
const pushed = []; // told when something new went to GitHub
export const onPushed = (fn) => pushed.push(fn);

// Called with nothing; re-reads whatever a module keeps in memory.
export const onReload = (fn) => reloaders.push(fn);
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
const status = { enabled: false, lastPush: 0, error: '', commit: '' };

// What origin/<branch> pointed at before a fetch that found GitHub's history rewritten
// (the other computer cleaned it): the next merge adopts it instead of merging.
let rewrittenFrom = '';
async function fetchOrigin() {
  const branch = config.dataBranch;
  const before = (await git(DATA_DIR, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).catch(() => '')).trim();
  const ok = await gitOk(DATA_DIR, ['fetch', '--quiet', 'origin', branch]);
  if (ok && before && !rewrittenFrom && await wasRewritten(DATA_DIR, branch, before)) rewrittenFrom = before;
  return ok;
}

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
    // What an earlier version saved from those folders (a worktree, as a link) goes again.
    if (await hasCommits()) await whenUnlocked(() => git(DATA_DIR, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', 'worktrees', 'shared']));
    // A conversation changed on two computers keeps both sides' lines.
    fs.mkdirSync(path.join(DATA_DIR, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, '.git', 'info', 'attributes'), '*.jsonl merge=union\n');
    // A fresh data folder takes over what is already saved on GitHub.
    const threadsDir = path.join(DATA_DIR, 'threads');
    const fresh = !(await hasCommits()) && (!fs.existsSync(threadsDir) || fs.readdirSync(threadsDir).length === 0);
    const remoteHas = await fetchOrigin();
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

// Git lets one process at a time write a repository's index and refuses the second
// ("Unable to create .../index.lock ... Another git process seems to be running").
// Something else can hold it for a moment (a status check, a shell in a thread's
// folder), so a refused step waits briefly and runs again. The same holds for a file
// the app is rewriting in the very moment git reads it ("unable to index file",
// seen on Windows): a moment later the write is over.
export async function whenUnlocked(fn, { tries = 5, wait = 400 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await fn(); } catch (err) {
      if (attempt >= tries || !/index\.lock|Another git process|unable to index file|failed to insert into database/i.test(`${err.stderr || ''} ${err.message || ''}`)) throw err;
      await new Promise((r) => setTimeout(r, wait * attempt));
    }
  }
}

// A git step stopped by its timeout is killed, and on Windows it leaves its index.lock
// behind: every later save is then refused until the file is gone. All writing steps on
// the data folder run one at a time, here, and none may run longer than its timeout, so
// a lock older than that belongs to no running step and is removed.
export function clearStaleLock(dir = DATA_DIR, { olderThan = 150_000 } = {}) {
  const lock = path.join(dir, '.git', 'index.lock');
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < olderThan) return false;
    fs.rmSync(lock);
    log('app data: removed a git lock a stopped step had left behind');
    return true;
  } catch { return false; }
}

// Folders that are ignored now but were committed before the rule existed leave the
// saved state (the files stay on disk).
async function untrackIgnored() {
  if (!(await git(DATA_DIR, ['ls-files', '--', 'worktrees', 'shared']).catch(() => '')).trim()) return;
  await git(DATA_DIR, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', 'worktrees', 'shared']).catch(() => {});
}

// A secret value in a thread's conversation (Florian typed it, or a tool's output
// showed it) is replaced by its placeholder before it is committed, so the data repo
// never holds one. Only the files changed since the last look are read; the read and the
// write happen in one go, so no message the app appends in between is lost.
const seen = new Map(); // file -> mtime when last checked
export async function redactMessages() {
  await refreshSecrets();
  if (!secretNames().length) return 0;
  let changed = 0;
  let ids = [];
  try { ids = fs.readdirSync(THREADS_DIR); } catch { return 0; }
  // thread.json too: its title and gist are words from the conversation.
  for (const file of ids.flatMap((id) => ['messages.jsonl', 'thread.json'].map((n) => path.join(THREADS_DIR, id, n)))) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (seen.get(file) === st.mtimeMs) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const clean = redact(text);
      if (clean !== text) { fs.writeFileSync(file, clean); changed += 1; }
      seen.set(file, fs.statSync(file).mtimeMs);
    } catch { /* the next save looks again */ }
  }
  if (changed) log(`app data: a secret value in ${changed} thread file(s) was replaced by its placeholder before saving`);
  return changed;
}

async function commitLocal(reason) {
  await redactMessages().catch((err) => log(`app data: redacting secrets failed: ${err.message}`));
  clearStaleLock();
  await untrackIgnored();
  await whenUnlocked(() => git(DATA_DIR, ['add', '-A']));
  if (await gitOk(DATA_DIR, ['diff', '--cached', '--quiet'])) return false;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await whenUnlocked(() => git(DATA_DIR, ['commit', '--quiet', '-m', `${reason}: ${stamp}`]));
  return true;
}

// Merges what is fetched from GitHub into this folder. True when files changed here.
async function mergeRemote() {
  const branch = config.dataBranch;
  const theirs = `origin/${branch}`;
  if (!(await gitOk(DATA_DIR, ['rev-parse', '--verify', '--quiet', theirs]))) return false;
  // The other computer cleaned the history: take it, and keep what only this one changed.
  if (rewrittenFrom && (await hasCommits())) {
    const from = rewrittenFrom;
    rewrittenFrom = '';
    const kept = await adoptRewritten(DATA_DIR, branch, from);
    fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), IGNORE);
    log(`app data: the other computer cleaned the saved history; took it over and kept ${kept.length} file(s) changed here`);
    serial(() => forgetOld(DATA_DIR)).catch(() => {});
    return true;
  }
  if (!(await hasCommits())) { await git(DATA_DIR, ['reset', '--quiet', '--hard', theirs]); return true; }
  const behind = Number((await git(DATA_DIR, ['rev-list', '--count', `HEAD..${theirs}`])).trim());
  if (!behind) return false;
  const merge = () => git(DATA_DIR, ['merge', '--quiet', '--no-edit', '--allow-unrelated-histories', '-m', 'merge what the other computer saved', theirs]);
  try {
    // The app keeps writing while this runs (a thread gets its name a moment after its
    // turn ends), and git refuses to merge over a file changed since the last commit.
    // So what changed is committed right before the merge, and once more if a write
    // slipped in between the two.
    for (let attempt = 0; ; attempt += 1) {
      await commitLocal('state');
      try { await merge(); break; } catch (err) {
        const unmerged = (await git(DATA_DIR, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
        if (unmerged.length || attempt >= 4) throw err;
        await git(DATA_DIR, ['merge', '--abort']).catch(() => {});
      }
    }
  } catch (err) {
    // Changed on both sides. What is on GitHub wins, file by file.
    const unmerged = (await git(DATA_DIR, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    if (!unmerged.length) { await git(DATA_DIR, ['merge', '--abort']).catch(() => {}); throw err; }
    let own = 0;
    for (const file of unmerged) {
      // A thread's state: the copy that is further on, not blindly GitHub's (pickThread).
      if (/^threads\/[^/]+\/thread\.json$/.test(file)) {
        const ours = await git(DATA_DIR, ['show', `:2:${file}`]).catch(() => '');
        const theirs = await git(DATA_DIR, ['show', `:3:${file}`]).catch(() => '');
        const picked = ours && theirs ? pickThread(ours, theirs, os.hostname()) : null;
        if (picked?.side === 'ours') {
          fs.writeFileSync(path.join(DATA_DIR, ...file.split('/')), picked.text);
          await git(DATA_DIR, ['add', '--', file]);
          own += 1;
          continue;
        }
        if (picked) {
          fs.writeFileSync(path.join(DATA_DIR, ...file.split('/')), picked.text);
          await git(DATA_DIR, ['add', '--', file]);
          continue;
        }
      }
      if (await gitOk(DATA_DIR, ['checkout', '--theirs', '--', file])) await git(DATA_DIR, ['add', '--', file]);
      else await git(DATA_DIR, ['rm', '--quiet', '-f', '--', file]).catch(() => {});
    }
    await git(DATA_DIR, ['commit', '--quiet', '--no-edit', '-m', 'merge what the other computer saved']);
    log(`app data: ${unmerged.length} file(s) changed on both computers; kept ${own ? `this computer's version of ${own}, and ` : ''}the version on GitHub${own ? ' of the rest' : ''}: ${unmerged.slice(0, 5).join(', ')}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), IGNORE);
  return true;
}

// A thread's state (thread.json) changed on both computers since they last agreed. Until
// 24-11-2026 GitHub's copy won, whichever it was: on 23-11-2026 a thread Florian had
// closed on the laptop (six messages, done) came back as the Pi's stale copy of it (one
// message, "the other computer went away before it finished"). The copy that is further
// on wins instead:
//   1. the one that knows more of the conversation (`messageCount`);
//   2. then the one whose own computer runs the turn (it is the only one that knows);
//   3. then the one changed last (`changedAt`); if that does not tell, GitHub's, as before.
// What he queued or sent with "send and done" on the losing side is kept if the winner
// has none. `ours` and `theirs` are the files' text; returns { side, text }.
export function pickThread(ours, theirs, host) {
  let a; let b;
  try { a = JSON.parse(ours); b = JSON.parse(theirs); } catch { return null; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
  const runsItself = (t, own) => t.state === 'working' && !t.held && Boolean(t.workingOn) && (t.workingOn === host) === own;
  let side = 'theirs';
  if ((a.messageCount || 0) !== (b.messageCount || 0)) side = (a.messageCount || 0) > (b.messageCount || 0) ? 'ours' : 'theirs';
  else if (runsItself(a, true) !== runsItself(b, false)) side = runsItself(a, true) ? 'ours' : 'theirs';
  else if ((a.changedAt || 0) !== (b.changedAt || 0)) side = (a.changedAt || 0) > (b.changedAt || 0) ? 'ours' : 'theirs';
  const [win, lose] = side === 'ours' ? [a, b] : [b, a];
  for (const k of ['queued', 'unsent']) if (!(win[k] || []).length && (lose[k] || []).length) win[k] = lose[k];
  return { side, text: `${JSON.stringify(win, null, 2)}\n` };
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
    if (!(await fetchOrigin())) throw new Error('GitHub is not reachable.');
    const changed = await mergeRemote();
    if (changed) reload();
    return changed;
  });
}

// Pushes; when GitHub rejects it because the other computer pushed in between, takes
// that in and pushes again. Both computers save on the same clock, so the second push
// can lose the same race (GitHub then says "cannot lock ref"): a few tries, a moment apart.
export async function pushTakingIn(push, takeIn, { tries = 4, wait = 1500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await push(); } catch (err) {
      if (attempt >= tries || !(await takeIn())) throw err;
      if (attempt > 1) await new Promise((r) => setTimeout(r, wait * (attempt - 1)));
    }
  }
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
          await pushTakingIn(
            () => git(DATA_DIR, ['push', '--quiet', 'origin', `HEAD:${branch}`]),
            async () => {
              if (!(await fetchOrigin())) return false;
              if (await mergeRemote()) reload();
              return true;
            },
          );
          await fetchOrigin().catch(() => {});
          status.lastPush = Date.now();
          for (const fn of pushed) { try { fn(); } catch { /* never in the way */ } }
        }
        status.commit = (await git(DATA_DIR, ['rev-parse', '--short', 'HEAD'])).trim();
      }
      netSince = 0;
      stalled = 0;
      if (status.error) { status.error = ''; events.emit('connections-changed'); }
    } catch (err) {
      if (isNetworkError(err.message)) {
        // Away from the network: the next save, two minutes on, tries again. Only said if it lasts.
        netSince ||= Date.now();
        if (Date.now() - netSince > 10 * 60_000 && !status.error) { status.error = 'GitHub has not been reachable for more than ten minutes. The app keeps trying to save.'; events.emit('connections-changed'); }
        return dataSyncStatus();
      }
      // A step stopped by its timeout (the laptop slept in the middle of it) is not a
      // failure yet: the next save does it again. Only said when it happens twice in a row.
      if (err.timedOut && (stalled += 1) < 2) { log(`app data: ${err.message}; the next save tries again`); return dataSyncStatus(); }
      const message = `The app's state could not be saved to GitHub: ${err.message}`;
      if (status.error !== message) { status.error = message; log(message); events.emit('connections-changed'); report('saving the app\'s state', err.message); }
    }
    return dataSyncStatus();
  });
}

// Takes `paths` out of the whole saved history, here and on GitHub, once. Everything
// is saved and taken in first, so GitHub and this computer agree; then the history is
// rewritten without those files, pushed over GitHub's (only if GitHub has not moved in
// the meantime), and the other computer adopts it on its next fetch (see mergeRemote).
// Returns { done, changed, reason }.
export function purgeHistory(paths) {
  if (!status.enabled) return Promise.resolve({ done: false, reason: 'The app data is not saved to GitHub here.' });
  return serial(async () => {
    const branch = config.dataBranch;
    await commitLocal('state');
    if (!(await fetchOrigin())) return { done: false, reason: 'GitHub is not reachable.' };
    if (await mergeRemote()) reload();
    const ahead = Number((await git(DATA_DIR, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim());
    if (ahead) await git(DATA_DIR, ['push', '--quiet', 'origin', `HEAD:${branch}`], { timeout: 600_000 });
    await fetchOrigin();
    const old = (await git(DATA_DIR, ['rev-parse', 'HEAD'])).trim();
    if (old !== (await git(DATA_DIR, ['rev-parse', `origin/${branch}`])).trim()) return { done: false, reason: 'GitHub and this computer do not agree yet.' };
    log(`app data: taking ${paths.length} file(s) out of the saved history`);
    const { tip, changed } = await rewriteWithout(DATA_DIR, branch, paths);
    if (!changed) return { done: true, changed: 0 };
    // Only over the version just checked: if the other computer saved in between, nothing happens.
    await git(DATA_DIR, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${old}`, 'origin', `${tip}:refs/heads/${branch}`], { timeout: 600_000 });
    await moveBranch(DATA_DIR, branch, tip, old);
    await fetchOrigin();
    status.commit = (await git(DATA_DIR, ['rev-parse', '--short', 'HEAD'])).trim();
    status.lastPush = Date.now();
    log(`app data: the saved history was rewritten without them (${changed} commit(s) changed)`);
    for (const fn of pushed) { try { fn(); } catch { /* never in the way */ } }
    return { done: true, changed };
  }).then((r) => { if (r.changed) serial(() => forgetOld(DATA_DIR)).catch(() => {}); return r; });
}

// What is here but not on GitHub yet: changed files, and commits not pushed.
// After saveNow: an error if not everything reached GitHub. saveNow itself says nothing
// about a network that was away for a moment (the next save tries again), which is right
// for the save every few minutes but not for a handover: the other computer would take
// in an older state and call it everything.
export async function notOnGithub() {
  if (!status.enabled) return '';
  if (status.error) return status.error;
  const left = await unsaved();
  return left.ahead ? 'GitHub could not be reached, so the latest changes are only on this computer' : '';
}

export async function unsaved() {
  if (!status.enabled) return { enabled: false, files: 0, ahead: 0 };
  // Runs beside a save, not in line with it, so it must not take the index lock itself.
  const changed = (await git(DATA_DIR, ['--no-optional-locks', 'status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean);
  const files = changed.length;
  const branch = config.dataBranch;
  const ahead = (await gitOk(DATA_DIR, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]))
    ? Number((await git(DATA_DIR, ['rev-list', '--count', `origin/${branch}..HEAD`]).catch(() => '0')).trim())
    : (await hasCommits()) ? 1 : 0;
  return { enabled: true, files, ahead, names: changed.slice(0, 5).map((l) => l.slice(3)), lastPush: status.lastPush, error: status.error };
}
