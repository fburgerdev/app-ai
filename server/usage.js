// What Claude used, as the Agent SDK reports it at the end of every run: tokens, and the
// price the same run would have had on the API. One line per run in usage.jsonl, which
// travels with the data repo, so the laptop's and the Pi's lines end up in one file.
//
// This is not the plan's limit: the SDK does not say how much of the five-hour or weekly
// allowance is left. It says what this app spent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'usage.jsonl');
const KINDS = { thread: 'Threads', extract: 'Brain update', cards: 'Cards', plain: 'Small jobs', lookup: 'Talk' };

export function record({ kind, model, usage, cost, durationMs }) {
  if (!usage && !cost) return;
  const u = usage || {};
  const line = {
    ts: Date.now(), host: os.hostname(), kind: kind || 'thread', model: model || '',
    in: u.input_tokens || 0, out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    cost: Number(cost) || 0, ms: durationMs || 0,
  };
  try { fs.appendFileSync(FILE, JSON.stringify(line) + '\n'); } catch { /* never in the way */ }
}

function read(since) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.ts >= since) out.push(e); } catch { /* a torn line */ }
  }
  return out;
}

const sum = (list) => list.reduce((a, e) => ({
  runs: a.runs + 1, in: a.in + e.in + e.cacheRead + e.cacheWrite, out: a.out + e.out, cost: a.cost + e.cost,
}), { runs: 0, in: 0, out: 0, cost: 0 });

export function overview() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const week = today - 6 * 86400_000;
  const all = read(week);
  const days = [];
  for (let d = week; d <= today; d += 86400_000) days.push({ day: d, ...sum(all.filter((e) => e.ts >= d && e.ts < d + 86400_000)) });
  const todays = all.filter((e) => e.ts >= today);
  const byKind = Object.entries(KINDS).map(([k, label]) => ({ kind: label, ...sum(todays.filter((e) => e.kind === k)) })).filter((k) => k.runs);
  return {
    today: sum(todays), week: sum(all), fiveHours: sum(all.filter((e) => e.ts >= Date.now() - 5 * 3600_000)),
    byKind, days,
  };
}
