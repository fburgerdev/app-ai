// "Lock for update" (gate.js, selfupdate.js): the app never locks by itself; while locked,
// what runs finishes, everything new waits as it was sent, and once nothing runs the app
// updates and what waited starts. Units first, then the whole app with the stand-in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';
import { holdLine, resumeText, interruptedText } from '../server/retry.js';
import * as gate from '../server/gate.js';

test('the lock: its reason, another reason asked each time, and what a waiting turn shows', () => {
  assert.equal(gate.isLocked(), false);
  let handingOver = false;
  gate.alsoWhen(() => (handingOver ? 'handover' : ''));
  handingOver = true;
  assert.deepEqual(gate.status(), { locked: true, reason: 'handover', since: 0 });
  handingOver = false;
  gate.lockFor('update');
  assert.equal(gate.reason(), 'update');
  gate.unlock();
  assert.equal(gate.isLocked(), false);

  const held = { kind: 'gate', reason: 'update', until: 0, prompt: 'Draft the mail', at: new Date(2026, 10, 23, 15, 0).getTime() };
  assert.match(holdLine(held), /^Queued for the update/);
  assert.match(holdLine({ ...held, reason: 'handover' }), /^Queued for the handover/);
  const { prompt, note } = resumeText(held, new Date(2026, 10, 23, 15, 20).getTime());
  assert.equal(prompt, 'Draft the mail', 'it never started, so Claude gets it as sent');
  assert.match(note, /Queued for the update at .*15:00.*started it on .*15:20/);
  assert.equal(interruptedText(held, 'and in German'), 'Draft the mail\n\nand in German');
});

// ---------- against the running app ----------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-gate-'));
const remote = path.join(dir, 'vault.git');
const seed = path.join(dir, 'seed');
const data = path.join(dir, 'data');
const port = await freePort();
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'clone', remote, seed);
for (const d of ['Core', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'seed');
git(seed, 'push', 'origin', 'main');

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cards: { auto: false }, limits: { checkMs: 100 }, updateDrainMs: 200 }));
const env = { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_BRAIN_REPO: remote, APP_AI_DATA_REPO: '', APP_AI_PORT: String(port) };
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'a'), 'inherit'] });
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'server.log'), 'utf8')); return cleanup(dir, [server]); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const answers = (t) => t.messages.filter((m) => m.role === 'assistant');
const settled = (id, n) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' && answers(t).length >= n ? t : null; }, `thread ${id} ready with ${n} answers`);
const update = async () => (await call('GET', '/api/update')).data;

test('nothing locks by itself: a new version only shows', async () => {
  await until(async () => (await call('GET', '/api/state')).data?.brain.brain.ready, 'brain ready');
  const quiet = await update();
  assert.equal(quiet.available, '');
  assert.equal(quiet.lock.locked, false);
  await call('POST', '/api/update/fake', { version: 'abc1234def', subject: 'Lock for update' });
  const shown = await update();
  assert.equal(shown.available, 'abc1234');
  assert.equal(shown.subject, 'Lock for update');
  assert.equal(shown.lock.locked, false, 'a new version alone does not lock');
  // Taken back for the next test, which wants Claude busy first.
  await call('POST', '/api/update/fake', { version: '' });
});

test('locked: what runs finishes, the new waits, and after the update everything queued starts', async () => {
  const slow = (await call('POST', '/api/threads', { text: 'Render the long one SLOW-TEST' })).data.thread.id;
  await until(async () => (await thread(slow)).thread.state === 'working', 'the slow turn runs');
  await call('POST', '/api/update/fake', { version: 'feed5678aa' });
  const locked = (await call('POST', '/api/update/lock', { on: true })).data;
  assert.equal(locked.outcome, 'locked');
  assert.equal(locked.status.lock.reason, 'update');
  assert.ok(locked.status.waitsFor.some((w) => w.id === slow), 'it says what it waits for');

  // A new thread and the brain update wait.
  const fresh = (await call('POST', '/api/threads', { text: 'Draft the mail to the canteen' })).data.thread.id;
  const queued = await thread(fresh);
  assert.equal(queued.thread.state, 'working');
  assert.equal(queued.thread.held?.kind, 'gate');
  assert.match(queued.thread.activity, /Queued for the update/);
  assert.equal(answers(queued).length, 0, 'it has not started');
  const brain = (await call('POST', '/api/brain/extract', {})).data;
  assert.equal(brain.started, false);
  assert.equal(brain.queued, true);
  assert.match(brain.reason, /Queued for the update/);
  assert.ok((await update()).queued >= 2, 'the line counts what waits');

  // The slow turn ends by itself, the (stand-in) update goes through, and what waited starts.
  const done = await settled(slow, 1);
  assert.equal(done.thread.error, '', 'the running turn was not cut off');
  const ran = await settled(fresh, 1);
  assert.equal(ran.thread.held, null);
  assert.match(ran.messages.filter((m) => m.supervisor).map((m) => m.text).join('\n'), /Queued for the update at .*the app started it on/);
  const after = await update();
  assert.equal(after.lock.locked, false);
  assert.equal(after.available, '', 'the new version was taken');
  await until(async () => !(await call('GET', '/api/state')).data.brain.held, 'the queued brain update ran');
});

test('unlocking by hand starts what waited at once', async () => {
  await call('POST', '/api/update/fake', { version: 'beef9999cc' });
  const slow = (await call('POST', '/api/threads', { text: 'Another long one SLOW-TEST' })).data.thread.id;
  await until(async () => (await thread(slow)).thread.state === 'working', 'the slow turn runs');
  await call('POST', '/api/update/lock', { on: true });
  const fresh = (await call('POST', '/api/threads', { text: 'Quick question' })).data.thread.id;
  assert.equal((await thread(fresh)).thread.held?.kind, 'gate');
  // He writes again into it while it waits: it goes along, still queued.
  await call('POST', `/api/threads/${fresh}/messages`, { text: 'and one more thing' });
  const both = await thread(fresh);
  assert.equal(both.thread.held?.kind, 'gate');
  assert.match(both.thread.held.prompt, /Quick question\n\nand one more thing/);
  const off = (await call('POST', '/api/update/lock', { on: false })).data;
  assert.equal(off.status.lock.locked, false);
  const ran = await settled(fresh, 1);
  assert.equal(ran.thread.held, null);
  await settled(slow, 1);
  assert.equal((await update()).available, 'beef999', 'unlocked, the new version is still offered');
});
