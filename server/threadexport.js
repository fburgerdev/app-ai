// Every thread, written into the vault as a plain Markdown file: Threads/YYYY-MM-DD Title.md.
//
// The app's data stays the original (it also holds what the vault has no use for: tool
// calls, a thread's state, every version of every file). The files in Threads/ are made
// from it by this script and by nothing else: no model is involved, nobody edits them,
// and every brain update writes each thread's file again from the app's data, so the
// two cannot drift apart. A thread the app has deleted since (a deferred one) keeps the
// file it had: by then that file is the only copy.
//
// What goes in is the conversation, each turn labelled with who said it, and the final
// text of the files Claude made. Tool output (mail bodies, file dumps, search results)
// stays out. Threads read these files only when they search for something, or, for the
// last thread on their project, when the app names it (see lastThreadOn).

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { THREADS_FOLDER } from './brain.js';
import { dateTimeDMY, messageText, safeFileName } from './util.js';
import { redact } from './secrets.js';

const FILE_TEXT_LIMIT = 20_000; // characters of a made file's final text that are kept
const TEXT_FILE = /\.(md|txt)$/i;

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function speaker(m) {
  if (m.role !== 'user') return 'Claude';
  if (m.event) return 'The app (what happened, not said by Florian)';
  if (m.auto) return 'The app (automatic, not Florian)';
  if (m.unanswered) return 'Florian (for the record; closed without an answer)';
  return 'Florian';
}

// A thread belongs in the vault once Florian said or did something in it. Cards are not
// conversations, and a thread the app started that he never touched holds only Claude.
export function isExported(thread, messages) {
  if (!thread || thread.kind === 'card') return false;
  return messages.some((m) => m.role === 'user' && (!m.auto || m.event));
}

// The file for one thread, as text. A secret value in it (Florian typed one, or a file
// holds one) comes out as its placeholder, so Threads/ never holds a value.
export function renderThread(thread, messages) {
  const own = thread.spunFrom ? messages.slice(thread.spunAt || 0) : messages;
  const turns = own
    .map((m) => ({ m, text: (messageText(m) || '').trim() }))
    .filter(({ m, text }) => text || m.files?.length)
    .map(({ m, text }) => `### ${speaker(m)}, ${dateTimeDMY(m.ts)}\n\n${text || '(no text)'}${m.files?.length ? `\n\n[He attached: ${m.files.map((f) => `"${f.name}"`).join(', ')}]` : ''}`);

  const files = [];
  for (const artifact of store.listArtifacts(thread.id)) {
    const last = artifact.versions.at(-1);
    const sent = artifact.mail?.sentAt ? `, sent by Florian ${dateTimeDMY(artifact.mail.sentAt)}` : '';
    files.push(`### File "${artifact.name}" (${artifact.versions.length} ${artifact.versions.length === 1 ? 'version' : 'versions'}; the last ${last.by === 'you' ? 'edited by Florian' : 'written by Claude'}, ${dateTimeDMY(last.ts)}${sent})`);
    if (!TEXT_FILE.test(artifact.name)) { files.push('', '(not a text file; kept in the app)', ''); continue; }
    let text = '';
    try { text = (store.readArtifactText(thread.id, artifact.name) || '').trim(); } catch { /* gone */ }
    if (text.length > FILE_TEXT_LIMIT) text = `${text.slice(0, FILE_TEXT_LIMIT)}\n\n(cut here; the rest is kept in the app)`;
    files.push('', text || '(empty)', '');
  }

  const last = messages.at(-1)?.ts || thread.updatedAt || thread.createdAt;
  const text = [
    `# ${thread.title}`,
    '',
    `Thread: ${thread.id}`,
    `Started: ${dateTimeDMY(thread.createdAt)}`,
    `Last message: ${dateTimeDMY(last)}`,
    `Project: ${thread.project ? `[[${thread.project}]]` : 'none'}`,
    `State: ${thread.state === 'done' ? 'closed' : 'open'}`,
    ...(thread.repo ? [`Repo: ${thread.repo}`] : []),
    ...(thread.spunFrom ? [`Spun off from: "${thread.spunTitle}" (what was said before the spin-off is in that thread's file)`] : []),
    '',
    'Written by the app from its own data; never edited by hand. Each turn says who spoke. Only what Florian said is his position; what Claude said is what Claude proposed at that time.',
    '',
    '## Conversation',
    '',
    turns.join('\n\n') || 'Nothing said yet.',
    '',
    ...(files.length ? ['## Files Claude made in this thread', '', ...files] : []),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return redact(text);
}

// The header of a thread file: which thread it is, its project, when it was last written in.
function readHeader(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1500);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
  } catch { return null; }
  const id = /^Thread:\s*(\S+)\s*$/m.exec(head)?.[1];
  if (!id) return null;
  const project = (/^Project:\s*(.*)$/m.exec(head)?.[1] || '').replace(/^\[\[|\]\]$/g, '').trim();
  const when = /^Last message:\s*(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/m.exec(head);
  return {
    id,
    title: (/^#\s+(.*)$/m.exec(head)?.[1] || '').trim(),
    project: /^none$/i.test(project) ? '' : project,
    last: when ? new Date(Number(when[3]), Number(when[2]) - 1, Number(when[1]), Number(when[4]), Number(when[5])).getTime() : 0,
  };
}

function existingFiles(dir) {
  const byId = new Map();
  const names = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { byId, names }; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    names.add(name.toLowerCase());
    const header = readHeader(path.join(dir, name));
    if (header && !byId.has(header.id)) byId.set(header.id, name);
  }
  return { byId, names };
}

// Writes every thread the app holds into <vault>/Threads. A thread keeps its file when
// its name still fits; a renamed thread's file moves. Returns what changed.
export function exportThreads(vaultDir) {
  const dir = path.join(vaultDir, THREADS_FOLDER);
  const { byId, names } = existingFiles(dir);
  const out = { total: 0, written: 0, renamed: 0 };
  const threads = store.listThreads().slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const thread of threads) {
    if (thread.kind === 'card') continue;
    const messages = store.readMessages(thread.id);
    if (!isExported(thread, messages)) continue;
    out.total += 1;
    const base = `${isoDate(thread.createdAt)} ${safeFileName(thread.title, 80)}`;
    const had = byId.get(thread.id);
    let name = had;
    // Its file still fits when it carries this name, or this name with a number (a
    // second thread of the same name that day).
    const rest = had ? had.slice(0, -3) : '';
    const fits = Boolean(had) && rest.startsWith(base) && /^( \d+)?$/.test(rest.slice(base.length));
    if (!fits) {
      name = `${base}.md`;
      for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${base} ${n}.md`;
      names.add(name.toLowerCase());
      if (had) {
        fs.rmSync(path.join(dir, had), { force: true });
        names.delete(had.toLowerCase());
        out.renamed += 1;
      }
    }
    const file = path.join(dir, name);
    const text = renderThread(thread, messages);
    let before = null;
    try { before = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
    if (before === text) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    out.written += 1;
  }
  return out;
}

// The thread a new thread on a project reads first: the one on that project that was
// last written in, other than itself. Read from the vault's Threads folder, so it also
// finds threads the app no longer holds. `cacheKey` is the vault's state (its commit).
let headers = { key: null, list: [] };
export function lastThreadOn(vaultDir, project, { exceptId = '', cacheKey = '' } = {}) {
  if (!project || !vaultDir) return null;
  if (!cacheKey || headers.key !== `${vaultDir}@${cacheKey}`) {
    const dir = path.join(vaultDir, THREADS_FOLDER);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { /* no threads yet */ }
    const list = [];
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const header = readHeader(path.join(dir, name));
      if (header) list.push({ ...header, path: `${THREADS_FOLDER}/${name}` });
    }
    headers = { key: `${vaultDir}@${cacheKey}`, list };
  }
  const mine = headers.list.filter((h) => h.project === project && h.id !== exceptId).sort((a, b) => b.last - a.last);
  return mine[0] || null;
}
