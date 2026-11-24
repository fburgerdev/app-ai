// Git repositories threads work in.
//
// Any thread can work in any of Florian's repos. A repo is cloned the first time a thread
// uses it and brought up to date each time one does. A thread holds the repo while its turn
// runs.
//
// Threads work side by side in every repo but the vault (Florian, 23-11-2026), unless
// `.app/repo.json` on the repo's main branch says `"parallel": false`: the first thread
// works in the main copy, one that comes while another works there gets a git worktree of
// its own, and the lock has two forms. Normal turns share it; a turn that needs
// the repo quiet (a migration, a rename, a dependency upgrade, changing `.app/repo.json`)
// takes it alone (`open_repo` with `exclusive: true`), after the turns already working
// there have ended, and no new ones start meanwhile. A turn that would wait long is parked:
// it ends, keeps its place in the queue, and the app starts it again by itself the moment
// the repo is free for it (runner.js). Folders the repo names under `shared` live once,
// outside the worktrees, and are linked into each: `readonly` ones no thread changes (only
// an exclusive turn), `addonly` ones take new files but never change or lose one. Windows'
// own access rules hold that; a check at the end of every turn catches what slipped through
// (on the Pi), and a turn that broke it is not merged.
//
// Each thread works on a branch of its own, made from the repo's main branch. When a turn
// ends, whatever Claude left uncommitted is committed onto that branch, so the copy is
// clean for the next thread, and the branch is pushed to GitHub (`autoPush`, on by
// default), so the work never sits on one computer only. The branch then goes into main by
// itself (ship.js), or by the button in the thread's repo panel.
//
// Managing repos themselves (renaming, creating, describing) goes through GitHub's API
// with the token the machine already uses for git, or `github.token` in config.json.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DATA_DIR, log } from './config.js';
import { git } from './git.js';
import * as store from './store.js';

let config;
export function initRepos(cfg) {
  config = cfg;
  if (!config.reposDir) config.reposDir = path.join(DATA_DIR, 'repos');
  if (!config.worktreesDir) config.worktreesDir = path.join(DATA_DIR, 'worktrees');
  if (!config.sharedDir) config.sharedDir = path.join(DATA_DIR, 'shared');
  fs.mkdirSync(config.reposDir, { recursive: true });
}

const busy = new Map(); // repo key -> promise: one git operation at a time per repo

const key = (full) => full.toLowerCase();
export const dirOf = (full) => path.join(config.reposDir, ...full.split('/'));
const owner = () => config?.github?.owner || 'fburgerdev';

// "app-ai", "fburgerdev/app-ai" or a GitHub URL, as "owner/name"; null if it is none of these.
export function repoName(input) {
  let s = String(input || '').trim().replace(/^`|`$/g, '');
  s = s.replace(/^(?:https?:\/\/|git@)github\.com[/:]/i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!s.includes('/')) s = `${owner()}/${s}`;
  return /^[\w.-]+\/[\w.-]+$/.test(s) && !s.split('/').some((p) => p === '.' || p === '..') ? s : null;
}

// The vault's repo (`brainRepo` in the config) as "owner/name", the way a thread opens it.
// A test's vault is a folder on disk ending in "<owner>/<name>.git"; its last two parts
// are the name.
export function vaultRepo(brainRepo) {
  const src = String(brainRepo || '');
  return repoName(src) || src.replace(/\.git$/i, '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || null;
}

function serial(full, fn) {
  const k = key(full);
  const run = (busy.get(k) || Promise.resolve()).then(fn, fn);
  busy.set(k, run.catch(() => {}));
  return run;
}

const remoteUrl = (full) => `${config.repoBase.replace(/\/$/, '')}/${full}.git`;

async function defaultBranch(dir) {
  try {
    return (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
  } catch {
    await git(dir, ['remote', 'set-head', 'origin', '--auto']).catch(() => {});
    try { return (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, ''); } catch { return 'main'; }
  }
}

// Clones the repo if it is not here yet, otherwise fetches. Returns its folder and main branch.
export function ensure(full) {
  return serial(full, async () => {
    const dir = dirOf(full);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      log(`repos: cloning ${full}`);
      try {
        await git(path.dirname(dir), ['clone', '--quiet', remoteUrl(full), dir], { timeout: 600_000 });
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(/not found|does not exist|repository .* not found/i.test(err.message)
          ? `There is no repo ${full} on GitHub, or this machine has no access to it.`
          : `Could not clone ${full}: ${err.message.split('\n')[0]}`);
      }
    } else {
      await git(dir, ['fetch', '--quiet', '--prune', 'origin']).catch((err) => log(`repos: fetch ${full} failed: ${err.message}`));
    }
    await startEmpty(dir, full);
    const base = await defaultBranch(dir);
    await loadSettings(dir, full, base);
    return { dir, base };
  });
}

// ---------- the repo's own settings: .app/repo.json on its main branch ----------
//
//   { "shared": { "writable": ["takes", "renders", "films"], "readonly": ["fonts"], "addonly": ["films/final4k"] } }
//
// Every repo lets threads work side by side, unless the file says "parallel": false; the vault
// never does (the brain update and the threads changing it take turns). Florian, 23-11-2026:
// "worktrees should be on demand created if two threads want to work on the same repo": the
// first thread works in the main copy, and only a thread that comes while it works there gets a
// worktree. Without "shared", every top-level folder git ignores is shared, writable
// (detectShared): "put any new not git tracked data to shared".
//
// Read from main as GitHub has it, so a branch cannot change them for itself; changing the
// file is work for an exclusive turn (the policy in agent.js and the check at the end of a
// turn hold that).

const NO_SETTINGS = Object.freeze({ parallel: true, explicit: false, shared: Object.freeze({ readonly: [], addonly: [], writable: [] }) });
const settings = new Map(); // repo key -> parsed settings
export const SETTINGS_FILE = '.app/repo.json';
export const repoSettings = (full) => settings.get(key(full)) || NO_SETTINGS;
const isVault = (full) => { const v = repoName(config?.brainRepo || ''); return Boolean(v && key(v) === key(full)) || /\/brain$/i.test(String(full)); };
export const isParallel = (full) => repoSettings(full).parallel && !isVault(full);
// For the tests: settings without a clone.
export const _setSettings = (full, raw) => settings.set(key(full), parseSettings(raw));

function cleanShared(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  if (s.split('/').some((x) => !x || x === '.' || x === '..' || /^\.(git|app)$/i.test(x))) return null;
  return s;
}

export function parseSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => [...new Set((Array.isArray(v) ? v : []).map(cleanShared).filter(Boolean))];
  const readonly = list(s.shared?.readonly);
  const addonly = list(s.shared?.addonly).filter((p) => !readonly.includes(p));
  const writable = list(s.shared?.writable).filter((p) => !readonly.includes(p) && !addonly.includes(p));
  // A protected folder inside a writable one is reached through the writable one's link and
  // protected in its store. Any other nesting would put a link into another shared store, so
  // neither is shared; a writable folder inside another writable one is the outer one's already.
  const all = [...writable.map((p) => ({ p, kind: 'writable' })), ...readonly.map((p) => ({ p, kind: 'readonly' })), ...addonly.map((p) => ({ p, kind: 'addonly' }))];
  const inside = (a, b) => a.startsWith(`${b}/`);
  const ok = (e) => !all.some((o) => o.p !== e.p && ((inside(e.p, o.p) && (o.kind !== 'writable' || e.kind === 'writable')) || (inside(o.p, e.p) && e.kind !== 'writable')));
  const keep = (kind) => all.filter((e) => e.kind === kind && ok(e)).map((e) => e.p);
  return {
    parallel: s.parallel !== false,
    explicit: Boolean(s.shared && typeof s.shared === 'object'),
    shared: { readonly: keep('readonly'), addonly: keep('addonly'), writable: keep('writable') },
  };
}

async function loadSettings(dir, full, base) {
  const ref = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).then(() => `origin/${base}`, () => 'HEAD');
  const text = await git(dir, ['show', `${ref}:${SETTINGS_FILE}`]).catch(() => '');
  let raw = null;
  if (text.trim()) {
    try { raw = JSON.parse(text); } catch (err) { log(`repos: ${full} has a ${SETTINGS_FILE} that is not JSON, so it is left as a repo of one thread at a time: ${err.message}`); }
  }
  const before = repoSettings(full);
  const now = parseSettings(raw);
  settings.set(key(full), now);
  if (before.parallel !== now.parallel && !now.parallel) log(`repos: ${full} is one thread at a time (${SETTINGS_FILE})`);
}

// A repo made on GitHub without a first commit has no branch to start from: nothing can
// be branched off it, pushed to it or merged into it. The app gives it one, an empty
// commit on main, and pushes it, so the repo works like any other from then on. Only when
// GitHub really has no branch at all; a repo with history is never touched.
async function startEmpty(dir, full) {
  const remoteBranches = (await git(dir, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/origin/']).catch(() => '')).trim();
  if (remoteBranches) return;
  const onGithub = (await git(dir, ['ls-remote', '--heads', 'origin'], { timeout: 60_000 }).catch(() => null));
  if (onGithub === null || onGithub.trim()) return; // offline, or branches appeared meanwhile
  const hasLocal = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  if (!hasLocal) {
    await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(dir, [...(await identity(dir)), 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Start']);
  }
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(dir, ['push', '--quiet', '-u', 'origin', `${branch}:refs/heads/${branch}`], { timeout: 180_000 });
  await git(dir, ['remote', 'set-head', 'origin', branch]).catch(() => {});
  log(`repos: ${full} was empty; gave it a first commit on ${branch}`);
}

// ---------- the lock: shared by many, or held by one ----------
//
// Per repo: who holds it (`holders`), in which form (`mode`), and who waits (`queue`, first
// come, first served). A repo that is not parallel knows only the exclusive form, which is
// the old "one thread at a time". An exclusive request waits for the holders to finish and
// keeps every later request behind it, so it cannot be starved. A waiting entry without a
// `resolve` is a parked turn: when the repo is free for it, it is given the lock and the app
// starts its turn (onGranted, runner.js). Locks live in the app's memory, never in the repo;
// parked turns are kept on their thread (`held`) and join the queue again after a restart.

const locks = new Map(); // repo key -> { full, mode: '' | 'shared' | 'exclusive', holders: Set, queue: [], lifted }

function lockOf(full) {
  const k = key(full);
  if (!locks.has(k)) locks.set(k, { full, mode: '', holders: new Set(), queue: [], lifted: false });
  return locks.get(k);
}

// For Video Kit (server/videokit.js): its git work on a repo goes in the same queue as the threads'.
export const serialFor = (full, fn) => serial(full, fn);
export const identityFor = (dir) => identity(dir);

// A job of the app itself can hold a repo too, under a name of its own: the brain update
// holds the vault's repo while it writes, so no thread changes the vault meanwhile.
export const jobHolder = (name) => `job:${name}`;
const isJob = (id) => String(id || '').startsWith('job:');
// A thread that no longer exists holds nothing; a job holds until it gives the repo back.
const alive = (id) => isJob(id) || Boolean(store.getThread(id));

// Holders that are gone (a deleted thread) let go by themselves.
function prune(L) {
  for (const id of [...L.holders]) if (!alive(id)) L.holders.delete(id);
  if (!L.holders.size) settle(L);
}

// Nobody holds it any more: an exclusive turn that lifted the shared folders' protection
// gets it back before anyone else comes in.
function settle(L) {
  L.mode = '';
  if (L.lifted) {
    try { protectShared(L.full); } catch (err) { log(`repos: could not protect the shared folders of ${L.full} again: ${err.message}`); }
    L.lifted = false;
  }
}

export const holders = (full) => { const L = locks.get(key(full)); return L ? [...L.holders] : []; };
export const holder = (full) => holders(full)[0] || null;
export const holds = (full, id) => Boolean(full) && holders(full).includes(id);
export const lockMode = (full) => (holders(full).length ? locks.get(key(full)).mode : '');
export const holdsExclusive = (full, id) => holds(full, id) && lockMode(full) === 'exclusive';
const nameOf = (id) => (isJob(id) ? `the ${id.slice(4)}` : `"${store.getThread(id)?.title || 'another thread'}"`);
export const holderTitle = (full) => store.getThread(holder(full))?.title || 'another thread';

// Who holds the repo, as a sentence can name it: "Tidy the server code" (quoted, a
// thread), the brain update (a job), or "A" and 2 more threads. Empty when nobody does.
// `except` leaves one holder out (the thread asking).
export function holderName(full, except = null) {
  const ids = holders(full).filter((id) => id !== except);
  if (!ids.length) return '';
  if (ids.length === 1) return nameOf(ids[0]);
  return `${nameOf(ids[0])} and ${ids.length - 1} more thread${ids.length > 2 ? 's' : ''}`;
}

const grantable = (L, mode) => (mode === 'exclusive' ? L.holders.size === 0 : L.mode !== 'exclusive');

function take(L, id, mode) {
  L.holders.add(id);
  L.mode = mode;
}

// Hands the lock on, from the front of the queue: one exclusive, or every shared one in a row.
let grantedHook = null;
export const onGranted = (fn) => { grantedHook = fn; };
function pump(L) {
  prune(L);
  while (L.queue.length) {
    const head = L.queue[0];
    // A parked turn of a thread that is gone: nobody to start. One waiting right now keeps its place.
    if (!head.resolve && !alive(head.id)) { L.queue.shift(); continue; }
    if (!grantable(L, head.mode)) break;
    L.queue.shift();
    take(L, head.id, head.mode);
    if (head.resolve) head.resolve(true);
    else {
      // A parked turn: the app starts it now. If it cannot (the thread was stopped, or is
      // already running), the lock goes on to the next one.
      let started = false;
      try { started = Boolean(grantedHook?.(L.full, head.id, head.mode)); } catch (err) { log(`repos: starting a parked turn failed: ${err.message}`); }
      if (!started) {
        L.holders.delete(head.id);
        if (!L.holders.size) settle(L);
        continue;
      }
    }
    if (head.mode === 'exclusive') break;
  }
}

// The form a request gets: shared only in a repo that is parallel.
const formFor = (full, mode) => (mode === 'shared' && isParallel(full) ? 'shared' : 'exclusive');

// Takes the repo for a thread (or a job), shared or exclusive (`mode`, default exclusive).
// With `wait`, waits until it is free; without, gives up at once. With `timeoutMs`, gives
// up after that long: it leaves the queue, so the repo is not handed later to someone who
// stopped waiting, unless `park` is set: then it keeps its place as a parked turn.
export function acquire(full, id, { wait = true, timeoutMs = 0, mode = 'exclusive', park = false } = {}) {
  const L = lockOf(full);
  const want = formFor(full, mode);
  prune(L);
  if (L.holders.has(id)) {
    if (want === 'shared' || L.mode === 'exclusive') return Promise.resolve(true);
    // Holds it shared and wants it alone: back into the queue like anyone else.
    release(full, id);
  }
  let entry = L.queue.find((q) => q.id === id);
  if (!entry && !L.queue.length && grantable(L, want)) {
    take(L, id, want);
    return Promise.resolve(true);
  }
  if (!wait) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (entry) entry.mode = want === 'exclusive' ? 'exclusive' : entry.mode; // a parked turn back: keeps its place
    else { entry = { id, mode: want, at: Date.now(), resolve: null }; L.queue.push(entry); }
    let timer = null;
    entry.resolve = (v) => { clearTimeout(timer); entry.resolve = null; resolve(v); };
    if (timeoutMs) {
      timer = setTimeout(() => {
        if (!entry.resolve) return;
        entry.resolve = null;
        if (!park) { L.queue = L.queue.filter((q) => q !== entry); pump(L); }
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    }
    pump(L);
  });
}

export function release(full, id) {
  const L = locks.get(key(full));
  if (!L || !L.holders.has(id)) return;
  L.holders.delete(id);
  if (!L.holders.size) settle(L);
  pump(L);
}

// Everything a thread holds, given back (its turn ended). A parked place in a queue stays,
// and so does `keep`: the repo a parked turn was given while it was still ending.
export function releaseAll(id, keep = null) {
  for (const L of [...locks.values()]) if (L.holders.has(id) && !(keep && key(L.full) === key(keep))) release(L.full, id);
}

// A thread deleted, or a parked turn he cancelled: out of every queue as well.
export function forget(id) {
  releaseAll(id);
  unpark(id);
}

// A parked turn joins the queue (again, after a restart), in the order it was parked.
export function park(full, id, mode = 'exclusive', at = Date.now()) {
  const L = lockOf(full);
  if (L.holders.has(id) || L.queue.some((q) => q.id === id)) return;
  const entry = { id, mode: formFor(full, mode), at, resolve: null };
  const i = L.queue.findIndex((q) => q.at > at);
  if (i < 0) L.queue.push(entry); else L.queue.splice(i, 0, entry);
  pump(L);
}

export function unpark(id) {
  for (const L of locks.values()) {
    const before = L.queue.length;
    L.queue = L.queue.filter((q) => q.id !== id || q.resolve);
    if (L.queue.length !== before) pump(L);
  }
}

export const queued = (full, id) => Boolean(locks.get(key(full))?.queue.some((q) => q.id === id));
// Where a thread waits: its place (1 = next) and who holds the repo now.
export function waitingFor(full, id) {
  const L = locks.get(key(full));
  const i = L ? L.queue.findIndex((q) => q.id === id) : -1;
  return i < 0 ? null : { place: i + 1, holder: holderName(full, id) };
}

// ---------- shared folders: one store per repo, linked into every worktree ----------

const worktreesDir = () => config.worktreesDir || path.join(DATA_DIR, 'worktrees');
const sharedBase = () => config.sharedDir || path.join(DATA_DIR, 'shared');
export const sharedRoot = (full) => path.join(sharedBase(), ...full.split('/'));
export const worktreeOf = (full, threadId) => path.join(worktreesDir(), ...full.split('/'), String(threadId));
export const dirsForPolicy = () => ({ worktrees: worktreesDir(), shared: sharedBase() });

// Writable ones first: a protected folder inside one is reached through its link.
const autoShared = new Map(); // repo key -> Set of top-level folders found by detectShared
const sharedList = (full) => {
  const s = repoSettings(full);
  if (!s.explicit) return [...(autoShared.get(key(full)) || [])].sort().map((p) => ({ p, kind: 'writable' }));
  const { readonly, addonly, writable = [] } = s.shared;
  return [...writable.map((p) => ({ p, kind: 'writable' })), ...readonly.map((p) => ({ p, kind: 'readonly' })), ...addonly.map((p) => ({ p, kind: 'addonly' }))];
};

// Folders tools make for each copy of a repo, which are never shared.
const TOOL_DIRS = new Set(['node_modules', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache', '.turbo', 'target', 'coverage', '.idea', '.vscode', '.gradle', '.terraform', 'tmp', 'temp']);

// In a repo whose settings name no shared folders: every top-level folder git ignores in this
// copy, and every folder already in the repo's store (a copy where it is a link already).
async function detectShared(full, dir) {
  if (repoSettings(full).explicit) return;
  const found = autoShared.get(key(full)) || new Set();
  const out = await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { timeout: 60_000 }).catch(() => '');
  for (const line of out.split('\n')) {
    const m = /^([^/"]+)\/$/.exec(line.trim());
    if (m && !TOOL_DIRS.has(m[1].toLowerCase()) && cleanShared(m[1])) found.add(m[1]);
  }
  try {
    for (const e of fs.readdirSync(sharedRoot(full), { withFileTypes: true })) if (e.isDirectory() && !TOOL_DIRS.has(e.name.toLowerCase())) found.add(e.name);
  } catch { /* nothing shared yet */ }
  autoShared.set(key(full), found);
}
const storeOf = (full, p) => path.join(sharedRoot(full), ...p.split('/'));
const norm = (p) => { const r = path.resolve(String(p).replace(/^\\\\\?\\/, '')); return process.platform === 'win32' ? r.toLowerCase() : r; };

// Who the app runs as, for Windows' access rules.
const who = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME || process.env.USER);

function icacls(args) {
  const r = spawnSync('icacls', args, { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`icacls ${args.slice(1).join(' ')}: ${(r.stdout || r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
}

// Read-only: nothing in it is written, added, renamed or deleted, nor the folder itself.
// Add-only: new files and folders go in; a file, once written and closed, is never changed,
// renamed or deleted. On Windows that is held by deny rules for the app's own user (tested
// 23-11-2026: they stop node, Git Bash's rm, and git following a link). On Linux read-only
// is the write bit; add-only is held only by the check at the end of a turn.
function lockStore(dir, kind) {
  if (!fs.existsSync(dir)) return;
  if (process.platform === 'win32') {
    icacls([dir, '/remove:d', who()]);
    if (kind === 'readonly') icacls([dir, '/deny', `${who()}:(OI)(CI)(DE,DC,WD,AD,WA,WEA)`]);
    else {
      icacls([dir, '/deny', `${who()}:(OI)(IO)(DE,WD,AD,WA,WEA)`]);
      icacls([dir, '/deny', `${who()}:(CI)(DE,DC)`]);
    }
  } else if (kind === 'readonly') {
    spawnSync('chmod', ['-R', 'a-w', dir]);
  }
}

function unlockStore(dir) {
  if (!fs.existsSync(dir)) return;
  if (process.platform === 'win32') icacls([dir, '/remove:d', who()]);
  else spawnSync('chmod', ['-R', 'u+w', dir]);
}

const protecting = () => config?.protectShared !== false;

// The stores this app has protected since it started: protecting walks every file in a
// store, so it is done once, not at every turn.
const guarded = new Set();

export function protectShared(full) {
  if (!protecting()) return;
  for (const { p, kind } of sharedList(full)) {
    const dir = storeOf(full, p);
    if (kind === 'writable' || guarded.has(`${norm(dir)}|${kind}`) || !fs.existsSync(dir)) continue;
    lockStore(dir, kind);
    guarded.add(`${norm(dir)}|${kind}`);
  }
}

export function unprotectShared(full) {
  if (!protecting()) return;
  for (const { p, kind } of sharedList(full)) {
    if (kind === 'writable') continue;
    const dir = storeOf(full, p);
    unlockStore(dir);
    guarded.delete(`${norm(dir)}|${kind}`);
  }
}

// Moves what a real folder holds into the store (the first time a repo shares a folder its
// main copy already has, the EA video's takes). Leaves what the store already has a file
// of the same name for. True when the folder is empty afterwards.
function moveInto(from, to) {
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.existsSync(b)) continue;
    fs.renameSync(a, b);
  }
  return fs.readdirSync(from).length === 0;
}

// Links the repo's shared folders into a copy of it (a worktree, or the main copy, so Video
// Kit sees them too), and tells git to leave the links alone. A folder git tracks files in is
// never shared: linking it would take those files out of the branch.
async function linkShared(full, dir) {
  await detectShared(full, dir).catch((err) => log(`repos: ${full}: could not look for folders to share: ${err.message}`));
  const list = sharedList(full);
  if (!list.length) return;
  // A folder inside a shared writable one needs no link of its own.
  const outer = (p) => list.find((o) => o.kind === 'writable' && p.startsWith(`${o.p}/`));
  const common = path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim());
  const excludeFile = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const had = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  const lines = new Set(had.split(/\r?\n/));
  const add = list.filter(({ p }) => !outer(p)).map(({ p }) => `/${p}`).filter((l) => !lines.has(l));
  if (add.length) fs.writeFileSync(excludeFile, `${had.replace(/\s*$/, '')}\n# shared folders, linked by the app\n${add.join('\n')}\n`);
  let lifted = false;
  try {
    for (const { p } of list) {
      const target = storeOf(full, p);
      try {
        if (outer(p)) { fs.mkdirSync(target, { recursive: true }); continue; }
        if ((await git(dir, ['ls-files', '--', p]).catch(() => '')).trim()) { log(`repos: ${full}: "${p}" holds files git tracks, so it is not shared`); continue; }
        fs.mkdirSync(target, { recursive: true });
        const link = path.join(dir, ...p.split('/'));
        let st = null;
        try { st = fs.lstatSync(link); } catch { /* not there yet */ }
        if (st?.isSymbolicLink()) {
          if (norm(fs.readlinkSync(link)) === norm(target)) continue;
          fs.unlinkSync(link);
        } else if (st?.isDirectory()) {
          if (!lifted && protecting()) { unprotectShared(full); lifted = true; }
          if (!moveInto(link, target)) { log(`repos: ${full}: "${p}" in ${dir} has files the shared folder has too; left as it is, not linked`); continue; }
          fs.rmdirSync(link);
          log(`repos: ${full}: moved "${p}" into its shared folder`);
        } else if (st) {
          log(`repos: ${full}: "${p}" is a file, not a folder; not linked`);
          continue;
        }
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        // A file in use (a video playing) stops a move; it is tried again next time.
        log(`repos: ${full}: could not share "${p}" in ${dir}: ${err.message}`);
      }
    }
  } finally {
    // Protected from the start, and again after a folder was moved in. Not while an
    // exclusive turn holds the repo with the protection lifted.
    if (!lockOf(full).lifted) {
      try { protectShared(full); } catch (err) { log(`repos: could not protect the shared folders of ${full}: ${err.message}`); }
    }
  }
}

// Every link into the shared stores inside `dir` goes, before anything deletes the folder:
// git and rm follow such a link and would empty the store behind it.
function unlinkShared(dir) {
  const base = norm(sharedBase());
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let to = '';
        try { to = norm(fs.readlinkSync(p)); } catch { /* broken */ }
        if (!to || to === base || to.startsWith(base + path.sep)) {
          try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
        }
      } else if (e.isDirectory() && e.name !== '.git') walk(p);
    }
  };
  walk(dir);
}

// ---------- what a turn did to the shared folders ----------

function listFiles(root) {
  const out = new Map();
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { try { const s = fs.statSync(p); out.set(r, `${s.size}:${Math.round(s.mtimeMs)}`); } catch { /* gone meanwhile */ } }
    }
  };
  walk(root, '');
  return out;
}

const snapshots = new Map(); // threadId -> { full, stores: { p: { kind, files } }, settingsFile }

async function settingsBlob(dir) {
  const file = path.join(dir, ...SETTINGS_FILE.split('/'));
  if (!fs.existsSync(file)) return '';
  return (await git(dir, ['hash-object', '--', SETTINGS_FILE]).catch(() => '?')).trim();
}

async function snapshot(threadId, full, dir) {
  const stores = {};
  for (const { p, kind } of sharedList(full)) if (kind !== 'writable') stores[p] = { kind, files: listFiles(storeOf(full, p)) };
  snapshots.set(threadId, { full, dir, stores, settingsFile: await settingsBlob(dir) });
}

// At the end of a shared turn: what it must not have done. Returns sentences, empty if all is well.
async function breaches(threadId) {
  const snap = snapshots.get(threadId);
  snapshots.delete(threadId);
  if (!snap) return [];
  const out = [];
  for (const [p, { kind, files }] of Object.entries(snap.stores)) {
    const now = listFiles(storeOf(snap.full, p));
    const changed = [...files].filter(([f, sig]) => now.has(f) && now.get(f) !== sig).map(([f]) => f);
    const gone = [...files.keys()].filter((f) => !now.has(f));
    const added = [...now.keys()].filter((f) => !files.has(f));
    const few = (l) => `${l.slice(0, 5).join(', ')}${l.length > 5 ? ` and ${l.length - 5} more` : ''}`;
    if (changed.length) out.push(`changed in the ${kind === 'readonly' ? 'read-only' : 'add-only'} folder "${p}": ${few(changed)}`);
    if (gone.length) out.push(`deleted from the ${kind === 'readonly' ? 'read-only' : 'add-only'} folder "${p}": ${few(gone)}`);
    if (kind === 'readonly' && added.length) out.push(`added to the read-only folder "${p}": ${few(added)}`);
  }
  if (fs.existsSync(snap.dir) && (await settingsBlob(snap.dir)) !== snap.settingsFile) out.push(`${SETTINGS_FILE} changed without the exclusive lock`);
  return out;
}

// ---------- the thread's branch ----------

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '') || 'work';

async function identity(dir) {
  const name = (await git(dir, ['config', 'user.name']).catch(() => '')).trim();
  return name ? [] : ['-c', 'user.name=Claude (Brain app)', '-c', 'user.email=claude@localhost'];
}

async function dirty(dir) {
  return Boolean((await git(dir, ['status', '--porcelain'])).trim());
}

async function currentBranch(dir) {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
}

// Commits what is left in the working copy onto whatever branch is checked out.
async function commitLeftovers(dir, message) {
  if (!(await dirty(dir))) return false;
  await git(dir, ['add', '-A']);
  await git(dir, [...(await identity(dir)), 'commit', '--quiet', '--no-verify', '-m', message]);
  return true;
}

// Something that has to happen before a thread starts in a repo, outside the repo's queue:
// Video Kit hands over what Florian typed in a video repo, as one commit (server/videokit.js).
let beforeOpen = null;
export const onBeforeOpen = (fn) => { beforeOpen = fn; };

// Where a thread's copy of the repo is: its worktree if it has one, otherwise the one copy.
export function dirFor(threadId, full) {
  const wt = worktreeOf(full, threadId);
  return fs.existsSync(path.join(wt, '.git')) ? wt : dirOf(full);
}

const hasRef = (dir, ref) => git(dir, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);

// The thread's branch in each repo it has worked in and not merged yet, by the repo's name:
// `repoBranch` is only the branch in the repo it is in now. '' forgets one (it was merged).
function keepBranch(threadId, full, branch) {
  const { [key(full)]: _was, ...rest } = store.getThread(threadId)?.repoBranches || {};
  return branch ? { ...rest, [key(full)]: branch } : rest;
}

// The thread's branch in a repo: `repoBranch` in the repo it is in now, the kept one in a
// repo it worked in earlier (the same turn, or one before).
export function branchIn(thread, full) {
  if (!thread || !full) return '';
  if (thread.repo && key(thread.repo) === key(full)) return thread.repoBranch || '';
  return thread.repoBranches?.[key(full)] || '';
}
export const isCurrent = (thread, full) => Boolean(thread?.repo && full && key(thread.repo) === key(full));

// The repos whose work goes into main at the end of a turn, in the order the thread opened
// them (`repoShip`), so what must be live first goes first (the app before the vault): every
// repo opened in the turn, not only the one it ended in. One leaves the list once it is
// merged, or has nothing main does not have.
export function shipList(thread) {
  const list = [...(thread?.repoShip || [])];
  if (thread?.repo && !list.some((r) => key(r) === key(thread.repo))) list.push(thread.repo);
  return list;
}
export function addShip(threadId, full) {
  const list = store.getThread(threadId)?.repoShip || [];
  if (list.some((r) => key(r) === key(full))) return;
  store.updateThread(threadId, { repoShip: [...list, full] });
}
export function dropShip(threadId, full) {
  const list = store.getThread(threadId)?.repoShip || [];
  if (!list.some((r) => key(r) === key(full))) return;
  store.updateThread(threadId, { repoShip: list.filter((r) => key(r) !== key(full)) });
}

// Which branch the thread works on, and from what it starts if the branch is not here yet.
//   { branch, from }   from: null (the local branch is there), or the ref to make it from
async function pickBranch(dir, thread, threadId, full, base) {
  let branch = thread.repo && key(thread.repo) === key(full) && thread.repoBranch ? thread.repoBranch : '';
  if (branch && await hasRef(dir, `refs/heads/${branch}`)) return { branch, from: null };
  // The thread's branch may have been made on the other computer and pushed from there.
  if (branch && await hasRef(dir, `refs/remotes/origin/${branch}`)) return { branch, from: `origin/${branch}` };
  const remote = await hasRef(dir, `refs/remotes/origin/${base}`) ? `origin/${base}` : 'HEAD';
  // A thread that worked here, went to another repo and comes back no longer has this
  // repo's branch as `repoBranch`, but the branch is still there, with work main does not
  // have (the turn ended in the other repo, so nothing merged it). It goes on from that
  // work instead of starting over from main and dropping it.
  const unmerged = async (ref) => (await hasRef(dir, ref)) && !(await git(dir, ['merge-base', '--is-ancestor', ref, remote]).then(() => true, () => false));
  // The branch it had here is kept under the repo's name (`repoBranches`), because the
  // thread may have been renamed since: a name made from the title it has now would be a
  // new, empty branch, "nothing to merge", and the work would stay on the old one (55d1,
  // 23-11-2026).
  const kept = thread.repoBranches?.[key(full)] || '';
  if (kept && await unmerged(`refs/heads/${kept}`)) return { branch: kept, from: null };
  if (kept && await unmerged(`refs/remotes/origin/${kept}`)) return { branch: kept, from: `origin/${kept}` };
  branch = `claude/${slug(thread.title)}-${threadId.slice(-4)}`;
  if (await unmerged(`refs/heads/${branch}`)) return { branch, from: null };
  if (await unmerged(`refs/remotes/origin/${branch}`)) return { branch, from: `origin/${branch}` };
  return { branch, from: remote };
}

// The worktrees git knows of this repo, as normalised paths.
async function worktreeList(mainDir) {
  const out = await git(mainDir, ['worktree', 'list', '--porcelain']).catch(() => '');
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => norm(l.slice(9).trim()));
}

// Opens the repo for a thread that holds it: up to date, on the thread's own branch.
// `exclusive`: the turn holds it alone, so the shared folders are open to it.
// `check: false`: the app's own use (testing, merging), not a turn: nothing to check after.
const mainUser = new Map(); // repo key -> the thread that works in the main copy of a parallel repo
// `current: false`: the app's own use of a repo the thread is not in now (ship.js merging the
// work of a repo it left in the same turn): the thread stays in the repo it is in.
export async function openFor(threadId, full, { exclusive = false, check = true, current = true } = {}) {
  const thread = store.getThread(threadId);
  let { dir, base } = await ensure(full);
  if (beforeOpen && (await beforeOpen(full, thread?.title || '').catch(() => null))?.saved?.length) {
    ({ dir, base } = await ensure(full));   // main moved on with that commit: the thread starts from it
  }
  if (!isParallel(full)) {
    // The repo is one thread at a time, but this thread still has a worktree from when it
    // was not: its work goes onto its branch and the worktree goes, so the branch can be
    // checked out in the one copy.
    if (fs.existsSync(worktreeOf(full, threadId))) await dropWorktree(full, threadId);
    return openMain(threadId, full, dir, base, { share: false, current });
  }
  // On demand: the main copy, unless another thread is working there right now; a thread
  // with a worktree keeps it until its branch is merged. Decided before anything waits, so
  // two threads opening at once cannot both take the main copy.
  const k = key(full);
  const user = mainUser.get(k);
  const own = fs.existsSync(path.join(worktreeOf(full, threadId), '.git'));
  const busy = Boolean(user && user !== threadId && holds(full, user));
  if (!own && !busy) mainUser.set(k, threadId);
  const result = own || busy ? await openWorktree(threadId, full, dir, base, { current }) : await openMain(threadId, full, dir, base, { share: true, current });
  if (exclusive && holdsExclusive(full, threadId)) {
    snapshots.delete(threadId);
    const L = lockOf(full);
    if (!L.lifted && protecting() && sharedList(full).some((e) => e.kind !== 'writable')) { unprotectShared(full); L.lifted = true; }
  } else if (check) {
    await snapshot(threadId, full, result.dir);
  }
  return result;
}

// The main copy, on the thread's branch. Whatever the thread before left behind goes onto its own branch.
// What a thread that opened a repo records: the repo it is in now, or only the branch kept.
const openedPatch = (threadId, full, branch, base, current) => (current
  ? { repo: full, repoBranch: branch, repoMain: base, repoBranches: keepBranch(threadId, full, branch) }
  : { repoBranches: keepBranch(threadId, full, branch) });

function openMain(threadId, full, dir, base, { share, current = true }) {
  const thread = store.getThread(threadId);
  return serial(full, async () => {
    const on = await currentBranch(dir);
    const { branch, from } = await pickBranch(dir, thread, threadId, full, base);
    // What is left uncommitted goes onto the branch that is checked out: this thread's own
    // (it opened the repo a second time in one turn), or the one of the thread before.
    if (await dirty(dir)) await commitLeftovers(dir, on === branch && !from ? `Work in progress: ${thread.title}` : 'Work in progress, saved when another thread took the repo');
    if (from) await git(dir, ['checkout', '--quiet', '-B', branch, from]);
    else if (on !== branch) await git(dir, ['checkout', '--quiet', branch]);
    if (share) await linkShared(full, dir);
    store.updateThread(threadId, openedPatch(threadId, full, branch, base, current));
    return { dir, branch, base, worktree: false };
  });
}

async function openWorktree(threadId, full, mainDir, base, { current = true } = {}) {
  const thread = store.getThread(threadId);
  const wt = worktreeOf(full, threadId);
  return serial(full, async () => {
    const { branch, from } = await pickBranch(mainDir, thread, threadId, full, base);
    const known = (await worktreeList(mainDir)).includes(norm(wt));
    if (known && fs.existsSync(path.join(wt, '.git'))) {
      if (from) { await commitLeftovers(wt, `Work in progress: ${thread.title}`); await git(wt, ['checkout', '--quiet', '-B', branch, from]); }
      else if ((await currentBranch(wt)) !== branch) { await commitLeftovers(wt, `Work in progress: ${thread.title}`); await git(wt, ['checkout', '--quiet', branch]); }
    } else {
      // A folder left from a worktree git no longer knows: its links go first, then the folder.
      if (fs.existsSync(wt)) { unlinkShared(wt); fs.rmSync(wt, { recursive: true, force: true }); }
      await git(mainDir, ['worktree', 'prune']).catch(() => {});
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      if (from) await git(mainDir, ['worktree', 'add', '--quiet', '-B', branch, wt, from]);
      else await git(mainDir, ['worktree', 'add', '--quiet', wt, branch]);
      log(`repos: "${thread.title}" got a worktree of its own in ${full}, as another thread works in the main copy`);
    }
    await linkShared(full, wt);
    store.updateThread(threadId, openedPatch(threadId, full, branch, base, current));
    return { dir: wt, branch, base, worktree: true };
  });
}

// A thread's worktree goes (its branch was merged, or the thread was deleted). Its links into
// the shared stores are taken out first, by the app, so nothing deletes through them.
export async function dropWorktree(full, threadId) {
  if (!fs.existsSync(worktreeOf(full, threadId))) return;
  await serial(full, () => removeWorktree(full, threadId));
}

// The same, for code already inside the repo's queue.
async function removeWorktree(full, threadId) {
  const wt = worktreeOf(full, threadId);
  if (!fs.existsSync(wt)) return;
  const mainDir = dirOf(full);
  if (fs.existsSync(path.join(wt, '.git')) && await dirty(wt).catch(() => false)) {
    const t = store.getThread(threadId);
    if (t) await commitLeftovers(wt, `Work in progress: ${t.title}`).catch(() => {});
  }
  unlinkShared(wt);
  await git(mainDir, ['worktree', 'remove', '--force', wt]).catch(() => {});
  if (fs.existsSync(wt)) { unlinkShared(wt); fs.rmSync(wt, { recursive: true, force: true }); }
  await git(mainDir, ['worktree', 'prune']).catch(() => {});
  log(`repos: removed the worktree of "${store.getThread(threadId)?.title || threadId}" in ${full}`);
}

// A deleted thread: its worktrees in every repo go (its branches stay, on GitHub too).
export async function dropWorktrees(threadId) {
  const base = worktreesDir();
  let owners = [];
  try { owners = fs.readdirSync(base); } catch { return; }
  for (const o of owners) {
    let names = [];
    try { names = fs.readdirSync(path.join(base, o)); } catch { continue; }
    for (const n of names) {
      if (fs.existsSync(path.join(base, o, n, String(threadId)))) await dropWorktree(`${o}/${n}`, threadId).catch((err) => log(`repos: could not remove a worktree of ${o}/${n}: ${err.message}`));
    }
  }
}

// At the end of a turn: what Claude did not commit is committed for it, and in a parallel
// repo, what the turn did to the shared folders is checked. A breach is noted on the thread
// (`repoBreach`) and in it, and ship.js does not merge until Florian has answered.
export async function saveWork(threadId) {
  const thread = store.getThread(threadId);
  // Read once: the thread record can change while this waits.
  const { repo: full, repoBranch: branch, title } = thread || {};
  if (!full || !holds(full, threadId)) return;
  const dir = dirFor(threadId, full);
  await serial(full, async () => {
    if (await currentBranch(dir) !== branch) return;
    if (await commitLeftovers(dir, `Work in progress: ${title}`)) log(`repos: committed leftovers of "${title}" in ${full}`);
  }).catch((err) => log(`repos: could not save work in ${full}: ${err.message}`));
  const found = await breaches(threadId).catch((err) => { log(`repos: could not check the shared folders of ${full}: ${err.message}`); return []; });
  if (found.length) {
    const text = found.join('; ');
    store.updateThread(threadId, { repoBreach: `${full}: ${text}` });
    store.appendMessage(threadId, { role: 'user', event: true, auto: true, text: `[The app found that this turn broke the rules of ${full}'s shared folders: ${text}. It does not merge this branch into main until Florian has written in this thread.]` });
    log(`repos: "${title}" broke the shared folders of ${full}: ${text}`);
  }
}

// At the end of a turn, after saveWork: the thread's branch goes to GitHub by itself.
// Only when it has something main does not have and GitHub does not have it yet. Never
// throws: offline, the branch stays here and goes out after the next turn, or with the
// Push button. True when it pushed.
export async function autoPush(threadId) {
  if (config.autoPush === false) return false;
  const { repo: full, repoBranch: branch, repoMain } = store.getThread(threadId) || {};
  if (!full || !branch || !holds(full, threadId)) return false;
  const dir = dirOf(full);
  return serial(full, async () => {
    const has = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then((o) => o.trim(), () => '');
    if (!has) return false;
    const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then((o) => o.trim(), () => '');
    if (remote === has) return false;
    const ahead = Number((await git(dir, ['rev-list', '--count', `origin/${repoMain || 'main'}..${branch}`]).catch(() => '0')).trim());
    if (!ahead && !remote) return false; // a fresh branch with nothing on it yet
    await git(dir, ['push', '--quiet', '-u', 'origin', branch], { timeout: 180_000 });
    log(`repos: pushed ${branch} to ${full} by itself`);
    return true;
  }).catch((err) => { log(`repos: could not push ${branch} of ${full} by itself: ${err.message.split('\n')[0]}`); return false; });
}

// ---------- what Florian sees, and the buttons ----------

const compareUrl = (full, base, branch) => `https://github.com/${full}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;

export async function status(threadId) {
  const thread = store.getThread(threadId);
  if (!thread?.repo) return null;
  const full = thread.repo;
  const dir = dirFor(threadId, full);
  const out = { repo: full, branch: thread.repoBranch || '', main: thread.repoMain || 'main', url: `https://github.com/${full}`, cloned: fs.existsSync(path.join(dirOf(full), '.git')), files: [], commits: [], ahead: 0, pushed: false, uncommitted: false, holder: '', merged: thread.repoMerged || 0, parallel: isParallel(full), lock: lockMode(full) };
  // Who else is in it. In a parallel repo others working side by side do not block this
  // thread, so only an exclusive holder is named.
  const others = holders(full).filter((id) => id !== threadId);
  if (others.length && (!out.parallel || out.lock === 'exclusive')) {
    const held = others[0];
    out.holder = isJob(held) ? `The ${held.slice(4)}` : store.getThread(held)?.title || 'another thread';
    out.holderJob = isJob(held);
  }
  if (out.parallel && others.length) out.alongside = others.length;
  if (!out.cloned || !out.branch) return out;
  return serial(full, async () => {
    const base = `origin/${out.main}`;
    const has = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${out.branch}`]).then(() => true, () => false);
    if (!has) { out.branch = ''; return out; }
    const checkedOut = (await currentBranch(dir)) === out.branch;
    const range = `${base}...${out.branch}`;
    const names = (await git(dir, ['diff', '--name-status', range]).catch(() => '')).trim();
    const files = new Map(names ? names.split('\n').map((l) => { const [st, ...rest] = l.split('\t'); return [rest.at(-1), st[0]]; }) : []);
    if (checkedOut) {
      for (const l of (await git(dir, ['status', '--porcelain'])).split('\n').filter(Boolean)) {
        out.uncommitted = true;
        const name = l.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, '');
        if (!files.has(name)) files.set(name, l.slice(0, 2).includes('?') ? 'A' : l.trim()[0]);
      }
    }
    out.files = [...files].map(([name, st]) => ({ name, status: st }));
    out.commits = (await git(dir, ['log', '--format=%h %s', `${base}..${out.branch}`]).catch(() => '')).trim().split('\n').filter(Boolean).slice(0, 30);
    out.ahead = out.commits.length;
    const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${out.branch}`]).catch(() => '');
    const local = await git(dir, ['rev-parse', out.branch]).catch(() => '');
    out.pushed = Boolean(remote.trim()) && remote.trim() === local.trim();
    out.compare = compareUrl(full, out.main, out.branch);
    return out;
  });
}

export async function fileDiff(threadId, file) {
  const thread = store.getThread(threadId);
  if (!thread?.repo || !thread.repoBranch) return '';
  const dir = dirFor(threadId, thread.repo);
  return serial(thread.repo, async () => {
    const checkedOut = (await currentBranch(dir)) === thread.repoBranch;
    const base = `origin/${thread.repoMain || 'main'}`;
    const mergeBase = (await git(dir, ['merge-base', base, thread.repoBranch]).catch(() => base)).trim();
    // Checked out: against the working copy, so uncommitted changes show too.
    const args = checkedOut ? ['diff', mergeBase, '--', file] : ['diff', `${mergeBase}..${thread.repoBranch}`, '--', file];
    let out = await git(dir, args).catch(() => '');
    const full = path.join(dir, file);
    if (!out.trim() && checkedOut && fs.existsSync(full) && fs.statSync(full).isFile()) {
      // A new file git does not track yet: all of it is added.
      const text = fs.readFileSync(full, 'utf8');
      out = `new file ${file}\n${text.split('\n').map((l) => `+${l}`).join('\n')}`;
    }
    return out.slice(0, 400_000);
  });
}

export async function push(threadId) {
  const thread = store.getThread(threadId);
  if (!thread?.repo || !thread.repoBranch) throw new Error('This thread has no branch to push.');
  if (thread.state === 'working') throw new Error('Claude is still working in this thread. Push when it is done.');
  const dir = dirFor(threadId, thread.repo);
  return serial(thread.repo, async () => {
    if ((await currentBranch(dir)) === thread.repoBranch) await commitLeftovers(dir, `Work in progress: ${thread.title}`);
    await git(dir, ['push', '--quiet', '-u', 'origin', thread.repoBranch], { timeout: 180_000 });
    log(`repos: pushed ${thread.repoBranch} to ${thread.repo}`);
    return compareUrl(thread.repo, thread.repoMain || 'main', thread.repoBranch);
  });
}

// Merges into main go one at a time per repo, also in a parallel repo: ship.js brings the
// branch up to date with main, tests it and merges it inside this, so two branches that each
// pass their tests cannot break main together.
const merging = new Map(); // repo key -> promise
export function withMergeLock(full, fn) {
  const k = key(full);
  const run = (merging.get(k) || Promise.resolve()).then(fn, fn);
  merging.set(k, run.catch(() => {}));
  return run;
}

const CLASH = (base) => `Main has changed in a way that clashes with this branch. Ask Claude in this thread to bring the branch up to date with ${base}, then merge again.`;

// In a parallel repo, before the tests: main as it is now goes into the thread's branch, in
// its worktree, so what is tested is what main will be. A clash stops it (ship.js: a turn fixes it).
export async function catchUp(threadId, { full: which = '', base: main = '' } = {}) {
  const thread = store.getThread(threadId);
  const full = which || thread?.repo;
  const branch = branchIn(thread, full);
  if (!full || !branch || !isParallel(full)) return false;
  const dir = dirFor(threadId, full);
  if ((await currentBranch(dir)) !== branch) return false;
  const base = main || (isCurrent(thread, full) && thread.repoMain) || 'main';
  return serial(full, async () => {
    if (!(await hasRef(dir, `refs/remotes/origin/${base}`))) return false;
    if (await git(dir, ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD']).then(() => true, () => false)) return false;
    try {
      await git(dir, [...(await identity(dir)), 'merge', '--quiet', '--no-edit', '-m', `Bring ${base} into "${thread.title}" before merging`, `origin/${base}`]);
    } catch {
      await git(dir, ['merge', '--abort']).catch(() => {});
      throw new Error(CLASH(base));
    }
    log(`repos: brought ${base} into ${branch} of ${full} before testing it`);
    return true;
  });
}

// The worktree merges are made in, in a parallel repo: never one a thread works in, so a
// merge never moves a thread's files under it. Detached on main as GitHub has it.
async function mergeTree(full, base) {
  const mainDir = dirOf(full);
  const md = path.join(worktreesDir(), ...full.split('/'), '_merge');
  const known = (await worktreeList(mainDir)).includes(norm(md));
  if (known && fs.existsSync(path.join(md, '.git'))) {
    await git(md, ['merge', '--abort']).catch(() => {});
    await git(md, ['reset', '--quiet', '--hard']).catch(() => {});
    await git(md, ['clean', '-fdq']).catch(() => {});
    await git(md, ['checkout', '--quiet', '--detach', `origin/${base}`]);
  } else {
    if (fs.existsSync(md)) { unlinkShared(md); fs.rmSync(md, { recursive: true, force: true }); }
    await git(mainDir, ['worktree', 'prune']).catch(() => {});
    fs.mkdirSync(path.dirname(md), { recursive: true });
    await git(mainDir, ['worktree', 'add', '--quiet', '--detach', md, `origin/${base}`]);
  }
  return md;
}

// Merges the thread's branch into main and pushes main. In a repo of one thread at a time
// this needs the working copy, so the repo must not be in another thread's hands at that
// moment; in a parallel repo it is done in a worktree of its own (mergeTree), and only an
// exclusive holder stops it. `locked`: the caller holds the merge lock already.
// `full`: a repo the thread left earlier (ship.js), instead of the one it is in now.
export async function merge(threadId, { locked = false, full: which = '' } = {}) {
  const thread = store.getThread(threadId);
  const full = which || thread?.repo;
  const current = isCurrent(thread, full);
  if (!full || !branchIn(thread, full)) throw new Error('This thread has no branch to merge.');
  if (thread.state === 'working') throw new Error('Claude is still working in this thread. Merge when it is done.');
  if (!(await acquire(full, threadId, { wait: false, mode: 'shared' }))) throw new Error(`${(holderName(full, threadId) || 'A thread waiting to work in it alone').replace(/^the /, 'The ')} ${holders(full).length ? 'is working' : 'goes first'} in ${full} right now. Merge when it is done.`);
  try {
    const { dir, base } = await ensure(full);
    const parallel = isParallel(full);
    const run = () => serial(full, async () => {
      const branch = branchIn(thread, full);
      const own = dirFor(threadId, full);
      const apart = own !== dir; // the thread has a worktree of its own
      if ((await currentBranch(own)) === branch) await commitLeftovers(own, `Work in progress: ${thread.title}`);
      if (!parallel && (await dirty(dir))) await commitLeftovers(dir, 'Work in progress, saved before a merge');
      const ahead = (await git(dir, ['rev-list', '--count', `origin/${base}..${branch}`])).trim();
      if (ahead === '0') throw new Error('There is nothing on this branch that main does not have.');
      const at = parallel ? await mergeTree(full, base) : dir;
      if (!parallel) await git(dir, ['checkout', '--quiet', '-B', base, `origin/${base}`]);
      try {
        await git(at, [...(await identity(at)), 'merge', '--quiet', '--no-ff', '-m', `Merge "${thread.title}" (${branch})`, branch]);
      } catch {
        await git(at, ['merge', '--abort']).catch(() => {});
        if (!parallel) await git(dir, ['checkout', '--quiet', branch]).catch(() => {});
        throw new Error(CLASH(base));
      }
      await git(at, ['push', '--quiet', 'origin', parallel ? `HEAD:refs/heads/${base}` : base], { timeout: 180_000 });
      if (parallel) await git(dir, ['fetch', '--quiet', 'origin']).catch(() => {});
      const pushed = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(() => true, () => false);
      if (pushed) await git(dir, ['push', '--quiet', 'origin', '--delete', branch]).catch(() => {});
      // The branch goes once nothing has it checked out: its worktree goes, or the main copy
      // goes back to main (only this thread works there while its branch is checked out).
      if (apart) await removeWorktree(full, threadId);
      else if (parallel && (await currentBranch(dir)) === branch) {
        await commitLeftovers(dir, `Work in progress: ${thread.title}`);
        await git(dir, ['checkout', '--quiet', '-B', base, `origin/${base}`]);
      }
      await git(dir, ['branch', '-D', branch]).catch(() => {});
      store.updateThread(threadId, current
        ? { repoBranch: '', repoMerged: Date.now(), repoBranches: keepBranch(threadId, full, '') }
        : { repoBranches: keepBranch(threadId, full, '') });
      log(`repos: merged ${branch} into ${full} ${base}`);
      return { base };
    });
    return await (locked || !parallel ? run() : withMergeLock(full, run));
  } finally {
    release(full, threadId);
  }
}

// ---------- GitHub itself: renaming, creating, describing ----------

let cachedToken = null;
function token() {
  if (config.github.token) return Promise.resolve(config.github.token);
  if (cachedToken) return Promise.resolve(cachedToken);
  // The token git already uses on this machine, from its credential helper.
  return new Promise((resolve) => {
    const child = spawn('git', ['credential', 'fill'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(''));
    child.on('close', () => { cachedToken = /^password=(.+)$/m.exec(out)?.[1].trim() || ''; resolve(cachedToken); });
    child.stdin.end('protocol=https\nhost=github.com\n\n');
    setTimeout(() => child.kill(), 8000);
  });
}

async function github(method, url, body) {
  if (config.fake && process.env.APP_AI_FAKE_GITHUB === '1') return fakeGithub(method, url, body);
  const t = await token();
  if (!t) throw new Error('No GitHub token on this machine. Add "github": { "token": "…" } to config.json (docs/repos.md).');
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub said ${res.status}: ${data.message || 'no reason given'}${res.status === 403 || res.status === 404 ? ' (does the token have the right to do that?)' : ''}`);
  return data;
}

// For ship.js: GitHub's answer as JSON, or as text (a job's log).
export const githubApi = (method, url, body) => github(method, url, body);
export async function githubText(url) {
  if (config.fake && process.env.APP_AI_FAKE_GITHUB === '1') return String(fakeGithub('GET', url) || '');
  const t = await token();
  if (!t) throw new Error('No GitHub token on this machine.');
  // GitHub answers with a redirect to the file; fetch follows it and drops the token there.
  const res = await fetch(`https://api.github.com${url}`, { headers: { Authorization: `Bearer ${t}`, 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return res.text();
}

let listCache = { at: 0, names: [] };
export async function list() {
  const here = [];
  try {
    for (const o of fs.readdirSync(config.reposDir)) for (const n of fs.readdirSync(path.join(config.reposDir, o))) here.push(`${o}/${n}`);
  } catch { /* none cloned yet */ }
  if (Date.now() - listCache.at > 10 * 60_000) {
    try {
      const repos = await github('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator');
      listCache = { at: Date.now(), names: repos.map((r) => r.full_name) };
    } catch { listCache = { at: Date.now(), names: listCache.names } }
  }
  return [...new Set([...listCache.names, ...here])];
}

// Renames a repo on GitHub and everywhere the app knows it: its copy, the threads that
// work in it, the brain and the app's own data if it is one of those.
export async function rename(fromInput, toName) {
  const from = repoName(fromInput);
  if (!from) throw new Error(`"${fromInput}" is not a repo name.`);
  const name = String(toName || '').trim();
  if (!/^[\w.-]+$/.test(name)) throw new Error(`"${toName}" is not a valid repo name: letters, digits, "-", "_" and "." only.`);
  const k = key(from);
  const data = await github('PATCH', `/repos/${from}`, { name });
  const to = data.full_name || `${from.split('/')[0]}/${name}`;
  await serial(from, async () => {
    const was = dirOf(from);
    if (fs.existsSync(was)) {
      fs.mkdirSync(path.dirname(dirOf(to)), { recursive: true });
      fs.renameSync(was, dirOf(to));
      await git(dirOf(to), ['remote', 'set-url', 'origin', remoteUrl(to)]).catch(() => {});
    }
    // Worktrees and the shared store move along; git is told where its worktrees are now.
    const wtWas = path.join(worktreesDir(), ...from.split('/'));
    if (fs.existsSync(wtWas)) {
      const wtTo = path.join(worktreesDir(), ...to.split('/'));
      fs.mkdirSync(path.dirname(wtTo), { recursive: true });
      fs.renameSync(wtWas, wtTo);
      const moved = fs.readdirSync(wtTo).map((n) => path.join(wtTo, n));
      if (moved.length) await git(dirOf(to), ['worktree', 'repair', ...moved]).catch((err) => log(`repos: could not repair the worktrees of ${to}: ${err.message}`));
    }
    if (fs.existsSync(sharedRoot(from))) {
      fs.mkdirSync(path.dirname(sharedRoot(to)), { recursive: true });
      fs.renameSync(sharedRoot(from), sharedRoot(to));
      // The links inside point to the old place: made again the next time a thread opens it.
      for (const d of [dirOf(to), ...(fs.existsSync(path.join(worktreesDir(), ...to.split('/'))) ? fs.readdirSync(path.join(worktreesDir(), ...to.split('/'))).map((n) => path.join(worktreesDir(), ...to.split('/'), n)) : [])]) unlinkShared(d);
    }
  });
  if (locks.has(k)) { const L = locks.get(k); L.full = to; locks.set(key(to), L); locks.delete(k); }
  if (settings.has(k)) { settings.set(key(to), settings.get(k)); settings.delete(k); }
  for (const t of store.listThreads()) {
    const patch = {};
    if (t.repo && key(t.repo) === k) patch.repo = to;
    if (t.repoBranches?.[k]) { const { [k]: branch, ...rest } = t.repoBranches; patch.repoBranches = { ...rest, [key(to)]: branch }; }
    if (t.repoShip?.some((r) => key(r) === k)) patch.repoShip = t.repoShip.map((r) => (key(r) === k ? to : r));
    if (Object.keys(patch).length) store.updateThread(t.id, patch);
  }
  // The brain and the app's data are repos too. GitHub forwards the old address, but the
  // clones are pointed at the new one so nothing depends on that.
  for (const field of ['brainRepo', 'dataRepo']) {
    if (config[field] && repoName(config[field]) && key(repoName(config[field])) === k) {
      const dir = field === 'brainRepo' ? config.brainDir : null;
      config[field] = `https://github.com/${to}.git`;
      if (dir) await git(dir, ['remote', 'set-url', 'origin', config[field]]).catch(() => {});
    }
  }
  log(`repos: renamed ${from} to ${to}`);
  return to;
}

export async function create(name, { isPrivate = true, description = '' } = {}) {
  if (!/^[\w.-]+$/.test(String(name || ''))) throw new Error(`"${name}" is not a valid repo name.`);
  const data = await github('POST', '/user/repos', { name, private: isPrivate !== false, description: String(description || ''), auto_init: true });
  listCache.at = 0;
  log(`repos: created ${data.full_name}`);
  return data.full_name;
}

export async function describe(input, description) {
  const full = repoName(input);
  if (!full) throw new Error(`"${input}" is not a repo name.`);
  await github('PATCH', `/repos/${full}`, { description: String(description || '') });
  return full;
}

// For the tests: GitHub played by the bare repos under repoBase on disk.
function fakeGithub(method, url, body) {
  const baseDir = config.repoBase;
  const m = /^\/repos\/([^/]+)\/([^/?]+)$/.exec(url);
  if (method === 'PATCH' && m && body.name) {
    fs.renameSync(path.join(baseDir, m[1], `${m[2]}.git`), path.join(baseDir, m[1], `${body.name}.git`));
    return { full_name: `${m[1]}/${body.name}` };
  }
  if (method === 'PATCH' && m) return { full_name: `${m[1]}/${m[2]}` };
  if (method === 'POST' && url === '/user/repos') {
    const o = owner();
    fs.mkdirSync(path.join(baseDir, o), { recursive: true });
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', path.join(baseDir, o, `${body.name}.git`)], { windowsHide: true, stdio: 'ignore' });
    return { full_name: `${o}/${body.name}` };
  }
  if (method === 'GET' && url.startsWith('/user/repos')) {
    const o = owner();
    return fs.readdirSync(path.join(baseDir, o)).filter((n) => n.endsWith('.git')).map((n) => ({ full_name: `${o}/${n.slice(0, -4)}` }));
  }
  // GitHub Actions: what a test writes into <repo>.checks.json under repoBase is the run of
  // that repo's tests, { conclusion, log }; without the file no run has started.
  const runs = /^\/repos\/([^/]+)\/([^/]+)\/commits\/[^/]+\/check-runs/.exec(url);
  const jobLog = /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/\d+\/logs$/.exec(url);
  if (method === 'GET' && (runs || jobLog)) {
    const [, o, r] = runs || jobLog;
    let played = null;
    try { played = JSON.parse(fs.readFileSync(path.join(baseDir, o, `${r}.checks.json`), 'utf8')); } catch { /* no run */ }
    if (jobLog) return played?.log || '';
    if (!played) return { total_count: 0, check_runs: [] };
    return { total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: played.conclusion, html_url: `https://github.com/${o}/${r}/actions/runs/1/job/1` }] };
  }
  throw new Error(`fake GitHub: ${method} ${url} is not played`);
}

// Threads whose branch has commits that are not on GitHub: work that stays on this computer.
// A thread still working, or whose branch is being tested and merged (`busy`), is not
// counted: the end of its turn pushes the branch by itself, so that work is only here for
// a moment, not left behind.
export async function unpushed({ busy = () => false } = {}) {
  const out = [];
  for (const t of store.listThreads()) {
    if (!t.repo || !t.repoBranch || t.archived) continue;
    if (t.state === 'working' || busy(t.id)) continue;
    const dir = dirOf(t.repo);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const onGithub = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${t.repoBranch}`]).then(() => true, () => false);
    const ahead = Number((await git(dir, ['rev-list', '--count', onGithub ? `origin/${t.repoBranch}..${t.repoBranch}` : `origin/${t.repoMain || 'main'}..${t.repoBranch}`]).catch(() => '0')).trim());
    if (ahead > 0) out.push({ id: t.id, title: t.title, repo: t.repo, commits: ahead });
  }
  return out;
}
