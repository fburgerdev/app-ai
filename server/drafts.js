// What Florian has typed into a thread's reply box and not sent yet.
//
// The page keeps it on the device as he types, and sends it here a moment later, so it
// survives closing the page, a crash or a restart of the app, and reaches the other
// computer and the phone with the rest of the app's data. One small file per thread
// (`drafts/<thread id>.json`, `new.json` for the box of a thread not started yet):
// two devices writing drafts of different threads never touch the same file.
//
// A draft that was sent or emptied is kept for a while as an empty one with its time.
// Otherwise a device that was offline would bring the old text back the next time it
// connects, because it would look newer than nothing.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'drafts');
const KEEP_EMPTY = 30 * 24 * 3600_000; // how long an emptied draft is remembered
const MAX = 200_000; // characters; a reply box, not a document store

const validKey = (key) => /^(new|[a-z0-9]{6,40})$/.test(String(key || ''));
const fileOf = (key) => path.join(DIR, `${key}.json`);

function read(key) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    return typeof d.text === 'string' && Number.isFinite(d.at) ? d : null;
  } catch { return null; }
}

// Every draft, emptied ones included (the page needs those to forget its own copy).
export function listDrafts() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => n.endsWith('.json')); } catch { return out; }
  const now = Date.now();
  for (const name of names) {
    const key = name.slice(0, -5);
    if (!validKey(key)) continue;
    const d = read(key);
    if (!d) continue;
    if (!d.text && now - d.at > KEEP_EMPTY) { try { fs.rmSync(fileOf(key), { force: true }); } catch { /* next time */ } continue; }
    out[key] = { text: d.text, at: d.at };
  }
  return out;
}

// Keeps the newer of what is here and what comes in. Returns what is kept.
export function putDraft(key, text, at = Date.now()) {
  if (!validKey(key)) throw new Error('Not a draft name.');
  text = String(text ?? '').slice(0, MAX);
  at = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const have = read(key);
  if (have && have.at > at) return have;
  if (!text && !have) return { text: '', at }; // nothing to forget
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${fileOf(key)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ text, at }));
  fs.renameSync(tmp, fileOf(key));
  return { text, at };
}

// The message went out: the draft is empty from now on, on every device.
export function clearDraft(key) {
  if (!validKey(key) || !read(key)) return;
  putDraft(key, '', Date.now());
}

// The thread is gone: so is its draft.
export function dropDraft(key) {
  if (validKey(key)) fs.rmSync(fileOf(key), { force: true });
}
