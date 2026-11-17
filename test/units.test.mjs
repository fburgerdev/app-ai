import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPolicy, describeTool, startsIn } from '../server/agent.js';
import { diffWords } from '../public/diff.js';
import { parseRanks } from '../server/projects.js';
import { pushTakingIn, whenUnlocked } from '../server/datasync.js';

test('saving state: losing the race to the other computer twice still saves', async () => {
  let sends = 0;
  let takenIn = 0;
  const send = async () => { sends += 1; if (sends < 3) throw new Error("cannot lock ref 'refs/heads/main'"); return 'ok'; };
  assert.equal(await pushTakingIn(send, async () => { takenIn += 1; return true; }, { wait: 1 }), 'ok');
  assert.equal(sends, 3);
  assert.equal(takenIn, 2);
  // It gives up after its tries, and at once when GitHub cannot be fetched from.
  await assert.rejects(pushTakingIn(async () => { throw new Error('rejected'); }, async () => true, { tries: 3, wait: 1 }), /rejected/);
  await assert.rejects(pushTakingIn(async () => { throw new Error('offline'); }, async () => false, { wait: 1 }), /offline/);
});

test('thread policy: writes only into the artifacts folder', async () => {
  const cwd = path.resolve('/vault');
  const artifactsDir = path.resolve('/data/threads/t1/artifacts');
  const can = buildPolicy({ mode: 'thread', cwd, artifactsDir, shell: false });
  assert.equal((await can('Write', { file_path: path.join(artifactsDir, 'Mail.md') })).behavior, 'allow');
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Core', 'X.md') })).behavior, 'deny');
  assert.equal((await can('Edit', { file_path: path.join(artifactsDir, '..', '..', 'other', 'x.md') })).behavior, 'deny');
  assert.equal((await can('Read', { file_path: path.join(cwd, 'Core', 'X.md') })).behavior, 'allow');
  assert.equal((await can('Read', { file_path: path.resolve('/home/someone/.ssh/id_rsa') })).behavior, 'deny');
  assert.equal((await can('WebSearch', { query: 'x' })).behavior, 'allow');
  assert.equal((await can('Bash', { command: 'ls' })).behavior, 'deny');
  assert.equal((await can('mcp__anything__tool', {})).behavior, 'deny');
});

test('thread policy: shell only when switched on', async () => {
  const can = buildPolicy({ mode: 'thread', cwd: '/vault', artifactsDir: '/a', shell: true });
  assert.equal((await can('Bash', { command: 'ls' })).behavior, 'allow');
});

test('thread policy: without a repo, scripts run in the artifacts folder and nowhere else', async () => {
  const cwd = path.resolve('/vault');
  const artifactsDir = path.resolve('/data/threads/t1/artifacts');
  const can = buildPolicy({ mode: 'thread', cwd, artifactsDir, shell: false, artifactsShell: true });
  const run = async (command, tool = 'Bash') => (await can(tool, { command })).behavior;
  assert.equal(await run(`cd "${artifactsDir}" && python fill.py`), 'allow');
  assert.equal(await run(`cd '${artifactsDir}'; python fill.py`), 'allow');
  assert.equal(await run(`Set-Location -LiteralPath "${artifactsDir}"; python fill.py`, 'PowerShell'), 'allow');
  assert.equal(await run(`cd "${path.join(artifactsDir, 'work')}" && ls`), 'allow', 'a folder inside it');
  assert.equal(await run('python fill.py'), 'deny', 'not without going there first');
  assert.equal(await run(`cd "${cwd}" && python fill.py`), 'deny', 'not in the vault');
  assert.equal(await run(`cd "${path.resolve('/data/threads/t2/artifacts')}" && ls`), 'deny', 'not in another thread');
  assert.equal(await run(`cd "${artifactsDir}/../.." && ls`), 'deny');
  assert.equal(await run(`cd "${artifactsDir}" && git status`), 'deny', 'no git without a repo');
  assert.equal(await run(`cd "${artifactsDir}" && python digit.py`), 'allow', 'a word that only contains "git"');
  assert.equal((await can('BashOutput', { bash_id: 'x' })).behavior, 'allow');
  // Switched off in the config: as before.
  const off = buildPolicy({ mode: 'thread', cwd, artifactsDir, shell: false, artifactsShell: false });
  assert.equal((await off('Bash', { command: `cd "${artifactsDir}" && ls` })).behavior, 'deny');
  // Writes stay where they were: only the artifacts folder.
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Core', 'X.md') })).behavior, 'deny');
  // A Windows drive path only means something on Windows; elsewhere it is just a folder by that name.
  if (process.platform === 'win32') assert.equal(startsIn('  cd /d "C:\\x\\a" && dir', path.resolve('C:\\x\\a')), true);
});

test('brain update policy: vault only, protected paths never, no git history, no web', async () => {
  const cwd = path.resolve('/vault');
  const can = buildPolicy({ mode: 'extract', cwd, readDirs: [path.resolve('/run/transcripts')], protectedPaths: ['Scratchpad.md', '.obsidian', 'For Claude', 'For Florian'] });
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Core', 'Areas', 'X.md') })).behavior, 'allow');
  assert.equal((await can('Write', { file_path: path.join(cwd, 'Scratchpad.md') })).behavior, 'deny');
  assert.equal((await can('Edit', { file_path: path.join(cwd, 'For Claude', 'Inbox.md') })).behavior, 'deny');
  assert.equal((await can('Write', { file_path: path.resolve('/elsewhere/x.md') })).behavior, 'deny');
  assert.equal((await can('Read', { file_path: path.resolve('/run/transcripts/01 A.md') })).behavior, 'allow');
  assert.equal((await can('Bash', { command: 'git mv "Artifacts/Mails/a.md" "Artifacts/Mails/sent/a.md"' })).behavior, 'allow');
  assert.equal((await can('Bash', { command: 'git commit -m x' })).behavior, 'deny');
  assert.equal((await can('Bash', { command: 'cd Core && git push' })).behavior, 'deny');
  assert.equal((await can('WebFetch', { url: 'https://example.com' })).behavior, 'deny');
});

test('tool lines read like sentences', () => {
  assert.equal(describeTool('Read', { file_path: '/vault/Core/Next Actions.md' }, '/vault'), 'Read Core/Next Actions.md');
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

test('a note renamed without a commit is found under its new name, and the old name reads as gone', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const brain = await import('../server/brain.js');
  const { projectContext } = await import('../server/projects.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-rename-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  fs.mkdirSync(path.join(dir, 'Core', 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Core', 'Projects', 'Old Talk.md'), '# Old Talk\n');
  run('init', '--quiet');
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '--quiet', '-m', 'seed');
  brain.initBrain({ brainDir: dir, hiddenPaths: [] });
  assert.equal((await brain.ensureClone()).ready, true);
  assert.equal(projectContext('Old Talk')[0].path, 'Core/Projects/Old Talk.md');
  // A brain update that is still writing: the file moves, the commit has not happened.
  fs.renameSync(path.join(dir, 'Core', 'Projects', 'Old Talk.md'), path.join(dir, 'Core', 'Projects', 'New.md'));
  assert.deepEqual(projectContext('Old Talk'), []);
  assert.equal(brain.resolveWikilink('New').path, 'Core/Projects/New.md');
  // Once the rename is committed, a thread still filed under the old name follows it.
  const { renamedTo } = await import('../server/projects.js');
  fs.writeFileSync(path.join(dir, 'Core', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## No area\n\n- [[New]] — the talk\n');
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '--quiet', '-m', 'rename');
  await brain.ensureClone();
  assert.equal(renamedTo('Old Talk'), 'New');
  assert.equal(renamedTo('Never Existed'), '', 'only a rename git knows of is followed');
  // A second rename: the old name follows the whole chain.
  fs.renameSync(path.join(dir, 'Core', 'Projects', 'New.md'), path.join(dir, 'Core', 'Projects', 'Newest.md'));
  fs.writeFileSync(path.join(dir, 'Core', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## No area\n\n- [[Newest]] — the talk\n');
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '--quiet', '-m', 'rename again');
  await brain.ensureClone();
  assert.equal(renamedTo('Old Talk'), 'Newest');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('policy: without a repo, scripts start on the workbench, and files may be written there', async () => {
  const cwd = path.resolve('/vault');
  const artifactsDir = path.resolve('/data/threads/t1/artifacts');
  const workDir = path.resolve('/data/threads/t1/work');
  const can = buildPolicy({ mode: 'thread', cwd, artifactsDir, workDir, shell: false, artifactsShell: true });
  assert.equal((await can('Bash', { command: `cd "${workDir}" && python fill.py` })).behavior, 'allow');
  assert.equal((await can('Bash', { command: `cd "${artifactsDir}" && pip install x` })).behavior, 'deny', 'not in the folder he sees');
  assert.equal((await can('Write', { file_path: path.join(workDir, 'fill.py') })).behavior, 'allow');
  assert.equal((await can('Read', { file_path: path.join(workDir, 'out.pdf') })).behavior, 'allow');
  assert.equal((await can('mcp__app__show_file', { path: 'out.pdf' })).behavior, 'allow');
});

test('a git step refused because another git process holds the index runs again', async () => {
  const locked = Object.assign(new Error('git commit failed: remove the file manually to continue.'), { stderr: "fatal: Unable to create 'C:/data/.git/index.lock': File exists. Another git process seems to be running in this repository" });
  let calls = 0;
  assert.equal(await whenUnlocked(async () => { calls += 1; if (calls < 3) throw locked; return 'ok'; }, { wait: 1 }), 'ok');
  assert.equal(calls, 3);
  await assert.rejects(whenUnlocked(async () => { throw locked; }, { tries: 2, wait: 1 }), /remove the file/);
  calls = 0;
  await assert.rejects(whenUnlocked(async () => { calls += 1; throw new Error('nothing to commit'); }, { wait: 1 }), /nothing to commit/);
  assert.equal(calls, 1);
  // A file the app was rewriting while git read it: the same, a moment later it is whole.
  const midWrite = Object.assign(new Error('git add -A failed: fatal: updating files failed'), { stderr: "error: threads/t1/thread.json: failed to insert into database; error: unable to index file 'threads/t1/thread.json'; fatal: updating files failed" });
  calls = 0;
  assert.equal(await whenUnlocked(async () => { calls += 1; if (calls < 2) throw midWrite; return 'ok'; }, { wait: 1 }), 'ok');
  assert.equal(calls, 2);
});

test('pi_shell: what could break the Pi or cut off the way in needs his OK first', async () => {
  const { needsConsent } = await import('../server/pi.js');
  for (const cmd of ['sudo reboot', 'rm -rf /', 'rm -rf ~/', 'sudo rm -rf /etc', 'sudo mkfs.ext4 /dev/sda1', 'dd if=x.img of=/dev/mmcblk0', 'sudo tailscale down', 'sudo systemctl stop ssh', 'sudo shutdown -h now']) {
    assert.ok(needsConsent(cmd), `needs consent: ${cmd}`);
  }
  for (const cmd of ['sudo apt-get install -y chromium', 'rm -rf ~/app-ai/node_modules', 'systemctl --user restart app-ai', 'journalctl --user -u app-ai -n 50', 'df -h']) {
    assert.equal(needsConsent(cmd), '', `runs at once: ${cmd}`);
  }
});

test('only the computer that runs a turn can call it lost; the other leaves it be', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-orphans-'));
  const threadsDir = path.join(dir, 'threads');
  const write = (id, meta) => { fs.mkdirSync(path.join(threadsDir, id), { recursive: true }); fs.writeFileSync(path.join(threadsDir, id, 'thread.json'), JSON.stringify({ id, title: id, state: 'working', updatedAt: Date.now(), ...meta })); };
  write('here', { workingOn: os.hostname() });
  write('there', { workingOn: 'the-other-computer' });
  write('thereold', { workingOn: 'the-other-computer', updatedAt: Date.now() - 60 * 60_000 });
  const { execFileSync } = await import('node:child_process');
  const script = `
    const store = await import(${JSON.stringify(new URL('../server/store.js', import.meta.url).href)});
    store.loadThreads();
    const s = (id) => store.getThread(id).state;
    const out = { afterLoad: [s('here'), s('there'), s('thereold')] };
    store.settleOrphans({ isRunning: () => false, otherGone: false });
    out.otherAway = [s('there'), s('thereold')];
    store.settleOrphans({ isRunning: () => false, otherGone: true });
    out.otherGone = [s('there'), s('thereold')];
    console.log(JSON.stringify(out));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_AI_DATA: dir }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(out.afterLoad, ['ready', 'working', 'working'], 'its own lost turn goes back; the other computer\'s is left');
  assert.deepEqual(out.otherAway, ['working', 'working'], 'while the other computer is there, nothing is touched');
  assert.deepEqual(out.otherGone, ['working', 'ready'], 'once it is gone: only what has not moved for a while');
  fs.rmSync(dir, { recursive: true, force: true });
});
