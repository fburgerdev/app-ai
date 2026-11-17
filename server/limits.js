// Claude's usage limits: the five-hour one and the weekly one.
//
// A run that is cut off by a limit is not an error to show Florian. It is held, and runs
// again by itself once the limit has lifted, so he can send something at night and find
// it done in the morning:
//
//   a thread's turn    the thread stays "working" with `held` on it (runner.js). The hold
//                      is saved with the thread, so it travels to the other computer with
//                      everything else: whichever one does the work when the limit lifts
//                      carries on (the rule background work follows, link.mayRunBackground).
//   the brain update   `brainHeld` in the app's state; started again the same way (extract.js).
//   cards, the queue   skip their round while a limit is known to be on.
//
// When the limit lifts comes from Claude Code's own report (the rate_limit_event: an exact
// time, and which limit), not from the error text, which only names a clock time and so
// cannot tell tonight from Friday. The text is the fallback.

import { resetTime } from './prune.js';

// Whether an error is Claude's usage limit (and not a busy service or a sign-in problem).
export const isUsageLimit = (text) => /hit your .*limit|usage limit|limit reached|rate.?limit|out of (extra )?usage/i.test(String(text || ''));

const LABELS = { five_hour: 'five-hour limit', seven_day: 'weekly limit', seven_day_opus: 'weekly limit', seven_day_sonnet: 'weekly limit', seven_day_overage_included: 'weekly limit', overage: 'extra-usage limit' };
export const limitLabel = (type) => LABELS[type] || 'usage limit';

// What the SDK said about a limit, as { until, type }. `until` is 0 when it gave no time.
export function fromEvent(info) {
  if (!info || info.status !== 'rejected') return null;
  const at = Number(info.resetsAt) || 0;
  return { until: at && at < 1e11 ? at * 1000 : at, type: info.rateLimitType || '' };
}

// The limit a failed run ran into, or null. `seen` is the last rejection the SDK reported.
export function limitOf({ error, code, seen, now = Date.now() }) {
  if (!error && code !== 'rate_limit') return null;
  // A limit Claude Code reported as reached, and a run that then failed: that is one too.
  if (code !== 'rate_limit' && !isUsageLimit(error) && !(seen?.until > now)) return null;
  let until = seen?.until > now ? seen.until : 0;
  let type = seen?.type || '';
  if (!until) until = resetTime(error, now);
  if (!type) type = /week/i.test(String(error)) ? 'seven_day' : /5.?hour|five.?hour/i.test(String(error)) ? 'five_hour' : '';
  return { until, type };
}

// When a held run starts again: a little after the limit lifts. With no time known, soon.
export function resumeAt(limit, { marginMs = 3 * 60_000, fallbackMs = 15 * 60_000, now = Date.now() } = {}) {
  return limit?.until > now ? limit.until + marginMs : now + fallbackMs;
}

// "02:43", or "Fri 09:03" when that is not today.
export function clock(ts, now = Date.now()) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400_000);
  return `${days > 6 ? `${d.getDate()}.${d.getMonth() + 1}.` : d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

// The limit known to be on right now, for work that just skips its round.
let known = null;
export function noteLimit(limit) { known = limit ? { ...limit, until: resumeAt(limit, { marginMs: 0 }) } : null; }
export function limitedUntil(now = Date.now()) { return known && known.until > now ? known.until : 0; }
