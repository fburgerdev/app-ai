// Git repositories threads work in.
//
// Any thread can work in any of Florian's repos. A repo is cloned the first time a thread
// uses it and brought up to date each time one does. There is one copy of each repo, and
// only one thread works in it at a time: a thread holds the repo while its turn runs, and
// any other thread that wants it waits until that turn has ended.
//
// Each thread works on a branch of its own, made from the repo's main branch. When a turn
// ends, whatever Claude left uncommitted is committed onto that branch, so the copy is
// clean for the next thread, and the branch is pushed to GitHub (`autoPush`, on by
// default), so the work never sits on one computer only. Merging into main is Florian's:
// the button in the thread.
//
// Managing repos themselves (renaming, creating, describing) goes through GitHub's API
// with the token the machine already uses for git, or `github.token` in config.json.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DATA_DIR, log } from './config.js';
import { git } from './git.js';
import * as store from './store.js';

let config;
export function initRepos(cfg) {
  config = cfg;
  if (!config.reposDir) config.reposDir = path.join(DATA_DIR, 'repos');
  fs.mkdirSync(config.reposDir, { recursive: true });
}

const locks = new Map(); // repo key -> thread id holding it
const waiters = new Map(); // repo key -> [resolve]
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
    return { dir, base: await defaultBranch(dir) };
  });
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

// ---------- one thread at a time ----------

export const holder = (full) => locks.get(key(full)) || null;
export const holderTitle = (full) => store.getThread(holder(full))?.title || 'another thread';
// For Video Kit (server/videokit.js): its git work on a repo goes in the same queue as the threads'.
export const serialFor = (full, fn) => serial(full, fn);
export const identityFor = (dir) => identity(dir);

// A job of the app itself can hold a repo too, under a name of its own: the brain update
// holds the vault's repo while it writes, so no thread changes the vault meanwhile.
export const jobHolder = (name) => `job:${name}`;
const isJob = (id) => String(id || '').startsWith('job:');
// A thread that no longer exists holds nothing; a job holds until it gives the repo back.
const alive = (id) => isJob(id) || Boolean(store.getThread(id));

// Who holds the repo, as a sentence can name it: "Tidy the server code" (quoted, a
// thread) or the brain update (a job). Empty when nobody does.
export function holderName(full) {
  const id = holder(full);
  if (!id) return '';
  return isJob(id) ? `the ${id.slice(4)}` : `"${store.getThread(id)?.title || 'another thread'}"`;
}

// Takes the repo for a thread (or a job). With `wait`, waits until it is free; without, gives up.
// With `timeoutMs`, gives up after that long and leaves the queue, so the repo is not
// handed later to someone who stopped waiting (and would then hold it with nobody to give
// it back).
export function acquire(full, threadId, { wait = true, timeoutMs = 0 } = {}) {
  const k = key(full);
  const held = locks.get(k);
  if (!held || held === threadId || !alive(held)) {
    locks.set(k, threadId);
    return Promise.resolve(true);
  }
  if (!wait) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    const take = () => { clearTimeout(timer); locks.set(k, threadId); resolve(true); };
    waiters.set(k, [...(waiters.get(k) || []), take]);
    if (timeoutMs) {
      timer = setTimeout(() => {
        waiters.set(k, (waiters.get(k) || []).filter((w) => w !== take));
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

export function release(full, threadId) {
  const k = key(full);
  if (locks.get(k) !== threadId) return;
  locks.delete(k);
  const next = (waiters.get(k) || []).shift();
  if (next) next();
}

// Everything a thread holds, given back (its turn ended, or it was deleted).
export function releaseAll(threadId) {
  for (const [k, id] of [...locks]) if (id === threadId) release(k, threadId);
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

// Opens the repo for a thread that holds it: up to date, on the thread's own branch.
export async function openFor(threadId, full) {
  const thread = store.getThread(threadId);
  let { dir, base } = await ensure(full);
  if (beforeOpen && (await beforeOpen(full, thread?.title || '').catch(() => null))?.saved?.length) {
    ({ dir, base } = await ensure(full));   // main moved on with that commit: the thread starts from it
  }
  return serial(full, async () => {
    // Whatever the thread before left behind goes onto its own branch.
    const on = await currentBranch(dir);
    if (await dirty(dir)) await commitLeftovers(dir, `Work in progress, saved when another thread took the repo`);
    let branch = thread.repo && key(thread.repo) === key(full) && thread.repoBranch ? thread.repoBranch : '';
    const exists = branch && (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false));
    // The thread's branch may have been made on the other computer and pushed from there.
    const pushed = branch && !exists && (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(() => true, () => false));
    if (pushed) {
      await git(dir, ['checkout', '--quiet', '-B', branch, `origin/${branch}`]);
    } else if (!exists) {
      branch = `claude/${slug(thread.title)}-${threadId.slice(-4)}`;
      const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).then(() => `origin/${base}`, () => 'HEAD');
      // A thread that worked here, went to another repo and comes back no longer knows
      // its branch, but the branch is still there, with work main does not have (the
      // turn ended in the other repo, so nothing merged it). It goes on from that work
      // instead of starting over from main and dropping it.
      const unmerged = async (ref) => (await git(dir, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false))
        && !(await git(dir, ['merge-base', '--is-ancestor', ref, remote]).then(() => true, () => false));
      if (await unmerged(`refs/heads/${branch}`)) await git(dir, ['checkout', '--quiet', branch]);
      else if (await unmerged(`refs/remotes/origin/${branch}`)) await git(dir, ['checkout', '--quiet', '-B', branch, `origin/${branch}`]);
      else await git(dir, ['checkout', '--quiet', '-B', branch, remote]);
    } else if (on !== branch) {
      await git(dir, ['checkout', '--quiet', branch]);
    }
    store.updateThread(threadId, { repo: full, repoBranch: branch, repoMain: base });
    return { dir, branch, base };
  });
}

// At the end of a turn: what Claude did not commit is committed for it.
export async function saveWork(threadId) {
  const thread = store.getThread(threadId);
  // Read once: the thread record can change while this waits.
  const { repo: full, repoBranch: branch, title } = thread || {};
  if (!full || holder(full) !== threadId) return;
  const dir = dirOf(full);
  await serial(full, async () => {
    if (await currentBranch(dir) !== branch) return;
    if (await commitLeftovers(dir, `Work in progress: ${title}`)) log(`repos: committed leftovers of "${title}" in ${full}`);
  }).catch((err) => log(`repos: could not save work in ${full}: ${err.message}`));
}

// At the end of a turn, after saveWork: the thread's branch goes to GitHub by itself.
// Only when it has something main does not have and GitHub does not have it yet. Never
// throws: offline, the branch stays here and goes out after the next turn, or with the
// Push button. True when it pushed.
export async function autoPush(threadId) {
  if (config.autoPush === false) return false;
  const { repo: full, repoBranch: branch, repoMain } = store.getThread(threadId) || {};
  if (!full || !branch || holder(full) !== threadId) return false;
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
  const dir = dirOf(full);
  const out = { repo: full, branch: thread.repoBranch || '', main: thread.repoMain || 'main', url: `https://github.com/${full}`, cloned: fs.existsSync(path.join(dir, '.git')), files: [], commits: [], ahead: 0, pushed: false, uncommitted: false, holder: '', merged: thread.repoMerged || 0 };
  const held = holder(full);
  if (held && held !== threadId) {
    out.holder = isJob(held) ? `The ${held.slice(4)}` : store.getThread(held)?.title || 'another thread';
    out.holderJob = isJob(held);
  }
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
  const dir = dirOf(thread.repo);
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
  const dir = dirOf(thread.repo);
  return serial(thread.repo, async () => {
    if ((await currentBranch(dir)) === thread.repoBranch) await commitLeftovers(dir, `Work in progress: ${thread.title}`);
    await git(dir, ['push', '--quiet', '-u', 'origin', thread.repoBranch], { timeout: 180_000 });
    log(`repos: pushed ${thread.repoBranch} to ${thread.repo}`);
    return compareUrl(thread.repo, thread.repoMain || 'main', thread.repoBranch);
  });
}

// Merges the thread's branch into main and pushes main. Needs the working copy, so the
// repo must not be in another thread's hands at that moment.
export async function merge(threadId) {
  const thread = store.getThread(threadId);
  if (!thread?.repo || !thread.repoBranch) throw new Error('This thread has no branch to merge.');
  if (thread.state === 'working') throw new Error('Claude is still working in this thread. Merge when it is done.');
  const full = thread.repo;
  if (!(await acquire(full, threadId, { wait: false }))) throw new Error(`${holderName(full).replace(/^the /, 'The ')} is working in ${full} right now. Merge when it is done.`);
  try {
    const { dir, base } = await ensure(full);
    return await serial(full, async () => {
      const branch = thread.repoBranch;
      if ((await currentBranch(dir)) === branch) await commitLeftovers(dir, `Work in progress: ${thread.title}`);
      else if (await dirty(dir)) await commitLeftovers(dir, 'Work in progress, saved before a merge');
      const ahead = (await git(dir, ['rev-list', '--count', `origin/${base}..${branch}`])).trim();
      if (ahead === '0') throw new Error('There is nothing on this branch that main does not have.');
      await git(dir, ['checkout', '--quiet', '-B', base, `origin/${base}`]);
      try {
        await git(dir, [...(await identity(dir)), 'merge', '--quiet', '--no-ff', '-m', `Merge "${thread.title}" (${branch})`, branch]);
      } catch {
        await git(dir, ['merge', '--abort']).catch(() => {});
        await git(dir, ['checkout', '--quiet', branch]).catch(() => {});
        throw new Error(`Main has changed in a way that clashes with this branch. Ask Claude in this thread to bring the branch up to date with ${base}, then merge again.`);
      }
      await git(dir, ['push', '--quiet', 'origin', base], { timeout: 180_000 });
      const pushed = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(() => true, () => false);
      if (pushed) await git(dir, ['push', '--quiet', 'origin', '--delete', branch]).catch(() => {});
      await git(dir, ['branch', '-D', branch]).catch(() => {});
      store.updateThread(threadId, { repoBranch: '', repoMerged: Date.now() });
      log(`repos: merged ${branch} into ${full} ${base}`);
      return { base };
    });
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
  });
  if (locks.has(k)) { locks.set(key(to), locks.get(k)); locks.delete(k); }
  for (const t of store.listThreads()) if (t.repo && key(t.repo) === k) store.updateThread(t.id, { repo: to });
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
