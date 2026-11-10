// The vault's areas and projects, as the app shows them.
//
// The list is read from Brain/Projects/Projects Index.md in the app's clone. The app
// keeps no list of its own, so a project exists here exactly when it exists in the vault.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as brain from './brain.js';
import * as store from './store.js';

const INDEX = 'Brain/Projects/Projects Index.md';
const link = (s) => /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(s)?.[1].trim() || '';

export function parseIndex(text) {
  const groups = [];
  let group = null;
  for (const line of String(text).split(/\r?\n/)) {
    const head = /^##\s+(.*)$/.exec(line);
    if (head) {
      const name = link(head[1]) || head[1].trim();
      group = { name, isArea: Boolean(link(head[1])), projects: [] };
      groups.push(group);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item && group) {
      const name = link(item[1]);
      if (!name) continue;
      const about = item[1].split(/\s[—–-]\s/).slice(1).join(' — ').trim();
      group.projects.push({ name, about, delegated: /\[delegated\]/i.test(item[1]) });
    }
  }
  return groups;
}

// A project's `Status:` line in its note: active, paused, blocked or done.
function statusOf(name) {
  const f = brain.resolveWikilink(name);
  if (!f) return 'active';
  try {
    return (/^Status:\s*([a-z]+)/im.exec(fs.readFileSync(f.full, 'utf8').slice(0, 600))?.[1] || 'active').toLowerCase();
  } catch { return 'active'; }
}

// When each note was last changed in the vault, from git. Read once per vault state.
let noteTimes = { head: null, byPath: new Map() };
function noteChanged(name) {
  const head = brain.brainStatus().head;
  if (noteTimes.head !== head) {
    const byPath = new Map();
    try {
      const out = execFileSync('git', ['-c', 'core.quotepath=off', 'log', '--format=@%ct', '--name-only', '--', 'Brain/Projects', 'Brain/Areas'],
        { cwd: brain.brainDir(), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      let ts = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('@')) ts = Number(line.slice(1)) * 1000;
        else if (line && !byPath.has(line)) byPath.set(line, ts);
      }
    } catch { /* no history: threads alone decide */ }
    noteTimes = { head, byPath };
  }
  const f = brain.resolveWikilink(name);
  return f ? noteTimes.byPath.get(f.path) || 0 : 0;
}

// The areas and projects with what the app knows on top: whether a project is paused,
// whether it has open threads, and when Florian last dealt with it (his latest message
// in one of its threads, or the last change to its note in the vault).
export function projectTree() {
  const file = brain.readVaultFile(INDEX);
  if (!file) return { groups: [], missing: true };
  const groups = parseIndex(fs.readFileSync(file.full, 'utf8'));
  const threads = store.listThreads().filter((t) => t.project && t.kind !== 'card');
  const stats = (name) => {
    const mine = threads.filter((t) => t.project === name);
    return {
      open: mine.filter((t) => t.state !== 'done').length,
      touched: Math.max(noteChanged(name), mine.reduce((max, t) => Math.max(max, t.lastUserTs || 0), 0)),
    };
  };
  for (const g of groups) {
    if (g.isArea) Object.assign(g, stats(g.name));
    for (const p of g.projects) {
      const status = statusOf(p.name);
      Object.assign(p, stats(p.name), { status, paused: status === 'paused' || status === 'blocked' });
    }
    if (g.isArea) g.touched = Math.max(g.touched, ...g.projects.map((p) => p.touched));
  }
  return { groups };
}

// The files a thread on this project starts with: the project's own note and, for a
// project, the note of the area it belongs to.
export function projectContext(name) {
  if (!name) return [];
  const out = [];
  const add = (note) => {
    const f = brain.resolveWikilink(note);
    if (f && f.path.endsWith('.md') && !out.some((o) => o.path === f.path)) out.push({ path: f.path, text: fs.readFileSync(f.full, 'utf8') });
  };
  add(name);
  const file = brain.readVaultFile(INDEX);
  if (file) {
    const area = parseIndex(fs.readFileSync(file.full, 'utf8')).find((g) => g.isArea && g.projects.some((p) => p.name === name));
    if (area) add(area.name);
  }
  return out;
}

export function isKnownProject(name) {
  const file = brain.readVaultFile(INDEX);
  if (!file) return false;
  return parseIndex(fs.readFileSync(file.full, 'utf8')).some((g) => (g.isArea && g.name === name) || g.projects.some((p) => p.name === name));
}
