import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { limitFor, overLimit } from '../server/notelimits.js';
import * as brain from '../server/brain.js';

test('project and area notes have a word limit, nothing else has', () => {
  assert.equal(limitFor('Core/Projects/A.md'), 1200);
  assert.equal(limitFor('Core/Areas/A.md'), 1500);
  assert.equal(limitFor('Core/Projects/Projects Index.md'), 0);
  assert.equal(limitFor('Core/People/A.md'), 0);
  assert.equal(limitFor('Archive/Projects/A.md'), 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-limit-'));
  fs.mkdirSync(path.join(dir, 'Core', 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Core/Projects/Long.md'), 'word '.repeat(1201));
  fs.writeFileSync(path.join(dir, 'Core/Projects/Fits.md'), 'word '.repeat(1200));
  fs.writeFileSync(path.join(dir, 'Core/Projects/Own.md'), `word limit: 2500
${'word '.repeat(2000)}`);
  assert.deepEqual(overLimit(dir, ['Core/Projects/Own.md']), []);
  assert.deepEqual(
    overLimit(dir, ['Core/Projects/Long.md', 'Core/Projects/Fits.md', 'Core/Projects/Gone.md']),
    [{ path: 'Core/Projects/Long.md', words: 1201, limit: 1200 }],
  );
});

test('a thread link is found by its id, and changed files are listed as they are named', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-link-'));
  fs.mkdirSync(path.join(dir, 'Threads'));
  fs.writeFileSync(path.join(dir, 'Threads', '2026-11-25 Renamed.md'), '# Renamed\n\nThread: mwabc123\n');
  const run = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run('init', '--quiet');
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '--quiet', '-m', 'seed');
  brain.initBrain({ brainDir: dir, hiddenPaths: [] });
  assert.equal((await brain.ensureClone()).ready, true);
  assert.equal(brain.resolveWikilink('Threads/mwabc123|Old title').path, 'Threads/2026-11-25 Renamed.md');
  assert.equal(brain.resolveWikilink('Threads/mwnone'), null);
  fs.writeFileSync(path.join(dir, 'A note ä.md'), 'x');
  run('mv', 'Threads/2026-11-25 Renamed.md', 'Threads/New.md');
  assert.deepEqual((await brain.changedPaths()).sort(), ['A note ä.md', 'Threads/New.md']);
});
