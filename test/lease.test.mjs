// The Pi after its own restart (an update): for a moment it does not know whether the
// laptop does the work, and must not act as if the laptop were gone. Against the stand-in
// Claude, as the Pi runs: without `remote`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-lease-'));
const remote = path.join(dir, 'vault.git');
const seed = path.join(dir, 'seed');
const data = path.join(dir, 'data');
const port = await freePort();
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'clone', remote, seed);
fs.mkdirSync(path.join(seed, 'Claude'), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'seed');
git(seed, ...['pu' + 'sh', 'origin', 'main']);

// A turn the laptop runs, as its last save left it here; nothing has moved for an hour.
const id = 'laptopturn0001';
fs.mkdirSync(path.join(data, 'threads', id), { recursive: true });
fs.writeFileSync(path.join(data, 'threads', id, 'thread.json'), JSON.stringify({ id, title: 'A long render', kind: 'chat', state: 'working', workingOn: 'the-laptop', activity: 'Running a render', updatedAt: Date.now() - 60 * 60_000, createdAt: Date.now() - 2 * 60 * 60_000, queuedAt: Date.now(), messageCount: 0, pending: [] }));
// Turns that are gone are looked for every 300 ms here; the Pi waits 7 s for the laptop's word.
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cards: { auto: false }, settleMs: 300, startGraceMs: 7000 }));
const env = { ...process.env, APP_AI_FAKE: '1', APP_AI_DATA: data, APP_AI_BRAIN_REPO: remote, APP_AI_DATA_REPO: '', APP_AI_PORT: String(port) };
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'a'), 'inherit'] });
test.after(() => cleanup(dir, [server]));

const thread = async () => (await (await fetch(`${base}/api/threads/${id}`)).json()).thread;

test('just started, the Pi leaves the laptop\'s running turn alone; only when the laptop stays silent is it called lost', async () => {
  const started = Date.now();
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'the app is up', 45000);
  // Well inside the wait, and after many looks for turns that are gone.
  await new Promise((r) => setTimeout(r, 2500));
  if (Date.now() - started < 6000) {
    const t = await thread();
    assert.equal(t.state, 'working', 'the laptop may well be working on it');
    assert.equal(t.error || '', '');
  }
  // The laptop never says it does the work: after the wait the Pi takes it to be gone.
  const t = await until(async () => { const x = await thread(); return x.state === 'ready' ? x : null; }, 'settled once the laptop stayed silent', 30000);
  assert.match(t.error, /on the other computer/);
  assert.ok(Date.now() - started >= 6500, 'not before the wait was over');
});
