// Threads working in git repos, end to end against the stand-in Claude and bare repos on
// disk playing GitHub: cloned on demand, one thread per repo at a time, a branch per
// thread, leftovers committed, push and merge from the buttons, renaming.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, holder, holderName, jobHolder, release, repoName } from '../server/repos.js';
import { cleanup, freePort, patience } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repo names are read the ways Florian writes them', () => {
  assert.equal(repoName('app-ai'), 'fburgerdev/app-ai');
  assert.equal(repoName('fburgerdev/website-stuwerke'), 'fburgerdev/website-stuwerke');
  assert.equal(repoName('`fburgerdev/website-pbu-cologne`'), 'fburgerdev/website-pbu-cologne');
  assert.equal(repoName('https://github.com/fburgerdev/brain.git'), 'fburgerdev/brain');
  assert.equal(repoName('../../etc'), null);
  assert.equal(repoName('a b'), null);
});

test('a job holds a repo until it gives it back; a waiter that gave up is not handed it later', async () => {
  const r = 'fburgerdev/lock-test';
  const job = jobHolder('brain update');
  assert.equal(await acquire(r, job), true);
  assert.equal(holderName(r), 'the brain update');
  // A thread the app does not know holds nothing, but a job is not a thread and still holds.
  assert.equal(await acquire(r, 'some-thread', { wait: false }), false, 'the job is not pushed aside');
  assert.equal(await acquire(r, 'gave-up', { timeoutMs: 30 }), false, 'gives up after its time');
  const later = acquire(r, 'still-waiting');
  release(r, job);
  assert.equal(await later, true);
  assert.equal(holder(r), 'still-waiting', 'the one that gave up left the queue');
  release(r, 'still-waiting');
  assert.equal(holder(r), null);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-repos-'));
const hub = path.join(dir, 'hub');
const vault = path.join(hub, 'fburgerdev', 'brain.git');
const data = path.join(dir, 'data');
const port = await freePort();
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bare(name, files) {
  const remote = path.join(hub, 'fburgerdev', `${name}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  git(dir, 'init', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, `seed-${name}`);
  git(dir, 'clone', remote, seed);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
    fs.writeFileSync(path.join(seed, f), text);
  }
  git(seed, 'checkout', '-B', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'main');
  return { remote, seed };
}
bare('brain', {
  'CLAUDE.md': '# vault\n',
  'Claude/Instructions.md': '# Instructions\n',
  'Core/Projects/Site.md': '# Site\n\nStatus: active\nrepo: `fburgerdev/site`\n',
  'Core/Projects/Projects Index.md': '# Projects Index\n\n## No area\n\n- [[Site]] — a website\n',
});
const site = bare('site', { 'index.html': '<h1>Hello</h1>\n' });
bare('tool', { 'README.md': '# tool\n' });
// A repo made on GitHub without a first commit.
const emptyRemote = path.join(hub, 'fburgerdev', 'blank.git');
git(dir, 'init', '--bare', '-b', 'main', emptyRemote);

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', repoBase: hub, cards: { auto: false }, autoMerge: false }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_FAKE_GITHUB: '1' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'w'), fs.openSync(path.join(dir, 'server.log'), 'a')],
});
test.after(() => { server.kill(); if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'server.log'), 'utf8')); return cleanup(dir, [server]); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data: parsed };
};
async function until(fn, what, ms = 45000) { // generous: eight test servers run side by side
  const end = Date.now() + ms * patience;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(80);
  }
  throw new Error(`timed out: ${what}`);
}
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' ? t : null; }, `thread ${id} ready`);
// Send a message and wait for Claude's answer to it.
async function turn(id, text) {
  const before = (await thread(id)).messages.filter((m) => m.role === 'assistant').length;
  await call('POST', `/api/threads/${id}/messages`, { text });
  return until(async () => { const t = await thread(id); return t.thread.state === 'ready' && t.messages.filter((m) => m.role === 'assistant').length > before ? t : null; }, `answer in ${id}`);
}
const repoStatus = async (id) => (await call('GET', `/api/threads/${id}/repo`)).data.status;
const clone = path.join(data, 'repos', 'fburgerdev', 'site');

test('the app is up', async () => {
  await until(async () => { try { return (await call('GET', '/api/state')).data.brain.brain.ready; } catch { return false; } }, 'brain cloned', 45000);
});

test('a thread on a project gets its repo, clones it when Claude opens it, and works on its own branch', async () => {
  const made = (await call('POST', '/api/threads', { text: 'Change the heading', project: 'Site' })).data.thread;
  assert.equal(made.repo, 'fburgerdev/site', 'from the project note\'s repo: line');
  await ready(made.id);
  assert.ok(!fs.existsSync(clone), 'nothing is cloned until Claude opens it');

  const done = await turn(made.id, 'REPO-TEST now please');
  assert.match(done.thread.repoBranch, /^claude\/change-the-heading-/);
  assert.ok(fs.existsSync(path.join(clone, 'CHANGED-BY-CLAUDE.md')));
  const st = await repoStatus(made.id);
  assert.equal(st.main, 'main');
  assert.equal(st.ahead, 1, 'what Claude left uncommitted was committed onto the branch');
  assert.equal(st.uncommitted, false);
  assert.deepEqual(st.files, [{ name: 'CHANGED-BY-CLAUDE.md', status: 'A' }]);
  assert.equal(st.pushed, true, 'the branch went to GitHub by itself when the turn ended');
  assert.equal(st.holder, '', 'given back when the turn ended');
  const diff = (await call('GET', `/api/threads/${made.id}/repo/diff?file=CHANGED-BY-CLAUDE.md`)).data;
  assert.match(diff, /\+Changed in a turn/);
  assert.match(git(site.remote, 'branch', '--list', 'claude/*'), /claude\/change-the-heading/, 'the branch is on GitHub');
  assert.ok(!git(site.remote, 'ls-tree', '--name-only', 'main').includes('CHANGED-BY-CLAUDE.md'), 'main is untouched until he merges');

  // Push, then merge.
  const pushed = await call('POST', `/api/threads/${made.id}/repo/push`, {});
  assert.equal(pushed.status, 200);
  assert.match(pushed.data.compare, /github\.com\/fburgerdev\/site\/compare\/main\.\.\.claude%2Fchange-the-heading/);
  assert.equal(pushed.data.status.pushed, true);
  assert.match(git(site.remote, 'branch', '--list', 'claude/*'), /claude\/change-the-heading/);
  const merged = await call('POST', `/api/threads/${made.id}/repo/merge`, {});
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.match(git(site.remote, 'log', '--format=%s', 'main'), /Merge "Change the heading"/);
  assert.ok(git(site.remote, 'ls-tree', '--name-only', 'main').includes('CHANGED-BY-CLAUDE.md'));
  assert.equal(git(site.remote, 'branch', '--list', 'claude/*').trim(), '', 'the merged branch is gone from GitHub');
  const after = await thread(made.id);
  assert.equal(after.thread.repoBranch, '');
  assert.match(after.messages.filter((m) => m.event).map((m) => m.text).join('\n'), /pushed the branch[\s\S]*merged the branch/);
  assert.equal((await call('POST', `/api/threads/${made.id}/repo/merge`, {})).status, 409, 'nothing left to merge');
});

test('two threads in one repo: the first in the main copy, the second in a worktree made on demand', async () => {
  const a = (await call('POST', '/api/threads', { text: 'First worker', project: 'Site' })).data.thread;
  const b = (await call('POST', '/api/threads', { text: 'Second worker', project: 'Site' })).data.thread;
  await ready(a.id); await ready(b.id);
  const hold = path.join(data, 'hold-first'); // a stays in the repo until this file goes
  fs.writeFileSync(hold, '');
  const aTurn = turn(a.id, 'REPO-TEST REPO-OWN REPO-HOLD=first go');
  await until(async () => fs.existsSync(path.join(clone, 'CHANGED-BY-First-worker.md')), 'a works in the main copy', 8000);
  // b does not wait: it gets a worktree of its own while a works in the main copy.
  const bDone = await turn(b.id, 'REPO-TEST REPO-OWN go too');
  const wt = path.join(data, 'worktrees', 'fburgerdev', 'site', b.id);
  assert.ok(fs.existsSync(path.join(wt, 'CHANGED-BY-Second-worker.md')));
  assert.equal((await thread(a.id)).thread.state, 'working', 'a was still at work meanwhile');
  fs.rmSync(hold);
  const aDone = await aTurn;
  assert.notEqual(aDone.thread.repoBranch, bDone.thread.repoBranch, 'each on a branch of its own');
  assert.equal((await repoStatus(a.id)).ahead, 1);
  assert.equal((await repoStatus(b.id)).ahead, 1);
  assert.equal(git(clone, 'status', '--porcelain').trim(), '', 'the main copy is clean between turns');
  assert.equal((await call('POST', `/api/threads/${a.id}/repo/merge`, {})).status, 200);
  assert.equal((await call('POST', `/api/threads/${b.id}/repo/merge`, {})).status, 200);
  assert.ok(!fs.existsSync(wt), 'the worktree goes with the merge');
  const files = git(site.remote, 'ls-tree', '--name-only', 'main');
  assert.ok(files.includes('CHANGED-BY-First-worker.md') && files.includes('CHANGED-BY-Second-worker.md'));
});

test('any thread can open any repo; Florian can change a thread\'s repo; repos can be renamed', async () => {
  const loose = (await call('POST', '/api/threads', { text: 'Something unrelated' })).data.thread;
  assert.ok(!loose.repo);
  await ready(loose.id);
  const opened = await turn(loose.id, 'REPO-TEST=tool');
  assert.equal(opened.thread.repo, 'fburgerdev/tool');
  assert.ok(fs.existsSync(path.join(data, 'repos', 'fburgerdev', 'tool', 'CHANGED-BY-CLAUDE.md')));

  assert.equal((await call('POST', `/api/threads/${loose.id}/repo`, { repo: 'not a name!' })).status, 400);
  const picked = (await call('POST', `/api/threads/${loose.id}/repo`, { repo: 'site' })).data.thread;
  assert.equal(picked.repo, 'fburgerdev/site');
  assert.equal(picked.repoBranch, '', 'a different repo starts a new branch');
  assert.ok((await call('GET', '/api/repos')).data.repos.includes('fburgerdev/tool'));

  const renamed = await turn(loose.id, 'RENAME-TEST tool toolbox');
  assert.ok(fs.existsSync(path.join(hub, 'fburgerdev', 'toolbox.git')), 'renamed on GitHub');
  assert.ok(fs.existsSync(path.join(data, 'repos', 'fburgerdev', 'toolbox')), 'and the app\'s copy moved');
  assert.match(git(path.join(data, 'repos', 'fburgerdev', 'toolbox'), 'remote', 'get-url', 'origin'), /toolbox\.git/);
  assert.match(renamed.messages.filter((m) => m.event).at(-1).text, /renamed the GitHub repo fburgerdev\/tool to fburgerdev\/toolbox/);
});

test('without a repo, shell commands stay off; the vault stays read-only', async () => {
  const { buildPolicy } = await import('../server/agent.js');
  const repo = path.join(dir, 'r');
  let held = null;
  const policy = buildPolicy({ mode: 'thread', cwd: path.join(dir, 'vault'), artifactsDir: path.join(dir, 'art'), repoDir: () => held, reposDir: dir });
  assert.equal((await policy('Bash', { command: 'ls' })).behavior, 'deny');
  assert.equal((await policy('Write', { file_path: path.join(repo, 'a.txt') })).behavior, 'deny');
  held = repo;
  assert.equal((await policy('Bash', { command: 'npm test' })).behavior, 'allow');
  assert.equal((await policy('Bash', { command: 'git commit -m x' })).behavior, 'allow');
  assert.equal((await policy('Bash', { command: 'git push origin HEAD' })).behavior, 'deny');
  assert.equal((await policy('Bash', { command: 'git checkout main' })).behavior, 'deny');
  assert.equal((await policy('Bash', { command: 'git checkout -- a.txt' })).behavior, 'allow');
  assert.equal((await policy('Bash', { command: 'gh repo delete x' })).behavior, 'deny');
  assert.equal((await policy('Write', { file_path: path.join(repo, 'a.txt') })).behavior, 'allow');
  assert.equal((await policy('Write', { file_path: path.join(repo, '.git', 'config') })).behavior, 'deny');
  assert.equal((await policy('Write', { file_path: path.join(dir, 'vault', 'Core', 'x.md') })).behavior, 'deny');
});

test('an empty repo gets a first commit, and the thread works in it like in any other', async () => {
  const t = (await call('POST', '/api/threads', { text: 'Start the new video project' })).data.thread;
  await ready(t.id);
  const done = await turn(t.id, 'REPO-TEST=blank set it up');
  assert.match(done.thread.repoBranch || '', /^claude\//, 'it got a branch of its own');
  assert.equal(git(emptyRemote, 'log', '--format=%s', 'main').trim(), 'Start', 'main has its first commit on GitHub');
  const st = await repoStatus(t.id);
  assert.equal(st.main, 'main');
  assert.deepEqual(st.files, [{ name: 'CHANGED-BY-CLAUDE.md', status: 'A' }]);
});

test('a repo he agreed to is created, gets its first commit, and the thread works in it', async () => {
  const t = (await call('POST', '/api/threads', { text: 'A video about the GTD framework' })).data.thread;
  await ready(t.id);
  const done = await turn(t.id, 'Yes, CREATE-TEST ytvideo-gtd-framework');
  assert.equal(done.thread.repo, 'fburgerdev/ytvideo-gtd-framework');
  assert.match(done.messages.filter((m) => m.event).map((m) => m.text).join('\n'), /created the GitHub repo fburgerdev\/ytvideo-gtd-framework \(private\)/);
  const made = path.join(hub, 'fburgerdev', 'ytvideo-gtd-framework.git');
  assert.equal(git(made, 'log', '--format=%s', 'main').trim(), 'Start');
  assert.deepEqual((await repoStatus(t.id)).files, [{ name: 'README.md', status: 'A' }]);
});

test('a brain update waits for a thread that is changing the vault, then runs', async () => {
  const t = (await call('POST', '/api/threads', { text: 'Rename a folder in the vault' })).data.thread;
  await ready(t.id);
  const hold = path.join(data, 'hold-vault'); // the thread stays in the vault until this file goes
  fs.writeFileSync(hold, '');
  const working = turn(t.id, 'REPO-TEST=brain REPO-HOLD=vault rename it');
  await until(async () => (await thread(t.id)).thread.repo === 'fburgerdev/brain' && (await thread(t.id)).thread.repoBranch, 'the thread holds the vault', 15000);
  assert.equal((await call('POST', '/api/brain/extract', {})).data.started, true);
  const waiting = await until(async () => { const b = (await call('GET', '/api/state')).data.brain; return /^Waiting for "Rename a folder in the vault", which is changing the vault/.test(b.step) ? b : null; }, 'the update says it waits', 5000);
  assert.equal(waiting.brain.writing, false, 'it has not touched the vault yet');
  fs.rmSync(hold);
  await working;
  await until(async () => !(await call('GET', '/api/state')).data.brain.running, 'the update ran after the thread', 45000);
  const run = (await call('GET', '/api/brain/runs')).data.runs[0];
  assert.notEqual(run?.status, 'failed', JSON.stringify(run));
});

test('the stats count what happened', async () => {
  const s = (await call('GET', '/api/stats')).data;
  assert.deepEqual(s.periods.map((p) => p.key), ['thisWeek', 'lastWeek', 'fourWeeks', 'all']);
  const row = (label) => s.rows.find((r) => r.label === label).values;
  assert.ok(row('Threads you started').thisWeek >= 3);
  assert.equal(row('Threads you started').thisWeek, row('Threads you started').all, 'everything here happened this week');
  assert.ok(row('Changes merged into main').all >= 1, 'the merge from the button, counted from the repo itself');
  assert.ok(row('Projects started').all >= 1, 'the Site project note, from the vault history');
  assert.equal(typeof s.cost.all, 'number');
});
