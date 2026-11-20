// Thin wrapper around the git command line.

import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(args, stderr, code) {
    super(`git ${args.join(' ')} failed: ${String(stderr).trim().split('\n').slice(-3).join(' ')}`);
    this.code = code;
    this.stderr = String(stderr);
  }
}

// Runs git and returns stdout. Never prompts: a hidden prompt would hang the app.
export function git(cwd, args, { timeout = 120_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args],
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', ...env },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        // Stopped by the timeout, not failed: git says nothing then. Seen when the laptop
        // slept in the middle of a step and the clock had run out by the time it woke.
        const timedOut = err.killed === true && !String(stderr).trim();
        const failure = new GitError(args, timedOut ? `did not finish within ${Math.round(timeout / 1000)} s and was stopped (the computer may have been asleep)` : stderr || err.message, err.code);
        failure.timedOut = timedOut;
        reject(failure);
      },
    );
  });
}

// True when git exits with 0 (for git's yes/no checks).
export async function gitOk(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
