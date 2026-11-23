// The app's small pieces of state that are not threads: the mood line, the chosen model
// and effort, the water level of the mailbox. One file, state.json, saved with the rest
// of the app's data.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { events } from './store.js';

const FILE = path.join(DATA_DIR, 'state.json');

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS = ['low', 'medium', 'high'];

// What Claude costs for one turn, as five steps. Florian's names, 13-11-2026.
export const TIERS = {
  cheap: { label: 'Cheap', model: 'opus', effort: 'low', about: 'quick and mechanical: a short reply, a small edit, looking one thing up' },
  low: { label: 'Low', model: 'opus', effort: 'medium', about: 'ordinary work: a normal mail, a small change, a clear question with a known answer' },
  default: { label: 'Default', model: 'opus', effort: 'high', about: 'most real work: drafting something that matters, a few sources, a decision with context' },
  high: { label: 'High', model: 'fable', effort: 'medium', about: 'hard: strategy, a tricky negotiation, a long document, code that has to be right' },
  extra: { label: 'Extra', model: 'fable', effort: 'high', about: 'the hardest: a big piece of thinking or building, where getting it right is worth the wait' },
};
export const TIER_NAMES = ['cheap', 'low', 'default', 'high', 'extra'];

const DEFAULTS = {
  mood: '',
  model: 'opus',
  effort: 'high',
  tier: 'auto', // auto: a cheap model picks per message | ask: choose on sending (quick select)
  mailLevel: 0, // mail up to this moment has been through a brain update
  cardsLevel: 0, // card outcomes up to this moment have been through a brain update
  sleep: { on: true, from: '00:00', to: '08:00' }, // the app shows a go-to-sleep screen in between
  // Off is Catch-up: everything. On, either `deep` (his own threads, until his sleep time)
  // or `project` (one project or area, `members` its names, until he ends it or `until`).
  focus: { on: false, until: 0, scope: 'deep', project: '', members: [] },
  hidden: [], // parts of the page he switched off in Settings → Layout (keys the page defines)
};
const PART = /^[a-z][a-z0-9-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

let state = null;

function load() {
  if (state) return state;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // first start
  }
  state = { ...DEFAULTS, ...stored };
  if (!MODELS.includes(state.model)) state.model = DEFAULTS.model;
  if (!EFFORTS.includes(state.effort)) state.effort = DEFAULTS.effort;
  // Until 13-11-2026 a fixed tier could be set here too. Such a state reads as Auto now.
  if (state.tier !== 'ask') state.tier = 'auto';
  state.sleep = { ...DEFAULTS.sleep, ...(state.sleep || {}) };
  state.focus = { ...DEFAULTS.focus, ...(state.focus || {}) };
  state.hidden = Array.isArray(state.hidden) ? state.hidden.filter((k) => PART.test(k)) : [];
  return state;
}

// When focus ends by itself: his next sleep time, or the next midnight when the sleep
// screen is off. So a day never starts in focus because it was forgotten the day before.
export function focusEnd(now = Date.now(), sleep = load().sleep) {
  const [h, m] = (sleep?.on && /^\d\d:\d\d$/.test(sleep.from || '') ? sleep.from : '00:00').split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

// Whether focus is on right now (it ends by itself at `until`).
export function inFocus(now = Date.now()) {
  const f = load().focus;
  return Boolean(f?.on) && (!f.until || now < f.until);
}

// The file changed on disk (the other computer's state came in).
export function reloadState() { state = null; }

export function getState() {
  const s = { ...load() };
  if (s.focus?.on && !inFocus()) s.focus = { ...DEFAULTS.focus };
  return s;
}

// The focus in force right now, or null in Catch-up.
export function focusNow(now = Date.now()) {
  return inFocus(now) ? load().focus : null;
}

// What he chose in the switch: true (deep work, as before), false (Catch-up), or
// { scope: 'project', project, members, until } with `until` 0 for "until I end it".
export function focusFrom(patch, sleep, now = Date.now()) {
  if (patch === false || patch?.on === false) return { ...DEFAULTS.focus };
  if (patch === true || patch?.scope === 'deep') return { ...DEFAULTS.focus, on: true, until: focusEnd(now, sleep) };
  if (patch?.scope === 'project' && typeof patch.project === 'string' && patch.project.trim()) {
    const project = patch.project.trim().slice(0, 120);
    const others = Array.isArray(patch.members) ? patch.members.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, 120)) : [];
    const members = [...new Set([project, ...others])].slice(0, 60);
    const until = Number.isFinite(patch.until) && patch.until > now ? patch.until : 0;
    return { on: true, until, scope: 'project', project, members };
  }
  return null;
}

export function setState(patch) {
  const next = { ...load() };
  if (typeof patch.mood === 'string') next.mood = patch.mood.slice(0, 300);
  if (MODELS.includes(patch.model)) next.model = patch.model;
  if (EFFORTS.includes(patch.effort)) next.effort = patch.effort;
  if (patch.tier === 'auto' || patch.tier === 'ask') next.tier = patch.tier;
  if (Number.isFinite(patch.mailLevel)) next.mailLevel = patch.mailLevel;
  if (Number.isFinite(patch.cardsLevel)) next.cardsLevel = patch.cardsLevel;
  // A brain update held by the usage limit: { until, type, only } (extract.js), or null.
  // `gate` when it waits for the lock instead (gate.js): 'update' or 'handover'.
  if ('brainHeld' in patch) next.brainHeld = Number.isFinite(patch.brainHeld?.until) ? { until: patch.brainHeld.until, type: String(patch.brainHeld.type || ''), only: patch.brainHeld.only === 'mail' ? 'mail' : '', ...(['update', 'handover'].includes(patch.brainHeld.gate) ? { gate: patch.brainHeld.gate } : {}) } : null;
  if (Array.isArray(patch.hidden)) next.hidden = [...new Set(patch.hidden.filter((k) => typeof k === 'string' && PART.test(k)))].slice(0, 100);
  if (patch.focus != null) { const f = focusFrom(patch.focus, next.sleep); if (f) next.focus = f; }
  if (patch.sleep && typeof patch.sleep === 'object') {
    const sl = { ...DEFAULTS.sleep, ...next.sleep };
    if (typeof patch.sleep.on === 'boolean') sl.on = patch.sleep.on;
    if (HHMM.test(patch.sleep.from || '')) sl.from = patch.sleep.from;
    if (HHMM.test(patch.sleep.to || '')) sl.to = patch.sleep.to;
    next.sleep = sl;
  }
  state = next;
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
  events.emit('state', getState());
  return getState();
}

// ---------- pads: plain text files you write in ----------
//
//   scratchpad   yours alone. Claude never reads it, in any run.
//   notes        notes for Claude. The next brain update files them and empties the pad.
//   profile      what the queue has learned about your choices. You can correct it.
//   words        names and words you use, so the voice host can repair what the phone mishears.

const PADS = { scratchpad: 'scratchpad.md', notes: 'notes-for-claude.md', profile: path.join('queue', 'profile.md'), words: 'voice-words.md' };

export function padFile(name) {
  return PADS[name] ? path.join(DATA_DIR, PADS[name]) : null;
}

export function readPad(name) {
  const file = padFile(name);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function writePad(name, text) {
  const file = padFile(name);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(text));
  fs.renameSync(tmp, file);
  return true;
}
