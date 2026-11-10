// Tries the app without touching your brain or your Claude account: a throwaway vault,
// throwaway app data, and a stand-in for Claude that gives canned answers.
//   npm run demo

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-demo-'));
const remote = path.join(dir, 'vault.git');
const seed = path.join(dir, 'seed');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...args], { cwd, stdio: 'ignore' });

git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'clone', remote, seed);
fs.mkdirSync(path.join(seed, 'Brain'), { recursive: true });
fs.mkdirSync(path.join(seed, 'Claude'), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# Demo vault\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Next Actions.md'), '# Next Actions\n\n- [ ] Try the inbox app\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Thinking With Me.md'), '# Thinking With Me\n');
fs.writeFileSync(path.join(seed, 'Scratchpad.md'), 'never read by the app\n');
fs.mkdirSync(path.join(seed, 'Brain', 'Projects'), { recursive: true });
fs.mkdirSync(path.join(seed, 'Brain', 'Areas'), { recursive: true });
fs.writeFileSync(path.join(seed, 'Brain', 'Areas', 'Example Campaign.md'), '# Example Campaign\n\ngoal: an example area\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Example Motion.md'), '# Example Motion\n\nStatus: active\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Example Grant.md'), '# Example Grant\n\nStatus: active\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Example Endorsement.md'), '# Example Endorsement\n\nStatus: paused\n\nWaiting for the office to reply.\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Areas', 'Example Channel.md'), '# Example Channel\n\ngoal: an area with no project right now\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## [[Example Campaign]]\n\n- [[Example Motion]] — a motion in the example parliament\n- [[Example Endorsement]] — getting the example office on record\n\n## [[Example Channel]]\n\n—\n\n## No area\n\n- [[Example Grant]] — applying for an example grant\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'demo vault');
git(seed, 'push', 'origin', 'main');

console.log(`Demo data is in ${dir} (delete it whenever you like).`);
spawn(process.execPath, [path.join(root, 'server', 'index.js'), '--open'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_AI_FAKE: '1',
    APP_AI_DATA: path.join(dir, 'data'),
    APP_AI_BRAIN_REPO: remote,
    APP_AI_DATA_REPO: '',
    APP_AI_PORT: process.env.APP_AI_PORT || '4399',
  },
});
