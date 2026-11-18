// Video Kit saving into a video repo through the app: onto main, pushed, and only video repos.
// Against the stand-in Claude and a bare repo on disk playing GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
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

fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', repoBase: hub, cards: { auto: false }, autoMerge: false }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_DATA: data, APP_AI_FAKE_GITHUB: '1' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'w'), fs.openSync(path.join(dir, 'server.log'), 'a')],
});
test.after(() => cleanup(dir, [server]));

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
