// The laptop in front of the Pi: two copies of the app sharing one data repo. The laptop
// passes the page on to the Pi while it is there, works by itself when it is not, and
// the threads move over through the data repo when the side changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-link-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vault = path.join(dir, 'brain.git');
const dataRepo = path.join(dir, 'data.git');
git(dir, 'init', '--bare', '-b', 'main', vault);
git(dir, 'init', '--bare', '-b', 'main', dataRepo);
const seed = path.join(dir, 'seed');
git(dir, 'clone', vault, seed);
fs.mkdirSync(path.join(seed, 'Claude'), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
git(seed, 'checkout', '-B', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');

const piPort = 6200 + Math.floor(Math.random() * 300);
const lapPort = piPort + 400;
const pi = `http://127.0.0.1:${piPort}`;
const lap = `http://127.0.0.1:${lapPort}`;
const procs = {};
function start(name, port, extra = {}) {
  const data = path.join(dir, name);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo, cards: { auto: false }, ...extra }));
  const out = fs.openSync(path.join(dir, `${name}.log`), 'a');
  procs[name] = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data }, stdio: ['ignore', out, out] });
}
const stop = (name) => new Promise((r) => { procs[name].once('exit', r); procs[name].kill(); });
test.after(() => { for (const p of Object.values(procs)) p.kill(); if (process.env.KEEP) for (const n of ['pi', 'laptop']) console.log(fs.readFileSync(path.join(dir, `${n}.log`), 'utf8')); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (base, method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
};
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}
const up = (base) => until(async () => (await call(base, 'GET', '/api/health')).data.ok, `${base} up`);
const threads = async (base) => (await call(base, 'GET', '/api/state')).data.threads;
const thread = async (base, id) => (await call(base, 'GET', `/api/threads/${id}`)).data;
const answered = (base, id, n) => until(async () => { const t = await thread(base, id); return t.thread.state === 'ready' && t.messages.filter((m) => m.role === 'assistant').length >= n ? t : null; }, `answer ${n} in ${id}`);
const linkIs = (active) => until(async () => { const l = (await call(lap, 'GET', '/api/link')).data; return l.active === active && !l.switching ? l : null; }, `laptop on ${active}`);

let first; let second;

test('the laptop does the work; the Pi hears about what it saves', async () => {
  start('pi', piPort);
  await up(pi);
  start('laptop', lapPort, { remote: pi, remoteCheckSeconds: 1 });
  await up(lap);
  const l = await until(async () => { const x = (await call(lap, 'GET', '/api/link')).data; return x.online ? x : null; }, 'laptop sees the Pi');
  assert.equal(l.enabled, true);
  assert.equal(l.active, 'local');
  assert.equal((await call(pi, 'GET', '/api/link')).data.enabled, false, 'the Pi has no switch');
  first = (await call(lap, 'POST', '/api/threads', { text: 'Started on the laptop' })).data.thread;
  await answered(lap, first.id, 1);
  assert.ok(fs.existsSync(path.join(dir, 'laptop', 'threads', first.id)));
  assert.ok(!(await threads(pi)).some((t) => t.id === first.id), 'not on the Pi yet');
  await call(lap, 'POST', '/api/sync/push', {}); // what its timer does every two minutes
  await until(async () => (await threads(pi)).some((t) => t.id === first.id), 'the Pi took it in without being asked by hand');
});

test('handing over: everything moves to the Pi and the page is passed on', async () => {
  await call(lap, 'POST', `/api/threads/${first.id}/messages`, { text: 'Last thing before the laptop sleeps' });
  await answered(lap, first.id, 2);
  await call(lap, 'POST', '/api/link', { choice: 'remote' });
  const l = await linkIs('remote');
  assert.equal(l.step, '');
  assert.ok(l.handedOverAt > 0);
  const st = (await call(lap, 'GET', '/api/status')).data;
  assert.equal(st.stage, 'safe', 'handed over: the laptop can sleep');
  assert.equal(st.locked, true);
  assert.equal((await thread(pi, first.id)).messages.length, 4, 'the Pi has the whole conversation');
  await call(lap, 'POST', `/api/threads/${first.id}/messages`, { text: 'Now through the Pi' });
  await answered(pi, first.id, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'laptop', 'threads', first.id, 'thread.json'), 'utf8')).messageCount, 4, 'the laptop rests');
  // Live updates are passed on too.
  const res = await fetch(`${lap}/api/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  await res.body.cancel();
});

test('the Pi goes off while it has everything: the laptop takes over with what the Pi had saved', async () => {
  await call(pi, 'POST', '/api/sync/push', {});
  await stop('pi');
  const l = await linkIs('local');
  assert.equal(l.online, false);
  assert.equal(l.choice, 'local');
  assert.match(l.note, /stopped answering/);
  assert.equal((await thread(lap, first.id)).messages.length, 6, 'came over through the data repo');
  second = (await call(lap, 'POST', '/api/threads', { text: 'Started on the laptop alone' })).data.thread;
  await answered(lap, second.id, 1);
  await call(lap, 'POST', '/api/link', { choice: 'remote' });
  await sleep(1500);
  assert.equal((await call(lap, 'GET', '/api/link')).data.active, 'local', 'no handing over to a Pi that is off');
});

test('the Pi comes back: the laptop stays, work on both sides merges, taking back works', async () => {
  start('pi', piPort);
  await up(pi);
  await until(async () => (await call(lap, 'GET', '/api/link')).data.online, 'laptop sees the Pi again');
  assert.equal((await call(lap, 'GET', '/api/link')).data.active, 'local');
  // The same thread continued on both (the phone talks to the Pi), and a new one on each.
  await call(pi, 'POST', `/api/threads/${first.id}/messages`, { text: 'Said on the Pi (from the phone)' });
  await answered(pi, first.id, 4);
  const piOnly = (await call(pi, 'POST', '/api/threads', { text: 'From the phone' })).data.thread;
  await answered(pi, piOnly.id, 1);
  await call(pi, 'POST', '/api/sync/push', {});
  await call(lap, 'POST', `/api/threads/${first.id}/messages`, { text: 'Said on the laptop' });
  await answered(lap, first.id, 4);

  await call(lap, 'POST', '/api/link', { choice: 'remote' });
  await linkIs('remote');
  const all = await threads(pi);
  assert.ok(all.some((t) => t.id === piOnly.id) && all.some((t) => t.id === second.id), 'threads of both sides are there');
  const merged = await thread(pi, first.id);
  const said = merged.messages.map((m) => m.text);
  assert.ok(said.includes('Said on the Pi (from the phone)') && said.includes('Said on the laptop'), 'both sides of the conversation are kept');
  assert.equal(merged.messages.length, 10);
  assert.equal(merged.thread.messageCount, 10);

  await call(lap, 'POST', `/api/threads/${piOnly.id}/messages`, { text: 'More, on the Pi' });
  await answered(pi, piOnly.id, 2);
  await call(lap, 'POST', '/api/link', { choice: 'local' });
  await linkIs('local');
  assert.equal((await thread(lap, piOnly.id)).messages.length, 4, 'the Pi saved before the laptop took everything back');
  assert.equal((await thread(lap, first.id)).messages.length, 10);
});

test('the background work runs on one side only; the status says when the laptop can sleep', async () => {
  // Doing the work, the laptop holds the lease: the Pi makes no cards of its own.
  await until(async () => (await call(pi, 'GET', '/api/status')).data && true, 'pi status');
  await call(lap, 'POST', '/api/link', { choice: 'local' });
  await linkIs('local');
  await sleep(1500);
  const st = await until(async () => { const x = (await call(lap, 'GET', '/api/status')).data; return x.busy.threads.length === 0 && x.saved.files === 0 && x.saved.ahead === 0 ? x : null; }, 'all saved', 20000).catch(async () => (await call(lap, 'GET', '/api/status')).data);
  assert.equal(st.show, true);
  assert.equal(st.link.active, 'local');
  await call(lap, 'POST', '/api/status/save', {});
  const after = (await call(lap, 'GET', '/api/status')).data;
  assert.equal(after.saved.files, 0);
  assert.equal(after.saved.ahead, 0);
  assert.equal(after.stage, 'idle', 'nothing running, but nothing locked either');
  assert.equal(after.safe, false);
  // A turn running: not safe.
  const t = (await call(lap, 'POST', '/api/threads', { text: 'Something slow SLOW-TEST' })).data.thread;
  const during = await until(async () => { const x = (await call(lap, 'GET', '/api/status')).data; return x.busy.threads.length ? x : null; }, 'busy seen', 5000);
  assert.equal(during.stage, 'busy');
  assert.equal(during.busy.threads[0].id, t.id);
});
