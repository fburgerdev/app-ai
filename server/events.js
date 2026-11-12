// Events: the threads for what is coming up in Florian's calendar.
//
// They are not in the inbox. Each entry worth preparing becomes one thread of kind
// "event" that waits, unseen, until it is time: a day before for an important entry, on
// the morning of the day for a smaller one. Then the briefing is written and the
// thread shows in Events in the top bar. It stays there until he marks it done: the
// preparation session before the entry, the debrief after it, in the same thread.

import * as store from './store.js';
import * as runner from './runner.js';
import { log } from './config.js';
import { isKnownProject } from './projects.js';

let mayRun = () => true;

// When the thread opens: a day before, or at 07:00 on the day; never later than an hour
// before it starts.
export function showAtFor(start, important) {
  const s = new Date(start).getTime();
  if (important) return s - 24 * 3600_000;
  const morning = new Date(s);
  morning.setHours(7, 0, 0, 0);
  return Math.min(morning.getTime(), s - 3600_000);
}

const LEAD = (t) => `This is the thread for an entry in Florian's calendar: ${t.title}, ${new Date(t.event.start).toString().slice(0, 21)}${t.event.where ? `, ${t.event.where}` : ''}. The app made it by itself; it is not in his inbox but in Events, where it stays until he closes it. He uses it to prepare before the entry and to debrief after it, so this thread is also where what came out of it gets recorded for the brain update. Do what the brief says, then end your turn with the first question of the preparation session.`;

export function createEvent(card) {
  const start = Date.parse(card.start);
  if (!Number.isFinite(start)) return null;
  const end = Number.isFinite(Date.parse(card.end)) ? Date.parse(card.end) : start + 3600_000;
  const important = card.important !== false;
  const thread = store.createThread({
    title: String(card.title).replace(/^Prepare:\s*/i, '').trim().slice(0, 100),
    kind: 'event',
    project: isKnownProject(card.project) ? card.project : '',
  });
  // Waiting, unseen, until it is time.
  store.updateThread(thread.id, {
    event: { key: card.key, start, end, important, where: String(card.where || '').slice(0, 120), showAt: showAtFor(start, important), brief: card.text.trim(), started: false },
    state: 'done', doneAt: 0, hidden: true, projectGuessed: true,
  });
  tick();
  return thread;
}

// Opens the events whose time has come.
export function tick() {
  if (!mayRun()) return;
  const now = Date.now();
  for (const t of store.listThreads()) {
    if (t.kind !== 'event' || !t.event || t.event.started || t.event.showAt > now) continue;
    // An entry already over by the time the app saw it is not worth a briefing any more.
    if (t.event.end < now) { store.updateThread(t.id, { event: { ...t.event, started: true }, hidden: false, archived: false, state: 'ready', queuedAt: now }); continue; }
    store.updateThread(t.id, { event: { ...t.event, started: true }, hidden: false, archived: false, state: 'ready', queuedAt: now });
    runner.sendMessage(t.id, `${LEAD(t)}\n\n${t.event.brief}`, { auto: true });
    log(`events: opened "${t.title}"`);
  }
}

export function initEvents({ mayRunHere }) {
  mayRun = mayRunHere;
  setInterval(tick, 60_000).unref?.();
  setTimeout(tick, 5000).unref?.();
}
