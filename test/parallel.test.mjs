// Repos that let threads work side by side (Florian, 23-11-2026), every repo by default, with worktrees on demand: the lock shared by many or
// held by one, turns parked while a repo is in use and started again by themselves when it is
// free, a worktree per thread, shared folders linked into every worktree and protected, the
// check at the end of a turn, and merges one at a time. Against the stand-in Claude and bare
// repos on disk playing GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, release, holders, lockMode, park, queued, forget, onGranted, parseSettings, _setSettings } from '../server/repos.js';
import { sharedRefusal } from '../server/agent.js';
import { cleanup, freePort, until } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = process.platform === 'win32';

// ---------- the lock on its own ----------

test('the lock: shared by many, exclusive for one, first come first served, no starving', async () => {
  const r = 'fburgerdev/par-lock';
  _setSettings(r, { parallel: true });
  assert.equal(await acquire(r, 'job:a', { mode: 'shared' }), true);
  assert.equal(await acquire(r, 'job:b', { mode: 'shared' }), true, 'a second shared holder gets in at once');
  assert.equal(lockMode(r), 'shared');
  assert.deepEqual(holders(r).sort(), ['job:a', 'job:b']);
  let alone = false;
  const x = acquire(r, 'job:x', { mode: 'exclusive' }).then((v) => { alone = v; });
  await sleep(20);
  assert.equal(alone, false, 'exclusive waits for the shared holders');
  assert.equal(await acquire(r, 'job:c', { mode: 'shared', wait: false }), false, 'nobody new gets in while exclusive waits');
  release(r, 'job:a');
  await sleep(20);
  assert.equal(alone, false, 'still one shared holder');
  release(r, 'job:b');
  await x;
  assert.equal(alone, true);
  assert.equal(lockMode(r), 'exclusive');
  assert.equal(await acquire(r, 'job:c', { mode: 'shared', wait: false }), false);
  release(r, 'job:x');
  assert.deepEqual(holders(r), []);
});

test('the lock: a repo that says parallel: false knows only one holder at a time', async () => {
  const r = 'fburgerdev/one-lock';
  _setSettings(r, { parallel: false });
  assert.equal(await acquire(r, 'job:a', { mode: 'shared' }), true);
  assert.equal(lockMode(r), 'exclusive', 'shared becomes exclusive');
  assert.equal(await acquire(r, 'job:b', { mode: 'shared', wait: false }), false);
  release(r, 'job:a');
});

test('the lock: a parked turn keeps its place and is handed the repo when it is free', async () => {
  const r = 'fburgerdev/park-lock';
  _setSettings(r, { parallel: true });
  const granted = [];
  onGranted((full, id) => { granted.push(id); return id !== 'job:refuses'; });
  assert.equal(await acquire(r, 'job:a', { mode: 'exclusive' }), true);
  // A turn that waited too long: it gives up waiting but keeps its place.
  assert.equal(await acquire(r, 'job:p', { mode: 'shared', timeoutMs: 30, park: true }), false);
  assert.equal(queued(r, 'job:p'), true);
  park(r, 'job:refuses', 'exclusive');
  park(r, 'job:later', 'shared');
  assert.equal(queued(r, 'job:later'), true);
  release(r, 'job:a');
  assert.deepEqual(granted, ['job:p'], 'the first in the queue, and only it while exclusive waits behind it');
  assert.deepEqual(holders(r), ['job:p']);
  release(r, 'job:p');
  assert.deepEqual(granted, ['job:p', 'job:refuses', 'job:later'], 'one that cannot start passes the lock on');
  assert.deepEqual(holders(r), ['job:later']);
  forget('job:later');
  assert.deepEqual(holders(r), []);
  onGranted(null);
});

test('the settings: only clean paths, protected folders only inside writable ones, parallel unless said otherwise', () => {
  const s = parseSettings({ parallel: true, shared: { readonly: ['fonts', '../x', '.git/hooks', 'a/b'], addonly: ['takes/', 'fonts', 'a', 'renders\\versions'] } });
  assert.equal(s.parallel, true);
  assert.deepEqual(s.shared.readonly, ['fonts']);
  assert.deepEqual(s.shared.addonly, ['takes', 'renders/versions'], 'a and a/b hold each other, so neither is shared');
  assert.equal(parseSettings({ parallel: false }).parallel, false);
  assert.equal(parseSettings(null).parallel, true, 'every repo is parallel unless it says otherwise');
  assert.equal(parseSettings(null).explicit, false);
  const w = parseSettings({ shared: { writable: ['films', 'renders', 'renders/x'], addonly: ['films/final4k'], readonly: ['fonts/a'] } });
  assert.deepEqual(w.shared, { writable: ['films', 'renders'], addonly: ['films/final4k'], readonly: ['fonts/a'] }, 'a protected folder may sit inside a writable one');
  assert.equal(w.explicit, true);
});

test('the file tools: read-only and add-only folders and the settings file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-shared-'));
  fs.mkdirSync(path.join(d, 'takes'));
  fs.writeFileSync(path.join(d, 'takes', 'old.mp4'), 'x');
  const rules = { exclusive: false, parallel: true, readonly: [path.join(d, 'fonts')], addonly: [path.join(d, 'takes')], settingsFile: path.join(d, '.app', 'repo.json') };
  assert.match(sharedRefusal(path.join(d, 'fonts', 'a.ttf'), rules), /read-only/);
  assert.match(sharedRefusal(path.join(d, 'takes', 'old.mp4'), rules), /add-only/);
  assert.equal(sharedRefusal(path.join(d, 'takes', 'new.mp4'), rules), null, 'a new file is fine');
  assert.match(sharedRefusal(path.join(d, '.app', 'repo.json'), rules), /exclusive: true/);
  assert.equal(sharedRefusal(path.join(d, 'src', 'a.js'), rules), null);
  assert.equal(sharedRefusal(path.join(d, 'fonts', 'a.ttf'), { ...rules, exclusive: true }), null, 'alone, everything is open');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- end to end ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-parallel-'));
const hub = path.join(dir, 'hub');
const data = path.join(dir, 'data');
const port = await freePort();
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

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
  return remote;
}
const vault = bare('brain', {
  'CLAUDE.md': '# vault\n',
  'Claude/Instructions.md': '# Instructions\n',
  'Core/Projects/Projects Index.md': '# Projects Index\n\n## No area\n',
});
const para = bare('para', {
  'README.md': '# para\n',
  '.gitignore': 'takes/\nfonts/\nrenders/\n',
  '.app/repo.json': JSON.stringify({ shared: { writable: ['renders'], addonly: ['takes', 'renders/versions'], readonly: ['fonts'] } }),
});
const auto = bare('auto', { 'README.md': '# auto\n', '.gitignore': 'renders/\nnode_modules/\n' });

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', repoBase: hub, cards: { auto: false }, autoMerge: true, repoWaitMs: 1500, limits: { checkMs: 500 } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_FAKE_GITHUB: '1' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'w'), fs.openSync(path.join(dir, 'server.log'), 'a')],
});
test.after(async () => {
  server.kill();
  if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'server.log'), 'utf8'));
  // The shared stores are protected against deleting; the test takes that off before it cleans up.
  if (win) spawnSync('icacls', [path.join(data, 'shared'), '/remove:d', `${process.env.USERDOMAIN}\\${process.env.USERNAME}`, '/T', '/C', '/Q'], { windowsHide: true });
  else spawnSync('chmod', ['-R', 'u+w', path.join(data, 'shared')]);
  return cleanup(dir, [server]);
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data: parsed };
};
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' ? t : null; }, `thread ${id} ready`, 45000);
const repoStatus = async (id) => (await call('GET', `/api/threads/${id}/repo`)).data.status;
const send = (id, text) => call('POST', `/api/threads/${id}/messages`, { text });
const hold = (name) => fs.writeFileSync(path.join(data, `hold-${name}`), '');
const letGo = (name) => fs.rmSync(path.join(data, `hold-${name}`), { force: true });
const worktree = (id, repo = 'para') => path.join(data, 'worktrees', 'fburgerdev', repo, id);
const mainCopy = (repo = 'para') => path.join(data, 'repos', 'fburgerdev', repo);
// The copy a thread works in: its worktree if it got one, the main copy otherwise.
const copyOf = (id, repo = 'para') => (fs.existsSync(path.join(worktree(id, repo), '.git')) ? worktree(id, repo) : mainCopy(repo));
const store = path.join(data, 'shared', 'fburgerdev', 'para');
const onMain = (remote = para) => git(remote, 'ls-tree', '--name-only', 'main').split('\n').filter(Boolean);
const events = async (id) => (await thread(id)).messages.filter((m) => m.event).map((m) => m.text).join('\n');
const fileOf = (title) => `CHANGED-BY-${title.replace(/[^\w]+/g, '-')}.md`;

test('the app is up', async () => {
  await until(async () => { try { return (await call('GET', '/api/state')).data.brain.brain.ready; } catch { return false; } }, 'brain cloned', 45000);
});

let A, B, C;
test('two threads in one repo: the first in the main copy, the second in a worktree made for it, the shared folders in both', async () => {
  A = (await call('POST', '/api/threads', { text: 'Alpha worker' })).data.thread;
  B = (await call('POST', '/api/threads', { text: 'Beta worker' })).data.thread;
  await ready(A.id); await ready(B.id);
  hold('pa'); hold('pb');
  await send(A.id, 'REPO-TEST=para REPO-OWN REPO-HOLD=pa go');
  await until(async () => fs.existsSync(path.join(mainCopy(), fileOf('Alpha worker'))), 'A works in the main copy', 30000);
  assert.ok(!fs.existsSync(worktree(A.id)), 'alone in the repo, no worktree is made');
  await send(B.id, 'REPO-TEST=para REPO-OWN REPO-HOLD=pb go');
  await until(async () => fs.existsSync(path.join(worktree(B.id), fileOf('Beta worker'))), 'B works beside A, in a worktree of its own', 30000);
  const [a, b] = [(await thread(A.id)).thread, (await thread(B.id)).thread];
  assert.equal(a.state, 'working'); assert.equal(b.state, 'working');
  assert.notEqual(a.repoBranch, b.repoBranch);
  // The shared folders: one store, linked into each copy, and git leaves the links alone.
  for (const copy of [mainCopy(), worktree(B.id)]) {
    for (const p of ['takes', 'fonts', 'renders']) {
      const link = path.join(copy, p);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${p} is a link in ${copy}`);
      assert.equal(path.resolve(fs.realpathSync(link)).toLowerCase(), path.resolve(fs.realpathSync(path.join(store, p))).toLowerCase());
    }
    assert.ok(!/takes|renders|fonts/.test(git(copy, 'status', '--porcelain')), 'git does not see the links');
  }
  // Add-only: a new take goes in, from either copy, and both see it.
  fs.writeFileSync(path.join(mainCopy(), 'takes', 'take1.txt'), 'first take');
  assert.equal(fs.readFileSync(path.join(worktree(B.id), 'takes', 'take1.txt'), 'utf8'), 'first take');
  // Writable: any thread writes and writes again; a protected folder inside it stays protected.
  fs.writeFileSync(path.join(mainCopy(), 'renders', 'cut.mp4'), 'cut 1');
  fs.writeFileSync(path.join(worktree(B.id), 'renders', 'cut.mp4'), 'cut 2');
  assert.equal(fs.readFileSync(path.join(mainCopy(), 'renders', 'cut.mp4'), 'utf8'), 'cut 2');
  fs.writeFileSync(path.join(worktree(B.id), 'renders', 'versions', 'v1.mp4'), 'v1');
  if (win) {
    assert.throws(() => fs.writeFileSync(path.join(worktree(B.id), 'takes', 'take1.txt'), 'over it'), /EPERM/, 'a take once written is not overwritten');
    assert.throws(() => fs.unlinkSync(path.join(worktree(B.id), 'takes', 'take1.txt')), /EPERM/, 'nor deleted');
    assert.throws(() => fs.writeFileSync(path.join(mainCopy(), 'renders', 'versions', 'v1.mp4'), 'v1 again'), /EPERM/, 'a version once written stays');
    assert.throws(() => fs.writeFileSync(path.join(worktree(B.id), 'fonts', 'a.ttf'), 'x'), /EPERM/, 'nothing goes into a read-only folder');
  }
});

test('an exclusive turn waits, is parked, and carries on by itself the moment the repo is free', async () => {
  C = (await call('POST', '/api/threads', { text: 'Gamma migration' })).data.thread;
  await ready(C.id);
  hold('pc');
  await send(C.id, 'REPO-TEST=para REPO-OWN REPO-EXCL REPO-HOLD=pc migrate');
  const parked = await until(async () => { const t = (await thread(C.id)).thread; return t.held?.kind === 'repo' ? t : null; }, 'C is parked', 30000);
  assert.equal(parked.state, 'working', 'parked, not handed back to him');
  assert.equal(parked.held.mode, 'exclusive');
  assert.match(parked.activity, /Waiting for fburgerdev\/para \(alone\)/);
  // A and B end their turns: C gets the repo alone and starts again, without a message.
  letGo('pa'); letGo('pb');
  await until(async () => fs.existsSync(path.join(copyOf(C.id), fileOf('Gamma migration'))), 'C carries on by itself', 45000);
  assert.match(await events(C.id), /fburgerdev\/para is free; the app carried on with this turn by itself/);
  assert.match(await events(C.id), /took fburgerdev\/para alone/);
  assert.equal((await repoStatus(C.id)).lock, 'exclusive');
  if (win) {
    // Alone, the shared folders are open to it.
    fs.writeFileSync(path.join(copyOf(C.id), 'fonts', 'a.ttf'), 'font');
    fs.writeFileSync(path.join(copyOf(C.id), 'takes', 'take1.txt'), 'redone');
  }
  // Meanwhile nothing of A's or B's is merged: an exclusive holder keeps the merges out too.
  assert.ok(!onMain().includes(fileOf('Alpha worker')));
  letGo('pc');
  await until(async () => ['Alpha worker', 'Beta worker', 'Gamma migration'].every((n) => onMain().includes(fileOf(n))), 'all three merged into main, one after the other', 90000);
  assert.match(git(para, 'log', '--format=%s', 'main'), /Bring main into/, 'a branch was brought up to date with main before it was tested and merged');
  await until(async () => !fs.existsSync(worktree(B.id)), 'B\'s worktree goes after its merge', 30000);
  await until(async () => git(mainCopy(), 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main', 'the main copy is back on main', 30000);
  assert.equal(fs.readFileSync(path.join(store, 'takes', 'take1.txt'), 'utf8'), win ? 'redone' : 'first take', 'the shared store outlives the worktrees');
  if (win) assert.throws(() => fs.writeFileSync(path.join(store, 'takes', 'take1.txt'), 'again'), /EPERM/, 'protected again once the exclusive turn ended');
});

test('a turn that changes the repo settings without the exclusive lock is not merged until he writes', async () => {
  const D = (await call('POST', '/api/threads', { text: 'Delta sneaky' })).data.thread;
  await ready(D.id);
  hold('pd');
  await send(D.id, 'REPO-TEST=para REPO-OWN REPO-HOLD=pd go');
  await until(async () => fs.existsSync(path.join(copyOf(D.id), fileOf('Delta sneaky'))), 'D works', 30000);
  fs.writeFileSync(path.join(copyOf(D.id), '.app', 'repo.json'), JSON.stringify({ parallel: false }));
  letGo('pd');
  await ready(D.id);
  await until(async () => /broke the rules of fburgerdev\/para's shared folders/.test(await events(D.id)), 'the breach is noted', 20000);
  await until(async () => /did not merge this branch/.test(await events(D.id)), 'and the merge refused', 20000);
  assert.ok(!onMain().includes(fileOf('Delta sneaky')));
  assert.ok((await thread(D.id)).thread.repoBreach);
});

test('a repo without settings shares what git ignores by itself, but not the folders tools make for each copy', async () => {
  const E = (await call('POST', '/api/threads', { text: 'Epsilon renders' })).data.thread;
  const F = (await call('POST', '/api/threads', { text: 'Zeta renders too' })).data.thread;
  await ready(E.id); await ready(F.id);
  // E works in the main copy and leaves a render and installed tools behind, as a pipeline would.
  hold('pe');
  await send(E.id, 'REPO-TEST=auto REPO-OWN REPO-HOLD=pe render');
  await until(async () => fs.existsSync(path.join(mainCopy('auto'), fileOf('Epsilon renders'))), 'E works', 30000);
  fs.mkdirSync(path.join(mainCopy('auto'), 'renders'), { recursive: true });
  fs.writeFileSync(path.join(mainCopy('auto'), 'renders', 'v1.mp4'), 'a render');
  fs.mkdirSync(path.join(mainCopy('auto'), 'node_modules', 'x'), { recursive: true });
  letGo('pe');
  await ready(E.id);
  // E again, and F while E works: F gets a worktree, and sees E's render through the shared folder.
  hold('pe2'); hold('pf');
  await send(E.id, 'REPO-TEST=auto REPO-HOLD=pe2 again');
  await until(async () => fs.existsSync(path.join(mainCopy('auto'), 'CHANGED-BY-CLAUDE.md')), 'E works in the main copy again', 30000);
  assert.ok(fs.lstatSync(path.join(mainCopy('auto'), 'renders')).isSymbolicLink(), 'the render folder moved into the shared store');
  await send(F.id, 'REPO-TEST=auto REPO-OWN REPO-HOLD=pf too');
  await until(async () => fs.existsSync(path.join(worktree(F.id, 'auto'), fileOf('Zeta renders too'))), 'F works in a worktree', 30000).catch(async (err) => {
    const t = (await thread(F.id)).thread;
    let here = [];
    try { here = fs.readdirSync(worktree(F.id, 'auto')); } catch { /* none */ }
    throw new Error(`${err.message}: ${JSON.stringify({ state: t.state, title: t.title, activity: t.activity, repo: t.repo, branch: t.repoBranch, here, main: fs.readdirSync(mainCopy('auto')) })}`);
  });
  assert.equal(fs.readFileSync(path.join(worktree(F.id, 'auto'), 'renders', 'v1.mp4'), 'utf8'), 'a render');
  fs.writeFileSync(path.join(worktree(F.id, 'auto'), 'renders', 'v1.mp4'), 'a better render');
  assert.equal(fs.readFileSync(path.join(mainCopy('auto'), 'renders', 'v1.mp4'), 'utf8'), 'a better render', 'shared and writable');
  assert.ok(!fs.existsSync(path.join(worktree(F.id, 'auto'), 'node_modules')), 'node_modules stays with each copy');
  assert.ok(fs.lstatSync(path.join(mainCopy('auto'), 'node_modules')).isDirectory() && !fs.lstatSync(path.join(mainCopy('auto'), 'node_modules')).isSymbolicLink());
  letGo('pe2'); letGo('pf');
  await ready(E.id); await ready(F.id);
  await until(async () => [fileOf('Epsilon renders'), 'CHANGED-BY-CLAUDE.md', fileOf('Zeta renders too')].every((f) => onMain(auto).includes(f)), 'both merged', 60000);
  assert.ok(!onMain(auto).some((f) => f === 'renders' || f === 'node_modules'), 'nothing shared went into git');
});
