// Video Kit saving into a video repo through the app: onto main, pushed, and only video repos.
// Against the stand-in Claude and a bare repo on disk playing GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, freePort, until } from './helpers.mjs';
import { isVideoRepo, updateKit, _configure } from '../server/videokit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-videokit-'));
const hub = path.join(dir, 'hub');
const data = path.join(dir, 'data');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
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
const vault = bare('brain', { 'CLAUDE.md': '# vault\n', 'Claude/Instructions.md': '# Instructions\n' });
const video = bare('ytvideo-demo', { 'writing/script/1 Start.md': '# Start\n\nHello.\n' });

// A stand-in Video Kit: asked for what Florian kept when a thread opens a video repo, it hands it
// over the way the real one does (a save with handover: true) and notes who held the repo meanwhile.
const kit = { kept: null, asked: [] };
const kitServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/api/handover') { res.statusCode = 404; return res.end('{}'); }
    const ask = JSON.parse(b);
    const held = await (await fetch(`${base}/api/videokit/held?repo=${encodeURIComponent(ask.repo)}`)).json();
    kit.asked.push({ ...ask, held });
    if (!kit.kept) return res.end(JSON.stringify({ saved: [], commit: null }));
    const r = await fetch(`${base}/api/videokit/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: ask.repo, message: `Video Kit: script (1 Start) (before “${ask.by}”)`, files: kit.kept, handover: true }) });
    const j = await r.json();
    res.end(JSON.stringify(r.ok ? { saved: kit.kept.map((f) => f.path), commit: j.commit } : { saved: [], error: j.error }));
  });
});
await new Promise((r) => kitServer.listen(0, '127.0.0.1', r));

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', repoBase: hub, cards: { auto: false }, autoMerge: false, videoKit: { port: kitServer.address().port } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_FAKE_GITHUB: '1' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'w'), fs.openSync(path.join(dir, 'server.log'), 'a')],
});
test.after(() => { kitServer.close(); return cleanup(dir, [server]); });

const post = async (url, body) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
const onMain = (file) => execFileSync('git', ['--git-dir', video, 'show', `main:${file}`], { encoding: 'utf8' });

test('only ytvideo repos count as video repos', () => {
  assert.ok(isVideoRepo('fburgerdev/ytvideo-closeness'));
  assert.ok(!isVideoRepo('fburgerdev/app-ai'));
  assert.ok(!isVideoRepo('fburgerdev/my-ytvideo'));
});

test('a script edit from Video Kit lands on main on GitHub, and nothing outside the repo is written', async () => {
  await until(async () => { try { return (await fetch(`${base}/api/videokit`)).ok; } catch { return false; } }, 'server up');

  const r = await post('/api/videokit/save', { repo: 'ytvideo-demo', message: 'script: start', files: [{ path: 'writing/script/1 Start.md', content: '# Start\n\nHello again.\n' }, { path: 'writing/feedback/review-v1.md', content: '# Review\n' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pushed, true);
  assert.equal(onMain('writing/script/1 Start.md'), '# Start\n\nHello again.\n');
  assert.equal(onMain('writing/feedback/review-v1.md'), '# Review\n');

  // GitHub moves on from elsewhere; the next save starts from there.
  const other = path.join(dir, 'other');
  git(dir, 'clone', video, other);
  fs.writeFileSync(path.join(other, 'README.md'), '# demo\n');
  git(other, 'add', '-A'); git(other, 'commit', '-m', 'readme'); git(other, 'push', 'origin', 'main');
  const again = await post('/api/videokit/save', { repo: 'ytvideo-demo', files: [{ path: 'writing/feedback/review-v1.md', content: null }] });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(onMain('README.md'), '# demo\n');
  assert.throws(() => onMain('writing/feedback/review-v1.md'));

  const refreshed = await post('/api/videokit/refresh', { repo: 'ytvideo-demo' });
  assert.deepEqual(refreshed.data, { held: null });

  for (const bad of ['../x.md', '.git/config', 'C:/x.md']) {
    const no = await post('/api/videokit/save', { repo: 'ytvideo-demo', files: [{ path: bad, content: 'x' }] });
    assert.equal(no.status, 400, bad);
  }
  const notVideo = await post('/api/videokit/save', { repo: 'brain', files: [{ path: 'x.md', content: 'x' }] });
  assert.equal(notVideo.status, 400);
});

test('a save typed against an older script is not written over what a thread merged meanwhile', async () => {
  await until(async () => { try { return (await fetch(`${base}/api/videokit`)).ok; } catch { return false; } }, 'server up');
  const file = 'writing/script/1 Start.md';
  const ok = await post('/api/videokit/save', { repo: 'ytvideo-demo', message: 'script', files: [{ path: file, content: '# Start\n\nTyped in Video Kit.\n' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const read = execFileSync('git', ['--git-dir', video, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();   // what Video Kit had open

  // 19-11-2026: a thread's work on the script reaches main while Video Kit's save is on its way
  const thread = path.join(dir, 'thread');
  git(dir, 'clone', video, thread);
  fs.writeFileSync(path.join(thread, file), '# Start\n\n> Outcome: the thread wrote this.\n\nTyped in Video Kit.\n');
  git(thread, 'commit', '-qam', 'thread: goals'); git(thread, 'push', '-q', 'origin', 'main');

  const stale = await post('/api/videokit/save', { repo: 'ytvideo-demo', from: read, files: [{ path: file, content: '# Start\n\nTyped in Video Kit, again.\n' }] });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.stale, true);
  assert.deepEqual(stale.data.paths, [file]);
  assert.match(onMain(file), /the thread wrote this/);              // nothing was taken out

  // a file the thread did not touch still goes through from the same point
  const other = await post('/api/videokit/save', { repo: 'ytvideo-demo', from: read, files: [{ path: 'writing/notes.md', content: 'notes\n' }] });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.equal(onMain('writing/notes.md'), 'notes\n');
  assert.match(onMain(file), /the thread wrote this/);

  // once Video Kit has put the two together against the new main, it is saved
  const now = execFileSync('git', ['--git-dir', video, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const merged = await post('/api/videokit/save', { repo: 'ytvideo-demo', from: now, files: [{ path: file, content: '# Start\n\n> Outcome: the thread wrote this.\n\nTyped in Video Kit, again.\n' }] });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.match(onMain(file), /the thread wrote this\.\n\nTyped in Video Kit, again/);

  const bad = await post('/api/videokit/save', { repo: 'ytvideo-demo', from: 'not a commit', files: [{ path: file, content: 'x' }] });
  assert.equal(bad.status, 400);
});

test('Video Kit runs from its own copy of main, which follows GitHub', async () => {
  const remote = bare('app-ytvideo-kit', { 'server.mjs': '// v1\n' });
  const seed = path.join(dir, 'seed-app-ytvideo-kit');
  const run = path.join(dir, 'kit-run');
  const kitFile = () => fs.readFileSync(path.join(run, 'server.mjs'), 'utf8').trim();   // git on Windows may check out CRLF
  _configure({ repoBase: hub, github: { owner: 'fburgerdev' }, videoKit: { dir: run } });
  assert.equal(await updateKit(), true);
  assert.equal(kitFile(), '// v1');
  assert.equal(await updateKit(), false);
  fs.writeFileSync(path.join(seed, 'server.mjs'), '// v2\n');
  git(seed, 'commit', '-qam', 'v2');
  git(seed, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(run, 'stray.txt'), 'left behind');
  assert.equal(await updateKit(), true);
  assert.equal(kitFile(), '// v2');
  assert.equal(fs.existsSync(path.join(run, 'stray.txt')), false);
  assert.ok(remote);
});

// Florian, 20-11-2026: "when i edit dont save every single time i do a change, only, the moment
// claude steps in again, take a snapshot", and the writing waits while Claude works.
test('a thread opening a video repo first gets what Florian kept in Video Kit, as one commit, and starts from it', async () => {
  await until(async () => { try { return (await fetch(`${base}/api/videokit`)).ok; } catch { return false; } }, 'server up');
  const file = 'writing/script/1 Start.md';
  const free = await (await fetch(`${base}/api/videokit/held?repo=ytvideo-demo`)).json();
  assert.deepEqual(free, { held: null, handover: true });
  assert.equal((await fetch(`${base}/api/videokit/held?repo=brain`)).status, 400);

  kit.kept = [{ path: file, content: '# Start\n\nKept in Video Kit until Claude stepped in.\n' }];
  const count = () => Number(execFileSync('git', ['--git-dir', video, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim());
  const commitsBefore = count();
  const made = (await post('/api/threads', { text: 'Tighten the opening' })).data.thread;
  const thread = async () => (await fetch(`${base}/api/threads/${made.id}`)).json();
  await until(async () => (await thread()).thread.state === 'ready', 'first answer');
  const before = (await thread()).messages.filter((m) => m.role === 'assistant').length;
  await post(`/api/threads/${made.id}/messages`, { text: 'REPO-TEST=ytvideo-demo' });
  const done = await until(async () => { const t = await thread(); return t.thread.state === 'ready' && t.messages.filter((m) => m.role === 'assistant').length > before ? t : null; }, 'the turn in the video repo');

  // asked once, while the thread already held the repo, and the save went through anyway
  assert.equal(kit.asked.length, 1);
  assert.equal(kit.asked[0].repo, 'fburgerdev/ytvideo-demo');
  assert.ok(kit.asked[0].held.held, 'Video Kit sees the thread holding the repo, so it locks');
  assert.equal(kit.asked[0].by, kit.asked[0].held.held);
  const subjects = execFileSync('git', ['--git-dir', video, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).split('\n');
  assert.equal(count(), commitsBefore + 1, 'one commit');
  assert.match(subjects[0], /^Video Kit: script \(1 Start\) \(before “/);
  assert.match(onMain(file), /Kept in Video Kit/);
  // the thread's branch starts from it
  const branch = done.thread.repoBranch;
  assert.match(branch, /^claude\//);
  assert.match(execFileSync('git', ['--git-dir', video, 'show', `${branch}:${file}`], { encoding: 'utf8' }), /Kept in Video Kit/);
  assert.deepEqual(await (await fetch(`${base}/api/videokit/held?repo=ytvideo-demo`)).json(), { held: null, handover: true }, 'free again after the turn');
});
