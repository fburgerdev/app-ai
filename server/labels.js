// Short labels for the Someday list in the outline.
//
// A Someday line is a sentence or three, written for the vault; in the side panel it needs
// to be readable at a glance. A small model gives each line a label of two to five words,
// once: the labels are kept in labels.json in the app's data, by the line's text, so a
// line keeps its label until it is reworded. The vault is not changed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';
import { runAgent } from './agent.js';
import { events } from './store.js';

const FILE = path.join(DATA_DIR, 'someday-labels.json');
let config;
let cache = null;
let making = false;

export function initLabels(cfg) { config = cfg; }

const key = (text) => crypto.createHash('sha1').update(String(text).trim()).digest('hex').slice(0, 16);

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}

// The data folder changed on disk (the other computer's labels came in).
export function reloadLabels() { cache = null; }

// The label of a line, or '' while it has none yet.
export const labelOf = (text) => load()[key(text)] || '';

// Makes labels for the lines that have none, in the background, in one call. The outline
// is told to load again when they are there.
export function labelMissing(texts) {
  const missing = [...new Set(texts.map((t) => String(t).trim()).filter(Boolean))].filter((t) => !labelOf(t));
  if (!missing.length || making || !config) return;
  making = true;
  make(missing)
    .then((made) => { if (made) events.emit('projects', {}); })
    .catch((err) => log(`someday labels: ${err.message}`))
    .finally(() => { making = false; });
}

// A label as he would say it: a few words, no full stop.
const clean = (s) => String(s || '').replace(/[*_`"“”[\]]/g, '').replace(/\s+/g, ' ').replace(/[.;:,]+$/, '').trim().slice(0, 48);

async function make(texts) {
  let labels = [];
  if (config.fake) {
    // The stand-in: the first words of the line, without the verb.
    labels = texts.map((t) => t.replace(/^(try to |look into |ask |take up |apply to |set up |inform himself about |continue working on |co-found )/i, '').split(/[.,;:—(]/)[0].split(' ').slice(0, 4).join(' '));
  } else {
    const result = await runAgent({
      prompt: `Each line below is an item on Florian's Someday list: something he may do one day. Give each a label of two to five words that tells him at a glance what it is about. Name the thing, a person or organisation where there is one, not the verb: "Investing", "Kitas Köln plant-based", "Niklas's one-dish campaign", "DSW intro via Flo". The language of the line. No full stop, no quotation marks.\n\nAnswer with a JSON array of strings, one per line, in the same order, and nothing else.\n\n${texts.map((t, i) => `${i + 1}. ${t.slice(0, 600)}`).join('\n')}`,
      cwd: DATA_DIR,
      systemAppend: 'You write short labels for list items. Answer with a JSON array of strings and nothing else.',
      model: config.queue?.pickModel || 'haiku',
      mode: 'plain',
      usageKind: 'plain',
      fake: false,
    });
    const json = /\[[\s\S]*\]/.exec(result.finalText || result.text || '');
    try { labels = json ? JSON.parse(json[0]) : []; } catch { labels = []; }
  }
  const all = load();
  let made = 0;
  texts.forEach((t, i) => { const l = clean(labels[i]); if (l) { all[key(t)] = l; made += 1; } });
  if (!made) return 0;
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
  return made;
}
