// How much of the plan's limits is used: the five-hour window and the week, as Claude
// Code's /usage shows them. Florian's wish, 27-11-2026; it replaced the API-cost button.
//
// The source is the Agent SDK's usage call (experimental, its name says it may change):
// it starts Claude Code, asks it for /usage without sending Claude a message, so it costs
// no tokens (about 3 s, measured 27-11-2026). Asked when someone looks and the last answer
// is older than five minutes, and shortly after each run ends. In between, a run's
// rate_limit_event that carries a utilization updates its window straight away.
// If the call breaks with an SDK update, the meter is simply not shown.
//
// Every reading is also written to plan.jsonl in the data folder (Florian's yes,
// 27-11-2026), next to usage.jsonl's runs, so it can be worked out which work and which
// time of day empties the five-hour window fastest. It travels with the data repo like
// usage.jsonl, merged line by line, each line saying which computer read it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';

const FILE = path.join(DATA_DIR, 'plan.jsonl');

const STALE_MS = 5 * 60_000; // older than this, a look asks again
const MIN_GAP_MS = 60_000; // never asked more often than this
const TIMEOUT_MS = 30_000;

let now = null; // { fiveHour, week, models, at }
let asking = null;
let lastAsk = 0;
let afterRun = null;

const pct = (n) => (Number.isFinite(Number(n)) && n !== null ? Math.round(Number(n)) : null);
const windowOf = (w) => (w && pct(w.utilization) !== null ? { pct: pct(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) || 0 : 0 } : null);

// The SDK's answer, as the app shows it. Null when the plan's limits are not available.
export function shape(u, at = Date.now()) {
  if (!u?.rate_limits_available || !u.rate_limits) return null;
  const r = u.rate_limits;
  const models = (Array.isArray(r.model_scoped) ? r.model_scoped : [])
    .map((m) => ({ name: m.display_name || '', ...windowOf(m) }))
    .filter((m) => m.name && m.pct !== undefined && m.pct !== null);
  for (const [key, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
    const w = windowOf(r[key]);
    if (w && !models.some((m) => m.name === name)) models.push({ name, ...w });
  }
  const fiveHour = windowOf(r.five_hour);
  const week = windowOf(r.seven_day);
  if (!fiveHour && !week) return null;
  return { fiveHour, week, models, plan: u.subscription_type || '', at };
}

async function ask() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  let release;
  const hold = new Promise((r) => { release = r; });
  async function* prompt() { await hold; } // no message goes to Claude
  const q = query({ prompt: prompt(), options: { cwd: os.tmpdir(), abortController, settingSources: [], persistSession: false } });
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  } finally {
    clearTimeout(timer);
    release();
    try { abortController.abort(); } catch { /* already closed */ }
  }
}

// Asks Claude Code again, unless that happened within the last minute. One at a time.
export function refreshPlan({ fake = process.env.APP_AI_FAKE === '1' } = {}) {
  if (fake) return Promise.resolve(now);
  if (asking) return asking;
  if (Date.now() - lastAsk < MIN_GAP_MS) return Promise.resolve(now);
  lastAsk = Date.now();
  asking = ask()
    .then((u) => { now = shape(u); keep(now, 'poll'); return now; })
    .catch((err) => { log(`plan usage: ${err.message}`); return now; })
    .finally(() => { asking = null; });
  return asking;
}

// What the app knows now. A stale answer is returned as it is and asked again behind it.
export async function planNow({ wait = false } = {}) {
  const stale = !now || Date.now() - now.at > STALE_MS;
  if (stale) {
    const p = refreshPlan();
    if (wait || !now) await p;
  }
  return now;
}

// A run's rate_limit_event: its window's utilization, when it says one.
export function notePlanEvent(info) {
  if (!now || !info || !Number.isFinite(Number(info.utilization))) return;
  const u = Number(info.utilization);
  const key = info.rateLimitType === 'five_hour' ? 'fiveHour' : info.rateLimitType === 'seven_day' ? 'week' : '';
  if (!key) return;
  // The event's number is a fraction (0.18) or a percentage (18); the SDK does not say
  // which. Whichever lies nearer the last reading is taken; usage only grows inside a window.
  const before = now[key]?.pct ?? 0;
  const value = pct(u > 1 || Math.abs(u - before) < Math.abs(u * 100 - before) ? u : u * 100);
  const resetsAt = Number(info.resetsAt) ? (info.resetsAt < 1e11 ? info.resetsAt * 1000 : info.resetsAt) : 0;
  now = { ...now, [key]: { pct: value, resetsAt: resetsAt || now[key]?.resetsAt || 0 } };
  keep(now, 'event', Date.now());
}

// One reading as a line of plan.jsonl: short keys, percentages and reset times only.
export function lineOf(p, src, ts = p?.at || Date.now()) {
  if (!p) return null;
  const w = (x) => (x ? [x.pct, x.resetsAt || 0] : null);
  const line = { ts, host: os.hostname(), src, h5: w(p.fiveHour), wk: w(p.week) };
  for (const m of p.models || []) line[`wk_${m.name.toLowerCase()}`] = w(m);
  return line;
}

function keep(p, src, ts) {
  const line = lineOf(p, src, ts);
  if (!line) return;
  try { fs.appendFileSync(FILE, JSON.stringify(line) + '\n'); } catch { /* never in the way */ }
}

// Every reading from `since` on, for working it out later.
export function readings(since = 0) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((l) => { try { const e = JSON.parse(l); return e.ts >= since ? [e] : []; } catch { return []; } });
}

// A run ended: ask again a little later, once, however many runs end at the same time.
export function planAfterRun() {
  if (afterRun || process.env.APP_AI_FAKE === '1') return;
  afterRun = setTimeout(() => { afterRun = null; refreshPlan(); }, 5_000);
  afterRun.unref?.();
}

export function _reset() { now = null; asking = null; lastAsk = 0; }
