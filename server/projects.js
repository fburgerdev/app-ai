// The vault's areas and projects, as the app shows them.
//
// The list is read from Brain/Projects/Projects Index.md in the app's clone. The app
// keeps no list of its own, so a project exists here exactly when it exists in the vault.

import fs from 'node:fs';
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

// The tree with what the app knows on top: open threads and when each was last touched.
export function projectTree() {
  const file = brain.readVaultFile(INDEX);
  if (!file) return { groups: [], missing: true };
  const groups = parseIndex(fs.readFileSync(file.full, 'utf8'));
  const threads = store.listThreads().filter((t) => t.project && t.kind !== 'card');
  const stats = (name) => {
    const mine = threads.filter((t) => t.project === name);
    return {
      open: mine.filter((t) => t.state !== 'done').length,
      touched: mine.reduce((max, t) => Math.max(max, t.updatedAt), 0),
    };
  };
  for (const g of groups) {
    Object.assign(g, stats(g.name));
    for (const p of g.projects) Object.assign(p, stats(p.name));
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
