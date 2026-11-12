// The queue: what Florian sees next.
//
// Instead of oldest-first, a small model orders what is waiting. It sees the waiting
// threads and cards, the mood line, the time of day, and a short profile learned from
// his earlier choices. The order is worked out in the background whenever something
// changes, so "next" never waits for a model.
//
// He can also drag a thread to where he wants it. It then stays at that place until he
// has dealt with it; the model orders the rest around it.
//
// Every choice he makes is written to queue/decisions.jsonl. Every so often a model
// rewrites queue/profile.md from that log. He can read and correct the profile.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';
import { runAgent } from './agent.js';
import * as store from './store.js';
import { getState, readPad, writePad } from './state.js';
import { readPrompt } from './util.js';

const DIR = path.join(DATA_DIR, 'queue');
const DECISIONS = path.join(DIR, 'decisions.jsonl');
const META = path.join(DIR, 'meta.json');
const PINS = path.join(DIR, 'pins.json');

let config;
let order = []; // thread ids, best first
let why = '';
let lastKey = '';
let pins = new Map(); // thread id -> the place Florian dragged it to (0 is first)
let ranking = false;
let again = false;
let timer = null;
let learning = false;

export function initQueue(cfg) {
  config = cfg;
  fs.mkdirSync(DIR, { recursive: true });
  try { pins = new Map(Object.entries(JSON.parse(fs.readFileSync(PINS, 'utf8')))); } catch { pins = new Map(); }
  store.events.on('thread', (t) => {
    // A thread he answered, closed or put off is no longer held in its place.
    if (pins.has(t.id) && (t.state !== 'ready' || requeuedLately(t))) { pins.delete(t.id); savePins(); }
    if (t.state === 'ready' || order.includes(t.id)) schedule();
  });
  store.events.on('state', () => schedule());
  store.events.on('thread-deleted', ({ id }) => { if (pins.delete(id)) savePins(); schedule(); });
}

// The data folder changed on disk (the other computer's state came in).
export function reloadQueue() {
  try { pins = new Map(Object.entries(JSON.parse(fs.readFileSync(PINS, 'utf8')))); } catch { pins = new Map(); }
  lastKey = '';
  schedule();
}

const waiting = () => store.listThreads().filter((t) => t.state === 'ready' && t.kind !== 'event').sort((a, b) => a.queuedAt - b.queuedAt);

const requeuedLately = (t) => t.requeuedAt > Date.now() - (Number(config.queue.requeueMinutes) || 20) * 60_000;

function savePins() {
  try { fs.writeFileSync(PINS, JSON.stringify(Object.fromEntries(pins))); } catch { /* never in the way */ }
}

// The order to show: the model's ranking where it has one, new arrivals behind it,
// anything requeued a moment ago at the very back, and what he dragged at the place
// he dragged it to.
export function queueOrder() {
  const ready = waiting();
  const byId = new Map(ready.map((t) => [t.id, t]));
  const ranked = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const rest = ready.filter((t) => !order.includes(t.id));
  const all = [...ranked, ...rest];
  const fresh = all.filter((t) => !requeuedLately(t));
  const requeued = all.filter(requeuedLately).sort((a, b) => a.requeuedAt - b.requeuedAt);
  const held = fresh.filter((t) => pins.has(t.id)).sort((a, b) => pins.get(a.id) - pins.get(b.id));
  const ids = [...fresh.filter((t) => !pins.has(t.id)), ...requeued].map((t) => t.id);
  for (const t of held) ids.splice(Math.min(pins.get(t.id), ids.length), 0, t.id);
  return ids;
}

// He dragged a waiting thread to a place in the queue.
export function moveTo(thread, index) {
  const before = queueOrder();
  const from = before.indexOf(thread.id);
  const to = Math.max(0, Math.min(Number(index) || 0, before.length - 1));
  if (from < 0 || from === to) return queueStatus();
  recordDecision('moved', thread, { to: to + 1, ahead: before.slice(to, to + 1).map((id) => store.getThread(id)?.title || '')[0] || '' });
  if (thread.requeuedAt) store.updateThread(thread.id, { requeuedAt: 0 });
  pins.set(thread.id, to);
  savePins();
  store.events.emit('queue', queueStatus());
  return queueStatus();
}

export function queueStatus() {
  return { order: queueOrder(), why, ranking };
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => rank().catch((err) => log(`queue: ${err.message}`)), 1200);
  timer.unref?.();
}

function describe(t) {
  const mins = Math.round((Date.now() - t.queuedAt) / 60_000);
  const waited = mins < 90 ? `${mins} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  let kind = 'thread';
  if (t.kind === 'card') kind = `${t.card?.type === 'chase' ? 'chase card' : 'opportunity card'} (${t.card?.channel})`;
  else if (t.kind === 'brain-update') kind = 'questions from the brain update';
  else if (t.kind === 'mail-reply') kind = 'mail to answer';
  const bits = [`[${kind}]`, t.title];
  if (t.project) bits.push(`project: ${t.project}`);
  bits.push(`waiting ${waited}`);
  if (t.requeuedAt) bits.push('requeued before');
  if (t.error) bits.push('stopped with an error');
  if (t.gist) bits.push(`— ${t.gist}`);
  return bits.join(' · ');
}

async function rank() {
  if (ranking) { again = true; return; }
  const ready = waiting();
  const mood = getState().mood.trim();
  const key = crypto.createHash('sha1').update(JSON.stringify([ready.map((t) => [t.id, t.requeuedAt]), mood])).digest('hex');
  if (key === lastKey) return;
  if (ready.length < 2) {
    order = ready.map((t) => t.id);
    why = '';
    lastKey = key;
    store.events.emit('queue', queueStatus());
    return;
  }
  ranking = true;
  store.events.emit('queue', queueStatus());
  try {
    const now = new Date();
    const prompt = [
      `Now: ${now.toLocaleDateString('en-GB', { weekday: 'long' })}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      `Mood line: ${mood || '(empty)'}`,
      '',
      'Profile:',
      (readPad('profile') || '').trim() || '(nothing learned yet)',
      '',
      'Waiting:',
      ...ready.map((t, i) => `${i + 1}. ${describe(t)}`),
    ].join('\n');
    const result = await runAgent({
      prompt,
      cwd: DATA_DIR,
      systemAppend: readPrompt('pick.md'),
      model: config.queue.pickModel,
      mode: 'plain',
      fake: config.fake,
    });
    const json = /\{[\s\S]*\}/.exec(result.finalText || result.text || '');
    const parsed = json ? JSON.parse(json[0]) : null;
    if (!parsed || !Array.isArray(parsed.order)) throw new Error(result.error || 'the picker gave no usable order');
    const seen = new Set();
    const ids = [];
    for (const n of parsed.order) {
      const t = ready[Number(n) - 1];
      if (t && !seen.has(t.id)) { seen.add(t.id); ids.push(t.id); }
    }
    order = ids;
    why = String(parsed.why || '').slice(0, 120);
    lastKey = key;
  } catch (err) {
    // Without a ranking the queue falls back to oldest first.
    log(`queue: ranking failed, using oldest first (${err.message})`);
    order = [];
    why = '';
    lastKey = key;
  } finally {
    ranking = false;
    store.events.emit('queue', queueStatus());
    if (again) { again = false; schedule(); }
  }
}

// ---------- learning ----------

// One choice. `action` is replied | requeued | done | opened | moved | spun off | accepted | declined.
export function recordDecision(action, thread, extra = {}) {
  const now = new Date();
  const entry = {
    ts: now.getTime(),
    hour: now.getHours(),
    weekday: now.toLocaleDateString('en-GB', { weekday: 'short' }),
    action,
    kind: thread.kind === 'card' ? `${thread.card?.type}:${thread.card?.channel}` : thread.kind,
    title: thread.title,
    project: thread.project || '',
    mood: getState().mood.trim(),
    position: queueOrder().indexOf(thread.id) + 1, // where the queue had put it
    ...extra,
  };
  try {
    fs.appendFileSync(DECISIONS, JSON.stringify(entry) + '\n');
  } catch { /* never in the way */ }
  maybeLearn().catch((err) => log(`queue: learning failed (${err.message})`));
}

function readDecisions() {
  try {
    return fs.readFileSync(DECISIONS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function maybeLearn() {
  if (learning) return;
  const all = readDecisions();
  let meta = { learnedAt: 0 };
  try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch { /* first time */ }
  if (all.length - (meta.learnedCount || 0) < (Number(config.queue.learnEvery) || 30)) return;
  learning = true;
  try {
    const lines = all.slice(-250).map((d) => {
      const bits = [`${d.weekday} ${d.hour}h`, d.action, d.kind, `"${d.title}"`];
      if (d.project) bits.push(`project ${d.project}`);
      if (d.position > 1) bits.push(`was offered as number ${d.position}`);
      if (d.to) bits.push(`dragged by hand to place ${d.to}`);
      if (d.reason) bits.push(`his reason: ${d.reason}`);
      if (d.edited) bits.push(`edited before deciding: ${d.edited}`);
      if (d.mood) bits.push(`mood line "${d.mood}"`);
      return `- ${bits.join(', ')}`;
    });
    const result = await runAgent({
      prompt: `Current profile:\n${(readPad('profile') || '').trim() || '(empty)'}\n\nRecent choices, oldest first:\n${lines.join('\n')}`,
      cwd: DATA_DIR,
      systemAppend: readPrompt('learn.md'),
      model: config.queue.learnModel,
      mode: 'plain',
      fake: config.fake,
    });
    const text = (result.finalText || result.text || '').trim();
    if (!text) throw new Error(result.error || 'no profile came back');
    writePad('profile', `${text}\n`);
    fs.writeFileSync(META, JSON.stringify({ learnedAt: Date.now(), learnedCount: all.length }));
    lastKey = '';
    schedule();
  } finally {
    learning = false;
  }
}
