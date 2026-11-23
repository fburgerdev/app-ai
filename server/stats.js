// What happened, counted: for the Stats view.
//
// Everything comes from what the app and the vault already keep; nothing is recorded just
// for this. Each figure is counted for this week, last week, the last four weeks and all
// time (from the oldest record there is). Weeks start on Monday.
//
//   threads     from the threads: started by Florian, closed
//   mail        from each thread's files: mails sent from the app, put into Gmail
//   cards       from the card log: decided, accepted, declined
//   brain       from the brain update's runs: updates that changed the vault
//   vault       from the vault's git history: project, area and person notes added or
//               removed (a removed project note is a project closed)
//   repos       from the repos the app holds: changes merged into main
//   usage       from usage.jsonl: what Claude cost
//
// Counting runs a git command per repo, so it never blocks the app: git runs
// asynchronously, the vault is read in one log for all three folders, and the last result
// is kept. The page gets the kept result at once, with when it was counted, and a fresh
// count runs in the background at most every few minutes; one also runs when the app starts.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from './store.js';
import * as brain from './brain.js';
import { readCardLog } from './cards.js';
import { lastRuns } from './extract.js';
import { DATA_DIR } from './config.js';
import { read as readUsage } from './usage.js';

const execFileP = promisify(execFile);
const git = async (args, cwd, maxBuffer = 8 * 1024 * 1024) =>
  (await execFileP('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer })).stdout;

const APP_KINDS = new Set(['card', 'brain-update', 'mail-reply', 'checkin-active', 'checkin-paused', 'checkin-areas', 'repair', 'prep', 'event']);
const NOT_NOTES = new Set(['Projects Index', 'People Index', 'PBU Community Members', 'Areas Index']);

function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// The periods every figure is counted in.
export function periods(now = Date.now()) {
  const thisWeek = weekStart(new Date(now));
  const week = 7 * 86400_000;
  return [
    { key: 'thisWeek', label: 'This week', from: thisWeek, to: Infinity },
    { key: 'lastWeek', label: 'Last week', from: thisWeek - week, to: thisWeek },
    { key: 'fourWeeks', label: 'Last 4 weeks', from: thisWeek - 3 * week, to: Infinity },
    { key: 'all', label: 'All time', from: 0, to: Infinity },
  ];
}

const count = (times, p) => times.filter((t) => t >= p.from && t < p.to).length;

// Notes added and removed under the vault's Projects, People and Areas folders, by the
// date of the commit, read in one git log.
const FOLDERS = ['Projects', 'People', 'Areas'];
async function vaultChanges() {
  const dir = brain.brainDir();
  // The notes' folder was called Brain/ until 17-11-2026; its history counts under both
  // names. Renaming the folder moved every note (-M sees a move, not an add and a delete).
  const names = [...new Set([brain.coreName(), 'Brain'])];
  const out = Object.fromEntries(FOLDERS.map((f) => [f, { added: [], removed: [] }]));
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return out;
  let text = '';
  try {
    text = await git(['-c', 'core.quotepath=off', 'log', '-M', '--diff-filter=AD', '--name-status', '--format=@%ct', '--',
      ...names.flatMap((c) => FOLDERS.map((f) => `${c}/${f}`))], dir, 32 * 1024 * 1024);
  } catch { return out; }
  let ts = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) { ts = Number(line.slice(1)) * 1000; continue; }
    const m = /^([AD])\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const file = m[2];
    // Only notes directly in a folder; the index and roster files are not things.
    if (!file.endsWith('.md')) continue;
    const folder = FOLDERS.find((f) => names.some((c) => path.posix.dirname(file) === `${c}/${f}`));
    if (!folder || NOT_NOTES.has(path.posix.basename(file, '.md'))) continue;
    out[folder][m[1] === 'A' ? 'added' : 'removed'].push(ts);
  }
  return out;
}

// Merges into main in every repo the app holds, by the date of the merge, all repos at once.
async function repoMerges() {
  const root = path.join(DATA_DIR, 'repos');
  const dirs = [];
  let owners = [];
  try { owners = fs.readdirSync(root); } catch { return []; }
  for (const owner of owners) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, owner)); } catch { continue; }
    for (const name of names) {
      const dir = path.join(root, owner, name);
      if (fs.existsSync(path.join(dir, '.git'))) dirs.push(dir);
    }
  }
  const lists = await Promise.all(dirs.map(async (dir) => {
    let head = 'origin/main';
    try { head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)).trim() || head; } catch { /* no origin HEAD: main */ }
    try {
      const out = await git(['log', '--merges', '--first-parent', '--format=%ct', head], dir);
      return out.split('\n').filter((l) => l.trim()).map((l) => Number(l) * 1000);
    } catch { return []; } // no main yet
  }));
  return lists.flat();
}

// What each run cost (usage.js works out the price of lines from before 18-11-2026 again).
const usageCosts = () => readUsage().map((e) => ({ ts: e.ts, cost: e.cost }));

async function countAll(now = Date.now()) {
  const ps = periods(now);
  const threads = store.listThreads();
  const own = threads.filter((t) => !APP_KINDS.has(t.kind));
  const sent = [];
  const drafted = [];
  for (const t of threads) {
    if (t.kind === 'card') continue;
    for (const a of store.listArtifacts(t.id)) {
      if (a.mail?.sentAt) sent.push(a.mail.sentAt);
      else if (a.mail?.draftAt) drafted.push(a.mail.draftAt);
    }
  }
  const cards = readCardLog().filter((e) => e.type !== 'prep');
  for (const e of cards) if (e.outcome === 'accepted' && e.how === 'sent') sent.push(e.ts);
  const runs = lastRuns(10_000).filter((r) => r.status === 'updated' && r.finishedAt);
  const [vault, merges] = await Promise.all([vaultChanges(), repoMerges()]);
  const { Projects: projects, People: people, Areas: areas } = vault;
  const costs = usageCosts();

  const rows = [
    { group: 'Threads', label: 'Threads you started', times: own.map((t) => t.createdAt).filter(Boolean) },
    { group: 'Threads', label: 'Threads closed', times: threads.filter((t) => t.kind !== 'card' && t.doneAt).map((t) => t.doneAt) },
    { group: 'Mail', label: 'Mails sent from the app', times: sent },
    { group: 'Mail', label: 'Mails put into Gmail', times: drafted },
    { group: 'Opportunities', label: 'Cards accepted', times: cards.filter((e) => e.outcome === 'accepted').map((e) => e.ts) },
    { group: 'Opportunities', label: 'Cards declined', times: cards.filter((e) => e.outcome === 'declined').map((e) => e.ts) },
    { group: 'Brain', label: 'Brain updates', times: runs.map((r) => r.finishedAt) },
    { group: 'Brain', label: 'Projects started', times: projects.added },
    { group: 'Brain', label: 'Projects closed', times: projects.removed },
    { group: 'Brain', label: 'People added', times: people.added },
    { group: 'Brain', label: 'Areas added', times: areas.added },
    { group: 'Code', label: 'Changes merged into main', times: merges },
  ];
  return {
    periods: ps.map(({ key, label }) => ({ key, label })),
    rows: rows.map((r) => ({ group: r.group, label: r.label, values: Object.fromEntries(ps.map((p) => [p.key, count(r.times, p)])) })),
    cost: Object.fromEntries(ps.map((p) => [p.key, Math.round(costs.filter((c) => c.ts >= p.from && c.ts < p.to).reduce((a, c) => a + c.cost, 0) * 100) / 100])),
    since: Math.min(...[...threads.map((t) => t.createdAt || now), now]),
    asOf: now,
  };
}

// The kept result and the count in flight. A count starts when the kept one is older than
// FRESH_MS, or there is none; only one runs at a time.
const FRESH_MS = 5 * 60_000;
let kept = null;
let counting = null;

export function recount() {
  if (!counting) {
    counting = countAll().then((s) => { kept = s; return s; }).finally(() => { counting = null; });
  }
  return counting;
}

// The kept count at once, plus `refreshing` while a newer one runs. Waits only when there is
// nothing kept yet, when asked to (`wait`) and a count is running, or for a new count
// (`fresh`, which the tests use).
export async function stats({ wait = false, fresh = false } = {}) {
  if (fresh) { await recount(); if (counting) await counting; }
  if (!kept || Date.now() - kept.asOf > FRESH_MS) recount().catch(() => {});
  if (!kept || (wait && counting)) await (counting || recount());
  return { ...kept, refreshing: Boolean(counting) };
}
