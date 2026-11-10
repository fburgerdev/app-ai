// The app's own clone of the brain vault.
//
// In the Claude app every session clones the vault from scratch. Here there is one clone
// that stays on disk, and the app, not Claude, keeps it current:
//
//   - before a turn starts, the clone is brought up to GitHub's state (at most once a
//     minute, a few hundred milliseconds when nothing changed);
//   - threads only read it. Several can run at once without stepping on each other;
//   - one job at a time writes it: the brain update, which commits and pushes.
//
// GitHub stays the ground truth. Nothing else may write this folder, so anything found
// changed outside a brain update is thrown away.

import fs from 'node:fs';
import path from 'node:path';
import { git, gitOk } from './git.js';
import { log } from './config.js';

let config;
let chain = Promise.resolve(); // serialises every git operation on the clone
let lastRefresh = 0;
let writer = null; // name of the job that currently owns the working tree

const status = { ready: false, head: '', error: '', refreshedAt: 0, unpushed: 0 };

export function initBrain(cfg) {
  config = cfg;
}

export function brainStatus() {
  return { ...status, writing: Boolean(writer) };
}

export const brainDir = () => config.brainDir;

function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function head() {
  return (await git(config.brainDir, ['rev-parse', '--short', 'HEAD'])).trim();
}

// Paths Claude must never read (the Scratchpad) or has no use for are left out of the
// clone's working folder altogether, with git's sparse checkout. They stay in the
// repository and on GitHub untouched; they are just never written to this disk, so no
// run can read or change them.
async function applyHiddenPaths() {
  const hidden = config.hiddenPaths || [];
  if (!hidden.length) {
    await gitOk(config.brainDir, ['sparse-checkout', 'disable']);
    return;
  }
  const patterns = ['/*', ...hidden.map((p) => `!/${p.replace(/^\/+|\/+$/g, '')}`)];
  await git(config.brainDir, ['sparse-checkout', 'set', '--no-cone', '--', ...patterns]);
}

export function ensureClone() {
  return serial(async () => {
    try {
      if (!fs.existsSync(path.join(config.brainDir, '.git'))) {
        fs.mkdirSync(path.dirname(config.brainDir), { recursive: true });
        log(`cloning ${config.brainRepo}`);
        await git(path.dirname(config.brainDir), [
          'clone', '--no-checkout', '--branch', config.brainBranch, config.brainRepo, config.brainDir,
        ], { timeout: 600_000 });
        await applyHiddenPaths();
        await git(config.brainDir, ['checkout', '--quiet', config.brainBranch]);
      } else {
        await applyHiddenPaths();
      }
      status.head = await head();
      status.ready = true;
      status.error = '';
    } catch (err) {
      status.ready = false;
      status.error = `The brain could not be cloned: ${err.message}`;
      log(status.error);
    }
    return brainStatus();
  });
}

// Brings the clone up to GitHub's state. Skipped while a brain update owns the tree.
// Never throws: offline, the threads simply work on the last state the laptop saw.
export function refresh({ force = false } = {}) {
  return serial(async () => {
    if (!status.ready || writer) return brainStatus();
    if (!force && Date.now() - lastRefresh < 60_000) return brainStatus();
    lastRefresh = Date.now();
    const dir = config.brainDir;
    const branch = config.brainBranch;
    try {
      // Threads must not write here. Whatever did: discard it.
      const dirty = (await git(dir, ['status', '--porcelain'])).trim();
      if (dirty) {
        log(`brain clone had stray changes, discarding:\n${dirty}`);
        await git(dir, ['reset', '--hard', 'HEAD']);
        await git(dir, ['clean', '-fd']);
      }
      await git(dir, ['fetch', '--quiet', 'origin', branch]);
      const [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]))
        .trim().split(/\s+/).map(Number);
      if (behind > 0 && ahead === 0) {
        await git(dir, ['merge', '--ff-only', '--quiet', `origin/${branch}`]);
      } else if (ahead > 0) {
        // A brain update committed but could not push (offline). Try again now.
        if (behind > 0) await rebaseOnto(dir, branch);
        await git(dir, ['push', '--quiet', 'origin', `HEAD:${branch}`]);
      }
      status.unpushed = 0;
      status.head = await head();
      status.refreshedAt = Date.now();
      status.error = '';
    } catch (err) {
      status.error = `The brain could not be brought up to date: ${err.message}`;
      log(status.error);
      try {
        status.unpushed = Number((await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim());
      } catch { /* leave as is */ }
    }
    return brainStatus();
  });
}

async function rebaseOnto(dir, branch) {
  try {
    await git(dir, ['rebase', '--quiet', `origin/${branch}`]);
  } catch (err) {
    await gitOk(dir, ['rebase', '--abort']);
    throw new Error(`the app's commit conflicts with a newer one on GitHub (${err.message})`);
  }
}

// Gives one job the working tree. While it runs, refresh() leaves the clone alone.
export async function withWriter(name, fn) {
  if (writer) throw new Error(`"${writer}" is already writing the brain`);
  writer = name;
  try {
    return await fn();
  } finally {
    writer = null;
    lastRefresh = 0;
  }
}

// Called by the brain update, inside withWriter: start from GitHub's current state.
export function pullForWriting() {
  return serial(async () => {
    const dir = config.brainDir;
    const branch = config.brainBranch;
    const dirty = (await git(dir, ['status', '--porcelain'])).trim();
    if (dirty) {
      log(`brain clone had stray changes before a brain update, discarding:\n${dirty}`);
      await git(dir, ['reset', '--hard', 'HEAD']);
      await git(dir, ['clean', '-fd']);
    }
    await git(dir, ['fetch', '--quiet', 'origin', branch]);
    const [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]))
      .trim().split(/\s+/).map(Number);
    if (behind > 0 && ahead === 0) await git(dir, ['merge', '--ff-only', '--quiet', `origin/${branch}`]);
    else if (behind > 0) await rebaseOnto(dir, branch);
    status.head = await head();
  });
}

// Commits whatever the brain update changed and pushes it. Returns null when nothing
// changed. Protected paths are put back first, whatever the run did to them.
export function commitAndPush({ subject, body }) {
  return serial(async () => {
    const dir = config.brainDir;
    const branch = config.brainBranch;
    const restored = [];
    for (const p of config.protectedPaths) {
      const spec = `:(literal)${p}`;
      const touched = (await git(dir, ['status', '--porcelain', '--', spec])).trim();
      if (!touched) continue;
      restored.push(p);
      await gitOk(dir, ['checkout', 'HEAD', '--', spec]);
      await gitOk(dir, ['clean', '-fdq', '--', spec]);
    }
    if (restored.length) log(`brain update touched protected paths, put back: ${restored.join(', ')}`);

    await git(dir, ['add', '-A']);
    if (await gitOk(dir, ['diff', '--cached', '--quiet'])) return null;

    const files = (await git(dir, ['diff', '--cached', '--name-status', '-z']))
      .split('\0').filter(Boolean);
    const changes = [];
    for (let i = 0; i + 1 < files.length; i += 2) changes.push({ change: files[i], path: files[i + 1] });

    await git(dir, ['commit', '--quiet', '-m', subject, '-m', body]);
    const commit = await head();
    status.head = commit;

    let pushed = false;
    let pushError = '';
    for (let attempt = 0; attempt < 2 && !pushed; attempt += 1) {
      try {
        await git(dir, ['push', '--quiet', 'origin', `HEAD:${branch}`]);
        pushed = true;
      } catch (err) {
        pushError = err.message;
        try {
          await git(dir, ['fetch', '--quiet', 'origin', branch]);
          await rebaseOnto(dir, branch);
        } catch (inner) {
          pushError = inner.message;
          break;
        }
      }
    }
    status.unpushed = pushed ? 0 : 1;
    status.head = await head();
    return { commit: status.head, pushed, pushError, changes, restored };
  });
}

// ---------- reading the vault for the interface ----------

function insideVault(rel) {
  const full = path.resolve(config.brainDir, rel);
  const root = path.resolve(config.brainDir) + path.sep;
  if (!full.startsWith(root)) return null;
  if (full.split(path.sep).includes('.git')) return null;
  return full;
}

export function readVaultFile(rel) {
  const full = insideVault(rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { path: path.relative(config.brainDir, full).split(path.sep).join('/'), full };
}

let noteIndex = { head: null, byName: new Map() };

// Resolves an Obsidian link target ("Next Actions" or a path)
// to a file in the vault, the way Obsidian does: by file name, wherever it sits.
export function resolveWikilink(target) {
  if (!status.ready) return null;
  const clean = target.split('#')[0].split('|')[0].trim();
  if (!clean) return null;
  for (const candidate of [clean, `${clean}.md`]) {
    const direct = readVaultFile(candidate);
    if (direct) return direct;
  }
  if (noteIndex.head !== status.head) {
    const byName = new Map();
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === '.obsidian') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else {
          const key = entry.name.replace(/\.md$/i, '').toLowerCase();
          if (!byName.has(key)) byName.set(key, full);
        }
      }
    };
    visit(config.brainDir);
    noteIndex = { head: status.head, byName };
  }
  const base = clean.split('/').pop().replace(/\.md$/i, '').toLowerCase();
  const full = noteIndex.byName.get(base);
  if (!full) return null;
  return { path: path.relative(config.brainDir, full).split(path.sep).join('/'), full };
}

// The vault files that go into every thread's instructions.
export function readPreload() {
  const out = [];
  for (const rel of config.preload || []) {
    const file = readVaultFile(rel);
    if (!file) continue;
    out.push({ path: file.path, text: fs.readFileSync(file.full, 'utf8') });
  }
  return out;
}

// Throws away whatever is uncommitted in the clone (a brain update that failed midway).
export function discardChanges() {
  return serial(async () => {
    await gitOk(config.brainDir, ['reset', '--hard', 'HEAD']);
    await gitOk(config.brainDir, ['clean', '-fd']);
  });
}
