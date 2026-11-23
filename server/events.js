// Events: the threads for what is coming up in Florian's calendar.
//
// They are not in the inbox. Each entry worth preparing becomes one thread of kind
// "event" that waits, unseen, until it is time: a day before for an important entry, on
// the morning of the day for a smaller one. Then the briefing is written and the
// thread shows in Events in the top bar: the preparation session before the entry, notes
// during it, the debrief after it, in the same thread. When the entry is over the thread
// asks "how was it?"; his first answer takes it out of Events into his queue as an
// ordinary thread (runner.sendMessage), and without an answer it goes there by itself
// on the evening of the next day (Florian, 23-11-2026).

import * as store from './store.js';
import * as runner from './runner.js';
import { log } from './config.js';
import { isKnownProject } from './projects.js';
import * as google from './google.js';
import { gmailLink, historyFileName, mailThreadIds, writeMailHistory } from './mailhistory.js';

let mayRun = () => true;
let mailOn = () => { try { return google.googleConnected(); } catch { return false; } };

// When the thread opens: a day before, or at 07:00 on the day; never later than an hour
// before it starts.
export function showAtFor(start, important) {
  const s = new Date(start).getTime();
  if (important) return s - 24 * 3600_000;
  const morning = new Date(s);
  morning.setHours(7, 0, 0, 0);
  return Math.min(morning.getTime(), s - 3600_000);
}

const LEAD = (t) => `This is the thread for an entry in Florian's calendar: ${t.title}, ${new Date(t.event.start).toString().slice(0, 21)}${t.event.where ? `, ${t.event.where}` : ''}. The app made it by itself; it is not in his inbox but in Events. He uses it to prepare before the entry, to dictate notes during it (keep those short and sorted by person), and to debrief after it, so this thread is also where what came out of it gets recorded for the brain update. Once the entry is over the app asks him how it was; his first answer is the debrief: turn it into the follow-up mail drafts and proposed action lines. Do what the brief says, then end your turn with the first question of the preparation session.

How the briefing is written (Florian, 23-11-2026): it goes into a file, and the file holds everything; he reads it beside the chat during the entry. The file starts with an "Abstract" of three to five lines: what the entry is (when, where, who), what he wants out of it, what is open with the people there, and what to have on screen. The rest follows below it. Your reply does not retell the file: one line naming it, then only the \`> [!move]\` block with the first question of the preparation session, and a folded \`> [!done]\` line for what you checked; what you found goes into the briefing, not into the reply. On a new version of the briefing, the same: one line on what changed, then the move. During the entry he types notes into a notes field under the briefing (Enter makes a new line); they come to you when he sends them for the debrief, as his message.`;

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
    event: { key: card.key, start, end, important, where: String(card.where || '').slice(0, 120), showAt: showAtFor(start, important), brief: card.text.trim(), mailThreads: mailThreadIds(card.mailThreads), started: false },
    state: 'done', doneAt: 0, hidden: true, projectGuessed: true,
  });
  tick();
  return thread;
}

function open(t, now = Date.now()) {
  // An entry already over by the time the app saw it is not worth a briefing any more.
  if (t.event.end < now) { store.updateThread(t.id, { event: { ...t.event, started: true }, hidden: false, archived: false, state: 'ready', queuedAt: now }); return; }
  store.updateThread(t.id, { event: { ...t.event, started: true }, hidden: false, archived: false, state: 'ready', queuedAt: now });
  // The mails that led to the entry come with the briefing, word for word (Florian,
  // 23-11-2026): the app fetches them itself when the calendar run found them.
  const ids = t.event.mailThreads || [];
  let fetchable = false;
  try { fetchable = ids.length > 0 && google.googleConnected(); } catch { /* Google not set up */ }
  if (fetchable) {
    writeMailHistory(t.id, t.title, ids).then(
      (file) => brief(t, { file }),
      (err) => { log(`events: the mails for "${t.title}" could not be fetched: ${err.message}`); brief(t, { failed: err.message }); },
    );
  } else brief(t, {});
}

function brief(t, { file = null, failed = '' }) {
  runner.sendMessage(t.id, `${LEAD(t)}\n\n${mailNote(t, { file, failed })}${t.event.brief}`, { auto: true });
  if (file) {
    store.appendMessage(t.id, { role: 'assistant', parts: [
      { type: 'text', text: 'The mails that led to this entry, as they were written:' },
      { type: 'artifact', name: file.name, v: file.v },
    ] });
  }
  log(`events: opened "${t.title}"${file ? ', with its mails' : ''}`);
}

// What the briefing is told about the mails: they are here already, or it looks for them.
export function mailNote(t, { file = null, failed = '', mail } = {}) {
  if (file) {
    return `The app has put the mail conversation that led to this entry into this thread, word for word, as the file "${file.name}" (${file.path}). Florian reads it beside your briefing, to see what he asked and agreed himself, not only your summary of it. Read it before you brief; where it matters, point to it ("as you asked on 12-11") instead of retelling it, and do not write it out again.\n\n`;
  }
  if (!(mail ?? mailOn())) return '';
  const name = historyFileName(t.title);
  return `${failed ? `The app found the mail conversation that led to this entry (Gmail thread ${(t.event.mailThreads || []).join(', ')}) but could not fetch it: ${failed}. Fetch it yourself. ` : 'Search his mail with the mail tools for the conversation that led to this entry: with the people in it, about its subject, in the weeks before. '}Florian wants to read what he asked and agreed himself, not only your summary of it, so show it to him word for word: write it into the artifacts folder as "${name}", with the Gmail link (${gmailLink('<thread id>')}) at the top and then every mail oldest first, each under a heading with its date (DD-MM-YYYY HH:MM), sender and recipients, and its text exactly as in the mail; earlier mails quoted at the bottom of a reply may be left off. Base the briefing on it and point to it rather than retelling it. If there is no such conversation (an entry he made himself, a call arranged by phone), say so in one line.\n\n`;
}

// The evening of the day after an entry ended: an event never debriefed leaves Events then.
export function eveningAfter(end) {
  const d = new Date(end);
  d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  return d.getTime();
}

export const DEBRIEF_ASK = 'It is over: how was it? Tell me, typed or spoken: what was said, what you promised, what they promised, and what comes next. I turn it into the follow-up mails and the lines for your lists. Your answer takes this thread out of Events into your queue.';

// After the entry: ask for the debrief once; unpin it the next evening if he never gave one.
function afterwards(t, now) {
  if (t.state === 'done' || t.pinned != null || now < t.event.end) return;
  if (now >= eveningAfter(t.event.end)) {
    store.updateThread(t.id, { pinned: false, queuedAt: now });
    log(`events: "${t.title}" was not debriefed; it left Events for the queue`);
    return;
  }
  if (t.event.debriefAsked || t.state !== 'ready') return;
  store.appendMessage(t.id, { role: 'assistant', parts: [{ type: 'text', text: DEBRIEF_ASK }] });
  store.updateThread(t.id, { event: { ...t.event, debriefAsked: true }, queuedAt: now });
}

// Opens the events whose time has come, and asks for the debrief of those that are over.
export function tick() {
  if (!mayRun()) return;
  const now = Date.now();
  for (const t of store.listThreads()) {
    if (t.kind !== 'event' || !t.event) continue;
    if (t.event.started) { afterwards(t, now); continue; }
    if (t.event.showAt > now) continue;
    open(t, now);
  }
}

// Florian wants to prepare already: the event opens now, with its briefing, instead of
// a day before or on the morning of the day.
export function openNow(threadId) {
  const t = store.getThread(threadId);
  if (!t || t.kind !== 'event' || !t.event) throw new Error('No such event.');
  if (t.event.started) return t;
  open(t);
  return store.getThread(threadId);
}

// The events not over yet, soonest first: what a thread can move.
export function upcomingEvents(now = Date.now()) {
  return store.listThreads()
    .filter((t) => t.kind === 'event' && t.event && t.event.end >= now - 3600_000 && !(t.state === 'done' && t.event.started))
    .sort((a, b) => a.event.start - b.event.start);
}

const when = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const list = (events) => events.map((t) => `- "${t.title}" (${t.id}), ${when(t.event.start)}`).join('\n') || '(none)';

// Which event a thread means: the thread itself when it is one and nothing is named, else
// by id, else by its title (all words of `ref` in it, case aside).
export function findEvent(ref, fromThreadId) {
  const own = store.getThread(fromThreadId);
  const name = String(ref || '').trim();
  if (!name) {
    if (own?.kind === 'event' && own.event) return own;
    throw new Error(`Name the event to move. The upcoming ones:\n${list(upcomingEvents())}`);
  }
  const byId = store.getThread(name);
  if (byId?.kind === 'event' && byId.event) return byId;
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = upcomingEvents().filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No upcoming event matches "${name}". The upcoming ones:\n${list(upcomingEvents())}`);
  throw new Error(`"${name}" matches more than one event; give its id:\n${list(hits)}`);
}

// An entry moved (postponed, brought forward): the event thread follows at once, in
// Events and in when its briefing opens. Its thread gets a note, so the brain update and
// its preparation know. Times are ISO 8601; without an end it keeps its length.
export function moveEvent({ ref, start, end, where, fromThreadId, now = Date.now() }) {
  const t = findEvent(ref, fromThreadId);
  const s = Date.parse(start);
  if (!Number.isFinite(s)) throw new Error(`"${start}" is not a time. Give it in ISO 8601 with the offset, e.g. 2026-11-19T12:00:00+01:00.`);
  const e = end ? Date.parse(end) : s + (t.event.end - t.event.start);
  if (!Number.isFinite(e) || e <= s) throw new Error('The end has to be a time after the start.');
  const before = t.event;
  const event = { ...before, start: s, end: e, showAt: showAtFor(s, before.important), ...(where != null ? { where: String(where).slice(0, 120) } : {}) };
  store.updateThread(t.id, { event });
  const by = fromThreadId && fromThreadId !== t.id ? ` (said in the thread "${store.getThread(fromThreadId)?.title || ''}")` : '';
  store.appendMessage(t.id, { role: 'user', event: true, auto: true, text: `[The entry moved from ${when(before.start)} to ${when(s)}–${when(e).slice(11)}${event.where && event.where !== before.where ? `, ${event.where}` : ''}, on ${when(now)}${by}.]` });
  log(`events: moved "${t.title}" to ${when(s)}`);
  // Not opened yet: it opens by the new time (at once, if that has come).
  if (!before.started) tick();
  const after = store.getThread(t.id);
  return `Moved "${t.title}" to ${when(s)}–${when(e).slice(11)}. ${after.event.started ? 'Its thread is open in Events.' : `It opens by itself on ${when(after.event.showAt)}.`} This moves the event in the app only; the entry in Google Calendar is not changed by it.`;
}

export function initEvents({ mayRunHere, mailConnected }) {
  mayRun = mayRunHere;
  if (mailConnected) mailOn = mailConnected;
  setInterval(tick, 60_000).unref?.();
  setTimeout(tick, 5000).unref?.();
}
