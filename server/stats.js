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

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as store from './store.js';
import * as brain from './brain.js';
import { readCardLog } from './cards.js';
import { lastRuns } from './extract.js';
import { DATA_DIR } from './config.js';
import { read as readUsage } from './usage.js';

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

// Notes added and removed under a vault folder, by the date of the commit.
function vaultChanges(folder) {
  const dir = brain.brainDir();
  // The notes' folder was called Brain/ until 17-11-2026; its history counts under both
  // names. Renaming the folder moved every note (-M sees a move, not an add and a delete).
  const names = [...new Set([brain.coreName(), 'Brain'])];
  const out = { added: [], removed: [] };
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return out;
  let text = '';
  try {
    text = execFileSync('git', ['-c', 'core.quotepath=off', 'log', '-M', '--diff-filter=AD', '--name-status', '--format=@%ct', '--', ...names.map((c) => `${c}/${folder}`)],
      { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } catch { return out; }
  let ts = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) { ts = Number(line.slice(1)) * 1000; continue; }
    const m = /^([AD])\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const file = m[2];
    // Only notes directly in the folder; the index and roster files are not things.
    if (!file.endsWith('.md') || !names.some((c) => path.posix.dirname(file) === `${c}/${folder}`)) continue;
    if (NOT_NOTES.has(path.posix.basename(file, '.md'))) continue;
    (m[1] === 'A' ? out.added : out.removed).push(ts);
  }
  return out;
}

// Merges into main in every repo the app holds, by the date of the merge.
function repoMerges() {
  const root = path.join(DATA_DIR, 'repos');
  const times = [];
  let owners = [];
  try { owners = fs.readdirSync(root); } catch { return times; }
  for (const owner of owners) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, owner)); } catch { continue; }
    for (const name of names) {
      const dir = path.join(root, owner, name);
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      try {
        const head = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'origin/main';
        const out = execFileSync('git', ['log', '--merges', '--first-parent', '--format=%ct', head], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const l of out.split('\n')) if (l.trim()) times.push(Number(l) * 1000);
      } catch { /* no main yet */ }
    }
  }
  return times;
}

// What each run cost (usage.js works out the price of lines from before 18-11-2026 again).
const usageCosts = () => readUsage().map((e) => ({ ts: e.ts, cost: e.cost }));

export function stats(now = Date.now()) {
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
  const projects = vaultChanges('Projects');
  const people = vaultChanges('People');
  const areas = vaultChanges('Areas');
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
    { group: 'Code', label: 'Changes merged into main', times: repoMerges() },
  ];
  return {
    periods: ps.map(({ key, label }) => ({ key, label })),
    rows: rows.map((r) => ({ group: r.group, label: r.label, values: Object.fromEntries(ps.map((p) => [p.key, count(r.times, p)])) })),
    cost: Object.fromEntries(ps.map((p) => [p.key, Math.round(costs.filter((c) => c.ts >= p.from && c.ts < p.to).reduce((a, c) => a + c.cost, 0) * 100) / 100])),
    since: Math.min(...[...threads.map((t) => t.createdAt || now), now]),
  };
}
