// Signs this computer in to Claude with your Claude subscription, using the copy of
// Claude Code that ships inside the Agent SDK. Run once:  npm run login
// "npm run login -- status" shows whether you are signed in.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const file = process.platform === 'win32' ? 'claude.exe' : 'claude';
const candidates = [
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${file}`,
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl/${file}`,
];

let bin = null;
for (const candidate of candidates) {
  try {
    bin = require.resolve(candidate);
    break;
  } catch {
    // try the next one
  }
}
if (!bin) {
  console.error('The Claude program that comes with the app was not found. Run "npm install" first.');
  process.exit(1);
}

const action = process.argv[2] === 'status' ? ['auth', 'status'] : ['auth', 'login', '--claudeai'];
spawn(bin, action, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
