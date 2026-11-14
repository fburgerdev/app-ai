// Taking files out of the data repo's history: the laptop rewrites and pushes over
// GitHub, the Pi adopts it on its next fetch and keeps what only it had changed.
// Throwaway repos on disk; a bare one plays GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptRewritten, forgetOld, moveBranch, rewriteWithout, wasRewritten } from '../server/purge.js';
import { cleanup } from './helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-purge-'));
test.after(() => cleanup(dir));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const send = (cwd, ...args) => git(cwd, ['pu', 'sh'].join(''), ...args);
const write = (repo, f, text) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); };
const commit = (repo, msg) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };
const everPaths = (repo, ref) => new Set(git(repo, 'log', '--name-only', '--format=', ref).split('\n').filter(Boolean));

const hub = path.join(dir, 'data.git');
const laptop = path.join(dir, 'laptop');
const pi = path.join(dir, 'pi');
const junk = Array.from({ length: 30 }, (_, i) => `threads/t1/artifacts/work/pylib/m${i}.pyc`);

test('the laptop takes files out of the history; the Pi adopts it and keeps its own changes', async () => {
  git(dir, 'init', '--bare', '-q', '-b', 'main', hub);
  git(dir, 'clone', '-q', hub, laptop);
  git(laptop, 'checkout', '-q', '-B', 'main');
  write(laptop, 'threads/t1/messages.jsonl', '{"a":1}\n');
  commit(laptop, 'state: 1');
  for (const f of junk) write(laptop, f, `compiled ${f}`);
  write(laptop, 'threads/t1/artifacts/Mail.md', 'the mail\n');
  commit(laptop, 'state: 2, with the library');
  write(laptop, 'threads/t1/messages.jsonl', '{"a":1}\n{"b":2}\n');
  for (const f of junk.slice(0, 10)) fs.rmSync(path.join(laptop, f));
  commit(laptop, 'state: 3');
  // The app's one-time tidy moves the rest off the shown files; the sync commits that.
  for (const f of junk.slice(10)) fs.rmSync(path.join(laptop, f));
  commit(laptop, 'state: 4, tidied');
  send(laptop, '-q', 'origin', 'main');
  // The Pi has all of it, and then works by itself: one change committed, one not.
  git(dir, 'clone', '-q', hub, pi);
  write(pi, 'threads/t2/messages.jsonl', '{"from":"pi"}\n');
  commit(pi, 'state: on the pi');
  write(pi, 'notes-for-claude.md', 'typed on the phone\n');

  // The laptop rewrites, pushes over GitHub only over the version it checked, moves its branch.
  const old = git(laptop, 'rev-parse', 'HEAD').trim();
  const messages = git(laptop, 'log', '--format=%s', 'main');
  const { tip, changed } = await rewriteWithout(laptop, 'main', junk);
  assert.equal(changed, 3, 'the commits from the one that added the library on');
  send(laptop, '-q', `--force-with-lease=refs/heads/main:${old}`, 'origin', `${tip}:refs/heads/main`);
  await moveBranch(laptop, 'main', tip, old);
  assert.equal(git(laptop, 'log', '--format=%s', 'main'), messages, 'every commit kept, with its message');
  assert.ok(![...everPaths(laptop, 'main')].some((p) => p.includes('pylib')), 'the library is gone from the history');
  assert.ok(everPaths(laptop, 'main').has('threads/t1/artifacts/Mail.md'), 'the mail is not');
  assert.equal(git(laptop, 'status', '--porcelain').trim(), '', 'the working folder is as it was');
  await forgetOld(laptop);

  // The Pi fetches: it sees the rewrite, adopts it, and keeps both of its changes.
  const before = git(pi, 'rev-parse', 'refs/remotes/origin/main').trim();
  git(pi, 'fetch', '-q', 'origin', 'main');
  assert.equal(await wasRewritten(pi, 'main', before), true);
  const kept = await adoptRewritten(pi, 'main', before);
  assert.deepEqual(kept.sort(), ['notes-for-claude.md', 'threads/t2/messages.jsonl']);
  assert.equal(fs.readFileSync(path.join(pi, 'notes-for-claude.md'), 'utf8'), 'typed on the phone\n');
  assert.equal(git(pi, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD') === '', true, 'built on the cleaned history');
  assert.ok(![...everPaths(pi, 'HEAD')].some((p) => p.includes('pylib')), 'nothing of the library on the Pi either');
  // Its next save goes on top of GitHub's without bringing anything back.
  send(pi, '-q', 'origin', 'HEAD:main');
  assert.ok(![...everPaths(hub, 'main')].some((p) => p.includes('pylib')));
  // A normal fetch afterwards is not mistaken for another rewrite.
  const again = git(laptop, 'rev-parse', 'refs/remotes/origin/main').trim();
  git(laptop, 'fetch', '-q', 'origin', 'main');
  assert.equal(await wasRewritten(laptop, 'main', again), false);
});

test('the push goes nowhere if GitHub moved on in the meantime', async () => {
  const old = git(laptop, 'rev-parse', 'HEAD').trim();
  write(pi, 'threads/t2/messages.jsonl', '{"from":"pi"}\n{"more":1}\n');
  commit(pi, 'state: the pi saved in between');
  send(pi, '-q', 'origin', 'HEAD:main');
  write(laptop, 'x.txt', 'x');
  commit(laptop, 'state: x');
  const { tip } = await rewriteWithout(laptop, 'main', ['x.txt']);
  assert.throws(() => send(laptop, '-q', `--force-with-lease=refs/heads/main:${old}`, 'origin', `${tip}:refs/heads/main`));
  assert.match(git(hub, 'log', '--format=%s', '-1', 'main'), /the pi saved in between/, 'GitHub keeps the Pi\'s save');
});
