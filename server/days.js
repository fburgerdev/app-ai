// The daily report: what Florian did that day, the things with a result first.
//
// His wish, 24-11-2026: with all the switching between threads he loses track of what he
// did. What counts is what actually happened and resulted in something; thinking counts
// least. Four levels, his yes the same day:
//
//   result   something outside him changed through what he did that day (a call, a talk,
//            an agreement, a finished thing). Only his own doing: what merely reached him
//            (an introduction, an answer to an old mail) is not his result.
//   out      sent or said to someone; what comes of it is open
//   made     built, written, cut, prepared
//   thought  decided, worked out
//
// The app collects what is recorded for the day (gather), each piece with an id; a model
// picks, words and orders; and the app keeps only lines that rest on a recorded piece
// (checkItems), so nothing is made up and a merge never counts as a result. A day runs from
// 04:00 to 04:00, since he often works past midnight. The report is written in the evening
// (config.report.at) and once more after the day has ended if he did something later.
//
// Reports are Claude's selection, so they stay in the app (reports/ in the data folder) and
// never go into the vault. What he adds to one ("what's missing?") are his own words: they
// also go onto the notes for Claude, which the next brain update files.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, log } from './config.js';
import { runAgent } from './agent.js';
import { limitedUntil } from './limits.js';
import * as brain from './brain.js';
import * as store from './store.js';
import * as google from './google.js';
import { readCardLog } from './cards.js';
import { areaOfProject, areaRanks, repoOf } from './projects.js';
import { gmailLink } from './mailhistory.js';
import { redact } from './secrets.js';
import { readPad, writePad } from './state.js';
import { dateDMY, dateTimeDMY, readPrompt } from './util.js';

const execFileP = promisify(execFile);
const DIR = path.join(DATA_DIR, 'reports');
const START_HOUR = 4;
const pad = (n) => String(n).padStart(2, '0');

export const LEVELS = ['result', 'out', 'made', 'thought'];

let config;
let deps = { mayRun: () => true, notesChanged: () => {} };

// ---------- days ----------

const parts = (day) => day.split('-').map(Number);
export function dayOf(ts = Date.now()) {
  const d = new Date(ts);
  if (d.getHours() < START_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function dayWindow(day) {
  const [y, m, d] = parts(day);
  return { from: new Date(y, m - 1, d, START_HOUR).getTime(), to: new Date(y, m - 1, d + 1, START_HOUR).getTime() };
}
export function shiftDay(day, by) {
  const [y, m, d] = parts(day);
  return dayOf(new Date(y, m - 1, d + by, 12).getTime());
}
export function isDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day)) && shiftDay(day, 0) === day;
}

// ---------- the files ----------

const fileOf = (day) => path.join(DIR, `${day}.json`);
export function readReport(day) {
  if (!isDay(day)) return null;
  try { return JSON.parse(fs.readFileSync(fileOf(day), 'utf8')); } catch { return null; }
}
function writeReport(day, report) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${fileOf(day)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, fileOf(day));
}
function savedDays() {
  try { return fs.readdirSync(DIR).map((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n)?.[1]).filter(Boolean); } catch { return []; }
}

// ---------- what is recorded for a day ----------

// The app's note that a branch went into main.
const MERGED = /merged .* into (\S+) of (\S+?) and pushed it/;
const SENT = /^\[Florian sent the mail/;

// What Florian himself did in a thread in the window: his messages, his button clicks, the
// mails he sent; plus the merges the app noted, and where Claude's last answer stood.
// A spin-off starts as a copy of another thread: the copied part is that thread's.
export function ofThread(thread, messages, { from, to }) {
  const own = messages.slice(thread.spunFrom ? thread.spunAt || 0 : 0).filter((m) => m.ts >= from && m.ts < to);
  const said = [];
  const did = [];
  const merges = [];
  let answer = '';
  for (const m of own) {
    if (m.role !== 'user') {
      const last = (m.parts || []).filter((p) => p.type === 'text' && p.text?.trim()).at(-1);
      if (last) answer = last.text.trim();
      continue;
    }
    const text = String(m.text || '').trim();
    const merged = m.event || /^\[The app/.test(text) ? MERGED.exec(text) : null;
    if (merged) { merges.push({ ts: m.ts, repo: merged[2], text }); continue; }
    if (m.auto || !text) continue;
    // A note of the app's: kept when it says what he did with a button.
    if (m.event || SENT.test(text)) { if (/^\[Florian /.test(text)) did.push({ ts: m.ts, text }); continue; }
    if (/^(\[The (app|turn|five-hour|weekly)|The app started this thread)/.test(text)) continue;
    said.push({ ts: m.ts, text });
  }
  const notes = thread.notes?.text?.trim() && thread.notes.ts >= from && thread.notes.ts < to ? { ts: thread.notes.ts, text: thread.notes.text.trim() } : null;
  return { said, did, merges, answer, notes };
}

// The threads that can hold something of that day: cards are in the card log.
const threadsIn = ({ from, to }) => store.listThreads().filter((t) => t.kind !== 'card' && (t.createdAt || 0) < to && Math.max(t.updatedAt || 0, t.notes?.ts || 0) >= from);

// Whether he did anything in the app in the window (cheap enough to ask now and then).
function activeIn(win) {
  if (readCardLog().some((e) => e.type !== 'prep' && e.ts >= win.from && e.ts < win.to)) return true;
  return threadsIn(win).some((t) => {
    const o = ofThread(t, store.readMessages(t.id), win);
    return o.said.length || o.did.length || o.notes;
  });
}

// Lines the brain updates filed that carry the day's date: they hold what he said happened,
// also when it was filed a day later.
async function vaultLines(day, from) {
  const dir = brain.brainDir();
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return [];
  const [y, m, d] = parts(day);
  const dmy = `${pad(d)}-${pad(m)}-${y}`;
  let out = '';
  try {
    out = (await execFileP('git', ['-c', 'core.quotepath=off', 'log', `--since=${new Date(from).toISOString()}`, '--no-merges', '--format=', '-p', '-U0', '--', brain.coreName()],
      { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch { return []; }
  const byNote = new Map();
  const seen = new Set();
  let note = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) { note = /\/([^/]+)\.md"?\s*$/.exec(line)?.[1] || ''; continue; }
    if (!line.startsWith('+') || !note || !line.includes(dmy)) continue;
    const text = line.slice(1).trim();
    if (seen.has(text)) continue;
    seen.add(text);
    byNote.set(note, [...(byNote.get(note) || []), text.slice(0, 450)]);
  }
  return [...byNote].map(([name, lines]) => ({ name, lines: lines.slice(0, 12) }));
}

// Work he did outside the threads that a repo recorded, such as the takes he picked in
// Video Kit (its saves are commits of their own).
async function savedInRepos({ from, to }) {
  const root = path.join(DATA_DIR, 'repos');
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).flatMap((o) => { try { return fs.readdirSync(path.join(root, o)).map((n) => [`${o}/${n}`, path.join(root, o, n)]); } catch { return []; } });
  } catch { return out; }
  await Promise.all(dirs.filter(([, dir]) => fs.existsSync(path.join(dir, '.git'))).map(async ([repo, dir]) => {
    try {
      const { stdout } = await execFileP('git', ['log', '--all', `--since=${new Date(from).toISOString()}`, `--until=${new Date(to).toISOString()}`, '--grep=^Video Kit:', '--shortstat', '--format=@%ct %s'],
        { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
      const seen = new Set();
      for (const entry of stdout.split(/^@/m).filter((x) => x.trim())) {
        const [head, ...rest] = entry.trim().split('\n');
        const [, ct, subject] = /^(\d+) (.*)$/.exec(head) || [];
        if (!subject || seen.has(`${ct} ${subject}`)) continue;
        seen.add(`${ct} ${subject}`);
        out.push({ ts: Number(ct) * 1000, repo, text: `${subject} (${rest.join(' ').trim() || 'no lines counted'})` });
      }
    } catch { /* a repo without history, or not answering: left out */ }
  }));
  return out.sort((a, b) => a.ts - b.ts);
}

const cut = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const hm = (ts) => dateTimeDMY(ts).slice(11);

// Everything recorded for the day: `text` for the model, `evidence` (id -> what it is and
// where it opens), and `split`, where his messages went.
export async function gather(day, { now = Date.now() } = {}) {
  const win = dayWindow(day);
  const evidence = new Map();
  const count = {};
  const add = (letter, e) => { count[letter] = (count[letter] || 0) + 1; const id = `${letter}${count[letter]}`; evidence.set(id, e); return id; };
  const sections = [];

  const areas = areaOfProject();
  const repoProject = new Map();
  for (const name of areas.keys()) { const r = repoOf(name); if (r && !repoProject.has(r)) repoProject.set(r, name); }
  const projectOf = (t) => t.project || repoProject.get(t.repo || '') || '';
  const areaOf = (project) => areas.get(project) || '';

  const split = new Map();
  const threadText = [];
  const merges = [];
  const list = threadsIn(win).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const t of list) {
    const o = ofThread(t, store.readMessages(t.id), win);
    const ref = { kind: 'thread', id: t.id, title: t.title };
    const project = projectOf(t);
    for (const m of o.merges) merges.push({ ...m, ref, project });
    if (!o.said.length && !o.did.length && !o.notes) continue;
    if (o.said.length) { const key = areaOf(project) || project || 'Other'; split.set(key, (split.get(key) || 0) + o.said.length); }
    const lines = [`### ${t.title}${project ? ` — ${project}${areaOf(project) && areaOf(project) !== project ? `, area ${areaOf(project)}` : ''}` : ''}${t.kind === 'event' ? ' — the thread of a calendar entry' : ''}`];
    const all = [
      ...o.said.map((m) => ({ ...m, letter: 'M', kind: 'said' })),
      ...o.did.map((m) => ({ ...m, letter: 'M', kind: 'did' })),
      ...(o.notes ? [{ ...o.notes, letter: 'M', kind: 'said', pre: 'his notes during the entry: ' }] : []),
    ].sort((a, b) => a.ts - b.ts);
    for (const m of all) lines.push(`[${add('M', { kind: m.kind, ref })}] ${hm(m.ts)} Florian: ${m.pre || ''}${cut(m.text, 1100)}`);
    if (o.answer) lines.push(`(Claude's last answer that day, context only: ${cut(o.answer, 500)})`);
    threadText.push(lines.join('\n'));
  }
  if (threadText.length) sections.push(`## His threads\n\n${threadText.join('\n\n')}`);

  const decided = readCardLog().filter((e) => e.type !== 'prep' && e.ts >= win.from && e.ts < win.to && e.outcome === 'accepted');
  if (decided.length) sections.push(`## Finished messages the app offered and he took\n\n${decided.map((e) => `[${add('C', { kind: 'did', ref: e.thread && store.getThread(e.thread) ? { kind: 'thread', id: e.thread, title: e.title } : null })}] ${hm(e.ts)} ${e.title} (${e.channel}, ${e.how || 'accepted'}; to ${e.to || 'not named'}${e.project ? `; ${e.project}` : ''})`).join('\n')}`);

  if (!config.fake && google.googleConnected()) {
    try {
      const sent = await google.gmailSearch({ query: `in:sent after:${Math.floor(win.from / 1000)} before:${Math.floor(win.to / 1000)}`, max: 25 });
      if (sent.length) sections.push(`## Mails he sent (Gmail)\n\n${sent.map((m) => `[${add('S', { kind: 'did', ref: { kind: 'mail', href: gmailLink(m.threadId), title: m.subject } })}] to ${m.to}: "${m.subject}" — ${cut(m.snippet, 300)}`).join('\n')}`);
    } catch (err) { log(`daily report: Gmail left out (${err.message})`); }
    try {
      const entries = await google.calendarList({ from: new Date(win.from).toISOString(), to: new Date(Math.min(win.to, now)).toISOString(), max: 50 });
      if (entries.length) sections.push(`## His calendar (context only: an entry alone does not show that it happened)\n\n${entries.map((e) => `- ${String(e.start).slice(11, 16) || 'all day'} ${e.title}`).join('\n')}`);
    } catch (err) { log(`daily report: the calendar left out (${err.message})`); }
  }

  const notes = await vaultLines(day, win.from);
  if (notes.length) {
    let room = 45_000;
    const blocks = [];
    for (const n of notes) {
      const block = `[${add('V', { kind: 'filed', ref: { kind: 'note', name: n.name } })}] ${n.name}\n${n.lines.join('\n')}`;
      if (block.length > room) continue;
      room -= block.length;
      blocks.push(block);
    }
    sections.push(`## Lines filed in his notes that carry the day's date (what happened, and also what others did: only his own doing counts)\n\n${blocks.join('\n\n')}`);
  }

  const saved = await savedInRepos(win);
  if (saved.length) sections.push(`## Work of his that a repo recorded\n\n${saved.map((s) => `[${add('R', { kind: 'work', ref: null })}] ${hm(s.ts)} ${s.repo}: ${cut(s.text, 200)}`).join('\n')}`);
  if (merges.length) sections.push(`## Changes merged into a repo (Claude's work on his word; never a result by themselves)\n\n${merges.sort((a, b) => a.ts - b.ts).map((m) => `[${add('G', { kind: 'merge', ref: m.ref })}] ${hm(m.ts)} ${m.repo}, from the thread "${m.ref.title}"${m.project ? ` (${m.project})` : ''}`).join('\n')}`);

  const added = readReport(day)?.added || [];
  if (added.length) sections.unshift(`## What Florian added to this report himself (it happened; place it where it belongs)\n\n${added.map((a) => `[${add('A', { kind: 'said', ref: null })}] ${cut(a.text, 1500)}`).join('\n')}`);

  // His own messages, most first.
  const total = [...split.values()].reduce((a, b) => a + b, 0);
  let text = sections.join('\n\n');
  if (text.length > 260_000) text = `${text.slice(0, 260_000)}\n(cut here)`;
  return { text: redact(text), evidence, split: [...split].map(([area, n]) => ({ area, n })).sort((a, b) => b.n - a.n), messages: total };
}

// ---------- the report ----------

const CAP = { result: 8, out: 12, made: 10, thought: 8 };

// Only lines that rest on something recorded; a line that rests on merges alone is never
// more than "made". Keeps the model's order inside each level.
export function checkItems(raw, evidence) {
  const out = [];
  const have = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = redact(String(item?.text || '').replace(/\s+/g, ' ').trim()).slice(0, 400);
    const refs = [...new Set((Array.isArray(item?.refs) ? item.refs : []).map((r) => String(r).replace(/[[\]\s]/g, '')))].filter((r) => evidence.has(r));
    if (!text || !refs.length) continue;
    const kinds = refs.map((r) => evidence.get(r).kind);
    let level = LEVELS.includes(item.level) ? item.level : 'made';
    if ((level === 'result' || level === 'out') && kinds.every((k) => k === 'merge' || k === 'work')) level = 'made';
    if (have[level] >= CAP[level]) continue;
    have[level] += 1;
    const sources = [];
    for (const r of refs) {
      const ref = evidence.get(r).ref;
      if (ref && !sources.some((s) => s.kind === ref.kind && (s.id || s.href || s.name) === (ref.id || ref.href || ref.name))) sources.push(ref);
    }
    out.push({ level, area: String(item.area || '').replace(/[[\]]/g, '').trim().slice(0, 60), text, sources: sources.slice(0, 4) });
  }
  return LEVELS.flatMap((l) => out.filter((i) => i.level === l));
}

export function parseAnswer(text) {
  const json = /\{[\s\S]*\}/.exec(String(text || ''));
  try { const a = json ? JSON.parse(json[0]) : null; return a && Array.isArray(a.items) ? a : null; } catch { return null; }
}

async function make(day) {
  const startedAt = Date.now();
  const win = dayWindow(day);
  if (brain.brainStatus().ready) await brain.refresh().catch(() => {});
  const g = await gather(day);
  const base = () => { const r = readReport(day) || {}; return { day, added: r.added || [] }; };
  if (!g.evidence.size) {
    writeReport(day, { ...base(), madeAt: startedAt, upTo: Math.min(startedAt, win.to), headline: '', items: [], split: [], messages: 0 });
    return;
  }
  const [y, m, d] = parts(day);
  const ranks = [...areaRanks()].map(([name, r]) => `${r.rank}. ${name}`).join('\n');
  const result = await runAgent({
    prompt: `${g.text}\n\n---\n\nWrite the report of ${new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long' })}, ${pad(d)}-${pad(m)}-${y}.${startedAt < win.to ? ` The day is not over: this is what it holds so far, up to ${hm(startedAt)}.` : ''} Answer with the JSON object and nothing else.`,
    cwd: DATA_DIR,
    systemAppend: readPrompt('day.md', { ranks: ranks || '(not set)' }),
    model: config.report?.model || 'opus',
    mode: 'plain',
    usageKind: 'report',
    fake: config.fake,
  });
  if (result.error) throw new Error(result.error);
  const answer = parseAnswer(result.finalText || result.text);
  if (!answer) throw new Error('The answer was not a report.');
  const items = checkItems(answer.items, g.evidence);
  if (!items.length) throw new Error('No line of the report rested on something recorded.');
  // What he added while it was being written is kept (and brings another run).
  writeReport(day, {
    ...base(), madeAt: startedAt, upTo: Math.min(startedAt, win.to),
    headline: redact(String(answer.headline || '').replace(/\s+/g, ' ').trim()).slice(0, 240),
    items, split: g.split, messages: g.messages,
  });
  log(`daily report: ${day} written, ${items.length} lines`);
}

// ---------- one at a time ----------

const pending = [];
const errors = new Map(); // day -> what went wrong the last time
const tried = new Map(); // day -> when the app last tried by itself
let running = '';

export const reportsRunning = () => running;
const emit = () => store.events.emit('report', status());

async function pump() {
  if (running) return;
  while (pending.length) {
    running = pending.shift();
    const day = running;
    emit();
    try { await make(day); errors.delete(day); } catch (err) { errors.set(day, err.message); log(`daily report: ${day} failed: ${err.message}`); }
    running = '';
    emit();
  }
}

export function request(day) {
  if (!isDay(day) || day > dayOf()) throw new Error('There is no such day yet.');
  if (!pending.includes(day) && running !== day) pending.push(day);
  pump();
  return status();
}

// His own line: kept with the report, and on the notes for Claude for the brain update.
export function addLine(day, text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (!t) throw new Error('Nothing to add.');
  if (!isDay(day) || day > dayOf()) throw new Error('There is no such day yet.');
  const report = readReport(day) || { day, items: [], madeAt: 0 };
  writeReport(day, { ...report, added: [...(report.added || []), { ts: Date.now(), text: redact(t) }] });
  const [y, m, d] = parts(day);
  const before = (readPad('notes') || '').trimEnd();
  writePad('notes', `${before ? `${before}\n\n` : ''}What I did on ${pad(d)}-${pad(m)}-${y} (added to the daily report on ${dateDMY()}): ${t}\n`);
  deps.notesChanged();
  // A run already going has not seen it: another one follows.
  if (!pending.includes(day)) pending.push(day);
  pump();
  return status();
}

// The days he can page through: the last two weeks, and every older one with a report.
export function status() {
  const today = dayOf();
  const days = new Set(Array.from({ length: 14 }, (_, i) => shiftDay(today, -i)));
  for (const d of savedDays()) days.add(d);
  return {
    today,
    at: config?.report?.at || '',
    running,
    pending: [...pending],
    days: [...days].sort().reverse().map((day) => {
      const r = readReport(day);
      return { day, madeAt: r?.madeAt || 0, lines: r?.items?.length || 0, headline: r?.headline || '', error: errors.get(day) || '' };
    }),
  };
}

// ---------- by itself ----------

// When today's report is due: the evening time of the day `now` belongs to.
export function eveningOf(day, at) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at || ''));
  if (!m) return 0;
  const [y, mo, d] = parts(day);
  const ts = new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime();
  // "00:30" belongs to the end of the day, not its start.
  return Number(m[1]) < START_HOUR ? ts + 24 * 3600_000 : ts;
}

// Which report is due now: today's once it is evening, yesterday's once the day is over if
// something came after the evening one (or none was written). `active(win)` says whether he
// did something in the window.
export function dueDay({ now, at, madeAt, active }) {
  const today = dayOf(now);
  const evening = eveningOf(today, at);
  if (!evening) return '';
  if (now >= evening && madeAt(today) < evening && active({ from: dayWindow(today).from, to: now })) return today;
  const before = shiftDay(today, -1);
  const win = dayWindow(before);
  if (madeAt(before) < win.to && active({ from: Math.max(win.from, madeAt(before)), to: win.to })) return before;
  return '';
}

const settled = new Set(); // days over and done, not looked at again
function tick() {
  if (!config.report?.auto || running || pending.length || !deps.mayRun() || limitedUntil() || !brain.brainStatus().ready) return;
  const now = Date.now();
  const before = shiftDay(dayOf(now), -1);
  const due = dueDay({
    now,
    at: config.report.at,
    madeAt: (d) => (d === before && settled.has(d) ? Infinity : readReport(d)?.madeAt || 0),
    active: activeIn,
  });
  if (!due) { settled.add(before); return; }
  // A failed try waits half an hour before the next.
  if (now - (tried.get(due) || 0) < 30 * 60_000) return;
  tried.set(due, now);
  request(due);
}

export function initDays(cfg, given = {}) {
  config = cfg;
  deps = { ...deps, ...given };
  if (!config.report?.auto) return;
  setTimeout(tick, Number(config.report.firstMs) || 60_000).unref?.();
  setInterval(tick, Number(config.report.checkMs) || 2 * 60_000).unref?.();
}
