// Video Kit, the review player for Florian's YouTube videos (repo fburgerdev/app-ytvideo-kit),
// runs alongside the app: started with it on http://localhost:4400, started again if it stops.
//
// It shows every video repo the app manages (`ytvideo-*`): the app clones the ones not on this
// computer yet and, while no thread works in one, keeps its copy on main and up to date, so
// what Video Kit shows is what GitHub has. Florian's script edits and comments in Video Kit are
// saved through the app (POST /api/videokit/save): committed onto main and pushed, after the
// thread working in that repo, if any, has finished its turn. Video Kit never writes into a
// copy a thread might be using.
//
// Florian, 18-11-2026: "i want the video-kit to start alongside the app-ai, so that its always
// running when i want to open it. also, it should detect all repos that are ytvideos that are
// managed by app-ai."

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, log } from './config.js';
import { git } from './git.js';
import * as repos from './repos.js';

const KIT = 'app-ytvideo-kit';
export const isVideoRepo = (full) => /^[\w.-]+\/ytvideo-[\w.-]+$/i.test(String(full || ''));

let config;
let child = null;
let stopped = false;
let restarts = 0;
let restartNow = false;   // a new version is there: start again at once, not after a pause

// Video Kit runs from a copy of its own, not from the repo copy threads work in: that one is on
// whichever thread's branch worked last. This copy is always GitHub's main, and is brought up to
// date every few minutes; when main has moved on, Video Kit is started again on the new code.
// Florian, 18-11-2026: "make sure the auto update of app-ai also update the video-kit".
const RUN_DIR = () => config.videoKit?.dir || path.join(DATA_DIR, 'videokit');
const CHECK_MS = 3 * 60_000;

const owner = () => config.github?.owner || 'fburgerdev';
const kitPort = () => Number(config.videoKit?.port) || 4400;
export const videoKitUrl = () => `http://localhost:${kitPort()}`;

export function initVideoKit(cfg) {
  config = cfg;
  repos.onBeforeOpen((full, title) => handover(full, title));
  if (config.fake || config.videoKit?.enabled === false) return;
  // A little after the start, so cloning does not slow the app's own start down.
  setTimeout(() => { start().catch((err) => log(`video kit: could not start: ${err.message}`)); }, 3000).unref?.();
  setInterval(() => { syncVideoRepos().catch((err) => log(`video kit: syncing the video repos failed: ${err.message}`)); }, 10 * 60_000).unref?.();
  setInterval(() => { updateKit().catch((err) => log(`video kit: could not look for a new version: ${err.message}`)); }, CHECK_MS).unref?.();
  process.on('exit', () => { stopped = true; child?.kill(); });
}

// For the tests: the settings, without starting anything.
export function _configure(cfg) { config = cfg; }

async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${kitPort()}/api/projects`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

// The copy Video Kit runs from, cloned if missing and set to GitHub's main. True when it changed.
let updating = null;
export function updateKit() {
  updating ||= (async () => {
    const dir = RUN_DIR();
    const url = `${config.repoBase.replace(/\/$/, '')}/${owner()}/${KIT}.git`;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(path.dirname(dir), ['clone', '--quiet', url, dir], { timeout: 300_000 });
      log(`video kit: cloned into ${dir}`);
      return true;
    }
    await git(dir, ['fetch', '--quiet', '--prune', 'origin'], { timeout: 120_000 });
    await git(dir, ['remote', 'set-head', 'origin', '--auto']).catch(() => {});
    const base = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).trim();
    const want = (await git(dir, ['rev-parse', base])).trim();
    const have = (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim();
    if (want === have) return false;
    // Nobody works in this copy: it is set to main outright.
    await git(dir, ['checkout', '--quiet', '--force', '-B', base.replace(/^origin\//, ''), base]);
    await git(dir, ['clean', '-fdq']).catch(() => {});
    log(`video kit: updated to ${want.slice(0, 7)}`);
    if (child) { restartNow = true; child.kill(); }
    return true;
  })().finally(() => { updating = null; });
  return updating;
}

async function start() {
  if (stopped || child) return;
  await updateKit().catch((err) => log(`video kit: could not update its copy: ${err.message}`));
  const dir = RUN_DIR();
  const full = `${owner()}/${KIT}`;
  await syncVideoRepos().catch((err) => log(`video kit: syncing the video repos failed: ${err.message}`));
  if (await alreadyRunning()) {
    // Started by hand (start.cmd): left alone, and looked at again later in case it is closed.
    setTimeout(() => start().catch(() => {}), 5 * 60_000).unref?.();
    return;
  }
  if (!fs.existsSync(path.join(dir, 'server.mjs'))) throw new Error(`${full} has no server.mjs`);
  child = spawn(process.execPath, ['server.mjs', '--no-open'], {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PORT: String(kitPort()),
      YTKIT_ROOTS: path.join(config.reposDir, owner()),
      YTKIT_ONLY: 'ytvideo-',
      YTKIT_APPAI: `http://127.0.0.1:${config.port}`,
    },
  });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const at = Date.now();
  log(`video kit: running at ${videoKitUrl()}`);
  child.on('exit', (code) => {
    child = null;
    if (stopped) return;
    if (restartNow) {
      restartNow = false;
      log('video kit: starting again on the new version');
      setTimeout(() => start().catch((e) => log(`video kit: could not start: ${e.message}`)), 500).unref?.();
      return;
    }
    if (Date.now() - at > 10 * 60_000) restarts = 0;
    restarts += 1;
    const wait = Math.min(10 * 60_000, 5000 * 2 ** Math.min(restarts, 7));
    log(`video kit: stopped (${code})${err ? `: ${err.trim().split('\n').at(-1)}` : ''}; starting again in ${Math.round(wait / 1000)} s`);
    setTimeout(() => start().catch((e) => log(`video kit: could not start: ${e.message}`)), wait).unref?.();
  });
}

// Every ytvideo repo of Florian's is cloned, and the copies no thread holds are brought to main.
let syncing = null;
export function syncVideoRepos() {
  syncing ||= (async () => {
    const names = (await repos.list().catch(() => [])).filter(isVideoRepo);
    for (const full of names) {
      try { await refresh(full); } catch (err) { log(`video kit: ${full}: ${err.message}`); }
    }
    return names;
  })().finally(() => { syncing = null; });
  return syncing;
}

// Brings a video repo's copy to GitHub's main, unless a thread works in it or it holds changes
// nobody committed (those are a thread's and wait for it). Says who holds it, if anyone.
export async function refresh(full) {
  if (!isVideoRepo(full)) throw new Error(`${full} is not a video repo`);
  if (repos.holder(full)) return { held: repos.holderTitle(full) };
  const { dir, base } = await repos.ensure(full);
  return repos.serialFor(full, async () => {
    if (repos.holder(full)) return { held: repos.holderTitle(full) };
    if ((await git(dir, ['status', '--porcelain'])).trim()) return { held: null, dirty: true };
    const has = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).then(() => true, () => false);
    if (has) await git(dir, ['checkout', '--quiet', '-B', base, `origin/${base}`]);
    return { held: null };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Florian, 20-11-2026: "when claude edits, its one diff state to save, but when i edit dont save
// every single time i do a change, only, the moment claude steps in again, take a snapshot", and
// "claude can lock the editing for a moment while it is changing things and then release".
// So Video Kit keeps what he types and saves nothing as he types. When a thread opens a video repo,
// before it gets its branch, the app asks Video Kit for it (POST /api/handover): Video Kit saves
// all of it as one commit (a save with handover: true, let through although the thread holds the
// repo already) and locks the writing; it asks GET /api/videokit/held until the thread is done.
const handingOver = new Set();
const lower = (full) => String(full || '').toLowerCase();
export const handingOverTo = (full) => handingOver.has(lower(full));

// Who holds a video repo, for Video Kit's lock: { held: title or null, handover: true }.
export function held(full) {
  if (!isVideoRepo(full)) throw new Error(`${full} is not a video repo`);
  return { held: repos.holder(full) ? repos.holderTitle(full) : null, handover: true };
}

// Before a thread starts in a video repo. Never throws: without Video Kit, nothing is kept there.
export async function handover(full, by) {
  if (!isVideoRepo(full) || !config || config.videoKit?.enabled === false) return null;
  if (config.fake && !config.videoKit?.port) return null;   // the tests' app: no Video Kit of this computer's
  handingOver.add(lower(full));
  try {
    const r = await fetch(`http://127.0.0.1:${kitPort()}/api/handover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: full, by }),
      signal: AbortSignal.timeout(120_000),
    });
    if (r.status === 404) return null;                       // a Video Kit from before snapshots
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { log(`video kit: handing ${full} over to "${by}" failed: ${j.error || r.status}`); return null; }
    if (j.saved?.length) log(`video kit: Florian's edits in ${full} saved as one commit before "${by}" (${j.commit || 'no commit'})`);
    if (j.error) log(`video kit: Florian's edits in ${full} could not be saved before "${by}", they stay kept in Video Kit: ${j.error}`);
    return j;
  } catch (err) {
    if (!/ECONNREFUSED|fetch failed/i.test(`${err.message} ${err.cause?.code || ''}`)) log(`video kit: handing ${full} over to "${by}": ${err.message}`);
    return null;
  } finally {
    handingOver.delete(lower(full));
  }
}

// What Video Kit typed was typed against the copy as it was when the save was asked for. If one of
// its files changed on main since (a thread merged while this waited, or GitHub moved on before a
// push went through), writing it whole would take that change out again: on 19-11-2026 a save of
// the EA video's script, waiting for a thread, landed 11 s after the thread's merge and reverted
// it. So such a save is refused; Video Kit puts the two together and asks again.
export class StaleError extends Error {
  constructor(paths) {
    super(`changed on main while this save waited (${paths.join(', ')}); Video Kit puts the two together and saves again`);
    this.code = 409;
    this.stale = true;
    this.paths = paths;
  }
}

// The commit the copy stood at, which is what Video Kit read: its main, or GitHub's main as last fetched.
async function standing(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const base = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).trim().replace(/^origin\//, '');
  const onMain = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((o) => o.trim() === base, () => false);
  const ref = onMain ? 'HEAD' : `refs/remotes/origin/${base}`;
  return (await git(dir, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '')).trim() || null;
}

// The files of the save that differ between the commit Video Kit read and the one about to be written on.
async function changedSince(dir, from, to, list) {
  if (!from) return [];
  const known = await git(dir, ['cat-file', '-e', `${from}^{commit}`]).then(() => true, () => false);
  if (!known) return list.map((f) => f.path);          // not a commit of this repo: nothing to go by
  const out = await git(dir, ['diff', '--name-only', from, to, '--', ...list.map((f) => f.path)]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Saves files from Video Kit into a video repo: onto main, one commit, pushed. Waits while a
// thread works in the repo. `files` are [{ path, content }] relative to the repo; content null
// deletes the file. `from` is the commit Video Kit read them against; left out, the commit the
// copy stood at when the save came in. A file changed on main since then is not written over
// (StaleError).
export async function save(full, files, message, { waitMs = 30 * 60_000, from = null, handover: handing = false } = {}) {
  if (!isVideoRepo(full)) throw new Error(`${full} is not a video repo`);
  const list = (files || []).map((f) => ({ path: String(f?.path || '').replace(/\\/g, '/'), content: f?.content ?? null }));
  for (const f of list) {
    if (!f.path || f.path.startsWith('/') || /^[a-z]:/i.test(f.path) || f.path.split('/').some((p) => p === '..' || p === '.' || p === '.git' || p === '')) throw new Error(`not a file in the repo: ${f.path}`);
    if (f.content !== null && typeof f.content !== 'string') throw new Error(`no text for ${f.path}`);
  }
  if (!list.length) return { commit: null };
  if (from !== null && !/^[0-9a-f]{4,40}$/i.test(String(from))) throw new Error('from is not a commit');
  const seen = from || await standing(repos.dirOf(full)).catch(() => null);
  // A thread's turn can run for a while; its work goes first, then this. Not so for what Video
  // Kit hands over while a thread is being given the repo: that goes first, so the thread starts from it.
  const until = Date.now() + waitMs;
  while (repos.holder(full) && !(handing && handingOverTo(full))) {
    if (Date.now() > until) throw new Error(`"${repos.holderTitle(full)}" is working in ${full}; saving waits until it is done`);
    await sleep(2000);
  }
  const { dir, base } = await repos.ensure(full);
  return repos.serialFor(full, async () => {
    await git(dir, ['fetch', '--quiet', 'origin']).catch(() => {});
    const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).then(() => `origin/${base}`, () => 'HEAD');
    if ((await git(dir, ['status', '--porcelain'])).trim()) {
      // Left by a turn whose leftovers were not saved; they stay on the branch they were made on.
      await git(dir, ['add', '-A']);
      await git(dir, [...(await repos.identityFor(dir)), 'commit', '--quiet', '--no-verify', '-m', 'Work in progress, saved before Video Kit saved']);
    }
    // Commits Video Kit made earlier that did not reach GitHub go along with this one.
    const onMain = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((o) => o.trim() === base, () => false);
    const unpushed = onMain && remote !== 'HEAD' && Number((await git(dir, ['rev-list', '--count', `${remote}..HEAD`]).catch(() => '0')).trim()) > 0
      && !Number((await git(dir, ['rev-list', '--count', `HEAD..${remote}`]).catch(() => '1')).trim());
    if (!unpushed) await git(dir, ['checkout', '--quiet', '-B', base, remote]);
    for (let attempt = 0; ; attempt++) {
      // Before every write, also after GitHub moved on: nothing Video Kit did not see is written over.
      const stale = await changedSince(dir, seen, 'HEAD', list);
      if (stale.length) {
        log(`video kit: not saving into ${full}, changed on main meanwhile: ${stale.join(', ')}`);
        throw new StaleError(stale);
      }
      for (const f of list) {
        const p = path.join(dir, ...f.path.split('/'));
        if (f.content === null) fs.rmSync(p, { force: true });
        else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content, 'utf8'); }
      }
      await git(dir, ['add', '-A', '--', ...list.map((f) => f.path)]);
      const staged = (await git(dir, ['diff', '--cached', '--name-only'])).trim();
      if (staged) await git(dir, [...(await repos.identityFor(dir)), 'commit', '--quiet', '--no-verify', '-m', message || 'Video Kit: saved']);
      const ahead = remote === 'HEAD' ? 1 : Number((await git(dir, ['rev-list', '--count', `${remote}..HEAD`]).catch(() => '0')).trim());
      if (!ahead) return { commit: null };
      try {
        await git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${base}`], { timeout: 180_000 });
        await git(dir, ['fetch', '--quiet', 'origin']).catch(() => {});
        const commit = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
        log(`video kit: saved ${list.map((f) => f.path).join(', ')} into ${full} (${commit})`);
        return { commit, pushed: true };
      } catch (err) {
        if (attempt >= 2) {
          // The commit stays on main here and goes out with the next save.
          log(`video kit: could not push ${full}: ${err.message.split('\n')[0]}`);
          return { commit: (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim(), pushed: false };
        }
        // GitHub moved on meanwhile: start again from there with the same files.
        await git(dir, ['fetch', '--quiet', 'origin']);
        await git(dir, ['reset', '--quiet', '--hard', remote]);
      }
    }
  });
}
