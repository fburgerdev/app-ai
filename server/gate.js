// The lock: nothing new starts on this computer, so it gets quiet for an update or for
// handing over to the Pi without cutting off a turn.
//
// Florian, 23-11-2026: the app never locks by itself for an update. A line at the top says
// a new version is there; his click locks. While locked, every new turn (his messages,
// Claude's continue_later, retries, threads the app starts, spin-offs) waits as a hold of
// kind "gate", and the brain update and the card run wait too. What already runs finishes.
// Once nothing runs, the app restarts with the new version (selfupdate.js) or hands over
// (link.js), and everything that waited starts, in the order it came.
//
// A handover he asked for locks the same way, for as long as it waits for Claude.
//
// The lock lives in memory, on this computer only: a restart ends it, and so does the Pi
// taking over (it has its own). What waited is data on the threads, so it survives both.

let lock = null; // { reason: 'update', at }
const others = []; // () => reason or '' (link.js: a handover waiting for Claude)
const listeners = new Set();

export function lockFor(reason) {
  if (!lock) lock = { reason, at: Date.now() };
  changed();
  return status();
}

export function unlock() {
  const was = Boolean(lock);
  lock = null;
  if (was) changed();
  return status();
}

// Another reason to be locked, asked each time (a handover waiting for Claude).
export function alsoWhen(fn) { others.push(fn); }

export function reason() {
  if (lock) return lock.reason;
  for (const fn of others) {
    try { const r = fn(); if (r) return r; } catch { /* not locked by it */ }
  }
  return '';
}

export const isLocked = () => Boolean(reason());

export function status() {
  const r = reason();
  return { locked: Boolean(r), reason: r, since: lock?.at || 0 };
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(status()); } catch { /* never in the way */ } } }
