// The app's small pieces of state that are not threads: the mood line, the chosen model
// and effort, the water level of the mailbox. One file, state.json, saved with the rest
// of the app's data.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { events } from './store.js';

const FILE = path.join(DATA_DIR, 'state.json');

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS = ['medium', 'high'];

const DEFAULTS = {
  mood: '',
  model: 'opus',
  effort: 'high',
  mailLevel: 0, // mail up to this moment has been through a brain update
  cardsLevel: 0, // card outcomes up to this moment have been through a brain update
};

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
  return state;
}

export function getState() {
  return { ...load() };
}

export function setState(patch) {
  const next = { ...load() };
  if (typeof patch.mood === 'string') next.mood = patch.mood.slice(0, 300);
  if (MODELS.includes(patch.model)) next.model = patch.model;
  if (EFFORTS.includes(patch.effort)) next.effort = patch.effort;
  if (Number.isFinite(patch.mailLevel)) next.mailLevel = patch.mailLevel;
  if (Number.isFinite(patch.cardsLevel)) next.cardsLevel = patch.cardsLevel;
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
