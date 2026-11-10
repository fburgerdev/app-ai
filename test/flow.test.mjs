// Runs the whole app against a throwaway vault with the stand-in Claude:
// threads, artifacts and their versions, the brain update, and what it must never touch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-test-'));
const remote = path.join(dir, 'vault.git');
const seed = path.join(dir, 'seed');
const data = path.join(dir, 'data');
const dataRemote = path.join(dir, 'app-data.git');
const port = 4400 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'init', '--bare', '-b', 'main', dataRemote);
git(dir, 'clone', remote, seed);
for (const d of ['Brain', 'Claude', '.obsidian', 'For Claude/processed']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Scratchpad.md'), 'private scratch\n');
fs.writeFileSync(path.join(seed, '.obsidian', 'workspace.json'), '{}\n');
fs.writeFileSync(path.join(seed, 'For Claude', 'Inbox.md'), '\n');
fs.writeFileSync(path.join(seed, 'For Claude', 'processed', 'old.md'), 'old\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Next Actions.md'), '- [ ] something\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'seed');
git(seed, 'push', 'origin', 'main');

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cards: { auto: false } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_DATA_REPO: dataRemote, APP_AI_BRAIN_REPO: remote, APP_AI_PORT: String(port) },
  stdio: 'ignore',
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const until = async (fn, label) => {
  for (let i = 0; i < 200; i += 1) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
};
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' ? t : null; }, `thread ${id} ready`);

test('the app starts and clones the vault without the hidden paths', async () => {
  const state = await until(async () => { const s = (await call('GET', '/api/state')).data; return s?.brain.brain.ready ? s : null; }, 'brain ready');
  assert.equal(state.threads.length, 0);
  const clone = path.join(data, 'brain');
  assert.ok(fs.existsSync(path.join(clone, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(clone, 'Scratchpad.md')), 'the Scratchpad must never be on disk');
  assert.ok(!fs.existsSync(path.join(clone, '.obsidian')));
  assert.ok(!fs.existsSync(path.join(clone, 'For Claude', 'processed')));
  assert.ok(fs.existsSync(path.join(clone, 'For Claude', 'Inbox.md')));
});

test('other websites cannot use the API', async () => {
  const foreign = await call('POST', '/api/threads', { text: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const plain = await fetch(`${base}/api/threads`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"text":"x"}' });
  assert.equal(plain.status, 415);
});

let mailThread;

test('a thread goes working, then ready, and keeps what Claude made', async () => {
  const created = await call('POST', '/api/threads', { text: 'Please draft a mail to the office' });
  assert.equal(created.data.thread.state, 'working');
  mailThread = created.data.thread.id;
  const t = await ready(mailThread);
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[1].role, 'assistant');
  assert.ok(t.messages[1].parts.some((p) => p.type === 'artifact' && p.v === 1));
  assert.equal(t.artifacts.length, 1);
  assert.equal(t.artifacts[0].versions.length, 1);
});

test('feedback makes a second version and the first one stays readable', async () => {
  await call('POST', `/api/threads/${mailThread}/messages`, { text: '> (Mail an das Büro.md) vielen Dank\n\ntoo stiff, new draft' });
  await until(async () => ((await thread(mailThread)).messages.length === 4 ? true : null), 'second reply');
  const t = await ready(mailThread);
  assert.equal(t.artifacts[0].versions.length, 2);
  const name = encodeURIComponent(t.artifacts[0].name);
  const v1 = await (await fetch(`${base}/api/threads/${mailThread}/artifact?name=${name}&v=1`)).text();
  const v2 = await (await fetch(`${base}/api/threads/${mailThread}/artifact?name=${name}&v=2`)).text();
  assert.match(v1, /^---\ntype: mail\nto: office@example.org/);
  assert.match(v1, /vielen Dank/);
  assert.match(v2, /Donnerstag/);
  const missing = await fetch(`${base}/api/threads/${mailThread}/artifact?name=${encodeURIComponent('../thread.json')}`);
  assert.equal(missing.status, 404);
});

test('later moves a thread to the back; done closes it', async () => {
  const other = (await call('POST', '/api/threads', { text: 'Second topic' })).data.thread.id;
  await ready(other);
  await call('POST', `/api/threads/${mailThread}/skip`, {});
  const state = (await call('GET', '/api/state')).data;
  assert.deepEqual(state.queue.order, [other, mailThread], 'a requeued thread goes behind the others');
  const closed = await call('POST', `/api/threads/${other}/state`, { state: 'done' });
  assert.equal(closed.data.thread.state, 'done');
});

test('the brain update commits once, pushes, and leaves protected paths alone', async () => {
  const before = git(remote, 'rev-parse', 'main').trim();
  const started = await call('POST', '/api/brain/extract', {});
  assert.equal(started.data.started, true);
  assert.equal(started.data.threads.length, 2);
  const run = await until(async () => { const r = (await call('GET', '/api/brain/runs')).data.runs[0]; return r?.finishedAt ? r : null; }, 'brain update finished');
  assert.equal(run.status, 'updated');
  assert.equal(run.pushed, true);
  const log = git(remote, 'log', '--format=%s%n%b', `${before}..main`).trim().split('\n').filter(Boolean);
  assert.equal(log[0], 'thinking: stand-in brain update from the app');
  assert.match(log[1], /^Co-Authored-By: /);
  assert.match(log[2], /^Claude-Session: /);
  assert.equal(log.length, 3, 'one commit, two attribution lines');
  assert.equal(git(remote, 'show', 'main:Scratchpad.md'), 'private scratch\n');
  assert.equal(git(remote, 'show', 'main:.obsidian/workspace.json'), '{}\n');
  assert.equal(git(remote, 'show', 'main:For Claude/processed/old.md'), 'old\n');

  const state = (await call('GET', '/api/state')).data;
  assert.equal(state.brain.waiting, 0);
  const closed = state.threads.find((t) => t.state === 'done');
  assert.equal(closed.archived, true, 'a closed thread that is in the brain is filed away');
  const again = await call('POST', '/api/brain/extract', {});
  assert.equal(again.data.started, false);
});

test('only what is new since the last update is handed over, and questions come back as a thread', async () => {
  await call('POST', `/api/threads/${mailThread}/messages`, { text: 'QUESTION-TEST and the room is booked' });
  await until(async () => ((await thread(mailThread)).messages.length === 6 ? true : null), 'third reply');
  await ready(mailThread);
  await call('POST', '/api/brain/extract', {});
  const run = await until(async () => { const r = (await call('GET', '/api/brain/runs')).data.runs; return r.length === 2 && r[0].finishedAt ? r[0] : null; }, 'second brain update');
  assert.equal(run.hasQuestions, true);
  const transcripts = path.join(data, 'extractions', run.id, 'transcripts');
  const text = fs.readFileSync(path.join(transcripts, fs.readdirSync(transcripts).find((f) => f.endsWith('.md'))), 'utf8');
  const [earlier, fresh] = text.split('## New (file from this part)');
  assert.match(earlier, /too stiff, new draft/);
  assert.match(fresh, /QUESTION-TEST and the room is booked/);
  assert.doesNotMatch(fresh, /too stiff, new draft/);
  const questions = await thread(run.questionsThread);
  assert.equal(questions.thread.state, 'ready');
  assert.match(questions.messages[0].parts[0].text, /Next Actions/);
  assert.equal((await call('GET', '/api/state')).data.brain.waiting, 0, 'the questions themselves are not something to file');
});

test('a push from elsewhere is picked up before the next turn', async () => {
  git(seed, 'pull', 'origin', 'main');
  fs.writeFileSync(path.join(seed, 'Brain', 'From Laptop.md'), 'hello\n');
  fs.writeFileSync(path.join(seed, 'Scratchpad.md'), 'changed on the laptop\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'inbox: test');
  git(seed, 'push', 'origin', 'main');
  await call('POST', '/api/brain/refresh', {});
  assert.ok(fs.existsSync(path.join(data, 'brain', 'Brain', 'From Laptop.md')));
  assert.ok(!fs.existsSync(path.join(data, 'brain', 'Scratchpad.md')));
  const note = await call('GET', `/api/vault?link=${encodeURIComponent('From Laptop')}`);
  assert.equal(note.data.path, 'Brain/From Laptop.md');
  const outside = await call('GET', `/api/vault?link=${encodeURIComponent('../../config.json')}`);
  assert.equal(outside.status, 404);
});

test('an error from Claude is shown in the thread, which stays in the inbox', async () => {
  const id = (await call('POST', '/api/threads', { text: 'FAIL-TEST' })).data.thread.id;
  const t = await ready(id);
  assert.match(t.thread.error, /not signed in/);
  assert.match(t.messages.at(-1).error, /npm run login/);
});
