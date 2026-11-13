import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPolicy, describeTool } from '../server/agent.js';
import { diffWords } from '../public/diff.js';
import { parseRanks } from '../server/projects.js';

test('thread policy: writes only into the artifacts folder', async () => {
  const cwd = path.resolve('/vault');
  const artifactsDir = path.resolve('/data/threads/t1/artifacts');
  const can = buildPolicy({ mode: 'thread', cwd, artifactsDir, shell: false });
  assert.equal((await can('Write', { file_path: path.join(artifactsDir, 'Mail.md') })).behavior, 'allow');
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Brain', 'X.md') })).behavior, 'deny');
  assert.equal((await can('Edit', { file_path: path.join(artifactsDir, '..', '..', 'other', 'x.md') })).behavior, 'deny');
  assert.equal((await can('Read', { file_path: path.join(cwd, 'Brain', 'X.md') })).behavior, 'allow');
  assert.equal((await can('Read', { file_path: path.resolve('/home/someone/.ssh/id_rsa') })).behavior, 'deny');
  assert.equal((await can('WebSearch', { query: 'x' })).behavior, 'allow');
  assert.equal((await can('Bash', { command: 'ls' })).behavior, 'deny');
  assert.equal((await can('mcp__anything__tool', {})).behavior, 'deny');
});

test('thread policy: shell only when switched on', async () => {
  const can = buildPolicy({ mode: 'thread', cwd: '/vault', artifactsDir: '/a', shell: true });
  assert.equal((await can('Bash', { command: 'ls' })).behavior, 'allow');
});

test('brain update policy: vault only, protected paths never, no git history, no web', async () => {
  const cwd = path.resolve('/vault');
  const can = buildPolicy({ mode: 'extract', cwd, readDirs: [path.resolve('/run/transcripts')], protectedPaths: ['Scratchpad.md', '.obsidian', 'For Claude', 'For Florian'] });
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Brain', 'Areas', 'X.md') })).behavior, 'allow');
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Scratchpad.md') })).behavior, 'deny');
  assert.equal((await can('Edit', { file_path: path.join(cwd, 'For Claude', 'Inbox.md') })).behavior, 'deny');
  assert.equal((await can('Write', { file_path: path.resolve('/elsewhere/x.md') })).behavior, 'deny');
  assert.equal((await can('Read', { file_path: path.resolve('/run/transcripts/01 A.md') })).behavior, 'allow');
  assert.equal((await can('Bash', { command: 'git mv "Artifacts/Mails/a.md" "Artifacts/Mails/sent/a.md"' })).behavior, 'allow');
  assert.equal((await can('Bash', { command: 'git commit -m x' })).behavior, 'deny');
  assert.equal((await can('Bash', { command: 'cd Brain && git push' })).behavior, 'deny');
  assert.equal((await can('WebFetch', { url: 'https://example.com' })).behavior, 'deny');
});

test('tool lines read like sentences', () => {
  assert.equal(describeTool('Read', { file_path: '/vault/Brain/Next Actions.md' }, '/vault'), 'Read Brain/Next Actions.md');
  assert.equal(describeTool('WebFetch', { url: 'https://example.com/a/b' }), 'Read example.com');
  assert.equal(describeTool('TodoWrite', {}), null);
});

test('diff marks added and removed words and keeps the rest', () => {
  const parts = diffWords('vielen Dank für das Gespräch', 'danke für das Gespräch');
  assert.deepEqual(parts.map((p) => p.type), ['removed', 'added', 'same']);
  assert.equal(parts.filter((p) => p.type !== 'removed').map((p) => p.text).join(''), 'danke für das Gespräch');
  assert.equal(parts.filter((p) => p.type !== 'added').map((p) => p.text).join(''), 'vielen Dank für das Gespräch');
});

test('area ranks: only the list under "## Order" counts, and the rank is the place in it', () => {
  const ranks = parseRanks([
    '# 30,000 ft Goals',
    '',
    '1. [[Before]] — above the heading, not the ranking',
    '',
    '## Order',
    '',
    '1. [[Health]] — run a marathon',
    '2. a line without an area',
    '3. **[[Campaign|The campaign]]** — win [[Münster]]',
    '4. [[Health]] — named twice, the first stands',
    '',
    '## Notes',
    '',
    '1. [[Writing]] — under a later heading, not the ranking',
  ].join('\n'));
  assert.deepEqual([...ranks.keys()], ['Health', 'Campaign']);
  assert.deepEqual(ranks.get('Health'), { rank: 1, goal: 'run a marathon' });
  // The unreadable line leaves no gap: third in the file, second in the ranking.
  assert.deepEqual(ranks.get('Campaign'), { rank: 2, goal: 'win Münster' });
});

test('area ranks: without an "## Order" heading every numbered area line counts', () => {
  const ranks = parseRanks([
    '# Goals',
    '1. [[Health]] — run a marathon',
    '- [[Garden]] — a bullet, not numbered',
    '## Later',
    '5. [[Writing]] — one essay a month',
    '7. [[Family]]',
  ].join('\r\n'));
  assert.deepEqual([...ranks], [
    ['Health', { rank: 1, goal: 'run a marathon' }],
    ['Writing', { rank: 2, goal: 'one essay a month' }],
    ['Family', { rank: 3, goal: '' }],
  ]);
  assert.equal(parseRanks('').size, 0);
});
