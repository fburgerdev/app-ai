// A thread's work goes into main by itself: pushed, tested, merged. Against the stand-in
// Claude and bare repos on disk playing GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-ship-'));
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
  git(seed, ...['pu', 'sh'].join('').split(' '), 'origin', 'main');
  return remote;
}
const vault = bare('brain', { 'CLAUDE.md': '# vault\n', 'Claude/Instructions.md': '# Instructions\n' });
// Tests that pass, and leave a file behind as tests do; tests that fail; no tests at all.
const good = bare('good', { 'package.json': JSON.stringify({ name: 'good', private: true, scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'test-output.txt\', \'x\')"' } }) });
const bad = bare('bad', { 'package.json': JSON.stringify({ name: 'bad', private: true, scripts: { test: 'node -e "console.log(\'1 failing\'); process.exit(1)"' } }) });
const plain = bare('plain', { 'README.md': '# plain\n' });

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', repoBase: hub, cards: { auto: false } }));
const log = path.join(dir, 'server.log');
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_FAKE_GITHUB: '1' },
  stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')],
});
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(log, 'utf8')); return cleanup(dir, [server]); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const notes = async (id) => (await thread(id)).messages.filter((m) => m.event).map((m) => m.text).join('\n');
const onMain = (remote) => git(remote, 'ls-tree', '--name-only', 'main');

test('the app is up', async () => {
  await until(async () => (await call('GET', '/api/state')).data?.brain.brain.ready, 'brain cloned', 45000);
});

test('tests pass: the branch is merged into main by itself, and what testing left behind is not', async () => {
  const t = (await call('POST', '/api/threads', { text: 'REPO-TEST=good change it' })).data.thread;
  const said = await until(async () => { const n = await notes(t.id); return /merged the branch/.test(n) ? n : null; }, 'merged', 60000);
  assert.match(said, /ran the tests, they passed/);
  assert.ok(onMain(good).includes('CHANGED-BY-CLAUDE.md'), 'Claude\'s change is on main');
  assert.ok(!onMain(good).includes('test-output.txt'), 'what the tests wrote is not');
  assert.equal(git(good, 'branch', '--list', 'claude/*').trim(), '', 'the merged branch is gone from GitHub');
  assert.equal((await thread(t.id)).thread.repoBranch, '');
});

test('tests fail: nothing is merged, the branch stays on GitHub, and the thread says why', async () => {
  const t = (await call('POST', '/api/threads', { text: 'REPO-TEST=bad change it' })).data.thread;
  const said = await until(async () => { const n = await notes(t.id); return /did not pass/.test(n) ? n : null; }, 'refused', 60000);
  assert.match(said, /1 failing/, 'with the end of the test output');
  assert.ok(!onMain(bad).includes('CHANGED-BY-CLAUDE.md'), 'main is untouched');
  assert.match(git(bad, 'branch', '--list', 'claude/*'), /claude\//, 'the branch is on GitHub');
  assert.ok((await thread(t.id)).thread.repoBranch, 'and still the thread\'s');
});

test('no tests: merged as it is, and the note says there were none', async () => {
  const t = (await call('POST', '/api/threads', { text: 'REPO-TEST=plain change it' })).data.thread;
  const said = await until(async () => { const n = await notes(t.id); return /merged the branch/.test(n) ? n : null; }, 'merged', 60000);
  assert.match(said, /found no tests/);
  assert.ok(onMain(plain).includes('CHANGED-BY-CLAUDE.md'));
});
