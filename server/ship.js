// A thread's work in a repo goes into main by itself.
//
// When a turn that worked in a repo ends, its branch is already committed and pushed
// (repos.saveWork, repos.autoPush). Then, in the background:
//
//   1. the app takes the repo, so no other thread changes it meanwhile;
//   2. if the repo has tests (`npm test` in package.json), it runs them on the branch;
//   3. if they pass, or there are none, it merges the branch into main and pushes main;
//   4. it says in the thread what it did, so Florian (and the next brain update) knows.
//
// Tests that fail, or a main that has moved on in a way that clashes, leave the branch
// as it is, on GitHub, with a note in the thread: ask Claude to fix it, or merge with the
// button. A repo without tests is merged as it is; the note says so.
//
// For the app's own repo this means a change reaches the running app with its next
// self-update, a few minutes later, and only once the tests have passed. Switched off
// with `"autoMerge": false` in config.json (repair threads: `"repair": { "autoMerge": false }`).

import fs from 'node:fs';
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
function whatNext(threadId, failure, detail) {
  let next = null;
  try { next = failedHook?.(threadId, { failure, detail }) || null; } catch (err) { log(`ship: carrying on by itself failed: ${err.message}`); }
  if (next?.fix) return ' Claude fixes it by itself now, and the app then tries the merge again.';
  if (next?.remerge) return ` The app tries the merge again by itself at ${clock(next.remerge)}.`;
  if (next?.stop) return ` The app does not try again by itself: ${next.stop}. Ask Claude to fix it, or merge it yourself from the repo panel.`;
  return '';
}

const shipping = new Set(); // threads whose branch is being tested or merged right now
export const isShipping = (threadId) => shipping.has(threadId);

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

// The repo's tests, if it has any. Returns { ran, ok, out }.
async function test(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* not a node project */ }
  const script = pkg?.scripts?.test;
  if (!script || /no test specified/.test(script)) return { ran: false, ok: true, out: '' };
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
  if (!thread?.repo || !thread.repoBranch || shipping.has(threadId)) return;
  const repair = thread.kind === 'repair';
  if (repair ? config?.repair?.autoMerge === false : config?.autoMerge === false) return;
  const full = thread.repo;
  const note = (text) => store.appendMessage(threadId, { role: 'user', text: `[${text}]`, event: true });
  // A merge that failed: what the app does about it by itself is decided once the repo is
  // given back, so the turn that fixes it can take it.
  let failed = null;
  shipping.add(threadId);
  try {
    // Is there anything main does not have?
    const dir = repos.dirOf(full);
    const main = thread.repoMain || 'main';
    const ahead = Number((await git(dir, ['rev-list', '--count', `origin/${main}..${thread.repoBranch}`]).catch(() => '0')).trim());
    if (!ahead) return;
    // The repo for this thread, so no other turn changes it while it is tested.
    await repos.acquire(full, threadId);
    try {
      const now = store.getThread(threadId);
      if (!now?.repoBranch || now.state === 'working') return; // he answered: the next turn's end tries again
      await repos.openFor(threadId, full); // its branch checked out, main fetched
      const result = await test(dir);
      await tidy(dir);
      if (!result.ok) {
        const out = tail(result.out);
        failed = { failure: 'tests', detail: out, text: (next) => `The app ran the tests of ${full} on this branch and they did not pass, so it did not merge into ${main}. The branch ${now.repoBranch} is on GitHub.${next || ' Ask Claude to fix it, or merge it yourself from the repo panel.'}\n\nThe end of the test output:\n${out}` };
        log(`ship: tests failed for "${now.title}" in ${full}; not merged`);
        return;
      }
      if (store.getThread(threadId)?.state === 'working') return;
      const branch = now.repoBranch;
      const { base } = await repos.merge(threadId);
      const tested = result.ran ? 'ran the tests, they passed, and it' : 'found no tests in this repo and';
      note(repair
        ? `The app ${tested} merged the fix into ${base} of ${full} and pushed it, on ${dateTimeDMY(Date.now())}. The app updates itself with it within ten minutes.`
        : `The app ${tested} merged the branch ${branch} into ${base} of ${full} and pushed it, on ${dateTimeDMY(Date.now())}. The next change in this repo starts on a new branch.${full.toLowerCase() === (config?.repair?.repo || 'fburgerdev/app-ai').toLowerCase() ? ' The app updates itself with it within ten minutes.' : ''}`);
      if (repair) store.updateThread(threadId, { state: 'done', doneAt: Date.now() });
      log(`ship: merged ${branch} into ${full} ${base}${result.ran ? ' after its tests passed' : ' (no tests)'}`);
    } finally {
      repos.release(full, threadId);
    }
  } catch (err) {
    const reason = err.message.split('\n')[0];
    const failure = mergeFailure(reason);
    failed = { failure, detail: reason, text: (next) => `The app could not merge this branch into main by itself: ${next ? reason.replace(/\s*Ask Claude.*$/, '') : reason}${next || ' The branch is on GitHub; the Merge button in the repo panel tries again.'}` };
    log(`ship: could not merge for "${thread.title}": ${err.message}`);
  } finally {
    shipping.delete(threadId);
  }
  if (failed) note(failed.text(failed.failure ? whatNext(threadId, failed.failure, failed.detail) : ''));
}
