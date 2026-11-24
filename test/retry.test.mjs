// Work that stalls carries on by itself: a turn that ended on an error is tried again, a
// turn in which Claude called continue_later is carried on, and the safety handles stop
// it. Units first, then the whole app with the stand-in Claude.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';
import { turnPlan, mergePlan, mergeFailure, retryable, holdLine, resumeText, interruptedText } from '../server/retry.js';

const now = new Date(2026, 10, 22, 14, 0).getTime();
const opts = { maxRuns: 5, errorTries: 3, backoffMin: [1, 4, 15], mergeFixes: 2, remerges: 3, remergeMin: 5, mergeFixDelayMs: 20_000 };

test('an error is tried again after a pause that grows, and stops when nothing gets done', () => {
  const first = turnPlan({ auto: null, error: 'API Error: Request timed out.', opts, now });
  assert.equal(first.kind, 'retry');
  assert.equal(first.until, now + 60_000);
  assert.deepEqual(first.auto, { runs: 1, fails: 1 });
  const second = turnPlan({ auto: first.auto, error: 'Stream closed', opts, now });
  assert.equal(second.until, now + 4 * 60_000);
  const third = turnPlan({ auto: second.auto, error: 'Stream closed', opts, now });
  assert.equal(third.until, now + 15 * 60_000);
  const fourth = turnPlan({ auto: third.auto, error: 'Stream closed', opts, now });
  assert.equal(fourth.kind, undefined);
  assert.match(fourth.stop, /4 times in a row without getting anything done/);
  // A try that got work done counts as progress: the pause starts small again.
  const moved = turnPlan({ auto: third.auto, error: 'Stream closed', didWork: true, opts, now });
  assert.equal(moved.kind, 'retry');
  assert.equal(moved.until, now + 60_000);
  // But never more than maxRuns automatic turns since his last message.
  assert.match(turnPlan({ auto: { runs: 5, fails: 0 }, error: 'Stream closed', didWork: true, opts, now }).stop, /already ran 5 times/);
});

test('errors no retry can fix are left to him; nothing happens when switched off or all went well', () => {
  assert.equal(retryable('Claude is not signed in on this computer. Run "npm run login"'), false);
  assert.equal(retryable('Prompt is too long'), false);
  assert.equal(retryable(''), false);
  assert.equal(retryable('API Error: Can\'t reach the API server (ENOTFOUND)'), true);
  assert.equal(turnPlan({ auto: null, error: 'Invalid API key · Please run /login', opts, now }), null);
  assert.equal(turnPlan({ auto: null, error: 'Stream closed', opts: { ...opts, enabled: false }, now }), null);
  assert.equal(turnPlan({ auto: null, error: '', opts, now }), null);
});

test('continue_later carries on when Claude asked, within bounds, and counts as a run', () => {
  const plan = turnPlan({ auto: { runs: 2, fails: 2 }, carryOn: { minutes: 12, why: 'the v14 render' }, opts, now });
  assert.equal(plan.kind, 'continue');
  assert.equal(plan.until, now + 12 * 60_000);
  assert.equal(plan.reason, 'the v14 render');
  assert.deepEqual(plan.auto, { runs: 3, fails: 0 });
  assert.equal(turnPlan({ auto: null, carryOn: { minutes: 500, why: 'x' }, opts, now }).until, now + 60 * 60_000);
  assert.match(turnPlan({ auto: { runs: 5 }, carryOn: { minutes: 5, why: 'x' }, opts, now }).stop, /already ran 5 times/);
  // An error wins over a continue_later in the same turn.
  assert.equal(turnPlan({ auto: null, error: 'Stream closed', carryOn: { minutes: 5 }, opts, now }).kind, 'retry');
});

test('a failed merge: fixed by a turn for tests and clashes, only retried for the rest, and not forever', () => {
  assert.equal(mergeFailure('Main has changed in a way that clashes with this branch. Ask Claude …'), 'clash');
  assert.equal(mergeFailure('There is nothing on this branch that main does not have.'), '');
  assert.equal(mergeFailure('could not resolve host github.com'), 'other');
  const fix = mergePlan({ auto: null, failure: 'tests', opts, now });
  assert.equal(fix.kind, 'merge');
  assert.equal(fix.until, now + 20_000);
  const again = mergePlan({ auto: fix.auto, failure: 'clash', opts, now });
  assert.equal(again.tries, 2);
  assert.match(mergePlan({ auto: again.auto, failure: 'tests', opts, now }).stop, /already tried to fix it 2 times/);
  const remerge = mergePlan({ auto: null, failure: 'other', opts, now });
  assert.equal(remerge.kind, 'remerge');
  assert.equal(remerge.at, now + 5 * 60_000);
  assert.match(mergePlan({ auto: { remerges: 3 }, failure: 'other', opts, now }).stop, /tried the merge 3 more times/);
  assert.equal(mergePlan({ auto: null, failure: '', opts, now }), null);
});

test('what the thread shows and what Claude is told', () => {
  const held = { kind: 'continue', until: now + 10 * 60_000, reason: 'the render', prompt: 'Render v14', at: now, tries: 1 };
  assert.equal(holdLine(held, now), 'Waiting (the render): carries on by itself at 14:10');
  const { prompt, note } = resumeText(held, now);
  assert.match(prompt, /you called continue_later \("the render"\)/);
  assert.match(prompt, /Render v14$/);
  assert.match(note, /Claude was waiting for the render; the app carried on by itself/);
  const retried = resumeText({ ...held, kind: 'retry', reason: 'Stream closed', tries: 2 }, now);
  assert.match(retried.prompt, /ended on an error .*"Stream closed".*automatic try 2/s);
  assert.match(retried.note, /try 2/);
  assert.match(interruptedText({ ...held, kind: 'retry', reason: 'Stream closed' }, 'Use v13 instead'), /Render v14\n\n\[Florian's new message:\]\n\nUse v13 instead$/);
});

test('a turn cut off by a restart of the app is not called an error', () => {
  const held = { kind: 'retry', restart: true, until: now, reason: 'the app restarted in the middle of the turn', prompt: 'Render v14', at: now, tries: 1 };
  assert.equal(holdLine(held, now), 'The app restarted mid-turn: carries on by itself now');
  const { prompt, note } = resumeText(held, now);
  assert.ok(!/error/i.test(note) && !/ended on an error/.test(prompt), 'nothing failed');
  assert.match(note, /The app restarted in the middle of this turn; it carried on by itself/);
  assert.match(prompt, /Render v14$/);
  assert.match(interruptedText(held, 'Use v13 instead'), /was cut off when the app restarted/);
  // A restart is a run of the app's own, never one of the errors in a row that stop a thread.
  const plan = turnPlan({ auto: { runs: 2, fails: 3 }, error: held.reason, didWork: true, now });
  assert.equal(plan.kind, 'retry');
  assert.equal(plan.auto.runs, 3);
});

// ---------- against the running app ----------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-retry-'));
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
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cards: { auto: false }, limits: { checkMs: 100 }, autoRetry: { backoffMin: [0.002], continueMinMin: 0 } }));
const env = { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_BRAIN_REPO: remote, APP_AI_DATA_REPO: '', APP_AI_PORT: String(port) };
const start = () => spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'a'), 'inherit'] });
let server = start();
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'server.log'), 'utf8')); return cleanup(dir, [server]); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const answers = (t) => t.messages.filter((m) => m.role === 'assistant');
const notes = (t) => t.messages.filter((m) => m.event).map((m) => m.text).join('\n');
const settled = (id, n) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' && answers(t).length >= n ? t : null; }, `thread ${id} ready with ${n} answers`);
const brainReady = () => until(async () => { const s = (await call('GET', '/api/state')).data; return s?.brain.brain.ready ? s : null; }, 'brain ready');

test('a turn that ended on an error is tried again by itself and then finishes', async () => {
  await brainReady();
  const id = (await call('POST', '/api/threads', { text: 'Render the chapter RETRY-TEST' })).data.thread.id;
  const t = await settled(id, 2);
  assert.equal(t.thread.error, '', 'the try that went through clears the error');
  assert.match(answers(t)[0].error, /timed out/);
  assert.equal(answers(t)[1].error, undefined);
  assert.match(notes(t), /ended on an error .*the app tried again by itself on .* \(try 1\)/);
  assert.equal(t.thread.held, null);
});

test('a turn that keeps failing without getting anything done stops by itself and comes back to him', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Build it RETRY-ALWAYS' })).data.thread.id;
  const t = await until(async () => { const x = await thread(id); return x.thread.state === 'ready' && /stopped carrying on by itself/.test(notes(x)) ? x : null; }, 'gave up');
  assert.equal(answers(t).length, 4, 'his turn and three tries');
  assert.match(t.thread.error, /timed out/);
  assert.match(notes(t), /4 times in a row without getting anything done\. Send a message to pick it up again/);
  // His message sets the count back: the app tries again for this one.
  await call('POST', `/api/threads/${id}/messages`, { text: 'Try it once more RETRY-ALWAYS' });
  await until(async () => { const x = await thread(id); return x.thread.state === 'ready' && answers(x).length === 8 ? x : null; }, 'four more turns');
});

test('when Claude calls continue_later the app carries on by itself, and a message of his starts at once', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Render v14 CONTINUE-TEST' })).data.thread.id;
  const t = await settled(id, 2);
  assert.match(notes(t), /Claude was waiting for the test render; the app carried on by itself/);
  assert.equal(answers(t)[0].parts.some((p) => p.type === 'tool' && /Carries on by itself/.test(p.summary)), true);
  assert.equal(t.thread.error, '');

  // A long wait: his message does not wait for it.
  const other = (await call('POST', '/api/threads', { text: 'Render v15 CONTINUE-TEST=30' })).data.thread.id;
  const waiting = await until(async () => { const x = await thread(other); return x.thread.held?.kind === 'continue' ? x : null; }, 'waiting to look again');
  assert.equal(waiting.thread.state, 'working');
  assert.match(waiting.thread.activity, /Waiting \(the test render\): carries on by itself at/);
  await call('POST', `/api/threads/${other}/messages`, { text: 'How far is it?' });
  const after = await settled(other, 2);
  assert.equal(after.thread.held, null);
  assert.ok(!/the app carried on by itself/.test(notes(after)), 'his message started it, not the app');
});

test('a turn cut off because the app closed is started again by itself once it runs again', async () => {
  const id = (await call('POST', '/api/threads', { text: 'Long job SLOW-TEST' })).data.thread.id;
  await until(async () => (await thread(id)).thread.state === 'working', 'working');
  await new Promise((r) => setTimeout(r, 400));
  await cleanup(path.join(dir, 'nothing'), [server]);
  server = start();
  await brainReady();
  const t = await settled(id, 1);
  assert.equal(t.thread.error, '');
  assert.match(notes(t), /The app restarted in the middle of this turn; it carried on by itself/);
  assert.ok(!/ended on an error/.test(notes(t)), 'a restart is not an error of the turn');
  assert.ok(!answers(t).some((m) => m.error), 'and no answer carries one');
  assert.equal(answers(t).length, 1, 'the cut-off turn left no answer; the new one finished');
});
