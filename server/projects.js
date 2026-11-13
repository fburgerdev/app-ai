// The vault's areas and projects, as the app shows them.
//
// The list is read from Brain/Projects/Projects Index.md in the app's clone. The app
// keeps no list of its own, so a project exists here exactly when it exists in the vault.

import fs from 'node:fs';
import path from 'node:path';
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
  const groups = withAreaFiles(parseIndex(fs.readFileSync(file.full, 'utf8')));
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
  // 30,000 ft: the order of the areas, and what each should have reached in a year or two.
  // A name in the list that matches no area is passed over; the ranks of the others are
  // counted without it, so the numbers shown have no gap.
  const ranks = areaRanks();
  const byLower = new Map([...ranks].map(([name, r]) => [name.toLowerCase(), r]));
  const ranked = groups.filter((g) => g.isArea && byLower.has(g.name.toLowerCase())).sort((a, b) => byLower.get(a.name.toLowerCase()).rank - byLower.get(b.name.toLowerCase()).rank);
  for (const g of groups) if (g.isArea) { g.rank = 0; g.goal = ''; }
  ranked.forEach((g, i) => { g.rank = i + 1; g.goal = byLower.get(g.name.toLowerCase()).goal; });
  return { groups, people: peopleList(), someday: somedayList() };
}

// Every note in Brain/Areas is an area, whether or not the Projects Index has a heading
// for it: one that is missing there is added, without projects, so it is never hidden.
const AREAS_DIR = 'Brain/Areas';
function areaFiles() {
  try {
    return fs.readdirSync(path.join(brain.brainDir() || '', AREAS_DIR)).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
  } catch { return []; }
}
function withAreaFiles(groups) {
  const have = new Set(groups.filter((g) => g.isArea).map((g) => g.name.toLowerCase()));
  for (const name of areaFiles()) if (!have.has(name.toLowerCase())) groups.push({ name, isArea: true, projects: [] });
  return groups;
}

// ---------- people and Someday, shown like projects ----------
//
// So that they come back to Florian the way projects do: who has something open, when
// he last dealt with them; and each Someday item with how long it has sat there.

const PEOPLE_DIR = 'Brain/People';
const SOMEDAY = 'Brain/Someday.md';
const NOT_PEOPLE = new Set(['People Index', 'PBU Community Members']);
const ddmmyyyy = (s) => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s || ''); return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12).getTime() : 0; };

let peopleCache = { head: null, list: [] };
export function peopleList() {
  const head = brain.brainStatus().head;
  if (peopleCache.head === head && head) return peopleCache.list;
  const dir = path.join(brain.brainDir() || '', PEOPLE_DIR);
  const list = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { /* no people yet */ }
  for (const file of names) {
    const name = file.slice(0, -3);
    if (NOT_PEOPLE.has(name)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const contacted = /^Last contacted:\s*(.*)$/im.exec(text)?.[1] || '';
    const threads = (/^Open threads:\s*(.*)$/im.exec(text)?.[1] || '').trim();
    const nothing = !threads || /^(none|nothing)\b/i.test(threads);
    const role = (/^role:\s*(.*)$/im.exec(text)?.[1] || '').replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').trim();
    // `Status:` in the file says which group; without it, what is open decides.
    const status = (/^Status:\s*(.*)$/im.exec(text.slice(0, 1500))?.[1] || '').trim().replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
    let group = nothing ? 'none' : 'move';
    let waitsFor = '';
    if (/^your move/i.test(status)) group = 'move';
    else if (/^keep warm/i.test(status)) group = 'warm';
    else if (/^waiting/i.test(status)) { group = 'waiting'; waitsFor = status.replace(/^waiting\s*(for)?\s*:?\s*/i, ''); }
    else if (/^nothing open|^dormant/i.test(status)) group = 'none';
    list.push({ name, about: threads ? `Open: ${threads.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')}` : role, open: !nothing, group, waitsFor, contacted: ddmmyyyy(contacted) });
  }
  peopleCache = { head, list };
  return list;
}

let somedayCache = { head: null, list: [] };
export function somedayList() {
  const head = brain.brainStatus().head;
  if (somedayCache.head === head && head) return somedayCache.list;
  const file = brain.readVaultFile(SOMEDAY);
  if (!file) return [];
  const lines = fs.readFileSync(file.full, 'utf8').split(/\r?\n/);
  // When each line last changed, from git.
  const times = [];
  try {
    const out = execFileSync('git', ['blame', '--line-porcelain', '--', SOMEDAY], { cwd: brain.brainDir(), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split('\n')) if (line.startsWith('author-time ')) times.push(Number(line.slice(12)) * 1000);
  } catch { /* no history */ }
  const list = [];
  let parked = false;
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) parked = /parked/i.test(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (!item) return;
    const text = item[1].replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/\*\*/g, '').trim();
    list.push({ text, short: text.split(/(?<=[.!?])\s/)[0].slice(0, 140), parked, touched: times[i] || 0 });
  });
  somedayCache = { head, list };
  return list;
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

// The GitHub repo a project or area note names on its optional `repo:` line, or ''.
export function repoOf(name) {
  if (!name) return '';
  const f = brain.resolveWikilink(name);
  if (!f) return '';
  try {
    const line = /^repo:\s*`?([^`\s,]+)`?/im.exec(fs.readFileSync(f.full, 'utf8').slice(0, 3000));
    return line ? line[1].replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '') : '';
  } catch { return ''; }
}

// A project or area from the index; also a person, or Someday, which threads can be on too.
export function isKnownProject(name) {
  if (!name) return false;
  if (name === 'Someday' || peopleList().some((p) => p.name === name)) return true;
  const file = brain.readVaultFile(INDEX);
  if (!file) return false;
  return withAreaFiles(parseIndex(fs.readFileSync(file.full, 'utf8'))).some((g) => (g.isArea && g.name === name) || g.projects.some((p) => p.name === name));
}

// Every project and area by name, with what the index says about it, for telling which
// one a thread is about.
export function projectChoices() {
  const file = brain.readVaultFile(INDEX);
  if (!file) return [];
  const out = [];
  for (const g of withAreaFiles(parseIndex(fs.readFileSync(file.full, 'utf8')))) {
    if (g.isArea) out.push({ name: g.name, line: `${g.name} (area)` });
    for (const p of g.projects) out.push({ name: p.name, line: `${p.name}${p.about ? `: ${p.about}` : ''}${g.isArea ? ` (in ${g.name})` : ''}` });
  }
  return out;
}

// The ranking of the areas: the numbered list under `## Order` in
// Brain/Horizons/30,000 ft Goals.md, one line each, `1. [[Area]] — where it should stand`.
// Areas left out of it are unranked on purpose. Numbered lines under other headings are
// not the ranking; a file without an `## Order` heading is read as one list. The rank is
// the place in the list, so a line that cannot be read leaves no gap.
const GOALS = 'Brain/Horizons/30,000 ft Goals.md';
export function parseRanks(text) {
  const out = new Map();
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Order\b/i.test(l));
  let section = lines;
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
    section = end < 0 ? rest : rest.slice(0, end);
  }
  for (const line of section) {
    const m = /^\s*(\d+)[.)]\s+\**\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\**\s*(?:[—–:-]\s*)?(.*)$/.exec(line);
    if (m && !out.has(m[2].trim())) out.set(m[2].trim(), { rank: out.size + 1, goal: m[3].replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/\*\*/g, '').trim() });
  }
  return out;
}
export function areaRanks() {
  const file = brain.readVaultFile(GOALS);
  if (!file) return new Map();
  try { return parseRanks(fs.readFileSync(file.full, 'utf8')); } catch { return new Map(); }
}
