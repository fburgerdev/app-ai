// Taking files out of the data repo's history.
//
// The app's data folder is a git repository that both computers push to. Files that never
// belonged there (a library a script once put among a thread's shown files: thousands of
// files, hundreds of megabytes) stay in its history even after they are gone, and every
// new copy of the repo downloads them. These two functions take them out for good:
//
//   rewriteWithout   the computer doing the work rewrites its history without those
//                    paths, commit by commit, keeping every commit's message, author and
//                    date. Its working folder is not touched, so the app keeps running.
//   adoptRewritten   the other computer, on its next fetch, sees that GitHub's history
//                    was rewritten. It keeps what only it had changed, takes GitHub's
//                    history, and puts its own changes back on top.
//
// Both work on any folder and branch, so they can be tested on throwaway repos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitOk } from './git.js';

const sha = async (dir, ref) => (await git(dir, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '')).trim();

// Rewrites `branch` without `paths` (exact file paths). Returns the new tip, the old one,
// and how many commits changed; the branch itself is not moved (see `moveBranch`), so a
// push can go first and nothing changes here if it fails.
export async function rewriteWithout(dir, branch, paths) {
  const old = await sha(dir, `refs/heads/${branch}`);
  if (!old || !paths.length) return { old, tip: old, changed: 0 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-purge-'));
  const list = path.join(tmp, 'paths');
  fs.writeFileSync(list, `${paths.join('\0')}\0`);
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  try {
    const commits = (await git(dir, ['rev-list', '--reverse', '--topo-order', old])).split('\n').filter(Boolean);
    const map = new Map(); // old commit -> new commit
    let changed = 0;
    for (const c of commits) {
      const [tree, parentsLine, an, ae, ad, cn, ce, cd] = (await git(dir, ['show', '-s', '--format=%T%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI', c])).split('\n');
      const parents = parentsLine.split(' ').filter(Boolean).map((p) => map.get(p) || p);
      await git(dir, ['read-tree', tree], { env });
      await git(dir, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], { env });
      const newTree = (await git(dir, ['write-tree'], { env })).trim();
      const sameParents = parents.join(' ') === parentsLine.trim();
      if (newTree === tree && sameParents) { map.set(c, c); continue; }
      const message = await git(dir, ['show', '-s', '--format=%B', c]);
      const msgFile = path.join(tmp, 'msg');
      fs.writeFileSync(msgFile, message);
      const made = (await git(dir, ['commit-tree', newTree, ...parents.flatMap((p) => ['-p', p]), '-F', msgFile], {
        env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd },
      })).trim();
      map.set(c, made);
      changed += 1;
    }
    return { old, tip: map.get(old) || old, changed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Points the branch at the rewritten tip, if it is still where the rewrite started, and
// brings the index in line so the working folder shows no changes it did not have.
export async function moveBranch(dir, branch, tip, old) {
  await git(dir, ['update-ref', `refs/heads/${branch}`, tip, old]);
  await git(dir, ['reset', '--quiet']);
}

// Frees the space the old history took on this computer.
export async function forgetOld(dir) {
  await git(dir, ['reflog', 'expire', '--expire=now', '--all']).catch(() => {});
  await git(dir, ['gc', '--quiet', '--prune=now'], { timeout: 30 * 60_000 }).catch(() => {});
}

// After a fetch: was GitHub's branch rewritten (the version this computer knew is no
// longer part of it)? `before` is what origin/<branch> pointed at before the fetch.
export async function wasRewritten(dir, branch, before) {
  const now = await sha(dir, `refs/remotes/origin/${branch}`);
  if (!before || !now || before === now) return false;
  return !(await gitOk(dir, ['merge-base', '--is-ancestor', before, now]));
}

// The other computer's side. `before` as above. Keeps the files this computer changed
// since it last had GitHub's version, takes the rewritten history, and commits those
// files on top. Returns the paths it kept.
export async function adoptRewritten(dir, branch, before, { message = 'state: kept on this computer after the history was cleaned', exclude = new Set() } = {}) {
  const theirs = `refs/remotes/origin/${branch}`;
  // What only this computer changed: its commits since `before`, and anything not committed.
  await git(dir, ['add', '-A']);
  const names = new Set();
  for (const range of [[before, 'HEAD'], ['HEAD']]) {
    const out = range.length === 2
      ? await git(dir, ['diff', '--name-only', '-z', '--no-renames', range[0], range[1]]).catch(() => '')
      : await git(dir, ['diff', '--name-only', '-z', '--no-renames', '--cached', 'HEAD']).catch(() => '');
    for (const n of out.split('\0').filter(Boolean)) if (!exclude.has(n)) names.add(n);
  }
  const kept = [];
  for (const n of names) {
    const full = path.join(dir, ...n.split('/'));
    kept.push({ n, data: fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full) : null });
  }
  await git(dir, ['reset', '--quiet', '--hard', theirs]);
  for (const { n, data } of kept) {
    const full = path.join(dir, ...n.split('/'));
    if (data === null) fs.rmSync(full, { force: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data); }
  }
  await git(dir, ['add', '-A']);
  if (!(await gitOk(dir, ['diff', '--cached', '--quiet']))) await git(dir, ['commit', '--quiet', '-m', message]);
  return kept.map((k) => k.n);
}
