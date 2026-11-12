// Events from the calendar, threads finding their project by themselves, and the lease
// that keeps background work to one computer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showAtFor } from '../server/events.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('when an event thread opens', () => {
  const start = new Date(2026, 10, 20, 15, 0).getTime();
  assert.equal(showAtFor(start, true), start - 24 * 3600_000, 'important: a day before');
  assert.equal(showAtFor(start, false), new Date(2026, 10, 20, 7, 0).getTime(), 'smaller: 07:00 on the day');
  const early = new Date(2026, 10, 20, 7, 30).getTime();
  assert.equal(showAtFor(early, false), early - 3600_000, 'but at least an hour before');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-events-'));
const vault = path.join(dir, 'vault.git');
const data = path.join(dir, 'data');
const port = 6900 + Math.floor(Math.random() * 300);
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
git(dir, 'init', '--bare', '-b', 'main', vault);
const seed = path.join(dir, 'seed');
git(dir, 'clone', vault, seed);
for (const d of ['Brain/Projects', 'Brain/Areas', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Areas', 'Campaign.md'), '# Campaign\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Mensa Tracker.md'), '# Mensa Tracker\n\nStatus: active\nrepo: `fburgerdev/website-stuwerke`\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## [[Campaign]]\n\n- [[Mensa Tracker]] — the website\n');
git(seed, 'checkout', '-B', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', cards: { auto: false } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data }, stdio: ['ignore', fs.openSync(path.join(dir, 'log'), 'w'), 'inherit'] });
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'log'), 'utf8')); });
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); }
  throw new Error(`timed out: ${what}`);
}
const state = async () => (await call('GET', '/api/state')).data;
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' && t.messages.some((m) => m.role === 'assistant') ? t : null; }, `thread ${id} answered`);

test('the app is up', async () => {
  await until(async () => (await state()).brain.brain.ready, 'brain cloned', 40000);
});

test('a thread finds its project by itself, after its first answer, and takes the project\'s repo', async () => {
  const t = (await call('POST', '/api/threads', { text: 'Let us add the Bavarian Studierendenwerke to the mensa tracker' })).data.thread;
  assert.equal(t.project, '', 'not chosen when it was started');
  const done = await until(async () => { const x = (await thread(t.id)).thread; return x.projectGuessed ? x : null; }, 'guessed');
  assert.equal(done.project, 'Mensa Tracker');
  assert.equal(done.repo, 'fburgerdev/website-stuwerke');
  // None fits: it stays without, and is not asked again.
  const loose = (await call('POST', '/api/threads', { text: 'What is a good book on game theory?' })).data.thread;
  const x = await until(async () => { const y = (await thread(loose.id)).thread; return y.projectGuessed ? y : null; }, 'guessed none');
  assert.equal(x.project, '');
  // What Florian sets stands.
  const mine = (await call('POST', '/api/threads', { text: 'Campaign or the tracker?' })).data.thread;
  await call('POST', `/api/threads/${mine.id}/project`, { project: 'Campaign' });
  await ready(mine.id);
  await sleep(300);
  assert.equal((await thread(mine.id)).thread.project, 'Campaign');
});

test('an event close enough opens with its briefing, outside the inbox, and stays until done', async () => {
  // The stand-in's calendar has the fair two hours from now when a thread says EVENT-SOON.
  await call('POST', '/api/threads', { text: 'EVENT-SOON marker for the stand-in calendar' });
  await call('POST', '/api/cards/make', {});
  const fair = await until(async () => (await state()).threads.find((t) => t.kind === 'event' && t.title === 'Example fair' && t.messageCount > 1), 'fair opened');
  assert.equal(fair.hidden, false);
  assert.equal(fair.event.started, true);
  const t = await ready(fair.id);
  assert.match(t.messages[0].text, /^This is the thread for an entry in Florian's calendar: Example fair/);
  assert.match(t.messages[0].text, /prepare before the entry and to debrief after it/);
  assert.ok(!(await state()).queue.order.includes(fair.id), 'not in the inbox');
  // The smaller call two hours from now opens too: its morning has passed, an hour before at the latest.
  const small = (await state()).threads.find((t2) => t2.kind === 'event' && t2.title === 'Call with the example office');
  assert.equal(small.event.important, false);
  // Prepare, debrief, done.
  await call('POST', `/api/threads/${fair.id}/messages`, { text: 'What should I bring?' });
  await until(async () => (await thread(fair.id)).messages.filter((m) => m.role === 'assistant').length >= 2, 'second answer');
  assert.ok(!(await state()).queue.order.includes(fair.id));
  await call('POST', `/api/threads/${fair.id}/state`, { state: 'done' });
  assert.equal((await thread(fair.id)).thread.state, 'done');
});

test('on the Pi, background work waits while the laptop holds the lease', async () => {
  const link = await import('../server/link.js');
  assert.equal(link.mayRunBackground(), true);
  link.takeLease(true);
  assert.equal(link.mayRunBackground(), false);
  assert.equal(link.leaseHeld(), true);
  link.takeLease(false);
  assert.equal(link.mayRunBackground(), true);
});
