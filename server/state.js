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
  tier: 'auto', // auto: a cheap model picks the tier per message; otherwise a fixed tier
  mailLevel: 0, // mail up to this moment has been through a brain update
  cardsLevel: 0, // card outcomes up to this moment have been through a brain update
  sleep: { on: true, from: '00:00', to: '08:00' }, // the app shows a go-to-sleep screen in between
};
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
  if (state.tier !== 'auto' && !TIER_NAMES.includes(state.tier)) state.tier = DEFAULTS.tier;
  state.sleep = { ...DEFAULTS.sleep, ...(state.sleep || {}) };
  return state;
}

// The file changed on disk (the other computer's state came in).
export function reloadState() { state = null; }

export function getState() {
  return { ...load() };
}

export function setState(patch) {
  const next = { ...load() };
  if (typeof patch.mood === 'string') next.mood = patch.mood.slice(0, 300);
  if (MODELS.includes(patch.model)) next.model = patch.model;
  if (EFFORTS.includes(patch.effort)) next.effort = patch.effort;
  if (patch.tier === 'auto' || TIER_NAMES.includes(patch.tier)) next.tier = patch.tier;
  if (Number.isFinite(patch.mailLevel)) next.mailLevel = patch.mailLevel;
  if (Number.isFinite(patch.cardsLevel)) next.cardsLevel = patch.cardsLevel;
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
