import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPolicy, describeTool, shortCommand, startsIn } from '../server/agent.js';
import { diffWords } from '../public/diff.js';
import { parseRanks } from '../server/projects.js';
import { IGNORE, clearStaleLock, pushTakingIn, whenUnlocked } from '../server/datasync.js';

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

test('command lines drop the leading cd and shorten long paths', () => {
  const bench = 'C:\\Users\\Florian\\AppData\\Local\\app-ai\\threads\\abc123\\work';
  assert.equal(
    describeTool('Bash', { command: `cd "${bench}" && PYTHONPATH=pylib python fill.py "C:\\Users\\Florian\\Downloads\\Antrag Form.pdf"` }, 'C:\\Users\\Florian\\AppData\\Local\\app-ai\\brain'),
    'Ran PYTHONPATH=pylib python fill.py "…/Downloads/Antrag Form.pdf"',
  );
  assert.equal(shortCommand('cd "C:\\Users\\F\\AppData\\Local\\app-ai\\repos\\fburgerdev\\app-ai"; npm test'), 'npm test');
  assert.equal(
    shortCommand('cd /c/Users/F/AppData/Local/app-ai/repos/fburgerdev/app-ai && node /c/Users/F/AppData/Local/app-ai/repos/fburgerdev/app-ai/server/index.js'),
    'node server/index.js',
  );
  assert.equal(shortCommand('cp out.pdf "C:/Users/F/AppData/Local/app-ai/threads/abc/artifacts/Antrag.pdf"'), 'cp out.pdf artifacts/Antrag.pdf');
  assert.equal(shortCommand('ls /home/pi/app-ai/server', '/home/pi/app-ai'), 'ls server');
  assert.equal(describeTool('mcp__app__pi_shell', { command: 'systemctl --user status app-ai' }), 'Ran on the Pi: systemctl --user status app-ai');
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

test('a git lock left behind by a stopped step is removed, a fresh one is not', async () => {
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const px = await import('node:path');
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), 'app-ai-lock-'));
  const lock = px.join(dir, '.git', 'index.lock');
  fsx.mkdirSync(px.dirname(lock));
  assert.equal(clearStaleLock(dir), false, 'no lock, nothing to do');
  fsx.writeFileSync(lock, '');
  assert.equal(clearStaleLock(dir), false, 'a running step may hold it');
  assert.ok(fsx.existsSync(lock));
  const old = new Date(Date.now() - 10 * 60_000);
  fsx.utimesSync(lock, old, old);
  assert.equal(clearStaleLock(dir), true);
  assert.ok(!fsx.existsSync(lock));
  fsx.rmSync(dir, { recursive: true, force: true });
});

test('the folders the app keeps other repos in are never saved with its state', () => {
  // repos.js puts all three into the data folder; shared/ held 39 GB of video when
  // "git add -A" tried to take it in (23-11-2026).
  for (const dir of ['repos', 'worktrees', 'shared']) assert.match(IGNORE, new RegExp(`^/${dir}/$`, 'm'), `${dir}/ is ignored`);
});

test('a git step stopped by its timeout says so, and is marked as such', async () => {
  const { git } = await import('../server/git.js');
  // Waits for input that never comes, as a step does that the computer slept through.
  const err = await git(process.cwd(), ['hash-object', '--stdin'], { timeout: 300 }).then(() => null, (e) => e);
  assert.ok(err, 'the step is stopped');
  assert.equal(err.timedOut, true);
  assert.match(err.message, /did not finish within/);
  const failed = await git(process.cwd(), ['rev-parse', '--verify', 'no-such-ref']).then(() => null, (e) => e);
  assert.equal(failed.timedOut, false, 'a step git itself refused is a failure');
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

test('a merge into main cut off when the app stopped is tried again; the other computer\'s is left', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-merging-'));
  const threadsDir = path.join(dir, 'threads');
  const write = (id, meta) => { fs.mkdirSync(path.join(threadsDir, id), { recursive: true }); fs.writeFileSync(path.join(threadsDir, id, 'thread.json'), JSON.stringify({ id, title: id, state: 'done', updatedAt: Date.now(), repo: 'fburgerdev/app-ai', repoBranch: `claude/${id}`, ...meta })); };
  const later = Date.now() + 10 * 60_000;
  write('here', { merging: { at: Date.now(), on: os.hostname() } });
  write('planned', { merging: { at: Date.now(), on: os.hostname() }, remerge: { at: later } });
  write('there', { merging: { at: Date.now(), on: 'the-other-computer' } });
  write('quiet', {});
  const { execFileSync } = await import('node:child_process');
  const script = `
    const store = await import(${JSON.stringify(new URL('../server/store.js', import.meta.url).href)});
    store.loadThreads();
    const g = (id) => { const t = store.getThread(id); return { merging: Boolean(t.merging), remerge: t.remerge?.at || 0 }; };
    console.log(JSON.stringify({ here: g('here'), planned: g('planned'), there: g('there'), quiet: g('quiet') }));`;
  const before = Date.now();
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_AI_DATA: dir }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(out.here.merging, false);
  assert.ok(out.here.remerge >= before && out.here.remerge < before + 5 * 60_000, 'its own cut-off merge runs again shortly');
  assert.deepEqual(out.planned, { merging: false, remerge: later }, 'a merge already planned for later keeps its time');
  assert.deepEqual(out.there, { merging: true, remerge: 0 }, 'a merge on the other computer is left as it is');
  assert.deepEqual(out.quiet, { merging: false, remerge: 0 });
  const saved = JSON.parse(fs.readFileSync(path.join(threadsDir, 'here', 'thread.json'), 'utf8'));
  assert.ok(saved.remerge && !saved.merging, 'written to disk, so a second restart does not lose it either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a turn the other computer finished shows its answer here, never a false error', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-finished-'));
  const threadsDir = path.join(dir, 'threads');
  const write = (id, meta) => { fs.mkdirSync(path.join(threadsDir, id), { recursive: true }); fs.writeFileSync(path.join(threadsDir, id, 'thread.json'), JSON.stringify({ id, title: id, updatedAt: Date.now() - 60 * 60_000, ...meta })); };
  const answer = (id) => fs.writeFileSync(path.join(threadsDir, id, 'messages.jsonl'), [
    JSON.stringify({ id: 'u', role: 'user', text: 'hi' }),
    JSON.stringify({ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'done' }] })].join('\n') + '\n');
  write('synced', { state: 'working', workingOn: 'the-other-computer' });
  write('stale', { state: 'working', workingOn: 'the-other-computer' }); answer('stale');
  write('flagged', { state: 'ready', error: 'Claude was working on this on the other computer, which went away before it finished. Send a message to pick it up again.' }); answer('flagged');
  const { execFileSync } = await import('node:child_process');
  const script = `
    const fs = await import('node:fs');
    const store = await import(${JSON.stringify(new URL('../server/store.js', import.meta.url).href)});
    store.loadThreads();
    const file = ${JSON.stringify(path.join(threadsDir, 'synced', 'thread.json'))};
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'ready', workingOn: '' }));
    store.reloadThreads();
    store.settleOrphans({ isRunning: () => false, otherGone: true });
    store.clearFalseErrors();
    const g = (id) => [store.getThread(id).state, store.getThread(id).error || ''];
    console.log(JSON.stringify({ synced: g('synced'), stale: g('stale'), flagged: g('flagged') }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_AI_DATA: dir }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(out.synced, ['ready', ''], 'the other computer\'s saved "ready" wins over the old "working" in memory');
  assert.deepEqual(out.stale, ['ready', ''], 'a turn whose answer arrived is ready, not lost');
  assert.deepEqual(out.flagged, ['ready', ''], 'the false note from before goes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usage: a run costs what it added to its session, not the session so far', async () => {
  const { spent, costOf, priced } = await import('../server/usage.js');
  const line = { model: 'opus', in: 2, out: 1000, cacheRead: 500_000, cacheWrite: 10_000 };
  // The SDK reports the whole session: the second run of a session is the difference.
  assert.equal(spent({ total: 5, before: undefined, resumed: false, line }), 5);
  assert.ok(Math.abs(spent({ total: 5.2, before: 5, resumed: true, line }) - 0.2) < 1e-9);
  // A session carried on that was never counted here: its tokens say what the run cost.
  assert.ok(Math.abs(priced(line) - (2 * 4 + 1000 * 20 + 500_000 * 0.2 + 10_000 * 8) / 1e6) < 1e-9);
  assert.equal(spent({ total: 150, before: undefined, resumed: true, line }), priced(line));
  // A total that starts again from nothing (the session was made new) counts as it is.
  assert.equal(spent({ total: 0.3, before: 5, resumed: true, line }), 0.3);
  // An unknown model's total is taken as it is rather than guessed.
  assert.equal(spent({ total: 7, before: undefined, resumed: true, line: { ...line, model: 'mystery' } }), 7);
  // Lines written before the fix: thread turns are priced again, everything else stands.
  assert.equal(costOf({ kind: 'thread', cost: 150, ...line }), priced(line));
  assert.equal(costOf({ kind: 'cards', cost: 1.5, ...line }), 1.5);
  assert.equal(costOf({ kind: 'thread', cost: 0.25, v: 2, ...line }), 0.25);
});

test('a message no turn took up is found, whatever order the two computers\' lines ended up in', async () => {
  const { leftOver } = await import('../server/runner.js');
  const t0 = 1_800_000_000_000;
  const user = (ts, extra = {}) => ({ role: 'user', ts, text: `at ${ts - t0}`, ...extra });
  const claude = (ts, durationMs) => ({ role: 'assistant', ts, durationMs, parts: [{ type: 'text', text: 'ok' }] });
  // The usual course: every message has a turn that started after it.
  assert.deepEqual(leftOver([user(t0), claude(t0 + 60_000, 50_000), user(t0 + 70_000), claude(t0 + 200_000, 100_000)]), []);
  // Sent while a turn ran on the other computer: that turn started before the message.
  const late = user(t0 + 30_000);
  assert.deepEqual(leftOver([user(t0), claude(t0 + 60_000, 50_000), late]), [late]);
  assert.deepEqual(leftOver([user(t0), late, claude(t0 + 60_000, 50_000)]), [late], 'the lines of two computers come in any order');
  // The app's own messages, notes about what he did and "send and done" are not owed an answer.
  assert.deepEqual(leftOver([user(t0), claude(t0 + 60_000, 50_000), user(t0 + 90_000, { auto: true }), user(t0 + 91_000, { event: true }), user(t0 + 92_000, { unanswered: true })]), []);
  // After Stop, what he sent before stays unanswered: stop means stop.
  assert.deepEqual(leftOver([user(t0), claude(t0 + 60_000, 50_000), late], { stoppedAt: t0 + 40_000 }), []);
  // Clocks a few seconds apart do not make an answered message look unanswered.
  assert.deepEqual(leftOver([user(t0 + 3000), claude(t0 + 60_000, 60_000)]), []);
  // A turn that left no answer behind (Claude had nothing to say) still took the message up.
  assert.deepEqual(leftOver([user(t0)]), [user(t0)]);
  assert.deepEqual(leftOver([user(t0)], { turnStartedAt: t0 + 200 }), []);
  assert.deepEqual(leftOver([user(t0), user(t0 + 90_000)], { turnStartedAt: t0 + 200 }).length, 1);
});

test('what no change to the code can fix opens no repair thread', async () => {
  const { isNotCode } = await import('../server/repair.js');
  assert.equal(isNotCode('Claude Code returned an error result: You\'ve hit your 5-hour limit · resets 1:50am (Europe/Berlin)'), true);
  assert.equal(isNotCode('Invalid API key · Please run /login'), true);
  assert.equal(isNotCode('TypeError: cannot read properties of undefined'), false);
});

test('Auto does not step down to the cheaper model while a big conversation is still ready', async () => {
  const { stickyTier } = await import('../server/runner.js');
  const now = 1_800_000_000_000;
  const warm = { sessionId: 's', lastTier: 'extra', turnEndedAt: now - 10 * 60_000, contextTokens: 300_000 };
  // Fable to Opus would read the whole conversation again: Fable's lowest tier instead.
  assert.equal(stickyTier('cheap', warm, now), 'high');
  assert.equal(stickyTier('default', warm, now), 'high');
  // The effort moves freely, and stepping up is what the message asks for.
  assert.equal(stickyTier('high', warm, now), 'high');
  assert.equal(stickyTier('extra', { ...warm, lastTier: 'low' }, now), 'extra');
  assert.equal(stickyTier('cheap', { ...warm, lastTier: 'default' }, now), 'cheap');
  // Nothing to keep: after an hour, in a short conversation, or in a new one.
  assert.equal(stickyTier('cheap', { ...warm, turnEndedAt: now - 70 * 60_000 }, now), 'cheap');
  assert.equal(stickyTier('cheap', { ...warm, contextTokens: 8000 }, now), 'cheap');
  assert.equal(stickyTier('cheap', { ...warm, sessionId: null }, now), 'cheap');
  assert.equal(stickyTier('cheap', { lastTier: 'extra', sessionId: 's' }, now), 'cheap', 'a thread from before this was measured');
});

test('the calendar is worth a run only when it holds an entry no run has looked at', async () => {
  const { unseenEntries } = await import('../server/cards.js');
  const seen = ['a 2026-11-20T10:00:00+01:00', 'b 2026-11-21T09:00:00+01:00'];
  assert.deepEqual(unseenEntries(['a 2026-11-20T10:00:00+01:00'], seen), [], 'an entry that passed changes nothing');
  assert.deepEqual(unseenEntries([...seen, 'c 2026-11-21T15:00:00+01:00'], seen), ['c 2026-11-21T15:00:00+01:00'], 'a new entry');
  assert.deepEqual(unseenEntries(['a 2026-11-20T14:00:00+01:00'], seen), ['a 2026-11-20T14:00:00+01:00'], 'an entry that moved');
});

test('the live line says what runs now; the steps say what was done', async () => {
  const { nowDoing } = await import('../server/runner.js');
  assert.equal(nowDoing('Ran npm test'), 'Running npm test');
  assert.equal(nowDoing('Read app.js'), 'Reading app.js');
  assert.equal(nowDoing('Edited server/runner.js'), 'Editing server/runner.js');
  assert.equal(nowDoing('Thinking'), 'Thinking');
  assert.equal(nowDoing('Runs the brain update again'), 'Runs the brain update again');
});

test('in a repo, reading what GitHub has is allowed; changing the repo\'s setup is not', async () => {
  const can = buildPolicy({ mode: 'thread', cwd: '/vault', artifactsDir: '/a', repoDir: () => '/repos/o/n' });
  const sh = async (...words) => (await can('Bash', { command: words.join(' ') })).behavior;
  assert.equal(await sh('git', 'for-each-ref', 'refs/remotes/origin'), 'allow');
  assert.equal(await sh('git', 'log', 'origin/main..refs/remotes/origin/claude/x'), 'allow');
  assert.equal(await sh('git', 'remote', '-v'), 'allow');
  assert.equal(await sh('git', 'remote', 'set-url', 'origin', 'https://example.org/x.git'), 'deny');
  assert.equal(await sh('git', 'remote', 'add', 'fork', 'https://example.org/x.git'), 'deny');
  assert.equal(await sh('git', 'branch', '-D', 'main'), 'deny');
  assert.equal(await sh('git', 'push', 'origin', 'main'), 'deny');
});

test('a turn the restart cut off keeps what he added and says the app carries on; an old one asks him', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-restart-'));
  const threadsDir = path.join(dir, 'threads');
  const write = (id, meta) => { fs.mkdirSync(path.join(threadsDir, id), { recursive: true }); fs.writeFileSync(path.join(threadsDir, id, 'thread.json'), JSON.stringify({ id, title: id, state: 'working', updatedAt: Date.now(), workingOn: os.hostname(), pending: ['and one more thing'], ...meta })); };
  write('kept', { turnPrompt: 'Build it' });
  write('old', {});
  const { execFileSync } = await import('node:child_process');
  const script = `
    const store = await import(${JSON.stringify(new URL('../server/store.js', import.meta.url).href)});
    store.loadThreads();
    const pick = (id) => { const t = store.getThread(id); return { state: t.state, error: t.error, pending: t.pending, interrupted: Boolean(t.interrupted) }; };
    console.log(JSON.stringify({ kept: pick('kept'), old: pick('old') }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_AI_DATA: dir }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(out.kept.pending, ['and one more thing'], 'what he added goes in with the turn that carries on');
  assert.match(out.kept.error, /carries on by itself/);
  assert.ok(out.kept.interrupted);
  assert.deepEqual(out.old.pending, []);
  assert.match(out.old.error, /Send a message to pick it up again/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a thread\'s state changed on both computers: the copy that is further on wins, not blindly GitHub\'s', async () => {
  const { pickThread } = await import('../server/datasync.js');
  const j = (o) => JSON.stringify(o);
  const pick = (ours, theirs) => { const p = pickThread(j(ours), j(theirs), 'laptop'); return { side: p.side, ...JSON.parse(p.text) }; };
  // 23-11-2026: closed on the laptop with six messages; GitHub had the Pi's stale copy with a false error.
  const closed = { id: 't', state: 'done', messageCount: 6, error: '', changedAt: 100 };
  const stale = { id: 't', state: 'ready', messageCount: 1, error: 'Claude was working on this on the other computer, which went away before it finished.', changedAt: 900 };
  assert.equal(pick(closed, stale).side, 'ours');
  assert.equal(pick(closed, stale).error, '');
  assert.equal(pick(stale, closed).side, 'theirs', 'the same the other way round');
  // The same conversation on both: the computer that runs the turn knows.
  const running = { id: 't', state: 'working', workingOn: 'laptop', messageCount: 3, changedAt: 100 };
  const settled = { id: 't', state: 'ready', workingOn: '', messageCount: 3, error: 'went away', changedAt: 900 };
  assert.equal(pick(running, settled).side, 'ours');
  assert.equal(pick(settled, { ...running, workingOn: 'pi' }).side, 'theirs');
  assert.equal(pick({ ...running, workingOn: 'pi' }, settled).side, 'theirs', 'a turn that is not this computer\'s is not ours to vouch for: the later change wins');
  // Otherwise the later change; if nothing tells, GitHub's, as before.
  assert.equal(pick({ id: 't', state: 'done', messageCount: 2, changedAt: 500 }, { id: 't', state: 'ready', messageCount: 2, changedAt: 400 }).side, 'ours');
  assert.equal(pick({ id: 't', messageCount: 2 }, { id: 't', messageCount: 2 }).side, 'theirs');
  // What he queued or sent with "send and done" on the losing side is not lost.
  const kept = pick({ id: 't', messageCount: 2, queued: [{ id: 'q1', text: 'then deploy' }], unsent: ['and this'] }, { id: 't', messageCount: 4 });
  assert.equal(kept.side, 'theirs');
  assert.deepEqual(kept.queued, [{ id: 'q1', text: 'then deploy' }]);
  assert.deepEqual(kept.unsent, ['and this']);
  assert.equal(pickThread('not json', j(closed), 'laptop'), null);
});

test('the Pi\'s update script: no answer is not "idle", and an old "Update now" does not count', { skip: process.platform === 'win32' }, async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-updatesh-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const hub = path.join(dir, 'hub.git');
  const seed = path.join(dir, 'seed');
  const appDir = path.join(dir, 'app');
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state', 'app-ai-update');
  git(dir, 'init', '--bare', '-b', 'main', hub);
  git(dir, 'clone', hub, seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'checkout', '-B', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'one');
  git(seed, ...['pu' + 'sh', 'origin', 'main']);
  git(dir, 'clone', hub, appDir);
  fs.mkdirSync(path.join(appDir, 'deploy'));
  fs.copyFileSync(new URL('../deploy/update.sh', import.meta.url), path.join(appDir, 'deploy', 'update.sh'));
  // GitHub has something new.
  fs.writeFileSync(path.join(seed, 'a.txt'), 'two\n');
  git(seed, 'commit', '-am', 'two'); git(seed, ...['pu' + 'sh', 'origin', 'main']);
  // The app, systemd and npm, played by small scripts.
  fs.mkdirSync(bin); fs.mkdirSync(state, { recursive: true });
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('curl', `[ -s "${dir}/health" ] && cat "${dir}/health" || exit 7`);
  stub('systemctl', `case "$*" in *is-active*) [ -f "${dir}/active" ];; *restart*) echo restarted >> "${dir}/restarts";; esac`);
  stub('npm', 'exit 0');
  stub('sleep', 'exit 0');
  const run = () => spawnSync('sh', [path.join(appDir, 'deploy', 'update.sh')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, 'state') }, encoding: 'utf8' });
  const restarts = () => (fs.existsSync(path.join(dir, 'restarts')) ? fs.readFileSync(path.join(dir, 'restarts'), 'utf8').trim().split('\n').length : 0);
  const head = () => git(appDir, 'log', '-1', '--format=%s').trim();

  // The app runs but does not answer: it may be in the middle of Claude's work.
  fs.writeFileSync(path.join(dir, 'active'), '');
  assert.match(run().stdout, /is waiting: the app did not answer/);
  assert.equal(restarts(), 0);
  assert.equal(head(), 'one');

  // Claude is working, and an "Update now" from long ago is still lying there: it does not count.
  fs.writeFileSync(path.join(dir, 'health'), '{"ok":true,"busy":true,"pruning":false}');
  fs.writeFileSync(path.join(state, 'force'), '1\n');
  const old = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(path.join(state, 'force'), old, old);
  assert.match(run().stdout, /is waiting: Claude is working/);
  assert.equal(restarts(), 0);
  assert.ok(!fs.existsSync(path.join(state, 'force')), 'and it is used up');

  // "Update now", just clicked: at once, whatever runs.
  fs.writeFileSync(path.join(state, 'force'), '1\n');
  assert.match(run().stdout, /running/);
  assert.equal(restarts(), 1);
  assert.equal(head(), 'two');
  fs.rmSync(dir, { recursive: true, force: true });
});
