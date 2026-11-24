// What Claude used, as the Agent SDK reports it at the end of every run: tokens, and the
// price the same run would have had on the API. One line per run in usage.jsonl, which
// travels with the data repo, so the laptop's and the Pi's lines end up in one file.
//
// This is not the plan's limit: the SDK does not say how much of the five-hour or weekly
// allowance is left. It says what this app spent.
//
// The SDK's tokens are those of the one run, but its price is that of the whole session
// so far: a thread's tenth turn reports what all ten cost together (measured 18-11-2026).
// Until then the app wrote that total down for every turn, so a long thread was counted
// many times over (about eight times too much across a week). Now a line holds what the
// run itself cost: the session's total minus the total it had after the run before
// (`v: 2`). Lines from before carry no `v`; for threads, the only runs that carry on a
// session, their price is worked out again from their tokens when they are read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'usage.jsonl');
// What each session had cost in total after its last run. This computer's only: a session
// lives on the computer that ran it.
const SESSIONS = path.join(DATA_DIR, 'usage-sessions.json');
const KINDS = { thread: 'Threads', extract: 'Brain update', cards: 'Cards', plain: 'Small jobs', report: 'Daily report', lookup: 'Talk' };

// Dollars per million tokens: input, output, read from the cache, written to the cache
// (kept for an hour, which is what Claude Code asks for). Measured against the SDK's own
// prices on 18-11-2026. Only used where the exact price is not known: lines from before
// `v: 2`, and the first run after this change of a session that was already going.
const PRICES = { fable: [8, 40, 0.2, 16], opus: [4, 20, 0.2, 8], sonnet: [2, 10, 0.1, 4], haiku: [0.1, 0.5, 0.01, 0.2] };

// What a line's tokens cost at those prices, or null for a model the table does not know.
export function priced(line) {
  const name = Object.keys(PRICES).find((k) => String(line.model || '').toLowerCase().includes(k));
  if (!name) return null;
  const [i, o, r, w] = PRICES[name];
  return ((line.in || 0) * i + (line.out || 0) * o + (line.cacheRead || 0) * r + (line.cacheWrite || 0) * w) / 1e6;
}

// What a stored line cost. Lines from before `v: 2` hold the session's running total for
// thread turns; their tokens say what the turn itself cost.
export function costOf(line) {
  const cost = Number(line.cost) || 0;
  if (line.v || line.kind !== 'thread') return cost;
  const p = priced(line);
  return p === null ? cost : Math.min(cost, p);
}

// What one run cost, from the session's total. `before` is the total after the session's
// previous run (undefined when this computer has not seen the session).
export function spent({ total, before, resumed, line }) {
  if (before !== undefined && total >= before) return total - before;
  // A session carried on that was never counted here: the total holds earlier runs too.
  if (before === undefined && resumed) { const p = priced(line); return p === null ? total : Math.min(total, p); }
  return total;
}

function readSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS, 'utf8')); } catch { return {}; }
}

export function record({ kind, model, usage, cost, durationMs, sessionId = '', resumed = false }) {
  if (!usage && !cost) return;
  const u = usage || {};
  const line = {
    ts: Date.now(), host: os.hostname(), kind: kind || 'thread', model: model || '',
    in: u.input_tokens || 0, out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    cost: Number(cost) || 0, ms: durationMs || 0, v: 2,
  };
  if (sessionId) {
    try {
      const sessions = readSessions();
      const total = line.cost;
      line.cost = spent({ total, before: sessions[sessionId]?.total, resumed, line });
      sessions[sessionId] = { total, ts: line.ts };
      // Sessions nobody carried on for two months are forgotten.
      const old = line.ts - 60 * 86400_000;
      for (const [id, s] of Object.entries(sessions)) if (!(s.ts > old)) delete sessions[id];
      fs.writeFileSync(SESSIONS, JSON.stringify(sessions));
    } catch { /* never in the way */ }
  }
  try { fs.appendFileSync(FILE, JSON.stringify(line) + '\n'); } catch { /* never in the way */ }
}

// Every line from `since` on, with `cost` being what the run itself cost.
export function read(since = 0) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.ts >= since) out.push({ ...e, cost: costOf(e) }); } catch { /* a torn line */ }
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
