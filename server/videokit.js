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
import { log } from './config.js';
import { git } from './git.js';
import * as repos from './repos.js';

const KIT = 'app-ytvideo-kit';
export const isVideoRepo = (full) => /^[\w.-]+\/ytvideo-[\w.-]+$/i.test(String(full || ''));

let config;
let child = null;
let stopped = false;
let restarts = 0;

const owner = () => config.github?.owner || 'fburgerdev';
const kitPort = () => Number(config.videoKit?.port) || 4400;
export const videoKitUrl = () => `http://localhost:${kitPort()}`;

export function initVideoKit(cfg) {
  config = cfg;
  if (config.fake || config.videoKit?.enabled === false) return;
  // A little after the start, so cloning does not slow the app's own start down.
  setTimeout(() => { start().catch((err) => log(`video kit: could not start: ${err.message}`)); }, 3000).unref?.();
  setInterval(() => { syncVideoRepos().catch((err) => log(`video kit: syncing the video repos failed: ${err.message}`)); }, 10 * 60_000).unref?.();
  process.on('exit', () => { stopped = true; child?.kill(); });
}

async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${kitPort()}/api/projects`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function start() {
  if (stopped || child) return;
  const full = `${owner()}/${KIT}`;
  const dir = repos.dirOf(full);
  // Its copy may be on a thread's branch; the player is plain files and runs from any of them.
  if (!fs.existsSync(path.join(dir, 'server.mjs'))) await repos.ensure(full);
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

// Saves files from Video Kit into a video repo: onto main, one commit, pushed. Waits while a
// thread works in the repo. `files` are [{ path, content }] relative to the repo; content null
// deletes the file.
export async function save(full, files, message, { waitMs = 30 * 60_000 } = {}) {
  if (!isVideoRepo(full)) throw new Error(`${full} is not a video repo`);
  const list = (files || []).map((f) => ({ path: String(f?.path || '').replace(/\\/g, '/'), content: f?.content ?? null }));
  for (const f of list) {
    if (!f.path || f.path.startsWith('/') || /^[a-z]:/i.test(f.path) || f.path.split('/').some((p) => p === '..' || p === '.' || p === '.git' || p === '')) throw new Error(`not a file in the repo: ${f.path}`);
    if (f.content !== null && typeof f.content !== 'string') throw new Error(`no text for ${f.path}`);
  }
  if (!list.length) return { commit: null };
  // A thread's turn can run for a while; its work goes first, then this.
  const until = Date.now() + waitMs;
  while (repos.holder(full)) {
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
