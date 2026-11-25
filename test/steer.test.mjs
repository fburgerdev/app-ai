// What he sends while Claude works, and the supervisor. "Add" goes into the running turn
// and stands in the conversation where Claude read it; "Next" waits and runs after the
// turn, unless the supervisor holds it; a reply that only waited for a go-ahead is
// carried on by itself; a broken line to Claude Code is tried again. Units first, then
// the whole app with the stand-in Claude.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';
import { turnPlan, holdLine, resumeText, interruptedText } from '../server/retry.js';
import { parseVerdict, fakeVerdict } from '../server/supervise.js';
import { turnOver } from '../server/agent.js';

test('the line to Claude Code stays open while a background job can still wake Claude', () => {
  // The reply is in and nothing runs: the turn is over.
  assert.equal(turnOver({ resultSeen: true, idle: true }), true);
  // "Started" while a render runs in the background: every reply used to close the line
  // here, and the tool call after the render failed with "Stream closed" (25-11-2026).
  assert.equal(turnOver({ resultSeen: true, background: 1, idle: true }), false);
  assert.equal(turnOver({ resultSeen: true, background: 1, quietMs: 3_600_000 }), false);
  // The job ended: Claude is woken within a second, so a short silence is no end yet...
  assert.equal(turnOver({ resultSeen: true, background: 0, quietMs: 5_000 }), false);
  // ...and when it was woken, the reply seen before no longer counts, however long it thinks.
  assert.equal(turnOver({ resultSeen: false, background: 0, quietMs: 600_000 }), false);
  // No wake came at all: over.
  assert.equal(turnOver({ resultSeen: true, background: 0, quietMs: 31_000 }), true);
  // Something he added still waits to go in, or a tool call is open: not over.
  assert.equal(turnOver({ resultSeen: true, queued: 1, idle: true }), false);
  assert.equal(turnOver({ resultSeen: true, inFlight: 1, idle: true }), false);
});

const now = new Date(2026, 10, 23, 14, 0).getTime();

test('the supervisor\'s answer is read safely, and leans towards running what he queued', () => {
  assert.deepEqual(parseVerdict('{"verdict":"goahead","next":"run","why":"only asked to go on"}'), { verdict: 'goahead', next: 'run', why: 'only asked to go on' });
  assert.deepEqual(parseVerdict('Sure: {"verdict":"NEEDS","next":"hold","why":"asks which"}'), { verdict: 'needs', next: 'hold', why: 'asks which' });
  assert.deepEqual(parseVerdict('no json'), { verdict: 'done', next: 'run', why: '' });
  assert.equal(parseVerdict('{"verdict":"maybe","next":"later"}').next, 'run');
  assert.equal(fakeVerdict({ reply: 'Done. When you\'re back, say go on.' }).verdict, 'goahead');
});

test('a reply that only waited for a go-ahead carries on by itself, within the same bounds', () => {
  const opts = { maxRuns: 10, goaheadDelayMs: 60_000 };
  const plan = turnPlan({ auto: null, goahead: 'it only asked to go on', didWork: true, opts, now });
  assert.equal(plan.kind, 'goahead');
  assert.equal(plan.until, now + 60_000);
  assert.equal(plan.auto.runs, 1);
  // A reply in which nothing was done is left to him, and so is the tenth run.
  assert.equal(turnPlan({ auto: null, goahead: 'x', didWork: false, opts, now }), null);
  assert.match(turnPlan({ auto: { runs: 10 }, goahead: 'x', didWork: true, opts, now }).stop, /10 times by itself/);
  // An error goes first.
  assert.equal(turnPlan({ auto: null, error: 'Stream closed', goahead: 'x', didWork: true, opts, now }).kind, 'retry');
  // Ten automatic runs, not twenty, by default.
  assert.match(turnPlan({ auto: { runs: 10 }, carryOn: { minutes: 5 }, now }).stop, /10 times/);
  const held = { kind: 'goahead', until: now + 60_000, reason: 'it only asked to go on', prompt: 'Render v14', at: now, tries: 1 };
  assert.match(holdLine(held, now), /only needed a go-ahead: the supervisor carries on at/);
  const r = resumeText(held, now);
  assert.match(r.prompt, /^\[Supervisor \(the app, not Florian\): your last reply only waited for a go-ahead/);
  assert.match(r.prompt, /Render v14$/);
  assert.match(r.note, /the supervisor told it to carry on/);
  assert.match(interruptedText(held, 'Stop, use v13'), /Florian wrote first.*\n\nStop, use v13$/s);
});

// ---------- against the running app ----------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-steer-'));
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
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cards: { auto: false }, limits: { checkMs: 100 }, autoRetry: { backoffMin: [0.002], continueMinMin: 0, goaheadDelayMs: 50 } }));
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
const brainReady = () => until(async () => { const s = (await call('GET', '/api/state')).data; return s?.brain.brain.ready ? s : null; }, 'brain ready');
// The stand-in is in its slow step: it waits on a background job, and reads what comes in.
const inJob = (id) => until(async () => { const t = await thread(id); return /Running in the background: the slow test job/.test(t.thread.activity || '') ? t : null; }, 'the background job running');
const shape = (t) => t.messages.map((m) => (m.role === 'assistant' ? 'claude' : m.supervisor ? 'supervisor' : m.event ? 'event' : m.steered ? 'added' : m.queuedAt ? 'next' : 'you'));

test('"Add" goes into the running turn and stands where Claude read it', async () => {
  await brainReady();
  const id = (await call('POST', '/api/threads', { text: 'Long job SLOW-TEST' })).data.thread.id;
  const during = await inJob(id);
  assert.equal(during.thread.background[0].description, 'the slow test job', 'the page sees the job');
  const sent = await call('POST', `/api/threads/${id}/messages`, { text: 'Also check the subtitles', mode: 'add' });
  assert.equal(sent.data.message.steered, true);
  const t = await settled(id, 1);
  assert.deepEqual(shape(t), ['you', 'added', 'claude']);
  assert.match(answers(t)[0].parts.find((p) => p.type === 'text').text, /Read what you added: \[Florian added this while you were working.*\n\nAlso check the subtitles/s);
  assert.deepEqual(t.thread.queued || [], []);
  assert.deepEqual(t.thread.background, []);
});

test('"Next" waits for the turn to end, then runs after Claude\'s reply, with the tier he picked', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Long job SLOW-TEST' })).data.thread.id;
  await inJob(id);
  const sent = await call('POST', `/api/threads/${id}/messages`, { text: 'Then write the summary', mode: 'next', tier: 'cheap' });
  assert.equal(sent.data.message, null, 'not in the conversation yet');
  assert.equal(sent.data.thread.queued.length, 1);
  assert.equal((await thread(id)).messages.length, 1);
  const t = await settled(id, 2);
  assert.deepEqual(shape(t), ['you', 'claude', 'next', 'claude']);
  assert.equal(t.messages[2].text, 'Then write the summary');
  assert.equal(answers(t)[1].tier, 'cheap');
  assert.deepEqual(t.thread.queued, []);
});

test('the supervisor holds a "Next" when the reply asks him something, and he runs it', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Long job SLOW-TEST DECIDE-TEST' })).data.thread.id;
  await inJob(id);
  await call('POST', `/api/threads/${id}/messages`, { text: 'Then send it out', mode: 'next' });
  const held = await until(async () => { const x = await thread(id); return x.thread.state === 'ready' && x.thread.queuedHeld ? x : null; }, 'held');
  assert.equal(held.thread.queued.length, 1);
  assert.match(held.thread.queuedHeld, /asked you something/);
  assert.deepEqual(shape(held), ['you', 'claude', 'supervisor']);
  assert.match(held.messages.at(-1).text, /The supervisor held what you queued/);
  const ran = await call('POST', `/api/threads/${id}/queued/run`, {});
  assert.equal(ran.status, 200);
  const t = await settled(id, 2);
  assert.deepEqual(shape(t), ['you', 'claude', 'supervisor', 'next', 'claude']);
  assert.deepEqual(t.thread.queued, []);
  assert.equal(t.thread.queuedHeld, '');
});

test('a held "Next" goes in before his new message; one can be taken back', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Long job SLOW-TEST DECIDE-TEST' })).data.thread.id;
  await inJob(id);
  await call('POST', `/api/threads/${id}/messages`, { text: 'First queued', mode: 'next' });
  await call('POST', `/api/threads/${id}/messages`, { text: 'Second queued', mode: 'next' });
  const held = await until(async () => { const x = await thread(id); return x.thread.state === 'ready' && x.thread.queuedHeld ? x : null; }, 'held');
  const second = held.thread.queued.find((q) => q.text === "Second queued");
  assert.ok(second, JSON.stringify(held.thread.queued) + JSON.stringify(held.messages.map((m) => m.text)));
  const dropped = await call('DELETE', `/api/threads/${id}/queued/${second.id}`, {});
  assert.equal(dropped.data.item.text, 'Second queued');
  assert.equal(dropped.data.thread.queued.length, 1);
  await call('POST', `/api/threads/${id}/messages`, { text: 'Option two' });
  const t = await settled(id, 2);
  assert.deepEqual(t.messages.filter((m) => m.role === 'user' && !m.event).map((m) => m.text), ['Long job SLOW-TEST DECIDE-TEST', 'First queued', 'Option two']);
  assert.deepEqual(t.thread.queued, []);
});

test('a reply that only waits for a go-ahead is carried on by the supervisor, visibly', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Render both halves GOAHEAD-TEST' })).data.thread.id;
  const t = await settled(id, 2);
  assert.deepEqual(shape(t), ['you', 'claude', 'supervisor', 'claude']);
  const note = t.messages[2];
  assert.match(note.text, /only needed a go-ahead/);
  assert.match(note.prompt, /^\[Supervisor \(the app, not Florian\)/);
  assert.equal(t.thread.held, null);
});

test('a turn whose line to Claude Code broke ("Stream closed") is tried again by itself', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Render the chapter STREAM-TEST' })).data.thread.id;
  const t = await settled(id, 2);
  assert.match(answers(t)[0].error, /Stream closed/);
  assert.equal(answers(t)[1].error, undefined);
  assert.ok(t.messages.some((m) => m.supervisor && /tried again by itself/.test(m.text)), 'the supervisor says it tried again');
  assert.equal(t.thread.error, '');
});
