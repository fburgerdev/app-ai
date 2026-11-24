// A thread's work in a repo goes into main by itself.
//
// When a turn that worked in a repo ends, its branch is already committed and pushed
// (repos.saveWork, repos.autoPush). Then, in the background, for every repo the thread opened
// (repos.shipList), one after another in the order it opened them:
//
//   1. if the repo has tests (`npm test` in package.json) and a workflow in
//      .github/workflows, GitHub Actions runs them on the pushed branch and the app waits for
//      the result, without holding the repo and without loading this computer;
//   2. the app takes the repo, so no other thread changes it meanwhile; tests GitHub did not
//      run (no workflow, no run started in time, GitHub out of reach) it runs here instead;
//   3. if they pass, or there are none, it merges the branch into main and pushes main;
//   4. it says in the thread what it did, so Florian (and the next brain update) knows.
//
// Tests that fail, or a main that has moved on in a way that clashes, leave the branch
// as it is, on GitHub, with a note in the thread, and the app starts a turn by itself that
// fixes it, after which the merge runs again; a merge that failed for another reason is
// tried again a few minutes later (retry.js, with its limits). A repo without tests is
// merged as it is; the note says so. The repos after one that did not go in wait for it, so
// what had to be live first (the app, before the vault) is never overtaken.
//
// For the app's own repo this means a change reaches the running app with its next
// self-update, a few minutes later, and only once the tests have passed. Switched off
// with `"autoMerge": false` in config.json (repair threads: `"repair": { "autoMerge": false }`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './config.js';
import { git } from './git.js';
import * as repos from './repos.js';
import * as store from './store.js';
import { dateTimeDMY } from './util.js';
import { mergeFailure } from './retry.js';
import { clock } from './limits.js';

let config;
export function initShip(cfg) { config = cfg; }

// What the app does by itself when a merge failed (runner.mergeFailed, retry.js): a turn
// that fixes it, the merge tried again later, or nothing more. Returns the words for the note.
let failedHook = null;
export function onMergeFailed(fn) { failedHook = fn; }
function whatNext(threadId, failure, detail, where = {}) {
  let next = null;
  try { next = failedHook?.(threadId, { failure, detail, ...where }) || null; } catch (err) { log(`ship: carrying on by itself failed: ${err.message}`); }
  if (next?.fix) return ' Claude fixes it by itself now, and the app then tries the merge again.';
  if (next?.remerge) return ` The app tries the merge again by itself at ${clock(next.remerge)}.`;
  if (next?.stop) return ` The app does not try again by itself: ${next.stop}. Ask Claude to fix it, or merge it yourself from the repo panel.`;
  return '';
}

const shipping = new Set(); // threads whose branch is being tested or merged right now
const again = new Set(); // threads whose turn ended again meanwhile: shipped once more after
export const isShipping = (threadId) => shipping.has(threadId);
export const anyShipping = () => shipping.size > 0;

// Told when a branch went into main (selfupdate.noteMerged: the app's own repo means a
// new version of the app).
let mergedHook = null;
export function onMerged(fn) { mergedHook = fn; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, cwd, ms) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let out = '';
    const add = (d) => { out = (out + d).slice(-8000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { out += '\n(stopped: it took too long)'; child.kill(); }, ms);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, out: err.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const testScript = (pkg) => {
  const script = pkg?.scripts?.test;
  return script && !/no test specified/.test(script) ? script : '';
};

// The repo's tests, if it has any. Returns { ran, ok, out }.
async function test(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* not a node project */ }
  if (!testScript(pkg)) return { ran: false, ok: true, out: '' };
  // Dependencies as the lock file has them; without one, installed without writing one,
  // so the branch is not changed by testing it.
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).length;
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) {
    const installed = await run(npm, ['ci', '--no-audit', '--no-fund'], dir, 10 * 60_000);
    if (!installed.ok) return { ran: true, ok: false, out: `npm ci failed:\n${installed.out}` };
  } else if (deps) {
    const installed = await run(npm, ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], dir, 10 * 60_000);
    if (!installed.ok) return { ran: true, ok: false, out: `npm install failed:\n${installed.out}` };
  }
  return { ran: true, ...(await run(npm, ['test'], dir, 20 * 60_000)) };
}

// The branch's tests as GitHub Actions ran them. Read from git, without the working copy,
// so the repo stays free for other threads meanwhile. Returns { ran, ok, out, url, sha },
// { stale: true } when the branch moved on or he answered (the next turn's end tries
// again), or null when GitHub is not running them: then they run here.
async function testOnGithub(threadId, full, dir, branch) {
  const ci = config?.ci || {};
  if (ci.auto === false) return null;
  const workflows = await git(dir, ['ls-tree', '-r', '--name-only', branch, '--', '.github/workflows']).catch(() => '');
  if (!/\.ya?ml$/m.test(workflows)) return null;
  let pkg = null;
  try { pkg = JSON.parse(await git(dir, ['show', `${branch}:package.json`])); } catch { /* none */ }
  if (!testScript(pkg)) return null;
  const sha = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')).trim();
  const remote = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).catch(() => '')).trim();
  if (!sha || sha !== remote) return null; // not on GitHub as it is here (offline): test here
  const startMs = ci.startMs ?? 4 * 60_000;
  const waitMs = ci.waitMs ?? 30 * 60_000;
  const began = Date.now();
  for (;;) {
    const now = store.getThread(threadId);
    if (!now || now.state === 'working' || repos.branchIn(now, full) !== branch) return { stale: true };
    let runs;
    try {
      runs = (await repos.githubApi('GET', `/repos/${full}/commits/${sha}/check-runs?per_page=100`)).check_runs || [];
    } catch (err) {
      log(`ship: could not ask GitHub about the tests of ${full}, testing here: ${err.message}`);
      return null;
    }
    if (!runs.length && Date.now() - began > startMs) {
      log(`ship: no GitHub run started for ${branch} of ${full}, testing here`);
      return null;
    }
    if (runs.length && runs.every((r) => r.status === 'completed')) {
      const failed = runs.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion));
      if (!failed.length) return { ran: true, ok: true, out: '', sha };
      let out = '';
      for (const r of failed.slice(0, 2)) {
        // Every line of a job's log starts with its time; the test output is what is left.
        const text = await repos.githubText(`/repos/${full}/actions/jobs/${r.id}/logs`).catch(() => '');
        out += text.split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')).join('\n');
      }
      return { ran: true, ok: false, out: out || failed.map((r) => `${r.name}: ${r.conclusion}`).join('\n'), url: failed[0].html_url, sha };
    }
    if (Date.now() - began > waitMs) {
      return { ran: true, ok: false, out: `GitHub had not finished the tests after ${Math.round(waitMs / 60_000)} minutes.`, url: runs[0]?.html_url, sha };
    }
    await sleep(ci.pollMs ?? 15_000);
  }
}

// Tests can leave files behind. Everything of Claude's is committed by now, so whatever
// is changed in the working copy came from testing it and goes.
async function tidy(dir) {
  if (!(await git(dir, ['status', '--porcelain']).catch(() => '')).trim()) return;
  await git(dir, ['reset', '--quiet', '--hard', 'HEAD']).catch(() => {});
  await git(dir, ['clean', '-fdq']).catch(() => {});
}

// The end of the output, and first the tests that failed with their error lines: node's own
// summary at the end does not name them.
const tail = (out) => {
  const lines = out.split('\n').map((l) => l.trimEnd());
  const failed = [];
  lines.forEach((l, i) => {
    if (!/^\s*not ok \d+/.test(l) || /^\s*not ok \d+ - .*\.(m?js|cjs)$/.test(l) && failed.length) return;
    const detail = lines.slice(i + 1, i + 30).filter((x) => /^\s*(error|message|expected|actual|  \+ |  - )/.test(x) || /timed out|Error:/.test(x)).slice(0, 6);
    failed.push([l.trim(), ...detail.map((x) => `  ${x.trim()}`)].join('\n'));
  });
  const end = lines.filter(Boolean).slice(-12).join('\n');
  return failed.length ? `${failed.slice(0, 5).join('\n')}\n…\n${end}` : end;
};

// After a turn. Never throws; runs in the background.
export async function afterTurn(threadId) {
  const thread = store.getThread(threadId);
  if (!thread) return;
  // A repo with no branch of the thread's has nothing to merge.
  const list = [];
  for (const full of repos.shipList(thread)) {
    if (repos.branchIn(thread, full)) list.push(full);
    else repos.dropShip(threadId, full);
  }
  if (!list.length) return;
  // Still at the last turn's branches (GitHub may take minutes): this one goes after it.
  if (shipping.has(threadId)) { again.add(threadId); return; }
  const repair = thread.kind === 'repair';
  if (repair ? config?.repair?.autoMerge === false : config?.autoMerge === false) return;
  const note = (text) => store.appendMessage(threadId, { role: 'user', text: `[${text}]`, event: true });
  // A merge that failed: what the app does about it by itself is decided once the repo is
  // given back, so the turn that fixes it can take it.
  let failed = null;
  shipping.add(threadId);
  // Kept on disk while it runs: an app that stops in the middle (Update now, a crash, the
  // laptop shut down) finds it when it starts and tries the merge again (store.loadThreads).
  store.updateThread(threadId, { merging: { at: Date.now(), on: os.hostname() } });
  try {
    for (const [i, full] of list.entries()) {
      const out = await shipOne(threadId, full, { repair, note });
      if (out.done) { repos.dropShip(threadId, full); continue; }
      // Not in main (yet): the repos after it wait for it.
      const rest = list.slice(i + 1);
      if (out.failed) {
        failed = out.failed;
        if (rest.length) {
          const text = failed.text;
          failed.text = (next) => `${text(next)}\n\nThe work in ${rest.join(', ')} waits on its branch until this is in main, and then goes in after it.`;
        }
      }
      break;
    }
  } finally {
    shipping.delete(threadId);
    store.updateThread(threadId, { merging: null });
    // Here and not after the loop: its early ends would skip it.
    if (failed) note(failed.text(failed.failure ? whatNext(threadId, failed.failure, failed.detail, failed.where) : ''));
    if (again.delete(threadId)) setTimeout(() => afterTurn(threadId).catch(() => {}), 0);
  }
}

// One repo's branch into main. Never throws. Returns { done: true } when the branch is in
// main or has nothing main does not have; otherwise it waits ({}), or failed ({ failed }).
async function shipOne(threadId, full, { repair, note }) {
  const thread = store.getThread(threadId);
  const current = repos.isCurrent(thread, full);
  const branch = repos.branchIn(thread, full);
  if (!branch) return { done: true };
  let failed = null;
  try {
    // Is there anything main does not have?
    const dir = repos.dirOf(full);
    // A repo the thread left in the same turn: its main as the repo has it.
    const main = current ? (thread.repoMain || 'main') : ((await repos.ensure(full).catch(() => null))?.base || 'main');
    const ahead = Number((await git(dir, ['rev-list', '--count', `origin/${main}..${branch}`]).catch(() => '0')).trim());
    if (!ahead) return { done: true };
    const where = { repo: full, branch, main };
    // A turn that broke a repo's shared folders waits for him (repos.saveWork).
    if (thread.repoBreach) {
      note(`The app did not merge this branch (${branch} of ${full}) into ${main}: the last turn broke the rules of a repo's shared folders (${thread.repoBreach}). It merges after Florian has written in this thread and the next turn ends.`);
      return {};
    }
    // GitHub first, without holding the repo: other threads can work in it meanwhile.
    let result = await testOnGithub(threadId, full, dir, branch);
    if (result?.stale) return {}; // he answered, or the branch moved on: the next turn's end tries again
    // The repo for this thread, so no other turn changes it while it is tested: alone in a
    // repo of one thread at a time; shared in a parallel one, where the merges go one at a
    // time instead (repos.withMergeLock) and the branch is brought up to date with main first.
    await repos.ensure(full);
    const parallel = repos.isParallel(full);
    // A new turn of this thread holds the repo already (a follow-up started meanwhile): the
    // lock is the turn's, under the same name, so this neither takes nor gives it back. That
    // turn's end merges.
    if (repos.holds(full, threadId)) return {};
    await repos.acquire(full, threadId, { mode: 'shared' });
    let done = false;
    try {
      const now = store.getThread(threadId);
      if (!now || now.state === 'working' || repos.branchIn(now, full) !== branch) return {}; // he answered: the next turn's end tries again
      const step = async () => {
        // Its branch checked out, main fetched; a repo it left stays left.
        await repos.openFor(threadId, full, { check: false, current: repos.isCurrent(now, full) });
        const here = repos.dirFor(threadId, full);
        // Main brought in: what GitHub tested is no longer what gets merged, so test here.
        const caughtUp = parallel ? await repos.catchUp(threadId, { full, base: main }) : false;
        let onGithub = Boolean(result) && !caughtUp;
        if (onGithub) {
          // Only what GitHub tested is merged.
          const head = (await git(here, ['rev-parse', 'HEAD']).catch(() => '')).trim();
          if (head !== result.sha) { again.add(threadId); return; }
        } else {
          onGithub = false;
          result = await test(here);
          await tidy(here);
        }
        if (!result.ok) {
          const out = tail(result.out);
          const who = onGithub ? 'GitHub ran' : 'The app ran';
          const app = onGithub ? 'the app' : 'it';
          failed = { failure: 'tests', detail: out, where, text: (next) => `${who} the tests of ${full} on this branch and they did not pass, so ${app} did not merge into ${main}. The branch ${branch} is on GitHub.${next || ' Ask Claude to fix it, or merge it yourself from the repo panel.'}${result.url ? `

The run: ${result.url}` : ''}

The end of the test output:
${out}` };
          log(`ship: tests failed${onGithub ? ' on GitHub' : ''} for "${now.title}" in ${full}; not merged`);
          return;
        }
        if (store.getThread(threadId)?.state === 'working') return;
        const { base } = await repos.merge(threadId, { locked: true, full });
        done = true;
        try { mergedHook?.(full); } catch { /* never in the way */ }
        const tested = !result.ran ? 'found no tests in this repo and'
          : onGithub ? 'had GitHub run the tests, they passed, and it' : 'ran the tests, they passed, and it';
        note(repair
          ? `The app ${tested} merged the fix into ${base} of ${full} and pushed it, on ${dateTimeDMY(Date.now())}. The app takes it as soon as nothing is running; while Claude works, the line at the top of the page offers to lock for the update.`
          : `The app ${tested} merged the branch ${branch} into ${base} of ${full} and pushed it, on ${dateTimeDMY(Date.now())}. The next change in this repo starts on a new branch.${full.toLowerCase() === (config?.repair?.repo || 'fburgerdev/app-ai').toLowerCase() ? ' The app takes it as soon as nothing is running; while Claude works, the line at the top of the page offers to lock for the update.' : ''}`);
        if (repair) store.updateThread(threadId, { state: 'done', doneAt: Date.now() });
        log(`ship: merged ${branch} into ${full} ${base}${result.ran ? ` after its tests passed${onGithub ? ' on GitHub' : ''}` : ' (no tests)'}`);
      };
      await (parallel ? repos.withMergeLock(full, step) : step());
    } finally {
      repos.release(full, threadId);
    }
    return done ? { done: true } : failed ? { failed } : {};
  } catch (err) {
    const reason = err.message.split('\n')[0];
    const failure = mergeFailure(reason);
    // Main got the branch's work meanwhile (merged from the other computer, or by hand):
    // nothing is left to merge, and nothing failed. No note. (23-11-2026: "The app could not
    // merge this branch … There is nothing on this branch that main does not have", in red,
    // after a turn that had changed only the vault.)
    if (!failure) { log(`ship: nothing left to merge for "${thread.title}" in ${full}`); return { done: true }; }
    log(`ship: could not merge for "${thread.title}" in ${full}: ${err.message}`);
    return { failed: { failure, detail: reason, where: { repo: full, branch, main: thread.repoMain || 'main' }, text: (next) => `The app could not merge this branch (${branch} of ${full}) into main by itself: ${next ? reason.replace(/\s*Ask Claude.*$/, '') : reason}${next || ' The branch is on GitHub; the Merge button in the repo panel tries again.'}` } };
  }
}
