// Claude's usage limits: a turn or a brain update they cut off is held and runs again by
// itself when the limit lifts. Units first, then the whole app with the stand-in Claude.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';
import { fromEvent, limitOf, resumeAt, clock, limitLabel, isUsageLimit } from '../server/limits.js';

test('the limit and its reset time come from Claude\'s own report, the text is the fallback', () => {
  const now = new Date(2026, 10, 18, 23, 0).getTime();
  const friday = new Date(2026, 10, 20, 9, 0).getTime();
  // Seconds since 1970, as Claude Code gives it.
  assert.deepEqual(fromEvent({ status: 'rejected', resetsAt: friday / 1000, rateLimitType: 'seven_day' }), { until: friday, type: 'seven_day' });
  assert.equal(fromEvent({ status: 'allowed_warning', resetsAt: friday / 1000 }), null);
  // The text alone says "9am": tonight's reading would be days too early. The report wins.
  const weekly = limitOf({ error: 'You\'ve hit your weekly limit · resets Fri 9am', code: 'rate_limit', seen: { until: friday, type: 'seven_day' }, now });
  assert.deepEqual(weekly, { until: friday, type: 'seven_day' });
  // No report: the clock time in the text, today or tomorrow.
  const five = limitOf({ error: 'You\'ve hit your 5-hour limit · resets 2:40am', now });
  assert.equal(new Date(five.until).getHours(), 2);
  assert.equal(new Date(five.until).getDate(), 19);
  assert.equal(five.type, 'five_hour');
  // Not a limit: a busy service, a sign-in problem, a run that went fine.
  assert.equal(limitOf({ error: 'API Error: 529 overloaded', code: 'overloaded', now }), null);
  assert.equal(limitOf({ error: 'Invalid API key · Please run /login', now }), null);
  assert.equal(limitOf({ error: '', now }), null);
  assert.ok(isUsageLimit('Claude usage limit reached'));
  // Runs again three minutes after the reset; with no time known, a quarter of an hour on.
  assert.equal(resumeAt(weekly, { now }), friday + 180_000);
  assert.equal(resumeAt({ until: 0, type: '' }, { now }), now + 900_000);
  assert.equal(clock(new Date(2026, 10, 19, 2, 43).getTime(), now), 'Thu 02:43');
  assert.equal(clock(new Date(2026, 10, 18, 23, 30).getTime(), now), '23:30');
  assert.equal(limitLabel('seven_day_opus'), 'weekly limit');
  assert.equal(limitLabel(''), 'usage limit');
});

// ---------- against the running app ----------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-limits-'));
const remote = path.join(dir, 'vault.git');
const seed = path.join(dir, 'seed');
const data = path.join(dir, 'data');
const dataRemote = path.join(dir, 'app-data.git');
const port = await freePort();
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const toRemote = ['push', 'origin', 'main'];
const fromRemote = ['pull', '-q', 'origin', 'main'];

git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'init', '--bare', '-b', 'main', dataRemote);
git(dir, 'clone', remote, seed);
for (const d of ['Core', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'seed');
git(seed, ...toRemote);

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cards: { auto: false }, limits: { marginMs: 150, checkMs: 100 } }));
const env = { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_DATA_REPO: dataRemote, APP_AI_BRAIN_REPO: remote, APP_AI_PORT: String(port) };
const start = () => spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'a'), 'inherit'] });
let server = start();
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'server.log'), 'utf8')); return cleanup(dir, [server]); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' ? t : null; }, `thread ${id} ready`);
const held = (id) => until(async () => { const t = await thread(id); return t.thread.held ? t : null; }, `thread ${id} held`);
const brainReady = () => until(async () => { const s = (await call('GET', '/api/state')).data; return s?.brain.brain.ready ? s : null; }, 'brain ready');

test('a turn cut off by the limit is held, takes what he adds, and carries on by itself', async () => {
  await brainReady();
  const id = (await call('POST', '/api/threads', { text: 'Write the plan LIMIT-TEST=1500' })).data.thread.id;
  const h = await held(id);
  assert.equal(h.thread.state, 'working', 'not in the inbox');
  assert.equal(h.thread.error, '');
  assert.equal(h.thread.held.type, 'five_hour');
  assert.match(h.thread.activity, /Held by the five-hour limit: carries on by itself at \d\d:\d\d/);
  assert.ok(h.thread.held.until > Date.now(), 'after the reset, plus the margin');
  const cut = h.messages.at(-1);
  assert.equal(cut.role, 'assistant');
  assert.deepEqual(cut.limit, { type: 'five_hour' });
  assert.equal(cut.error, undefined, 'not shown as an error');
  // A held turn is not work in progress: the laptop may hand over, the app may update.
  assert.equal((await call('GET', '/api/health')).data.busy, false);
  // What he sends meanwhile waits in the same hold.
  await call('POST', `/api/threads/${id}/messages`, { text: 'And keep it to one page.' });
  assert.ok((await thread(id)).thread.held, 'still held');

  const t = await ready(id);
  assert.equal(t.thread.held, null);
  assert.equal(t.thread.error, '');
  assert.ok(t.messages.some((m) => /five-hour limit lifted; the app carried on/.test(m.text || '')), 'the thread says what happened');
  const last = t.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.limit, undefined);
  assert.equal(t.messages.filter((m) => m.role === 'assistant').length, 2, 'one cut-off answer, one finished; the added message started no third turn');
});

test('cancelling a hold gives the thread back; a hold survives a restart of the app', async () => {
  const gone = (await call('POST', '/api/threads', { text: 'Something else LIMIT-TEST=600000' })).data.thread.id;
  await held(gone);
  assert.equal((await call('POST', `/api/threads/${gone}/stop`, {})).data.stopped, true);
  const back = await ready(gone);
  assert.equal(back.thread.held, null);
  assert.equal(back.thread.error, '');

  const id = (await call('POST', '/api/threads', { text: 'Overnight work LIMIT-TEST=4000' })).data.thread.id;
  await held(id);
  await cleanup(path.join(dir, 'nothing'), [server]);
  server = start();
  await brainReady();
  const after = await thread(id);
  assert.notEqual(after.thread.error, 'The app was closed while Claude was working on this. Send a message to pick it up again.');
  const t = await ready(id);
  assert.equal(t.thread.error, '');
  assert.equal(t.messages.at(-1).role, 'assistant');
  assert.equal(t.messages.at(-1).limit, undefined);
  assert.ok(t.messages.some((m) => /limit lifted; the app carried on/.test(m.text || '')));
});

test('a brain update cut off by the limit files nothing and runs again by itself', async () => {
  await call('PUT', '/api/pads/notes', { text: 'The board meets on 03-12-2026. BRAIN-LIMIT-TEST' });
  assert.equal((await call('POST', '/api/brain/extract', {})).data.started, true);
  const runs = async () => (await call('GET', '/api/brain/runs')).data.runs;
  const first = await until(async () => (await runs()).find((x) => x.status === 'held'), 'the held run');
  assert.match(first.error, /weekly limit was reached\. Nothing was filed; the update runs again by itself at/);
  const done = await until(async () => { const r = await runs(); return r[0].finishedAt && r[0].status !== 'held' ? r[0] : null; }, 'the second run');
  assert.equal(done.status, 'updated');
  assert.equal((await call('GET', '/api/state')).data.brain.held, null);
  git(seed, ...fromRemote);
  assert.equal(fs.readFileSync(path.join(seed, 'Core', 'App Test.md'), 'utf8').trim().split('\n').length, 1, 'the cut-off run left nothing behind');
});
