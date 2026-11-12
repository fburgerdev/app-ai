// Git repositories threads work in.
//
// Any thread can work in any of Florian's repos. A repo is cloned the first time a thread
// uses it and brought up to date each time one does. There is one copy of each repo, and
// only one thread works in it at a time: a thread holds the repo while its turn runs, and
// any other thread that wants it waits until that turn has ended.
//
// Each thread works on a branch of its own, made from the repo's main branch. When a turn
// ends, whatever Claude left uncommitted is committed onto that branch, so the copy is
// clean for the next thread. Nothing leaves the machine on its own: Florian pushes, opens
// a pull request or merges into main with the buttons in the thread.
//
// Managing repos themselves (renaming, creating, describing) goes through GitHub's API
// with the token the machine already uses for git, or `github.token` in config.json.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    return { dir, base: await defaultBranch(dir) };
  });
}

// ---------- one thread at a time ----------

export const holder = (full) => locks.get(key(full)) || null;

// Takes the repo for a thread. With `wait`, waits until it is free; without, gives up.
export function acquire(full, threadId, { wait = true } = {}) {
  const k = key(full);
  const held = locks.get(k);
  if (!held || held === threadId || !store.getThread(held)) {
    locks.set(k, threadId);
    return Promise.resolve(true);
  }
  if (!wait) return Promise.resolve(false);
  return new Promise((resolve) => {
    waiters.set(k, [...(waiters.get(k) || []), () => { locks.set(k, threadId); resolve(true); }]);
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

// Opens the repo for a thread that holds it: up to date, on the thread's own branch.
export async function openFor(threadId, full) {
  const thread = store.getThread(threadId);
  const { dir, base } = await ensure(full);
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
      await git(dir, ['checkout', '--quiet', '-B', branch, remote]);
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

// ---------- what Florian sees, and the buttons ----------

const compareUrl = (full, base, branch) => `https://github.com/${full}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;

export async function status(threadId) {
  const thread = store.getThread(threadId);
  if (!thread?.repo) return null;
  const full = thread.repo;
  const dir = dirOf(full);
  const out = { repo: full, branch: thread.repoBranch || '', main: thread.repoMain || 'main', url: `https://github.com/${full}`, cloned: fs.existsSync(path.join(dir, '.git')), files: [], commits: [], ahead: 0, pushed: false, uncommitted: false, holder: '', merged: thread.repoMerged || 0 };
  const held = holder(full);
  if (held && held !== threadId) out.holder = store.getThread(held)?.title || 'another thread';
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
  if (!(await acquire(full, threadId, { wait: false }))) throw new Error(`The thread "${store.getThread(holder(full))?.title}" is working in ${full} right now. Merge when it is done.`);
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
  if (method === 'GET' && url.startsWith('/user/repos')) {
    const o = owner();
    return fs.readdirSync(path.join(baseDir, o)).filter((n) => n.endsWith('.git')).map((n) => ({ full_name: `${o}/${n.slice(0, -4)}` }));
  }
  throw new Error(`fake GitHub: ${method} ${url} is not played`);
}

// Threads whose branch has commits that are not on GitHub: work that stays on this computer.
export async function unpushed() {
  const out = [];
  for (const t of store.listThreads()) {
    if (!t.repo || !t.repoBranch || t.archived) continue;
    const dir = dirOf(t.repo);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const onGithub = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${t.repoBranch}`]).then(() => true, () => false);
    const ahead = Number((await git(dir, ['rev-list', '--count', onGithub ? `origin/${t.repoBranch}..${t.repoBranch}` : `origin/${t.repoMain || 'main'}..${t.repoBranch}`]).catch(() => '0')).trim());
    if (ahead > 0) out.push({ id: t.id, title: t.title, repo: t.repo, commits: ahead });
  }
  return out;
}
