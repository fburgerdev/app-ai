// The interface. One loop: the app shows what the queue puts first, you reply or decide,
// and it brings up the next thing.

import { renderMarkdown, highlightPlain } from '/markdown.js';
import { renderDiff } from '/diff.js';
import { parseMail, serializeMail } from '/mail.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), lists: $('rail-lists'), paneQueue: $('pane-queue'), paneFolders: $('pane-folders'), brain: $('brain'), head: $('thread-head'),
  scroller: $('scroller'), messages: $('messages'), composer: $('composer'), input: $('input'),
  send: $('send'), spin: $('spin'), sendDone: $('send-done'), agree: $('agree'), picks: $('picks'), defer: $('defer'), attach: $('attach'), fileInput: $('file-input'), attached: $('attached'), panel: $('panel'), quote: $('quote-btn'), toast: $('toast'),
  tier: $('tier'), tabQueue: $('tab-queue'), tabProjects: $('tab-projects'),
  rail: document.querySelector('.rail'), edge: $('rail-edge'), backdrop: $('rail-backdrop'),
  pin: $('rail-pin'), railClose: $('rail-close'), tree: $('tree'),
  openInbox: $('open-inbox'), inboxCount: $('inbox-count'), openSettings: $('open-settings'),
  settings: $('settings'), settingsBody: $('settings-body'), settingsClose: $('settings-close'),
};

const S = {
  threads: new Map(),
  current: null, // thread id, or null for the "new thread" view
  pad: null, // name of the pad shown on the stage, when one is
  newProject: '', // project a new thread will belong to
  view: null, // { messages, artifacts } of the current thread
  live: null, // parts of the message Claude is writing in the current thread
  brain: null,
  config: {},
  connections: null,
  settings: { model: 'opus', effort: 'high', tier: 'auto', tiers: {}, tierNames: [] },
  queue: { order: [], why: '', ranking: false },
  cards: { running: false, ready: 0 },
  projects: null,
  tab: 'queue',
  settingsTab: 'general',
  lastThread: null, // where to go back to from the scratchpad
  panel: null,
  drafts: new Map(),
  picks: new Map(), // thread -> the answers he picked with buttons and has not sent
  attach: new Map(), // files picked for a message not sent yet, by thread ('new' for a new one)
  showDone: false,
};

// Declared up here because opening a thread touches them, whenever that first happens.
let tierAsk = null; // the quick-select row over the reply box, while it asks
let sending = false; // a message is on its way to the app
let armedDefer = ''; // the thread whose Defer button was clicked once
let armedDeferTimer = 0;

// ---------- parts of the page he can switch off ----------
//
// Settings → Layout lists them; "Pick on the page" lets him click them away instead.
// Hidden parts are hidden by CSS, so anything drawn later is hidden too; their keys
// still work. Saved with the app's state, so laptop, Pi and phone look the same; a copy
// in this browser hides them before the page has loaded.
const PARTS = [
  { group: 'Top bar', key: 'focus', label: 'Focus switch (Catch-up / Focus)', sel: '#focus-toggle' },
  { group: 'Top bar', key: 'reports', label: 'Daily reports', sel: '#open-reports' },
  { group: 'Top bar', key: 'computer', label: 'Which computer works (Laptop / Pi)', sel: '.laptop-wrap' },
  { group: 'Top bar', key: 'usage', label: 'What Claude used today', sel: '#usage' },
  { group: 'Top bar', key: 'videokit', label: 'Video Kit', sel: '#videokit-link' },
  { group: 'Top bar', key: 'talk', label: 'Talk', sel: '#talk-link' },
  { group: 'Inbox drawer', key: 'new-thread', label: 'New thread button (Alt N still works)', sel: '#new-thread' },
  { group: 'Inbox drawer', key: 'coming', label: 'Events coming later', sel: '[data-part="coming"]' },
  { group: 'Inbox drawer', key: 'opportunities', label: 'Look for opportunities', sel: '.group-foot' },
  { group: 'Inbox drawer', key: 'done-list', label: 'Done', sel: '.group[data-drop="done"]' },
  { group: 'Inbox drawer', key: 'gmail', label: 'Update Gmail', sel: '.brain-gmail, .brain-sub.is-mail' },
  { group: 'Right bar', key: 'tree', label: 'The right bar (Brain moves into the inbox drawer)', sel: '' },
  { group: 'Right bar', key: 'tree-people', label: 'People', sel: '.slide-tab[data-part="tree-people"]', redraw: true },
  { group: 'Right bar', key: 'tree-next', label: 'Next actions, asleep', sel: '[data-part="tree-next"]', redraw: true },
  { group: 'Right bar', key: 'tree-someday', label: 'Someday', sel: '.slide-tab[data-part="tree-someday"]', redraw: true },
  { group: 'Right bar', key: 'tree-paused', label: 'Paused projects', sel: '[data-part="tree-paused"]' },
  { group: 'Right bar', key: 'tree-bulk', label: 'A thread on every active / paused / area', sel: '[data-part="tree-bulk"]' },
  { group: 'Right bar', key: 'tree-times', label: 'How long ago, beside each row', sel: '.tree .out-when' },
  { group: 'Right bar', key: 'tree-ranks', label: 'Rank numbers of the areas', sel: '.tree .out-rank' },
  { group: 'Thread header', key: 'tier-again', label: 'Tier of the last turn, and one up', sel: '.btn-tier' },
  { group: 'Thread header', key: 'requeue', label: 'Requeue (Alt S still works)', sel: '.btn-requeue' },
  { group: 'Thread header', key: 'pin', label: 'Pin', sel: '.pin-btn' },
  { group: 'Thread header', key: 'later', label: 'Later / Back to focus (dragging onto "waiting for later" still works)', sel: '.later-btn' },
  { group: 'Reply box', key: 'attach', label: 'Attach files (dropping and pasting still work)', sel: '#attach' },
  { group: 'Reply box', key: 'effort', label: 'Effort', sel: '#tier' },
  { group: 'Reply box', key: 'spin', label: 'Send into spin-off (Alt Enter still works)', sel: '#spin' },
  { group: 'Reply box', key: 'defer', label: 'Defer', sel: '#defer' },
  { group: 'Reply box', key: 'agree-btn', label: 'Agree', sel: '#agree' },
  { group: 'Reply box', key: 'done-btn', label: 'Done (Ctrl Enter and Alt X still work)', sel: '#send-done' },
  { group: 'Everywhere', key: 'kbd', label: 'Key hints on buttons (Alt S, Alt N …)', sel: '.btn kbd, .btn-new kbd, .tier-ask-btn kbd' },
];
const HIDDEN_SAVED = 'app-ai-hidden';
let arranging = false; // "Pick on the page": click a part to hide or show it
const hiddenParts = () => new Set(S.settings?.hidden || []);
const partHidden = (key) => hiddenParts().has(key);
const partStyle = document.createElement('style');
partStyle.id = 'parts';
document.head.append(partStyle);

// The CSS for what is hidden. While picking, hidden parts show faded instead.
function partCss(hidden) {
  const list = PARTS.filter((p) => p.sel && hidden.has(p.key)).map((p) => p.sel).join(', ');
  return list ? `html:not(.is-arranging) :is(${list}) { display: none !important; }\nhtml.is-arranging :is(${list}) { opacity: 0.38; }` : '';
}
function applyParts() {
  const hidden = hiddenParts();
  partStyle.textContent = partCss(hidden);
  try { localStorage.setItem(HIDDEN_SAVED, JSON.stringify([...hidden])); } catch { /* private mode */ }
  els.app.classList.toggle('no-tree', hidden.has('tree'));
}
async function setPart(key, show) {
  const hidden = hiddenParts();
  if (show) hidden.delete(key); else hidden.add(key);
  S.settings = { ...S.settings, hidden: [...hidden] };
  applyParts();
  renderRail(); renderTree();
  try { await api('PUT', '/api/settings', { hidden: [...hidden] }); } catch (err) { toast(err.message); }
}
// Before the app's state has come: what this browser saw last time.
try { S.settings.hidden = JSON.parse(localStorage.getItem(HIDDEN_SAVED) || '[]'); } catch { S.settings.hidden = []; }
applyParts();

// ---------- how he arranged the page: button order, keys, his own buttons, the look ----------
//
// Florian, 25-11-2026: "make the app more customizable, like deciding on the button order".
// All of it is saved with the app's state (Settings → Layout, Shortcuts and General), so
// laptop, Pi and phone agree. The app's own order is the order of the lists below.

// The rows of buttons whose order is his. [key, name in the settings, where it is on the page].
const ROWS = {
  topbar: { label: 'Top bar', box: '.topbar', items: [
    ['inbox', 'Inbox', '#open-inbox'], ['gap', '↔ gap', '.top-space'], ['focus', 'Focus', '.focus-wrap'], ['reports', 'Reports', '#open-reports'],
    ['computer', 'Laptop / Pi', '.laptop-wrap'], ['usage', 'Usage', '#usage'], ['videokit', 'Video Kit', '#videokit-link'], ['talk', 'Talk', '#talk-link'],
    ['search', 'Search', '#open-search'], ['settings', 'Settings', '#open-settings']] },
  composer: { label: 'Reply box', box: '.composer-foot', items: [
    ['attach', 'Attach', '#attach'], ['effort', 'Effort', '#tier'], ['gap', '↔ gap', '.foot-space'], ['replies', 'Your own buttons', '#replies'],
    ['spin', 'Spin-off', '#spin'], ['defer', 'Defer', '#defer'], ['agree', 'Agree', '#agree'], ['done-btn', 'Done', '#send-done'], ['send', 'Send', '#send']] },
  // Built anew with every thread (renderHead), which sorts by this.
  head: { label: 'Thread header', items: [
    ['repo', 'Repo'], ['files', 'Files'], ['notes', 'Notes'], ['stop', 'Stop'], ['retry', 'Try again'], ['tier-again', 'Tier'], ['requeue', 'Requeue'],
    ['reopen', 'Reopen'], ['pin', 'Pin'], ['later', 'Later'], ['delete', 'Delete']] },
};
// His order for a row: what he saved, with any button he has not placed (a new one) put
// behind the button it follows in the app's own order.
function rowOrder(row) {
  const known = ROWS[row].items.map((i) => i[0]);
  const out = (S.settings.order?.[row] || []).filter((k) => known.includes(k));
  known.forEach((k, i) => {
    if (out.includes(k)) return;
    const before = known.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, k);
  });
  return out;
}
function applyOrder() {
  for (const row of ['topbar', 'composer']) {
    const box = document.querySelector(ROWS[row].box);
    if (!box) continue;
    const sel = Object.fromEntries(ROWS[row].items.map((i) => [i[0], i[2]]));
    const want = rowOrder(row).map((k) => box.querySelector(`:scope > ${sel[k]}`)).filter(Boolean);
    const now = [...box.children].filter((c) => want.includes(c));
    // Moving a button takes the focus off it, so only when the order really differs.
    if (now.some((c, i) => c !== want[i])) box.append(...want);
  }
}
async function saveSetting(patch) {
  S.settings = { ...S.settings, ...patch };
  applyCustom();
  try { await api('PUT', '/api/settings', patch); } catch (err) { toast(err.message); }
}

// The actions that have a key with Alt, and the key the app gives each.
const KEY_ACTIONS = [
  { id: 'new', code: 'KeyN', group: 'Threads', text: 'New thread' },
  { id: 'requeue', code: 'KeyS', group: 'Threads', text: 'Requeue: not now, show me the next' },
  { id: 'done', code: 'KeyX', group: 'Threads', text: 'Done: close this thread' },
  { id: 'next', code: 'KeyJ', group: 'Threads', text: 'Next thread in the inbox (also Alt ↓)' },
  { id: 'prev', code: 'KeyK', group: 'Threads', text: 'Previous thread in the inbox (also Alt ↑)' },
  { id: 'search', code: 'KeyP', group: 'Showing and hiding', text: 'Search every thread, or run a command (also Ctrl K)' },
  { id: 'inbox', code: 'KeyL', group: 'Showing and hiding', text: 'Show or hide the inbox (or move the pointer to the left edge)' },
  { id: 'files', code: 'KeyA', group: 'Showing and hiding', text: 'Show or hide the files Claude made in this thread' },
  { id: 'brain', code: 'KeyU', group: 'Brain', text: 'Update the brain' },
];
// Key -> action. A key he gave to one action is taken from the action that had it.
function keyMap() {
  const mine = S.settings.keys || {};
  const map = new Map();
  for (const a of KEY_ACTIONS) if (mine[a.id]) map.set(mine[a.id], a.id);
  for (const a of KEY_ACTIONS) if (!mine[a.id] && !map.has(a.code)) map.set(a.code, a.id);
  return map;
}
const KEY_NAMES = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Backquote: '`', BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
let keyLayout = null; // what this keyboard prints on each key, where the browser tells (a German Z is "KeyY")
navigator.keyboard?.getLayoutMap?.().then((map) => { keyLayout = map; applyCustom(); }).catch(() => {});
const keyName = (code) => (keyLayout?.get(code) || KEY_NAMES[code] || code.replace(/^(Key|Digit)/, '')).toUpperCase();
function keyHint(id) {
  const code = [...keyMap()].find(([, action]) => action === id)?.[0];
  return code ? `Alt ${keyName(code)}` : '';
}
// The key hint on a button, or nothing when the action has no key.
const kbdFor = (id) => { const text = keyHint(id); return text ? h('kbd', {}, text) : null; };

// The look beyond light and dark: the colour of what is yours, and the size of the text in
// a thread. Kept in this browser too, so the page has it before the app's state has come.
const LOOK_SAVED = 'app-ai-look-more';
const ACCENTS = [['', 'Amber'], ['orange', 'Orange'], ['rose', 'Rose'], ['lime', 'Lime']];
const SIZES = [['small', 'Small'], ['', 'Normal'], ['large', 'Large'], ['larger', 'Larger']];
function applyLookMore() {
  const look = S.settings.look || {};
  const root = document.documentElement;
  if (look.accent) root.dataset.accent = look.accent; else delete root.dataset.accent;
  if (look.size) root.dataset.size = look.size; else delete root.dataset.size;
  try { localStorage.setItem(LOOK_SAVED, JSON.stringify({ accent: look.accent || '', size: look.size || '' })); } catch { /* private mode */ }
}
try { S.settings.look = JSON.parse(localStorage.getItem(LOOK_SAVED) || '{}'); } catch { S.settings.look = {}; }
applyLookMore();

// Everything above, put onto the page. Called when the settings come or change.
function applyCustom() {
  applyOrder();
  applyLookMore();
  const hint = document.querySelector('#new-thread kbd');
  if (hint) { hint.textContent = keyHint('new'); hint.hidden = !hint.textContent; }
  renderReplies();
}

// His own reply buttons: a click sends the text, like Agree.
function renderReplies() {
  const box = document.getElementById('replies');
  if (!box) return;
  const t = S.current ? S.threads.get(S.current) : null;
  const list = t && t.kind !== 'card' && !S.pad ? S.settings.replies || [] : [];
  box.hidden = !list.length;
  box.replaceChildren(...list.map((r) => h('button', { class: 'btn btn-quiet btn-reply', type: 'button', title: `Sends: “${r.text}”`, onclick: () => send(false, '', '', r.text) }, r.label)));
}

// ---------- small helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Lists folded to one line that unfold under the pointer (events coming, waiting for later,
// paused projects). With plain CSS :hover they snapped shut on the slightest move past an
// edge, the jump in height put the pointer back on them, and they flickered. Now they open
// after a short dwell and close only once the pointer has stayed away for a moment, and the
// open state outlives the re-renders of the rail and the outline.
const FOLD_OPEN_MS = 110;
const FOLD_CLOSE_MS = 380;
const foldOpen = new Set();
const foldTimers = new Map(); // key -> { on, timer }
function hoverFold(el, key) {
  el.dataset.fold = key;
  if (foldOpen.has(key)) el.classList.add('is-hover');
  return el;
}
function setFold(key, on) {
  foldTimers.delete(key);
  if (on) foldOpen.add(key); else foldOpen.delete(key);
  document.querySelectorAll(`[data-fold="${key}"]`).forEach((el) => el.classList.toggle('is-hover', on));
}
function foldLater(key, on) {
  const pending = foldTimers.get(key);
  if (pending && pending.on === on) return;
  if (pending) clearTimeout(pending.timer);
  if (foldOpen.has(key) === on) { foldTimers.delete(key); return; }
  foldTimers.set(key, { on, timer: setTimeout(() => setFold(key, on), on ? FOLD_OPEN_MS : FOLD_CLOSE_MS) });
}
function foldPointer(key) {
  if (key) foldLater(key, true);
  for (const k of new Set([...foldOpen, ...foldTimers.keys()])) if (k !== key) foldLater(k, false);
}
document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  foldPointer(e.target.closest?.('[data-fold]')?.dataset.fold || '');
}, { passive: true });
document.documentElement.addEventListener('mouseleave', () => foldPointer(''));

// The notes field of an event thread (notesBox): text typed but not saved yet, and the
// save of the one on screen, run before the panel changes.
const notesDraft = new Map();
let flushNotes = () => {};

// A request that did not reach the app at all: nearly always the app restarting for an
// update. Said in plain words (the browser's own are "Failed to fetch"), and not at all
// while the pill at the top already says the app is away.
const AWAY = 'The app is not answering right now; it is probably restarting. Nothing is lost: try again in a moment.';
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error(AWAY); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The app answered with an error (${res.status}).`);
  return data;
}

// Copies text with its {{secret:name}} placeholders filled in by the app: the values are
// only ever put in at this last step. The clipboard is written while the click still
// counts (Safari asks for that), with the filled text arriving a moment later.
const SECRET_PLACEHOLDER = /\{\{\s*secret:[A-Za-z0-9_]+\s*\}\}/;
async function copyFilled(text) {
  const plain = String(text ?? '');
  if (!SECRET_PLACEHOLDER.test(plain)) return navigator.clipboard.writeText(plain);
  const filled = api('POST', '/api/fill', { text: plain }).then((d) => d.text ?? plain);
  if (window.ClipboardItem) {
    try {
      const blob = filled.then((t) => new Blob([t], { type: 'text/plain' }));
      return await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } catch { /* below */ }
  }
  return navigator.clipboard.writeText(await filled);
}

let toastTimer;
function toast(text) {
  if (text === AWAY && conn.shown) return; // the pill says it already
  // A window opened as a dialog covers the page, the toast included: it goes into the window.
  const host = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
  if (els.toast.parentElement !== host) host.append(els.toast);
  els.toast.textContent = text;
  els.toast.hidden = false;
  enter(els.toast, 'pop');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4500);
}

// Claude's usage limits, and when a held turn or brain update runs again.
const LIMIT_NAMES = { five_hour: 'five-hour limit', seven_day: 'weekly limit', seven_day_opus: 'weekly limit', seven_day_sonnet: 'weekly limit', seven_day_overage_included: 'weekly limit', overage: 'extra-usage limit' };
// What a held thread waits for: the usage limit, or carrying on by itself (retry.js).
function heldText(held) {
  if (held.kind === 'gate') return gateText(held);
  const at = holdClock(held.until);
  if (held.kind === 'retry') return held.restart ? 'The app restarted mid-turn · carries on by itself now' : `Ended on an error · tries again by itself at ${at}`;
  if (held.kind === 'continue') return `Waiting for ${held.reason || 'work still running'} · carries on by itself at ${at}`;
  if (held.kind === 'merge') return `Could not merge · Claude fixes it by itself at ${at}`;
  // Parked for a repo: it carries on when the repo is free, not by the clock (its `until` is a week away).
  if (held.kind === 'repo') return `Waiting for ${held.repo || held.reason}${held.holder ? `, held by ${held.holder}` : ''} · carries on by itself when it is free`;
  if (held.kind === 'goahead') return `Claude only needed a go-ahead · the supervisor carries on at ${at}`;
  return `Held by the ${LIMIT_NAMES[held.type] || 'usage limit'} · carries on at ${at}`;
}
// Waiting for the lock (an update or a handover): it starts once that is through.
const gateText = (held) => (held.reason === 'handover' ? 'Queued for the handover · starts on the Pi' : 'Queued for the update · starts after the restart');
function holdClock(ts) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'numeric' })} ${hm}`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

const clock = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
function stamp(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(ts) : `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${clock(ts)}`;
}

const kbd = (text) => h('kbd', {}, text);
// "9h", "3d": for the right bar, where every row carries one.
const agoShort = (ts) => ago(ts).replace('just now', 'now').replace(/ (min|h|d)$/, (m, u) => (u === 'min' ? 'm' : u));
const clip = (s, n = 34) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const debounce = (fn, ms) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };

// Restarts a CSS entrance animation on an element.
function enter(el, name = 'enter') {
  el.classList.remove(name);
  void el.offsetWidth;
  el.classList.add(name);
}

function grow(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}

// A text box that fits its text keeps fitting it when its column changes width (the side
// panel opens, the window is resized): the lines wrap differently then.
function keepGrown(area) {
  let width = 0;
  new ResizeObserver(() => { const w = area.clientWidth; if (w && w !== width) { width = w; grow(area); } }).observe(area);
  return area;
}

const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.isContentEditable);
};

// ---------- which thread comes next ----------

// Event threads waiting to open are not shown anywhere but in Events' "Coming".
const all = () => [...S.threads.values()].filter((t) => !t.hidden);
// What is waiting, in the queue's order; anything the queue has not placed yet follows, oldest first.
// Pinned threads sit on top of the inbox and are not part of the queue. An event is
// pinned unless he unpinned it; any other thread once he pinned it. (The same rule as
// the server's, so threads from before pins existed fall under it too.)
const isPinned = (t) => Boolean(t) && t.kind !== 'card' && (t.pinned ?? t.kind === 'event');
const pinPlace = (t) => t.pinAt ?? t.event?.start ?? t.createdAt ?? 0;
// Two kinds, kept apart: events always first and always by date (their order is the
// information, like a calendar's), then the threads he pinned, in the order he gave them.
const pinnedEvents = () => all().filter((t) => isPinned(t) && t.event && t.state !== 'done').sort((a, b) => a.event.start - b.event.start);
const pinnedThreads = () => all().filter((t) => isPinned(t) && !t.event && t.state !== 'done').sort((a, b) => pinPlace(a) - pinPlace(b));
const pinned = () => [...pinnedEvents(), ...pinnedThreads()];
// Catch-up (focus off) shows everything. Focus has two scopes (Florian, 23-11-2026):
// deep work, his own threads on anything; or one project (an area brings its projects,
// `members`). In both, events and mail replies marked pressing come through and cards
// wait. His "Later" mark corrects it both ways: `later` true sends any thread under
// "waiting for later", false keeps any in the queue. The same rule as the server's
// (store.isLater).
const APP_KINDS = new Set(['card', 'brain-update', 'mail-reply', 'checkin-active', 'checkin-paused', 'checkin-areas', 'repair', 'prep']);
const isAppThread = (t) => APP_KINDS.has(t.kind) && !(t.lastUserAt > 0);
const focusOn = () => Boolean(S.settings.focus?.on) && (!S.settings.focus.until || Date.now() < S.settings.focus.until);
const focusNow = () => (focusOn() ? S.settings.focus : null);
function isLater(t, focus = focusNow()) {
  if (typeof t.later === 'boolean') return t.later;
  if (t.kind === 'event') return false;
  if (t.kind === 'card') return true;
  if (t.kind === 'mail-reply' && t.pressing) return false;
  if (focus?.scope === 'project') return !(focus.members?.length ? focus.members : [focus.project]).includes(t.project);
  return isAppThread(t);
}
const later = () => (focusOn() ? all().filter((t) => t.state === 'ready' && !isPinned(t) && isLater(t)).sort((a, b) => a.queuedAt - b.queuedAt) : []);
// Mark a thread "Later" (true) or "keep in focus" (false). The mark stays, also once he
// writes in the thread, until he flips it.
async function setLater(t, value) {
  try {
    S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/later`, { later: Boolean(value) })).thread);
    renderRail(); renderHead();
  } catch (err) { toast(err.message); }
}
function inbox() {
  const ready = all().filter((t) => t.state === 'ready' && !isPinned(t) && !(focusOn() && isLater(t))).sort((a, b) => a.queuedAt - b.queuedAt);
  const pos = new Map(S.queue.order.map((id, i) => [id, i]));
  return ready.sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6));
}
const working = () => all().filter((t) => t.state === 'working' && !isPinned(t)).sort((a, b) => a.updatedAt - b.updatedAt);
// Done lists only what is not in the brain yet: a brain update archives the rest.
const done = () => all().filter((t) => t.state === 'done' && t.kind !== 'card' && !t.archived && !t.deferred).sort((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt));
const nextReady = (exceptId) => inbox().find((t) => t.id !== exceptId) || null;
const isUnfiled = (t) => t.kind !== 'card' && (t.lastUserAt || 0) > (t.extractedCount || 0);

function advance(fromId) {
  const next = nextReady(fromId);
  if (next) openThread(next.id, { byQueue: true });
  else openNew();
}

const KIND = { event: 'Event', repair: 'Repair', 'next-action': 'Next action', 'brain-update': 'Brain update', 'mail-reply': 'Mail to answer', prep: 'Coming up', 'checkin-active': 'Check-in', 'checkin-paused': 'Paused', 'checkin-areas': 'New project?' };
// What kind of work a thread he started himself is; the app works it out with the name.
const TYPE = { thinking: 'Thinking', mail: 'Mail', build: 'Build', document: 'Document', question: 'Question' };
function kindLabel(t) {
  if (t.kind === 'card') return { chase: 'Chase', proposal: 'Proposal' }[t.card?.type] || 'Opportunity';
  return KIND[t.kind] || TYPE[t.type] || '';
}

// ---------- the inbox ----------

function railItem(t) {
  let sub = '';
  const gated = t.state === 'working' && t.held?.kind === 'gate';
  if (gated) sub = `${gateText(t.held)}${t.doneAfter ? ', closes when finished' : ''}`;
  else if (t.state === 'working' && t.held?.kind === 'repo') sub = `Waiting for ${String(t.held.repo || t.held.reason).split('/').pop()} · carries on by itself`;
  else if (t.state === 'working' && t.held) sub = `${t.held.kind && t.held.kind !== 'limit' ? 'Carries on by itself' : 'Held: carries on'} at ${holdClock(t.held.until)}${t.doneAfter ? ', closes when finished' : ''}`;
  else if (t.state === 'working') sub = `${t.activity || 'Working'}${t.activityAt && Date.now() - t.activityAt > 60_000 ? ` · ${ago(t.activityAt)}` : ''}${t.doneAfter ? ', closes when finished' : ''}`;
  // Cut off by a restart of the app: no error of the turn, and it carries on by itself.
  else if (t.state === 'ready' && t.interrupted) sub = 'Restarted mid-turn · carries on by itself';
  else if (t.state === 'ready') sub = t.error ? 'Stopped with an error' : `waiting ${ago(t.queuedAt)}`;
  else sub = isUnfiled(t) ? 'not in the brain yet' : 'in the brain, archived with the next update';
  const label = kindLabel(t);
  return h('button', {
    class: `item item-${t.state}${t.id === S.current ? ' is-current' : ''}${t.error && !t.interrupted ? ' has-error' : ''}${t.kind === 'card' ? ' is-card' : ''}${t.later === true ? ' is-later' : ''}${gated ? ' is-gated' : ''}`,
    type: 'button',
    title: t.title,
    dataset: { id: t.id },
    onclick: () => openThread(t.id),
  },
    h('span', { class: 'item-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'item-text' },
      h('span', { class: 'item-title' }, t.title),
      h('span', { class: 'item-sub' }, label ? h('span', { class: 'tag' }, label) : null, t.kind === 'mail-reply' && t.pressing && t.state !== 'done' ? h('span', { class: 'tag tag-today', title: `Has to go out today${t.pressingWhy ? `: ${t.pressingWhy}` : ''}. Reaches you in Focus too.` }, 'Today') : null, t.project ? `${t.project}, ` : '', sub),
    ),
  );
}

// Deep work comes first in the queue (the server decides which threads that is). When
// both kinds are waiting, a quiet label over each part says which is which.
function withDeepLabels(ready) {
  const deep = new Set(S.queue.deep || []);
  const big = ready.filter((t) => deep.has(t.id));
  if (!big.length || big.length === ready.length) return ready.map(railItem);
  const label = (text, title) => h('p', { class: 'queue-part', title }, text);
  return [
    label('Deep work', 'Thinking sessions, building in a repo, documents, long threads: answered first, so they keep running.'),
    ...ready.filter((t) => deep.has(t.id)).map(railItem),
    label('In between', 'Cards, mail, questions and small threads: for while the deep ones work.'),
    ...ready.filter((t) => !deep.has(t.id)).map(railItem),
  ];
}

// `drop` names what dropping a thread on the section does: "queue" or "done".
const section = (label, count, items, extra, drop, part) => h('section', { class: 'group', dataset: { ...(drop ? { drop } : {}), ...(part ? { part } : {}) } },
  h('h2', { class: 'group-head' }, label, count ? h('span', { class: 'count' }, String(count)) : null, extra),
  ...items,
);

function queueLists() {
  const ready = inbox();
  const busy = working();
  const closed = done();
  const parts = [...pinnedSection()];
  const note = S.queue.ranking ? 'ordering…' : S.queue.why && ready.length > 1 ? `first because: ${S.queue.why}` : '';
  // In focus: what the app made waits here, folded, until focus ends or he opens it.
  const waits = later();
  // Dropping a thread on this line marks it "Later"; dragging one out into the queue
  // keeps it in focus.
  const laterLine = waits.length ? hoverFold(h('div', { class: `coming later${laterOpen ? ' is-open' : ''}`, dataset: { drop: 'later' } },
    h('button', { class: 'coming-head', type: 'button', 'aria-expanded': String(laterOpen), title: 'Outside your focus: started by the app (cards, proposals, questions, mail that can wait, check-ins), on another project, or marked "Later" by you. They come back into the queue in Catch-up. Drop a thread here to mark it "Later".', onclick: () => { laterOpen = !laterOpen; renderRail(); } },
      `${waits.length} waiting for later`, h('span', { class: 'coming-next' }, ' · focus')),
    h('div', { class: 'coming-list' }, ...waits.map(railItem))), 'later') : null;
  parts.push(section('Next up', ready.length, [
    note ? h('p', { class: 'group-note' }, note) : null,
    laterLine,
    ...(ready.length ? withDeepLabels(ready) : [h('p', { class: 'group-empty' }, busy.length ? 'Nothing yet. Claude is still working.' : 'Nothing is waiting.')]),
    h('p', { class: 'group-foot' }, S.cards.running
      ? h('span', { class: 'looking' }, h('span', { class: 'pulse' }), 'Looking for opportunities')
      : h('button', { class: 'link', type: 'button', onclick: () => api('POST', '/api/cards/make', {}).catch((e) => toast(e.message)) }, 'Look for opportunities')),
  ], null, 'queue'));
  if (busy.length) parts.push(section('Claude is working', busy.length, busy.map(railItem)));
  const toggle = closed.length ? h('button', { class: 'link', type: 'button', onclick: () => { S.showDone = !S.showDone; renderRail(); } }, S.showDone ? 'Hide' : 'Show') : null;
  parts.push(section('Done', closed.length, [
    h('p', { class: 'group-drop' }, 'Drop a thread here to close it'),
    ...(S.showDone ? closed.map(railItem) : []),
  ], toggle, 'done'));
  return parts;
}

let laterOpen = false;

// The switch in the top bar: Catch-up, or Focus on deep work (ends at his sleep time),
// or Focus on one project or area (until he ends it, tonight, or a day he picks).
function focusUntil(f = focusNow()) {
  if (!f) return '';
  if (!f.until) return 'until you end it';
  const d = new Date(f.until);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(f.until).setHours(0, 0, 0, 0) - today.getTime()) / 86400_000);
  return days <= 1 ? `until ${clock(f.until)}` : `until ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}
function renderFocus() {
  const b = document.getElementById('focus-toggle');
  const f = focusNow();
  b.classList.toggle('is-on', Boolean(f));
  b.title = f
    ? `Focus on ${f.scope === 'project' ? f.project : 'deep work'}, ${focusUntil(f)}: ${f.scope === 'project' ? 'only its threads' : 'your own threads'}, events, and mail that has to go out today. Everything else waits; no new cards. Click to change.`
    : 'Catch-up: everything, piled-up work, mail, cards and opportunities. Click to focus.';
  const sub = f && f.until ? focusUntil(f) : '';
  b.replaceChildren(svg('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>'),
    h('span', { class: 'top-label' }, f ? (f.scope === 'project' ? `Focus: ${f.project}` : 'Focus') : 'Catch-up'),
    ...(sub ? [h('span', { class: 'top-sub' }, sub)] : []));
  if (!document.getElementById('focus-pop').hidden) renderFocusPop();
}
async function setFocus(value, note) {
  try {
    S.settings = { ...S.settings, ...(await api('PUT', '/api/settings', { focus: value })) };
    toggleFocusPop(false);
    renderFocus(); renderRail(); renderComposer();
    toast(note());
  } catch (err) { toast(err.message); }
}
// The projects and areas to focus on, in the outline's order; paused projects left out.
function focusChoices() {
  const out = [];
  for (const g of S.projects?.groups || []) {
    if (g.isArea) out.push({ name: g.name, label: `${g.name} (area)` });
    for (const p of g.projects || []) if (!p.paused) out.push({ name: p.name, label: g.isArea ? `\u2003${p.name}` : p.name });
  }
  return out;
}
// When a deep-work focus would end if started now: his sleep time, or midnight.
function focusEndAt() {
  const sl = S.settings.sleep;
  const [hh, mm] = (sl?.on && /^\d\d:\d\d$/.test(sl.from || '') ? sl.from : '00:00').split(':').map(Number);
  const at = new Date(); at.setHours(hh, mm, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at.getTime();
}
const focusPick = { project: '', until: 'open', day: '' };
function renderFocusPop() {
  const pop = document.getElementById('focus-pop');
  const f = focusNow();
  const choices = focusChoices();
  if (!choices.some((c) => c.name === focusPick.project)) focusPick.project = f?.scope === 'project' ? f.project : (choices[0]?.name || '');
  const opt = (on, title, sub, onclick) => h('button', { class: `focus-opt${on ? ' is-on' : ''}`, type: 'button', onclick },
    h('span', { class: 'focus-opt-title' }, title), h('span', { class: 'focus-opt-sub' }, sub));
  const untilOf = () => {
    if (focusPick.until === 'tonight') { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime(); }
    if (focusPick.until === 'day' && focusPick.day) return new Date(`${focusPick.day}T23:59`).getTime();
    return 0;
  };
  const dayInput = h('input', { class: 'select', type: 'date', value: focusPick.day, 'aria-label': 'Last day of the focus', onchange: (e) => { focusPick.day = e.target.value; } });
  dayInput.hidden = focusPick.until !== 'day';
  const projectSelect = h('select', { class: 'select', 'aria-label': 'Project or area', onchange: (e) => { focusPick.project = e.target.value; } },
    ...choices.map((c) => h('option', { value: c.name }, c.label)));
  projectSelect.value = focusPick.project;
  const untilSelect = h('select', { class: 'select', 'aria-label': 'Until', onchange: (e) => { focusPick.until = e.target.value; dayInput.hidden = focusPick.until !== 'day'; } },
    h('option', { value: 'open' }, 'until I end it'),
    h('option', { value: 'tonight' }, 'until tonight'),
    h('option', { value: 'day' }, 'until a day…'));
  untilSelect.value = focusPick.until;
  pop.replaceChildren(
    opt(!f, 'Catch-up', 'Everything: piled-up work, mail, cards and opportunities.', () => setFocus(false, () => 'Catch-up: everything again.')),
    opt(f?.scope === 'deep', 'Focus: deep work', `Your own threads, events, and mail that has to go out today. Until ${clock(focusEndAt())}.`, () => setFocus(true, () => `Focus on deep work until ${clock(focusEndAt())}.`)),
    h('div', { class: `focus-project${f?.scope === 'project' ? ' is-on' : ''}` },
      h('span', { class: 'focus-opt-title' }, 'Focus: one project'),
      h('span', { class: 'focus-opt-sub' }, 'Only its threads, events, and mail that has to go out today. An area brings its projects.'),
      ...(choices.length ? [
        h('div', { class: 'focus-row' }, projectSelect, untilSelect, dayInput),
        h('button', { class: 'btn', type: 'button', onclick: () => {
          if (focusPick.until === 'day' && !focusPick.day) { toast('Pick the last day first.'); return; }
          const name = focusPick.project;
          setFocus({ scope: 'project', project: name, until: untilOf() }, () => `Focus on ${name}, ${focusUntil()}.`);
        } }, f?.scope === 'project' ? 'Change focus' : 'Focus on it'),
      ] : [h('span', { class: 'focus-opt-sub' }, 'No projects found in the Projects Index.')])));
}
function toggleFocusPop(open) {
  const pop = document.getElementById('focus-pop');
  const b = document.getElementById('focus-toggle');
  pop.hidden = !(open ?? pop.hidden);
  b.setAttribute('aria-expanded', String(!pop.hidden));
  if (!pop.hidden) renderFocusPop();
}
document.getElementById('focus-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggleFocusPop(); });
document.getElementById('focus-pop').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!document.getElementById('focus-pop').hidden) toggleFocusPop(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('focus-pop').hidden) toggleFocusPop(false); });
// It ends by itself: checked every minute, like the event times.
setInterval(() => { if (S.settings.focus?.on && !focusOn()) { S.settings = { ...S.settings, focus: { on: false, until: 0, scope: 'deep', project: '', members: [] } }; renderFocus(); renderRail(); } }, 60_000);

// Next Actions, asleep: lines of Next Actions.md, and threads deferred until the next
// brain update writes their line. They sit in Brain (the right bar, or the drawer's Brain
// tab), just before Someday, since he looks at them only when asking what needs doing
// (Florian, 23-11-2026). Waking one asks once more, in place: a next action started by
// accident is a real nuisance.
let armedWake = '';
function nextNodes(withHead = false) {
  const asleep = S.next?.actions || [];
  const deferred = (S.next?.deferred || []).filter((d) => S.threads.get(d.id)?.deferred);
  for (const t of all()) if (t.deferred && !t.archived && !deferred.some((d) => d.id === t.id)) deferred.push({ id: t.id, title: t.title, project: t.project || '' });
  const n = asleep.length + deferred.length;
  if (!n) return withHead ? [] : [h('p', { class: 'tree-note' }, 'Nothing in Next Actions.')];
  const wake = async (a, button) => {
    // Once more, in place: the first click only arms it.
    if (armedWake !== a.text) {
      armedWake = a.text;
      renderTree();
      setTimeout(() => { if (armedWake === a.text) { armedWake = ''; renderTree(); } }, 4000);
      return;
    }
    armedWake = '';
    button.disabled = true;
    try {
      const out = await api('POST', '/api/next-actions/wake', { project: a.project, text: a.text });
      S.threads.set(out.thread.id, out.thread);
      S.next = { ...S.next, actions: S.next.actions.filter((x) => x !== a) };
      openThread(out.thread.id);
      renderTree();
    } catch (err) { toast(err.message); button.disabled = false; }
  };
  return [
    withHead ? h('div', { class: 'tree-head', dataset: { part: 'tree-next' } }, h('span', { class: 'tree-label' }, 'Next actions'), h('span', { class: 'tree-n' }, String(n))) : null,
    h('div', { class: 'sleep-list', dataset: { part: 'tree-next' } },
      ...asleep.map((a) => h('button', { class: `item sleep-item${armedWake === a.text ? ' is-armed' : ''}`, type: 'button', dataset: { id: `na-${a.text.slice(0, 40)}` }, title: `${a.show}\n\nAsleep in Next Actions.md. Waking it makes it a thread in the inbox, opening with a brief.`, onclick: (e) => wake(a, e.currentTarget) },
        h('span', { class: 'item-mark', 'aria-hidden': 'true' }), h('span', { class: 'sleep-z', 'aria-hidden': 'true' }, armedWake === a.text ? '→' : 'z'),
        h('span', { class: 'sleep-main' }, h('span', { class: 'sleep-text' }, a.show),
          h('span', { class: 'sleep-sub' }, armedWake === a.text ? 'Click again to start it' : (a.project || 'no project'))))),
      ...deferred.map((d) => h('button', { class: `item sleep-item is-deferred${d.id === S.current ? ' is-current' : ''}`, type: 'button', dataset: { id: d.id }, title: 'Deferred. The next brain update writes it into Next Actions.md and deletes the thread. Reply in it to wake it again.', onclick: () => openThread(d.id) },
        h('span', { class: 'item-mark', 'aria-hidden': 'true' }), h('span', { class: 'sleep-z', 'aria-hidden': 'true' }, 'z'),
        h('span', { class: 'sleep-main' }, h('span', { class: 'sleep-text' }, d.title), h('span', { class: 'sleep-sub' }, 'deferred · written at the next brain update'))))),
  ].filter(Boolean);
}

// The vault on GitHub, from `brainRepo`; nothing when it is not a GitHub repo (a local
// path, as in the tests).
function brainRepoUrl() {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(S.config?.brainRepo || ''));
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
}
function brainRepoLink(withName = false) {
  const url = brainRepoUrl();
  if (!url) return null;
  return h('a', { class: `brain-gh${withName ? ' has-name' : ''}`, href: url, target: '_blank', rel: 'noopener', title: `Open the brain on GitHub (${url.replace('https://github.com/', '')})`, 'aria-label': 'Open the brain on GitHub' },
    svg('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'),
    withName ? h('span', {}, url.replace('https://github.com/', '')) : null);
}

// Events not open yet are folded under one quiet line; hovering or clicking it unfolds
// them. Clicking one arms it, a second click opens it now to prepare already: started by
// accident it would cost a briefing he did not want.
let comingOpen = false;
let armedEvent = '';
async function openEventNow(t, button) {
  if (armedEvent !== t.id) {
    armedEvent = t.id;
    renderRail();
    setTimeout(() => { if (armedEvent === t.id) { armedEvent = ''; renderRail(); } }, 4000);
    return;
  }
  armedEvent = '';
  button.disabled = true;
  try {
    const out = await api('POST', `/api/events/${t.id}/open`, {});
    S.threads.set(out.thread.id, out.thread);
    openThread(out.thread.id);
  } catch (err) { toast(err.message); button.disabled = false; }
}

// Pinned: on the very top of the inbox, and not part of the queue. Events from the
// calendar are here from the start; any thread can be pinned (the button in its header,
// or drag it here) and unpinned. Events come first, by date, with those not open yet
// greyed after them; then a thin divider; then his own pinned threads, which he reorders
// by dragging. Events are not reordered: their order is their date.
function pinnedSection() {
  const events = pinnedEvents();
  const mine = pinnedThreads();
  const coming = comingEvents();
  if (!events.length && !mine.length && !coming.length) return [];
  const plain = (t) => {
    const row = railItem(t);
    row.classList.add('pin-item');
    row.append(h('span', { class: `event-phase pin-state is-${t.state}` }, t.state === 'working' ? 'Claude…' : 'yours'));
    return row;
  };
  const item = (t, soon) => (!t.event ? plain(t) : h('button', {
    class: `item event-item${soon ? ' is-coming' : ''}${soon && armedEvent === t.id ? ' is-armed' : ''}${t.id === S.current ? ' is-current' : ''}`, type: 'button', dataset: soon ? {} : { id: t.id },
    title: soon ? `${t.title}\n${eventWhen(t.event)} · opens by itself ${eventWhen({ start: t.event.showAt }).toLowerCase()}\nClick twice to open it now and prepare already.` : `${t.title}\n${eventWhen(t.event)}${t.event.where ? ` · ${t.event.where}` : ''}`,
    onclick: soon ? (e) => openEventNow(t, e.currentTarget) : () => openThread(t.id),
  },
  h('span', { class: 'item-mark', 'aria-hidden': 'true' }),
  h('span', { class: 'sleep-main' },
    h('span', { class: 'sleep-text' }, t.title),
    h('span', { class: 'sleep-sub' }, soon && armedEvent === t.id ? 'Click again to prepare it now' : `${eventWhen(t.event)}${t.event.where ? ` · ${t.event.where}` : ''}${soon ? ` · opens ${eventWhen({ start: t.event.showAt }).toLowerCase()}` : ''}`)),
  soon ? null : h('span', { class: `event-phase is-${eventPhase(t.event).toLowerCase()}` }, t.state === 'working' ? 'Claude…' : t.state === 'ready' ? `${eventPhase(t.event)} · yours` : eventPhase(t.event))));
  return [section('Pinned', events.length + mine.length, [
    ...events.map((t) => item(t, false)),
    coming.length ? hoverFold(h('div', { class: `coming${comingOpen || coming.some((t) => t.id === armedEvent) ? ' is-open' : ''}`, dataset: { part: 'coming' } },
      h('button', { class: 'coming-head', type: 'button', 'aria-expanded': String(comingOpen), title: 'Events from your calendar that open by themselves later. Hover or click to see them.', onclick: () => { comingOpen = !comingOpen; renderRail(); } },
        `${coming.length} coming`, h('span', { class: 'coming-next' }, ` · next ${eventWhen(coming[0].event).toLowerCase()}`)),
      h('div', { class: 'coming-list' }, ...coming.map((t) => item(t, true)))), 'coming') : null,
    (events.length || coming.length) && mine.length ? h('div', { class: 'pin-divide', role: 'separator' }) : null,
    ...mine.map((t) => item(t, false)),
  ], null, 'pin')];
}

// ---------- the folder outline: areas, projects, and the threads in them ----------

const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
// The app's mark: the icon's graph without its tile.
const MARK = '<svg class="mark" viewBox="16 18 68 66" aria-hidden="true"><g stroke-width="4.4" stroke-linecap="butt"><line x1="29" y1="59" x2="26.5" y2="50.5" stroke="#8fd0a8"/><line x1="26.5" y1="50.5" x2="24" y2="42" stroke="#7aa8ff"/><line x1="24" y1="42" x2="30.5" y2="35.5" stroke="#7aa8ff"/><line x1="30.5" y1="35.5" x2="37" y2="29" stroke="#7aa8ff"/><line x1="37" y1="29" x2="46.5" y2="27.5" stroke="#7aa8ff"/><line x1="46.5" y1="27.5" x2="56" y2="26" stroke="#c3a6ff"/><line x1="56" y1="26" x2="64.5" y2="31" stroke="#c3a6ff"/><line x1="64.5" y1="31" x2="73" y2="36" stroke="#c3a6ff"/><line x1="73" y1="36" x2="74" y2="45" stroke="#c3a6ff"/><line x1="74" y1="45" x2="75" y2="54" stroke="#f5b75c"/><line x1="75" y1="54" x2="66.5" y2="58" stroke="#f5b75c"/><line x1="66.5" y1="58" x2="58" y2="62" stroke="#f5b75c"/><line x1="58" y1="62" x2="43.5" y2="60.5" stroke="#f5b75c"/><line x1="43.5" y1="60.5" x2="29" y2="59" stroke="#8fd0a8"/><line x1="47" y1="45" x2="35.5" y2="43.5" stroke="#f5b75c"/><line x1="35.5" y1="43.5" x2="24" y2="42" stroke="#7aa8ff"/><line x1="47" y1="45" x2="42" y2="37" stroke="#f5b75c"/><line x1="42" y1="37" x2="37" y2="29" stroke="#7aa8ff"/><line x1="47" y1="45" x2="60" y2="40.5" stroke="#f5b75c"/><line x1="60" y1="40.5" x2="73" y2="36" stroke="#c3a6ff"/><line x1="47" y1="45" x2="52.5" y2="53.5" stroke="#f5b75c"/><line x1="52.5" y1="53.5" x2="58" y2="62" stroke="#f5b75c"/><line x1="58" y1="62" x2="59" y2="69" stroke="#f5b75c"/><line x1="59" y1="69" x2="60" y2="76" stroke="#f5b75c"/></g><circle cx="29" cy="59" r="4.2" fill="var(--mark-ground, #171924)" stroke="#8fd0a8" stroke-width="4.4"/><circle cx="24" cy="42" r="4.2" fill="var(--mark-ground, #171924)" stroke="#7aa8ff" stroke-width="4.4"/><circle cx="37" cy="29" r="4.2" fill="var(--mark-ground, #171924)" stroke="#7aa8ff" stroke-width="4.4"/><circle cx="56" cy="26" r="4.2" fill="var(--mark-ground, #171924)" stroke="#c3a6ff" stroke-width="4.4"/><circle cx="73" cy="36" r="4.2" fill="var(--mark-ground, #171924)" stroke="#c3a6ff" stroke-width="4.4"/><circle cx="75" cy="54" r="4.2" fill="var(--mark-ground, #171924)" stroke="#f5b75c" stroke-width="4.4"/><circle cx="58" cy="62" r="4.2" fill="var(--mark-ground, #171924)" stroke="#f5b75c" stroke-width="4.4"/><circle cx="60" cy="76" r="4.2" fill="var(--mark-ground, #171924)" stroke="#f5b75c" stroke-width="4.4"/><circle cx="47" cy="45" r="6.6" fill="#f5b75c"/></svg>';

const wide = window.matchMedia('(min-width: 1100px)');
const tree = { open: '' }; // the one project or area that is expanded

const threadsIn = (project) => all().filter((t) => t.kind !== 'card' && (t.project || '') === project);

// Where a project sits: [area, project], [area] for an area itself, [] for none.
function pathOf(project) {
  if (!project) return [];
  for (const g of S.projects?.groups || []) {
    if (g.isArea && g.name === project) return [g.name];
    if (g.projects.some((p) => p.name === project)) return g.isArea ? [g.name, project] : [project];
  }
  return [project];
}

// ---------- the outline: every project and area, most recently dealt with first ----------
//
// It shows projects, not threads (and below them people and Someday items). A dot marks a project that has open threads; paused
// projects and areas without a project are grey and at the bottom. Click one to see its
// threads and what can be done there. Drop a thread on one to file it.

function outlineRow({ name, sub, project, about, touched, open, grey, isArea, hereName, rank }) {
  return h('div', { class: `out${grey ? ' is-grey' : ''}${hereName === project ? ' is-here' : ''}`, dataset: { drop: 'folder', project } },
    h('button', {
      class: 'out-row', type: 'button',
      title: `${name}${about ? `\n${about}` : ''}${open ? `\n${open} open ${open === 1 ? 'thread' : 'threads'}` : ''}\nClick to read its note`,
      onclick: () => openPanel({ kind: 'note', link: project }),
    },
    // A ranked area carries its place in 30,000 ft as a quiet marker in front.
    rank ? h('span', { class: 'out-rank', 'aria-label': `Rank ${rank}` }, String(rank)) : null,
    // The dot for open threads sticks to the last word, so a long name never leaves it
    // alone on a line of its own.
    h('span', { class: 'out-name' }, ...(open ? [String(name).replace(/\S+$/, ''), h('span', { class: 'out-last' }, /\S+$/.exec(String(name))?.[0] || '', h('span', { class: 'out-mark', 'aria-label': 'has open threads' }))] : [name]),
      sub ? h('span', { class: 'out-sub' }, sub) : null),
    touched ? h('span', { class: 'out-when' }, agoShort(touched)) : null),
    h('button', { class: 'out-plus', type: 'button', title: `New thread ${isArea ? 'in' : 'on'} ${name}`, 'aria-label': `New thread on ${name}`, onclick: () => openNew(project) }, '+'));
}

// Starts threads on many projects or areas at once. Asks once more, in place.
let armedStart = '';
async function startThreads(which, name = '') {
  try {
    const out = await api('POST', '/api/projects/start', { which, name });
    toast(out.started
      ? `Started ${out.started} ${out.started === 1 ? 'thread' : 'threads'}${out.skipped ? `; ${out.skipped} already had one` : ''}. They come into the inbox as Claude finishes.`
      : out.skipped ? 'Each of them already has an open thread.' : 'There is nothing to start a thread on.');
  } catch (err) { toast(err.message); }
}
function bulkButton(which, label, count, title) {
  const armed = armedStart === which;
  return h('button', {
    class: `out-start${armed ? ' is-armed' : ''}`, type: 'button', disabled: !count, title,
    onclick: () => {
      if (!armed) { armedStart = which; renderTree(); setTimeout(() => { if (armedStart === which) { armedStart = ''; renderTree(); } }, 4000); return; }
      armedStart = '';
      renderTree();
      startThreads(which);
    },
  }, armed ? `Start ${count}?` : label);
}

function treeNodes() {
  const t = S.projects;
  if (!t) return [h('p', { class: 'tree-note' }, 'Reading the vault…')];
  if (t.missing) return [h('p', { class: 'tree-note' }, 'The vault has no Projects Index yet.')];
  const hereName = S.current ? (S.threads.get(S.current)?.kind === 'card' ? null : S.threads.get(S.current)?.project || null) : S.pad ? null : S.newProject || null;
  // Counted here, from the threads the page has, so the marks are always current.
  const openIn = (name) => threadsIn(name).filter((x) => x.state !== 'done').length;
  const dealt = (name, vault) => Math.max(vault || 0, ...threadsIn(name).map((x) => x.lastUserTs || 0));
  const byRecent = (a, b) => b.touched - a.touched || a.name.localeCompare(b.name);
  const projects = t.groups.flatMap((g) => g.projects.map((p) => ({ name: p.name, project: p.name, about: p.about, paused: p.paused, touched: dealt(p.name, p.touched), open: openIn(p.name) })));
  const active = projects.filter((p) => !p.paused).sort(byRecent);
  const paused = projects.filter((p) => p.paused).sort(byRecent);
  const areas = t.groups.filter((g) => g.isArea).map((g) => ({
    name: g.name, project: g.name, isArea: true, about: g.projects.length ? g.projects.map((p) => p.name).join(', ') : 'No project right now',
    empty: !g.projects.length, open: openIn(g.name),
    touched: Math.max(dealt(g.name, g.touched), ...g.projects.map((p) => dealt(p.name, p.touched))),
  }));
  const row = (x, grey) => outlineRow({ ...x, grey, hereName });
  const each = 'One thread each, for those without an open thread';
  // Areas: the ranked ones in the order of 30,000 ft (Core/Horizons), each with its
  // number; then a quiet divider; then the ones left out of the ranking, alphabetically
  // and looking the same, since they are outside the ranking, not below it.
  const rankOf = new Map(t.groups.filter((g) => g.isArea && g.rank).map((g) => [g.name, g]));
  // An area with no active project under it is grey: a caption with nothing below.
  const areaRow = (a, bare) => {
    const r = rankOf.get(a.name);
    return row({ ...a, rank: r?.rank || 0, about: `${r ? `${r.rank}. ${r.goal || 'no goal line yet'}\n` : 'Not in the ranking of 30,000 ft Goals.\n'}${a.about}` }, bare);
  };
  const rankedAreas = areas.filter((a) => rankOf.has(a.name)).sort((a, b) => rankOf.get(a.name).rank - rankOf.get(b.name).rank);
  const unrankedAreas = areas.filter((a) => !rankOf.has(a.name)).sort((a, b) => a.name.localeCompare(b.name));
  // Projects hang under their area: the area is a quiet caption row (its rank in front),
  // its active projects on a rail below it, most recently dealt with first. Areas come in
  // the order of 30,000 ft, so the projects of the highest area are on top. An area
  // without an active project is just its row.
  const areaOf = new Map(t.groups.flatMap((g) => g.projects.map((p) => [p.name, g.isArea ? g.name : ''])));
  const group = (a) => {
    const mine = active.filter((p) => areaOf.get(p.name) === a.name);
    return h('div', { class: `area-group${mine.length ? '' : ' is-bare'}` },
      h('div', { class: 'out-list is-flat is-area' }, areaRow(a, !mine.length)),
      mine.length ? h('div', { class: 'out-list' }, ...mine.map((p) => row(p, false))) : null);
  };
  const loose = active.filter((p) => !areaOf.get(p.name));
  const first = [
    ...rankedAreas.map(group),
    rankedAreas.length && unrankedAreas.length ? h('div', { class: 'out-divide', role: 'separator', 'aria-label': 'Not ranked' }) : null,
    ...unrankedAreas.map(group),
    loose.length ? h('div', { class: 'area-group' },
      h('div', { class: 'area-none' }, 'No area'),
      h('div', { class: 'out-list' }, ...loose.map((p) => row(p, false)))) : null,
    !projects.length && !areas.length ? h('p', { class: 'tree-note' }, 'No projects in the vault.') : null,
    // Paused means he is waiting on something, so they are folded away and unfold on hover.
    paused.length ? hoverFold(h('div', { class: 'out-folded', dataset: { part: 'tree-paused' } },
      h('div', { class: 'out-folded-head' }, `${paused.length} paused`),
      h('div', { class: 'out-list out-folded-list' }, ...paused.map((p) => row({ ...p, sub: areaOf.get(p.name) || '' }, true)))), 'paused') : null,
    // Starting many threads at once, and where the order of the areas comes from: at the
    // foot, out of the way of the list itself.
    h('div', { class: 'tree-foot' },
      h('div', { class: 'tree-bulk', dataset: { part: 'tree-bulk' } },
        h('span', { class: 'tree-foot-label', title: each }, 'Start a thread on every'),
        bulkButton('active', 'active', active.length, `Start a check-in thread on every active project. ${each}.`),
        bulkButton('paused', 'paused', paused.length, `Start a thread on every paused project: has what it waits for happened? ${each}.`),
        bulkButton('areas', 'area', areas.length, `Start a thread per area about which new project to start there. ${each}.`)),
      h('button', { class: 'tree-sub', type: 'button', title: 'The order of the areas and each area\'s one- to two-year line come from this file. Click to read it.', onclick: () => openPanel({ kind: 'note', link: '30,000 ft Goals' }) },
        rankedAreas.length ? 'Areas in the order of 30,000 ft Goals' : 'No order in 30,000 ft Goals yet')),
  ].filter(Boolean);
  const second = peopleNodes(t.people || [], row, dealt);
  const third = somedayNodes(t.someday || []);
  return { first, second, third };
}

// People, on a slide of their own, in four groups. The group comes from the `Status:`
// line in each person's file; the order inside a group from when he last dealt with them.
function peopleNodes(people, row, dealt) {
  if (!people.length) return [h('p', { class: 'tree-note' }, 'No people in the vault.')];
  const list = people.map((p) => ({
    // "Flo (Mensa Revolution)": the name, and underneath it what it says about them.
    name: p.name.replace(/\s*\(([^)]*)\)\s*$/, ''), sub: /\(([^)]*)\)\s*$/.exec(p.name)?.[1] || '', project: p.name, group: p.group,
    about: `${p.name}${p.waitsFor ? `\nWaiting for: ${p.waitsFor}` : ''}\n${p.about || ''}`,
    touched: dealt(p.name, p.contacted), open: threadsIn(p.name).filter((x) => x.state !== 'done').length,
  }));
  const oldest = (a, b) => (a.touched || 0) - (b.touched || 0) || a.name.localeCompare(b.name);
  const group = (key, label, title, grey) => {
    const rows = list.filter((p) => p.group === key).sort(oldest);
    return rows.length ? [h('div', { class: 'tree-head', title }, h('span', { class: 'tree-label' }, label), h('span', { class: 'tree-n' }, String(rows.length))), h('div', { class: 'out-list' }, ...rows.map((p) => row(p, grey)))] : [];
  };
  return [
    ...group('move', 'Your move', 'You owe them something. Longest owed first.', false),
    ...group('warm', 'Keep warm', 'A reason to stay in touch, nothing owed. Longest silent first.', false),
    ...group('waiting', 'Waiting', 'Nothing to do until what they wait for happens. Hover for what.', true),
    ...group('none', 'Nothing open', 'Nothing open with them. Fold to dormant, or find the next step.', true),
  ];
}

// Someday, item by item, newest first; the parked old actions grey at the bottom. + starts
// a thread on the item: do it now, keep it, or fold it.
function somedayNodes(items, withHead = false) {
  if (!items.length) return withHead ? [] : [h('p', { class: 'tree-note' }, 'Nothing in Someday.')];
  const item = (x) => h('div', { class: `out${x.parked ? ' is-grey' : ''}` },
    h('button', { class: 'out-row', type: 'button', title: `${x.text}\n${x.parked ? 'Parked: an old action, never confirmed.\n' : ''}Click to read Someday`, onclick: () => openPanel({ kind: 'note', link: 'Someday' }) },
      h('span', { class: `out-name${x.label ? '' : ' is-long'}` }, x.label || x.short),
      x.touched ? h('span', { class: 'out-when' }, agoShort(x.touched)) : null),
    h('button', { class: 'out-plus', type: 'button', title: 'New thread on this: do it now, keep it, or fold it', 'aria-label': 'New thread on this Someday item', onclick: () => {
      openNew('Someday');
      els.input.value = `From Someday: "${x.text}"\n\n`;
      els.input.dispatchEvent(new Event('input'));
      els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    } }, '+'));
  const byNew = (a, b) => b.touched - a.touched;
  const parked = items.filter((x) => x.parked).sort(byNew);
  return [
    withHead ? h('div', { class: 'tree-head' }, h('span', { class: 'tree-label' }, 'Someday'), h('span', { class: 'tree-n' }, String(items.length))) : null,
    h('div', { class: 'out-list' }, ...items.filter((x) => !x.parked).sort(byNew).map(item)),
    parked.length ? h('div', { class: 'tree-head', title: 'Old actions that were parked here and never confirmed' }, h('span', { class: 'tree-label' }, 'Parked'), h('span', { class: 'tree-n' }, String(parked.length))) : null,
    parked.length ? h('div', { class: 'out-list' }, ...parked.map(item)) : null,
  ].filter(Boolean);
}

// The outline, Brain, is up to four slides side by side: projects under their areas;
// people; next actions; Someday. Swipe or scroll sideways and it snaps; the words on top
// jump. All but Projects can be switched off in Settings → Layout.
const SLIDES = [
  { key: 'projects', label: 'Projects' },
  { key: 'people', label: 'People', part: 'tree-people' },
  { key: 'next', label: 'Next', title: 'Next actions', part: 'tree-next' },
  { key: 'someday', label: 'Someday', part: 'tree-someday' },
];
const shownSlides = () => SLIDES.filter((s) => !s.part || arranging || !partHidden(s.part));
const slideIndex = () => Math.max(0, shownSlides().findIndex((s) => s.key === (tree.slide || 'projects')));
function slideNodes() {
  const nodes = treeNodes();
  if (Array.isArray(nodes)) return nodes;
  const slides = shownSlides();
  if (!slides.some((s) => s.key === tree.slide)) tree.slide = 'projects';
  const content = { projects: nodes.first, people: nodes.second, next: nextNodes(), someday: nodes.third };
  // A click slides straight there; the slides passed on the way do not light their tab.
  let heading = null;
  const go = (i) => {
    tree.slide = slides[i].key;
    const box = els.tree.querySelector('.slides');
    if (box) { heading = { left: i * box.clientWidth, until: Date.now() + 900 }; box.scrollTo({ left: heading.left, behavior: reducedMotion.matches ? 'auto' : 'smooth' }); }
    markSlide();
  };
  const nav = slides.length > 1
    ? h('div', { class: 'slide-nav', role: 'tablist' }, ...slides.map((s, i) => h('button', {
      class: `slide-tab${slideIndex() === i ? ' is-on' : ''}`, type: 'button', role: 'tab', title: s.title || null, dataset: s.part ? { part: s.part } : {}, onclick: () => go(i),
    }, s.label)))
    : h('div', { class: 'slide-nav is-single' }, h('span', { class: 'slide-title' }, slides[0].label));
  // On top: its name, and the way to the vault on GitHub.
  const top = h('div', { class: 'brain-top' }, h('span', { class: 'brain-title' }, 'Brain'), brainRepoLink());
  const box = h('div', { class: 'slides' }, ...slides.map((s) => h('div', { class: 'slide' }, ...content[s.key])));
  box.addEventListener('scroll', () => {
    if (heading) {
      if (Math.abs(box.scrollLeft - heading.left) > 2 && Date.now() < heading.until) return;
      heading = null;
    }
    const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
    if (slides[i] && slides[i].key !== tree.slide) { tree.slide = slides[i].key; markSlide(); }
  }, { passive: true });
  return [top, nav, box];
}
function markSlide() { els.tree.querySelectorAll('.slide-tab').forEach((b, i) => b.classList.toggle('is-on', i === slideIndex())); }

// The right bar is there on a wide window, unless he switched it off; then the outline
// is under "Brain" in the inbox drawer, as on a narrower window.
const treeShown = () => wide.matches && !partHidden('tree');

function renderTree(force = false) {
  if (drag?.active && !force) { drag.stale = true; return; }
  if (treeShown()) {
    // Drawn afresh, but where he was (which slide, how far down) stays.
    const tops = [...els.tree.querySelectorAll('.slide')].map((el) => el.scrollTop);
    els.tree.replaceChildren(...slideNodes());
    const box = els.tree.querySelector('.slides');
    if (box) {
      box.scrollLeft = slideIndex() * box.clientWidth;
      box.querySelectorAll('.slide').forEach((el, i) => { el.scrollTop = tops[i] || 0; });
    }
  } else renderFolders();
}

// Without the right bar, its outline is the drawer's second pane, beside the inbox. Both
// are drawn all the time, so a sideways swipe shows the other one at once and it snaps.
function drawerTree() {
  const n = treeNodes();
  if (Array.isArray(n)) return n;
  const link = brainRepoLink(true);
  return [...(link ? [h('div', { class: 'brain-top is-drawer' }, link)] : []),
    ...n.first,
    ...(partHidden('tree-people') ? [] : n.second),
    ...(partHidden('tree-next') ? [] : nextNodes(true)),
    ...(partHidden('tree-someday') ? [] : somedayNodes(S.projects?.someday || [], true))];
}
function renderFolders() {
  if (drag?.active) { drag.stale = true; return; }
  const has = !treeShown();
  els.paneFolders.hidden = !has;
  if (!has) {
    els.paneFolders.replaceChildren();
    if (S.tab !== 'queue') S.tab = 'queue';
    markTabs();
    return;
  }
  els.paneFolders.replaceChildren(h('div', { class: 'tree' }, ...drawerTree()));
}
function markTabs() {
  const folders = S.tab === 'projects' && !treeShown();
  els.tabQueue.classList.toggle('is-on', !folders);
  els.tabProjects.classList.toggle('is-on', folders);
  els.tabQueue.setAttribute('aria-selected', String(!folders));
  els.tabProjects.setAttribute('aria-selected', String(folders));
}
// Which pane is in view decides the tab, so a swipe moves the underline with it.
// While a tab click slides it there, the panes passed on the way do not count.
let tabSlide = null;
els.lists.addEventListener('scroll', () => {
  if (els.paneFolders.hidden) return;
  if (tabSlide) {
    if (Math.abs(els.lists.scrollLeft - tabSlide.left) > 2 && Date.now() < tabSlide.until) return;
    tabSlide = null;
  }
  const tab = Math.round(els.lists.scrollLeft / Math.max(1, els.lists.clientWidth)) ? 'projects' : 'queue';
  if (tab !== S.tab) { S.tab = tab; markTabs(); }
}, { passive: true });

async function moveToProject(id, project) {
  try {
    const out = await api('POST', `/api/threads/${id}/project`, { project });
    S.threads.set(id, out.thread);
    renderRail(); renderTree(); if (id === S.current) renderHead();
  } catch (err) { toast(err.message); }
}

// A press on the inbox that is still down: drawing the lists afresh between the press and
// the release would swallow the click (every step of a working thread redraws them).
let railPress = 0;
let railStale = false;
els.rail.addEventListener('pointerdown', () => { railPress = Date.now(); }, true);
for (const type of ['pointerup', 'pointercancel', 'dragend']) {
  document.addEventListener(type, () => {
    railPress = 0;
    if (railStale) { railStale = false; setTimeout(renderRail, 0); }
  }, true);
}

function renderRail() {
  // While a thread is being dragged the lists stay as they are; they are drawn afresh on the drop.
  if (drag?.active) { drag.stale = true; return; }
  if (railPress && Date.now() - railPress < 1200) { railStale = true; setTimeout(() => { if (railStale) { railStale = false; renderRail(); } }, 1300); return; }
  const before = new Map([...els.paneQueue.querySelectorAll('.item')].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
  els.paneQueue.replaceChildren(...queueLists());
  renderFolders();
  markTabs();
  if (!reducedMotion.matches && before.size) {
    for (const el of els.paneQueue.querySelectorAll('.item')) {
      const was = before.get(el.dataset.id);
      const now = el.getBoundingClientRect().top;
      if (was == null) el.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
      else if (Math.abs(was - now) > 1) el.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  const n = inbox().length;
  const busy = working().length;
  els.inboxCount.textContent = n ? String(n) : '';
  els.inboxCount.classList.toggle('has-ready', n > 0);
  els.inboxCount.classList.toggle('is-working', busy > 0 && n > 0);
  els.openInbox.title = `${n} waiting${busy ? `, Claude is working on ${busy}` : ''}. Alt L, or move the pointer to the left edge.`;
  // No count in the title or on the taskbar icon: there is always something waiting.
  document.title = 'Brain';
}

// On a phone, putting the cursor in the reply box brings up the keyboard over what you
// came to read. There the box is focused only when you tap it.
const coarse = window.matchMedia('(pointer: coarse)');
function focusInput() { if (!coarse.matches) els.input.focus(); }

// ---------- the inbox drawer: out of the way until the pointer is at the left edge ----------

const phone = window.matchMedia('(max-width: 700px)');
let railTimer = 0;

function setRail(open) {
  clearTimeout(railTimer);
  els.app.classList.toggle('rail-open', open);
  els.openInbox.classList.toggle('is-on', open || els.app.classList.contains('rail-pinned'));
  els.backdrop.hidden = !(open && phone.matches);
}
const closeRailSoon = (ms = 320) => { clearTimeout(railTimer); railTimer = setTimeout(() => { if (!drag?.active) setRail(false); }, ms); };

function setPinned(pinned) {
  els.app.classList.toggle('rail-pinned', pinned);
  els.pin.textContent = pinned ? 'Hide when not in use' : 'Keep open';
  els.pin.setAttribute('aria-pressed', String(pinned));
  els.openInbox.classList.toggle('is-on', pinned || els.app.classList.contains('rail-open'));
  try { localStorage.setItem('rail-pinned', pinned ? '1' : ''); } catch { /* private mode */ }
}

// A short dwell, so a pointer passing over the edge does not open it.
els.edge.addEventListener('mouseenter', () => { clearTimeout(railTimer); railTimer = setTimeout(() => setRail(true), 90); });
els.edge.addEventListener('mouseleave', () => { if (!els.app.classList.contains('rail-open')) clearTimeout(railTimer); });
els.edge.addEventListener('click', () => setRail(true));
els.rail.addEventListener('mouseenter', () => clearTimeout(railTimer));
els.rail.addEventListener('mouseleave', () => { if (!phone.matches) closeRailSoon(); });
els.pin.addEventListener('click', () => setPinned(!els.app.classList.contains('rail-pinned')));
els.railClose.addEventListener('click', () => setRail(false));
els.backdrop.addEventListener('click', () => setRail(false));
els.openInbox.addEventListener('click', () => {
  if (els.app.classList.contains('rail-pinned') && !phone.matches) setPinned(false);
  else {
    const opening = !els.app.classList.contains('rail-open');
    setRail(opening);
    // Opening the inbox also opens what is first in the queue.
    const first = inbox()[0];
    if (opening && first && first.id !== S.current) openThread(first.id, { byQueue: true }).then(() => { if (!phone.matches) setRail(true); });
  }
});
try { setPinned(localStorage.getItem('rail-pinned') === '1'); } catch { setPinned(false); }
wide.addEventListener('change', () => { if (treeShown()) S.tab = 'queue'; renderRail(); renderTree(); });

// ---------- dragging a thread ----------
//
// A thread can be dragged to another place in the queue, onto "Done" to close it, from
// Done back into the queue to reopen it, and onto a folder to file it there. With a
// mouse: press and move. With a finger: press and hold, then move (a plain swipe scrolls).

let drag = null;

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after, .is-drop')) el.classList.remove('drop-before', 'drop-after', 'is-drop');
}

// What letting go at this point would do, or null.
function dropAt(x, y) {
  const zone = document.elementFromPoint(x, y)?.closest('[data-drop]');
  const t = S.threads.get(drag.id);
  if (!zone || !t) return null;
  const kind = zone.dataset.drop;
  if (kind === 'pin') {
    // Onto the pinned section: pins it, at the place it is dropped.
    if (t.kind === 'card' || t.hidden) return null;
    // An event has no place of its own to be dragged to: it stands by its date. One
    // that was unpinned can be dropped here to pin it again.
    if (t.event) return isPinned(t) && t.state !== 'done' ? null : { kind, zone, index: 0, others: [] };
    const others = [...zone.querySelectorAll('.pin-item[data-id]')].filter((el) => el.dataset.id !== drag.id);
    let index = others.findIndex((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (index < 0) index = others.length;
    return { kind, zone, index, others };
  }
  if (kind === 'queue') {
    // A pinned thread dropped on the queue is unpinned; only a waiting one has a place there.
    if (t.state === 'working' && !isPinned(t)) return null;
    const others = [...zone.querySelectorAll('.item[data-id]')].filter((el) => el.dataset.id !== drag.id && !el.closest('.later'));
    let index = others.findIndex((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (index < 0) index = others.length;
    return { kind, zone, index, others };
  }
  if (kind === 'later') return t.state !== 'done' && !isLater(t) ? { kind, zone } : null;
  if (kind === 'done') return t.state === 'ready' && t.kind !== 'card' ? { kind, zone } : null;
  if (kind === 'folder') return t.kind !== 'card' && (t.project || '') !== zone.dataset.project ? { kind, zone, project: zone.dataset.project } : null;
  return null;
}

function beginDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  drag.item.classList.add('is-dragged');
  document.body.classList.add('is-dragging');
  drag.ghost = h('div', { class: 'drag-ghost' }, S.threads.get(drag.id)?.title || '');
  document.body.append(drag.ghost);
  if (drag.touch) navigator.vibrate?.(12);
}

function moveDrag(x, y) {
  drag.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
  // Coming from the folders with the inbox hidden: the left edge brings it in.
  if (x < 18 && !els.app.classList.contains('rail-open') && !els.app.classList.contains('rail-pinned')) setRail(true);
  // Over a drawer tab, the drawer slides to that pane, so a thread can be carried from
  // the inbox onto a folder.
  const tab = document.elementFromPoint(x, y)?.closest('.tab');
  if (tab) { const want = tab === els.tabProjects ? 'projects' : 'queue'; if (want !== S.tab) setTab(want); }
  clearDropMarks();
  const target = dropAt(x, y);
  drag.target = target;
  if (!target) return;
  if (target.kind === 'queue' || target.kind === 'pin') {
    if (!target.others.length) target.zone.classList.add('is-drop');
    else if (target.index < target.others.length) target.others[target.index].classList.add('drop-before');
    else target.others.at(-1).classList.add('drop-after');
  } else target.zone.classList.add('is-drop');
}

async function endDrag(drop) {
  const d = drag;
  drag = null;
  if (!d) return;
  clearTimeout(d.timer);
  d.item.classList.remove('is-dragged');
  d.ghost?.remove();
  document.body.classList.remove('is-dragging');
  clearDropMarks();
  if (d.active) {
    // The click that ends a drag must not open the thread.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 80);
  }
  const t = S.threads.get(d.id);
  const target = drop && d.active ? d.target : null;
  if (target && t) {
    try {
      if (target.kind === 'pin') {
        if (!isPinned(t) || t.state === 'done') S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/pin`, { pinned: true })).thread);
        // Only his own pinned threads have an order to keep; events stand by date.
        if (!t.event) {
          const ids = pinnedThreads().map((x) => x.id).filter((id) => id !== d.id);
          ids.splice(target.index, 0, d.id);
          // Shown at once; the server's order follows.
          ids.forEach((id, i) => { const x = S.threads.get(id); if (x) S.threads.set(id, { ...x, pinAt: i }); });
          const out = await api('POST', '/api/pins/order', { ids });
          for (const x of out.threads || []) S.threads.set(x.id, x);
        }
      } else if (target.kind === 'queue') {
        if (isPinned(t)) S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/pin`, { pinned: false })).thread);
        // Out of "waiting for later" into the queue: keep it in focus from now on.
        if (focusOn() && isLater(t)) S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/later`, { later: false })).thread);
        if (t.state === 'done') S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/state`, { state: 'ready' })).thread);
        if (S.threads.get(t.id)?.state === 'ready') {
          // Shown at once; the server's order follows a moment later.
          const ids = inbox().map((x) => x.id).filter((id) => id !== d.id);
          ids.splice(target.index, 0, d.id);
          S.queue = { ...S.queue, order: ids };
          S.queue = await api('POST', '/api/queue/move', { id: d.id, index: target.index });
        }
      } else if (target.kind === 'later') {
        // A pinned thread dropped here leaves the top too, or the mark would show nothing.
        if (isPinned(t)) S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/pin`, { pinned: false })).thread);
        S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/later`, { later: true })).thread);
      } else if (target.kind === 'done') {
        S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/state`, { state: 'done' })).thread);
      } else if (target.kind === 'folder') {
        S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/project`, { project: target.project })).thread);
        toast(target.project ? `Filed under ${target.project}.` : 'Taken out of its project.');
      }
    } catch (err) { toast(err.message); }
  }
  if (d.active || d.stale) { renderRail(); renderTree(); renderComposer(); if (S.current === d.id) renderHead(); }
  if (!els.rail.matches(':hover') && !phone.matches) closeRailSoon(600);
}

document.addEventListener('pointerdown', (e) => {
  const item = e.target.closest('.item[data-id], .out-thread[data-id]');
  if (!item || e.button > 0) return;
  const touch = e.pointerType !== 'mouse';
  drag = { item, id: item.dataset.id, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, touch, active: false, target: null, timer: 0, stale: false };
  if (touch) drag.timer = setTimeout(beginDrag, 380);
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const far = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
  if (!drag.active) {
    if (drag.touch) { if (far > 10) endDrag(false); return; } // a swipe scrolls
    if (far < 6) return;
    beginDrag();
  }
  moveDrag(e.clientX, e.clientY);
});
window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
// Once a finger holds a thread, moving it must not scroll the list or open a menu.
document.addEventListener('touchmove', (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (drag) e.preventDefault(); });

const loadProjects = debounce(async () => {
  try {
    [S.projects, S.next] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/next-actions').catch(() => null)]);
    renderTree();
    renderRail();
    if (S.current && !S.pad) renderHead();
  } catch { /* the next change brings it */ }
}, 400);

// Both panes are drawn already: a tab only slides the drawer to its pane.
function setTab(tab, smooth = true) {
  S.tab = els.paneFolders.hidden ? 'queue' : tab;
  markTabs();
  const left = S.tab === 'projects' ? els.lists.clientWidth : 0;
  tabSlide = { left, until: Date.now() + 900 };
  els.lists.scrollTo({ left, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto' });
}

// ---------- the brain footer ----------

function renderBrain() {
  const b = S.brain;
  if (!b) return;
  const rows = [];
  if (!b.brain.ready) {
    rows.push(h('p', { class: 'brain-line is-error' }, b.brain.error || 'Cloning the brain…'));
    if (b.brain.error) rows.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', '/api/brain/refresh', {}).then(setBrain).catch((e) => toast(e.message)) }, 'Try again'));
  } else if (b.running) {
    // It runs in a thread of its own: a click opens it.
    const label = [h('span', { class: 'mark-live' }, svg(MARK)), b.mailOnly ? 'Taking in new mail' : 'Updating the brain'];
    rows.push(b.threadId
      ? h('button', { class: 'link brain-line is-running', type: 'button', title: 'Open the update’s thread', onclick: () => openThread(b.threadId) }, ...label)
      : h('p', { class: 'brain-line is-running' }, ...label));
    rows.push(h('p', { class: 'brain-sub' }, b.step || 'Starting'));
  } else {
    const bits = [];
    if (b.waiting) bits.push(`${b.waiting} ${b.waiting === 1 ? 'thread' : 'threads'}`);
    if (b.notes) bits.push('your notes');
    if (b.cards) bits.push(`${b.cards} ${b.cards === 1 ? 'card' : 'cards'}`);
    rows.push(h('p', { class: 'brain-line' }, bits.length ? `Not in the brain yet: ${bits.join(', ')}` : 'Nothing new to file in the brain'));
    // Counted here, from the threads the page has, so it is current the moment they are archived.
    const clean = done().filter((t) => !isUnfiled(t)).length;
    if (clean) rows.push(h('p', { class: 'brain-sub' }, `${clean} closed ${clean === 1 ? 'thread is' : 'threads are'} already in the brain and leave Done with the next update.`));
    rows.push(h('div', { class: 'brain-btns' },
      h('button', { class: 'brain-go', type: 'button', disabled: !bits.length && !b.mail && !clean, title: 'Files what is new in the threads, the cards you decided and new mail, and clears Done of what is already in the brain (Alt U)', onclick: () => updateBrain() },
        svg(MARK), h('span', { class: 'brain-go-text' }, 'Update brain')),
      h('button', { class: 'btn brain-gmail', type: 'button', disabled: !b.mail, title: b.mail ? 'Takes in the mail that arrived and went out since the last time, and nothing else' : 'Connect Gmail in the settings first', onclick: () => updateBrain('mail') }, 'Update Gmail'),
    ));
    if (b.mail) rows.push(h('p', { class: 'brain-sub is-mail' }, b.mailLevel ? `Mail is taken in up to ${stamp(b.mailLevel)}` : 'No mail taken in yet; the first time looks back one day'));
    if (b.brain.error) rows.push(h('p', { class: 'brain-sub is-error' }, b.brain.error));
  }
  // Pressed while the app was locked for an update or a handover: it runs once that is through.
  if (b.held?.gate && !b.running) rows.push(h('p', { class: 'brain-sub is-gated' }, b.held.gate === 'handover' ? `${b.held.only === 'mail' ? 'Gmail update' : 'Brain update'} queued for the handover: runs once the Pi has taken over` : `${b.held.only === 'mail' ? 'Gmail update' : 'Brain update'} queued for the update: runs once the app has restarted`));
  if (b.last && !b.running) {
    const last = b.last;
    const what = last.mailOnly ? 'Gmail update' : 'update';
    let text;
    if (last.status === 'held') text = b.held ? `Held by the usage limit: runs by itself at ${holdClock(b.held.until)}` : `Last ${what} was held by the usage limit, ${stamp(last.finishedAt)}`;
    else if (last.status === 'failed') text = `Last ${what} failed, ${stamp(last.finishedAt)}`;
    else if (last.status === 'nothing') text = `Last ${what} ${stamp(last.finishedAt)}: nothing to file`;
    else text = `Last ${what} ${stamp(last.finishedAt)}: ${last.changes.length} ${last.changes.length === 1 ? 'file' : 'files'}${last.pushed ? '' : ', not pushed yet'}`;
    rows.push(h('button', { class: `link brain-last${last.status === 'failed' || !last.pushed ? ' is-error' : ''}`, type: 'button', onclick: () => openPanel({ kind: 'run', run: last }) }, text));
  }
  els.brain.replaceChildren(...rows);
}

function setBrain(status) {
  const wasRunning = S.brain?.running;
  S.brain = status;
  renderBrain();
  if (wasRunning && !status.running && status.last) {
    const last = status.last;
    const what = last.mailOnly ? 'Gmail update' : 'brain update';
    if (last.status === 'held') toast(last.error);
    else if (last.status === 'failed') toast(`The ${what} failed: ${last.error}`);
    else if (last.status === 'nothing') toast(last.mailOnly ? 'No new mail that needs filing.' : 'Brain update finished. Nothing needed filing.');
    else toast(`${last.mailOnly ? 'Mail taken in' : 'Brain updated'}: ${last.changes.length} ${last.changes.length === 1 ? 'file' : 'files'}${last.hasQuestions ? ', and Claude has questions for you in its thread' : ''}${last.replyThreads?.length ? `, ${last.replyThreads.length} to answer` : ''}.`);
    if (S.panel?.kind === 'run') openPanel({ kind: 'run', run: last });
    loadProjects();
  }
}

async function updateBrain(only = '') {
  try {
    const out = await api('POST', '/api/brain/extract', { only });
    if (!out.started) toast(out.reason);
    // One is running already: its thread opens.
    if (!out.started && out.threadId && S.threads.has(out.threadId)) openThread(out.threadId);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- a mail, as a card you can edit and send ----------

const googleOn = () => S.config.fake || S.connections?.google?.connected;

// `onDecided` is set for opportunity and chase cards, where putting the mail in Gmail or
// sending it is the same as accepting the card.
function mailCard(threadId, name, text, info, { onDecided, reason } = {}) {
  const mail = parseMail(text);
  const sent = info?.mail?.sentAt;
  const latest = info?.versions.at(-1)?.v || 1;
  const field = (label, key) => h('label', { class: 'mail-field' }, h('span', {}, label),
    h('input', { type: 'text', value: mail[key], disabled: Boolean(sent), spellcheck: 'false', oninput: (e) => { mail[key] = e.target.value; changed(); } }));
  const body = h('textarea', { class: 'mail-body', rows: '4', disabled: Boolean(sent), spellcheck: 'true', oninput: (e) => { mail.body = e.target.value; grow(e.target); changed(); } });
  body.value = mail.body;
  keepGrown(body);
  const status = h('span', { class: 'mail-status' });
  const actions = h('div', { class: 'mail-actions' });
  // The files that go along (the mail's `attach:` lines). He can take one off; adding one
  // is asked of Claude, who knows where the file is.
  const attached = h('div', { class: 'mail-attach' });
  const drawAttached = () => {
    attached.hidden = !mail.attach.length;
    attached.replaceChildren(h('span', {}, 'Attached'), ...mail.attach.map((file) => h('span', { class: 'mail-file', title: file },
      file.split('/').pop(),
      sent ? null : h('button', { type: 'button', class: 'mail-file-off', title: 'Do not attach this file', 'aria-label': `Do not attach ${file}`, onclick: () => { mail.attach = mail.attach.filter((f) => f !== file); drawAttached(); changed(); } }, '×'))));
  };
  drawAttached();
  let dirty = false;
  let saving = Promise.resolve();

  const save = () => {
    if (!dirty) return saving;
    dirty = false;
    status.textContent = 'Saving…';
    saving = api('POST', `/api/threads/${threadId}/artifact/save`, { name, content: serializeMail(mail) })
      .then(() => { status.textContent = 'Your edit is saved'; })
      .catch((err) => { status.textContent = ''; toast(err.message); });
    return saving;
  };
  const saveSoon = debounce(save, 700);
  function changed() { dirty = true; status.textContent = ''; saveSoon(); }

  // One click, one request: until Gmail has answered, the buttons are off, so a second
  // click or Enter on the focused button cannot send the mail again.
  let acting = false;
  const act = async (path, okText) => {
    if (acting) return;
    acting = true;
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    status.textContent = path === 'send' ? 'Sending…' : 'Putting it in Gmail…';
    if (!status.isConnected) actions.append(status);
    let ok = false;
    try {
      await save();
      await saving;
      const out = await api('POST', `/api/threads/${threadId}/mail/${path}`, { name, reason: reason ? reason() : '' });
      ok = true;
      toast([
        okText,
        out.closed ? 'The thread is done.' : '',
        out.archived ? 'Archived in Gmail.' : '',
        out.archiveError ? `Not archived in Gmail: ${out.archiveError}` : '',
      ].filter(Boolean).join(' '));
      document.activeElement?.blur();
      if (onDecided) onDecided();
      else if (out.closed) {
        // A sent reply closes its thread: it leaves the inbox and the next one opens.
        S.threads.set(threadId, out.thread);
        renderRail(); renderTree();
        if (S.current === threadId) advance(threadId);
      } else { await onArtifacts({ threadId }); }
    } catch (err) { toast(err.message); } finally {
      acting = false;
      // After a failure the card is as it was, so he can try again.
      if (!ok && el.isConnected) { status.textContent = ''; drawActions(); }
    }
  };

  function drawActions(confirming = false) {
    if (sent) {
      actions.replaceChildren(h('span', { class: 'mail-sent' }, `Sent ${stamp(sent)}`));
      return;
    }
    if (confirming) {
      actions.replaceChildren(
        h('span', { class: 'mail-confirm' }, `Send to ${mail.to || '(no recipient)'} with the subject “${mail.subject}”${mail.attach.length ? ` and ${plural(mail.attach.length, 'file', 'files')} attached` : ''}?`),
        h('button', { class: 'btn btn-send', type: 'button', onclick: () => act('send', 'Sent.') }, 'Send now'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => drawActions(false) }, 'Cancel'),
      );
      actions.querySelector('.btn-send').focus();
      return;
    }
    const m = info?.mail || {};
    const inGmail = m.draftId && m.draftVersion === latest;
    const off = !googleOn();
    const hint = off ? 'Connect Gmail in the settings first' : null;
    actions.replaceChildren(...[
      h('button', { class: 'btn', type: 'button', disabled: off, title: hint, onclick: () => act('draft', m.draftId ? 'The Gmail draft is updated.' : 'It is in your Gmail drafts.') },
        m.draftId ? (inGmail ? 'In Gmail drafts ✓' : 'Update Gmail draft') : 'Put in Gmail'),
      h('button', { class: 'btn', type: 'button', disabled: off, title: hint, onclick: () => drawActions(true) }, 'Send…'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: async () => { try { await copyFilled(mail.body); toast('Copied.'); } catch (err) { toast(err.message || 'Could not copy.'); } } }, 'Copy text'),
      info && info.versions.length > 1 ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openPanel({ kind: 'artifact', threadId, name, diff: true }) }, `${info.versions.length} versions`) : null,
      status,
    ].filter(Boolean));
  }
  drawActions();
  const el = h('div', { class: `mail${sent ? ' is-sent' : ''}`, dataset: { name } },
    field('To', 'to'), field('Subject', 'subject'), attached, body, actions);
  requestAnimationFrame(() => grow(body));
  return el;
}

// Turns the last mention of each mail file in the thread into a live mail card.
async function upgradeMailCards() {
  const threadId = S.current;
  if (!threadId || !S.view) return;
  const last = new Map();
  for (const el of els.messages.querySelectorAll('.artifact-card[data-name], .mail[data-name]')) last.set(el.dataset.name, el);
  for (const [name, el] of last) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const info = S.view.artifacts.find((a) => a.name === name);
    if (!info) continue;
    // Do not redraw a card he is typing in.
    if (el.classList.contains('mail') && el.contains(document.activeElement)) continue;
    try {
      const text = await (await fetch(`/api/threads/${threadId}/artifact?name=${encodeURIComponent(name)}`)).text();
      if (threadId !== S.current || !el.isConnected) return;
      if (parseMail(text)) el.replaceWith(mailCard(threadId, name, text, info));
    } catch { /* stays a plain file card */ }
  }
}

// ---------- the thread ----------

function stepsEl(tools, { live = false } = {}) {
  const label = live
    ? `${tools.at(-1).summary}${tools.length > 1 ? ` (step ${tools.length})` : ''}`
    : `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`;
  return h('details', { class: `steps${live ? ' is-live' : ''}` },
    h('summary', {}, live ? h('span', { class: 'pulse' }) : null, label),
    h('ol', {}, tools.map((t) => h('li', {}, t.summary))),
  );
}

function artifactCard(threadId, part) {
  return h('button', { class: 'artifact-card', type: 'button', dataset: { name: part.name }, onclick: () => openPanel({ kind: 'artifact', threadId, name: part.name, v: part.v }) },
    h('span', { class: 'artifact-glyph', 'aria-hidden': 'true' }),
    h('span', { class: 'artifact-name' }, part.name),
    h('span', { class: 'artifact-version' }, part.v > 1 ? `version ${part.v}` : 'new'),
    h('span', { class: 'artifact-open' }, 'Open'),
  );
}

function partNodes(threadId, parts, { live = false } = {}) {
  const out = [];
  let tools = [];
  const flush = (isLast) => {
    if (!tools.length) return;
    out.push(stepsEl(tools, { live: live && isLast }));
    tools = [];
  };
  parts.forEach((part) => {
    if (part.type === 'tool') { tools.push(part); return; }
    flush(false);
    if (part.type === 'text') {
      if (part.text.trim()) out.push(renderMarkdown(part.text));
    } else if (part.type === 'artifact') out.push(artifactCard(threadId, part));
  });
  flush(true);
  return out;
}

// While Claude works, every progress line and step shows as it comes. Once the turn is
// over, all of that folds into one line, and only the report at the end stays open,
// with the files the turn made. Florian, 19-11-2026: "when the run finishes i want this
// collapsed and just want to see the end report". A turn that ended mid-way (stopped,
// an error, the limit) has no report, so it stays as it is.
const hasText = (p) => p.type === 'text' && p.text.trim();
function partsInto(container, threadId, parts, { live = false } = {}) {
  const lastTool = parts.findLastIndex((p) => p.type === 'tool');
  const run = parts.slice(0, lastTool + 1);
  const report = parts.slice(lastTool + 1);
  const updates = run.filter(hasText).length;
  if (live || lastTool < 0 || !updates || !report.some(hasText)) {
    container.replaceChildren(...partNodes(threadId, parts));
    return;
  }
  const steps = run.filter((p) => p.type === 'tool').length;
  const label = `${updates} ${updates === 1 ? 'update' : 'updates'} on the way, ${steps} ${steps === 1 ? 'step' : 'steps'}`;
  container.replaceChildren(
    h('details', { class: 'progress' },
      h('summary', {}, label),
      h('div', { class: 'progress-body' }, ...partNodes(threadId, run.filter((p) => p.type !== 'artifact')))),
    // A file written several times on the way shows once, at its last version.
    ...[...new Map(run.filter((p) => p.type === 'artifact').map((p) => [p.name, p])).values()].map((p) => artifactCard(threadId, p)),
    ...partNodes(threadId, report),
  );
}

// What a note in the thread says, in a few words. The note itself stays as it is
// written, for Claude and the brain update; this is only how it is shown.
function shortNote(text) {
  const t = text.replace(/^\[|\]$/g, '').trim();
  let m;
  if ((m = /^Florian sent the mail "([^"]+)".*?To: (.+?)\. Subject: (.*)\.$/s.exec(t))) return { line: `Mail sent to ${m[2]}` };
  if ((m = /^Florian merged the branch \S+ into (\S+) of (\S+)/.exec(t))) return { line: `Merged into ${m[1]} of ${m[2].split('/').pop()}` };
  if ((m = /^Florian pushed the branch \S+ of (\S+)/.exec(t))) return { line: `Branch of ${m[1].split('/').pop()} pushed` };
  if ((m = /^The app (ran the tests, they passed, and it|found no tests in this repo and) merged (?:the branch \S+|the fix) into (\S+) of (\S+)/.exec(t))) {
    return { line: `Merged into ${m[2]} of ${m[3].split('/').pop()}${/passed/.test(m[1]) ? ', tests passed' : ', no tests'}${/updates itself/.test(t) ? ' · live within 10 min' : ''}` };
  }
  if (/^The app ran the tests on this fix, they passed, and it merged and pushed the fix/.test(t)) return { line: 'Fix merged, tests passed · live within 10 min' };
  if (/^The app ran the tests on this fix and they did not pass/.test(t)) return { line: 'Fix not merged: tests failed', bad: true };
  if ((m = /^The app ran the tests of (\S+) on this branch and they did not pass/.exec(t))) {
    return { line: `Not merged: tests of ${m[1].split('/').pop()} failed`, more: t.split('The end of the test output:')[1]?.trim() || '', bad: true };
  }
  if ((m = /^The app could not merge this branch into main by itself: (.*?)(?: The branch is on GitHub|$)/s.exec(t))) return { line: `Not merged: ${m[1].replace(/\.$/, '')}`, bad: true };
  if ((m = /^Claude renamed the GitHub repo (\S+) to (\S+?)\.? on/.exec(t))) return { line: `Repo renamed to ${m[2]}` };
  if ((m = /^Claude created the GitHub repo (\S+)/.exec(t))) return { line: `Repo ${m[1]} created` };
  const first = t.split(/(?<=[.!?])\s/)[0];
  return { line: first.length > 110 ? `${first.slice(0, 109).trim()}…` : first };
}

function messageEl(threadId, m) {
  // A Yes or No shows on its line, not as a note of its own.
  if (m.role === 'user' && m.event && m.confirm) return h('span', { class: 'msg-hidden', hidden: true });
  // What the app did by itself: the supervisor's own bubble, in its own colour, with what
  // Claude got when it started a turn.
  if (m.role === 'user' && m.supervisor) {
    const text = String(m.text || '').replace(/^\[|\]$/g, '').trim();
    return h('article', { class: 'msg msg-supervisor' },
      h('p', { class: 'supervisor-label' }, 'Supervisor', m.ts ? h('span', { class: 'supervisor-time' }, ` · ${stamp(m.ts)}`) : null),
      h('div', { class: 'msg-body' }, renderMarkdown(text)),
      m.prompt ? h('details', { class: 'supervisor-prompt' }, h('summary', {}, 'What Claude got'), h('div', { class: 'msg-body' }, renderMarkdown(m.prompt))) : null);
  }
  if (m.role === 'user' && m.event) {
    const n = shortNote(m.text);
    const full = m.text.replace(/^\[|\]$/g, '');
    const line = h('span', { class: 'event-line' }, n.line, m.ts ? h('span', { class: 'event-time' }, ` · ${stamp(m.ts)}`) : null);
    return n.more
      ? h('details', { class: `msg msg-event${n.bad ? ' is-bad' : ''}`, title: full }, h('summary', {}, line), h('pre', { class: 'event-more' }, n.more))
      : h('p', { class: `msg msg-event${n.bad ? ' is-bad' : ''}`, title: full }, line);
  }
  if (m.role === 'user' && m.auto) {
    return h('details', { class: 'msg msg-auto' }, h('summary', {}, 'Started by the app'), h('div', { class: 'msg-body' }, renderMarkdown(m.text)));
  }
  if (m.role === 'user') {
    return h('article', { class: 'msg msg-you' },
      ...(m.answers || []).map((a) => h('p', { class: 'answer', title: a.line }, h('span', {}, `${a.short || a.line}: `), h('b', {}, a.confirm ? (a.answer === 'no' ? 'No' : 'Yes') : a.answer))),
      m.answers?.length ? (m.typed ? h('div', { class: 'msg-body' }, renderMarkdown(m.typed)) : null) : m.text ? h('div', { class: 'msg-body' }, renderMarkdown(m.text)) : null,
      m.files?.length ? h('div', { class: 'msg-files' }, m.files.map((f) => h('a', {
        class: 'chip', href: `/api/threads/${threadId}/upload?name=${encodeURIComponent(f.name)}`, target: '_blank', rel: 'noopener', title: `Open ${f.name}`,
      }, h('span', { class: 'chip-name' }, f.name), h('span', { class: 'chip-size' }, fileSize(f.size))))) : null,
      h('time', { class: 'msg-time' }, stamp(m.ts), m.unanswered ? ' · sent and done, no answer' : '', m.steered ? ' · added while Claude worked' : '', m.queuedAt ? ` · queued as Next at ${clock(m.queuedAt)}` : ''),
    );
  }
  const body = h('div', { class: 'msg-body' });
  partsInto(body, threadId, m.parts || []);
  const el = h('article', { class: 'msg msg-claude', dataset: { mid: m.id || '' } }, body);
  markLines(el);
  const tier = tierText(m.tier || (isLastAnswer(threadId, m) ? S.threads.get(threadId)?.lastTier : ''));
  // The reply as Claude wrote it (Markdown), for pasting somewhere else.
  const written = (m.parts || []).filter((p) => p.type === 'text' && p.text.trim()).map((p) => p.text.trim()).join('\n\n');
  const copy = written ? h('button', { class: 'msg-copy', type: 'button', title: 'Copy this reply as text', onclick: async (e) => {
    const button = e.currentTarget;
    try { await copyFilled(written); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1600); } catch { toast('The browser did not allow copying.'); }
  } }, 'Copy') : null;
  if (m.ts || tier || copy) el.append(h('p', { class: 'msg-time msg-tier' }, copy, h('span', { title: tier ? 'The effort this answer ran on' : '' }, m.ts ? stamp(m.ts) : '', m.ts && tier ? ' · ' : '', tier)));
  if (m.stopped) el.append(h('p', { class: 'msg-note' }, 'You stopped Claude here.'));
  if (m.limit) el.append(h('p', { class: 'msg-note' }, `Claude's ${LIMIT_NAMES[m.limit.type] || 'usage limit'} cut the turn off here. The app carries on by itself when it lifts.`));
  // An error the app tried again after by itself is a note, not an alarm: the work went on below.
  if (m.error && m.retried) {
    // Nothing of the turn to show: the note of the app right below says what happened, once.
    if (!(m.parts || []).length) el.classList.add('is-bare');
    el.append(h('p', { class: 'msg-note', title: m.error }, 'The turn broke off here; the app carried on by itself.'));
  } else if (m.error) el.append(h('p', { class: 'msg-note is-error' }, m.error));
  return el;
}

// "High · Fable, medium": a tier as he reads it.
function tierText(name) {
  const t = name && S.settings.tiers?.[name];
  if (!t) return '';
  const model = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }[t.model] || t.model;
  return `${t.label} · ${model}, ${t.effort}`;
}
// Answers from before each one kept its tier: only the newest can be told, from the thread.
function isLastAnswer(threadId, m) {
  const msgs = S.current === threadId ? S.view?.messages : null;
  return Boolean(msgs) && msgs.filter((x) => x.role === 'assistant').at(-1) === m;
}

// The water level: everything above this line is in the brain.
function placeLevel() {
  els.messages.querySelector('.level')?.remove();
  const t = S.current && S.threads.get(S.current);
  if (!t || !S.view || t.kind === 'card' || !(t.extractedCount > 0)) return;
  const msgs = [...els.messages.querySelectorAll(':scope > .msg:not(.is-live)')];
  const upTo = Math.min(t.extractedCount, msgs.length);
  if (!upTo) return;
  const everything = upTo >= msgs.length && t.state !== 'working';
  const line = h('div', { class: 'level' }, h('span', {}, everything
    ? `In the brain, all of it${t.extractedAt ? `, since ${stamp(t.extractedAt)}` : ''}`
    : `In the brain up to here${t.extractedAt ? `, since ${stamp(t.extractedAt)}` : ''}`));
  msgs[upTo - 1].after(line);
}

let liveEl = null;
let liveTimer = 0;

function renderLive() {
  liveTimer = 0;
  if (!S.live || !S.current) return;
  const stick = nearBottom();
  if (!liveEl || !liveEl.isConnected) {
    liveEl = h('article', { class: 'msg msg-claude is-live' }, h('div', { class: 'msg-body' }));
    const box = els.messages.querySelector('.queued-box');
    if (box) box.before(liveEl); else els.messages.append(liveEl);
  }
  // The reply is drawn afresh with every piece that arrives: what he unfolded stays unfolded.
  const open = [...liveEl.querySelectorAll('details')].map((d) => d.open);
  partsInto(liveEl.firstChild, S.current, S.live, { live: true });
  liveEl.querySelectorAll('details').forEach((d, i) => { if (open[i]) d.open = true; });
  liveEl.firstChild.append(liveStatus(S.threads.get(S.current)));
  if (stick) els.scroller.scrollTop = els.scroller.scrollHeight;
}

// While Claude works, the live reply always ends on what it is doing now and for how
// long, with the last line each background job wrote. Before 23-11-2026 the pulse showed
// only while the last thing in the reply was a step, so a thread waiting on a render
// looked finished.
function liveStatus(t) {
  const since = t?.activityAt ? Date.now() - t.activityAt : 0;
  const long = since >= 10_000 ? (since < 60_000 ? `${Math.round(since / 1000)} s` : ago(t.activityAt)) : '';
  const jobs = (t?.background || []).filter((j) => j.tail);
  return h('div', { class: 'live-status' },
    h('p', { class: 'starting' }, h('span', { class: 'pulse' }), t?.activity || 'Starting', long ? h('span', { class: 'live-since' }, ` · ${long}`) : null),
    ...jobs.map((j) => h('p', { class: 'live-tail', title: `${j.description}: the last line it wrote` }, j.tail)));
}
// The time on the status line moves on by itself.
// Not while he is selecting text in the live reply: redrawing would drop the selection.
const selectingIn = (el) => { const sel = window.getSelection(); return Boolean(sel && !sel.isCollapsed && el.contains(sel.anchorNode)); };
setInterval(() => { if (S.live && liveEl?.isConnected && !selectingIn(liveEl)) scheduleLive(); }, 5000);

// What he queued as "Next": under the live reply while Claude works, and once the turn is
// over, with why the supervisor held it and a button to run it.
function renderQueued() {
  els.messages.querySelector('.queued-box')?.remove();
  const t = S.current ? S.threads.get(S.current) : null;
  if (!t || !S.view || t.kind === 'card' || !t.queued?.length) return;
  const working = t.state === 'working';
  const head = working ? 'Next, when this turn ends' : t.queuedHeld ? `Held by the supervisor: ${t.queuedHeld}` : 'Queued as Next, not run yet';
  const box = h('div', { class: `queued-box${working ? '' : ' is-held'}` },
    h('p', { class: 'queued-head' }, head),
    ...t.queued.map((q) => h('div', { class: 'queued-item' },
      h('span', { class: 'queued-text', title: q.text }, clip(q.text || (q.files?.length ? `${q.files.length} file(s)` : ''), 140)),
      q.tier ? h('span', { class: 'queued-tier' }, S.settings.tiers?.[q.tier]?.label || q.tier) : null,
      h('button', { class: 'link', type: 'button', title: 'Take it back into the box to change it', onclick: () => unqueue(t.id, q, true) }, 'Change'),
      h('button', { class: 'queued-x', type: 'button', title: 'Take it out', 'aria-label': 'Take it out', onclick: () => unqueue(t.id, q, false) }, '×'))),
    working ? null : h('div', { class: 'queued-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/queued/run`, {}).then((out) => { S.threads.set(t.id, out.thread); renderQueued(); renderRail(); }).catch((e) => toast(e.message)) }, 'Run it')));
  els.messages.append(box);
}
async function unqueue(threadId, q, edit) {
  try {
    const out = await api('DELETE', `/api/threads/${threadId}/queued/${q.id}`, {});
    S.threads.set(threadId, out.thread);
    if (edit) {
      els.input.value = [out.item.text, els.input.value].filter((x) => x.trim()).join('\n\n');
      els.input.dispatchEvent(new Event('input'));
      focusInput();
    }
    renderQueued();
  } catch (e) { toast(e.message); }
}

function scheduleLive() {
  if (!liveTimer) liveTimer = setTimeout(renderLive, 80);
}

const nearBottom = () => els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight < 120;

// Where the thread is filed, as a line under its name.
function pathEl(project) {
  const path = pathOf(project);
  return h('p', { class: 'thread-path', title: 'Drag the thread onto a folder to file it somewhere else' },
    path.length ? path.flatMap((name, i) => [i ? ' › ' : null, i === path.length - 1 ? h('b', {}, name) : name]) : 'No project');
}

// Deleting asks once more, in place.
function deleteButton(t) {
  const button = h('button', { class: 'btn btn-quiet', type: 'button', title: 'Delete this thread for good' }, 'Delete');
  let armed = 0;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Delete for good';
      button.className = 'btn btn-danger';
      armed = setTimeout(() => { armed = 0; button.textContent = 'Delete'; button.className = 'btn btn-quiet'; }, 4000);
      return;
    }
    clearTimeout(armed);
    try {
      await api('DELETE', `/api/threads/${t.id}`, {});
      onThreadDeleted({ id: t.id });
      toast('Deleted.');
    } catch (err) { toast(err.message); }
  });
  return button;
}

function renderHead() {
  if (S.pad) return;
  const t = S.current ? S.threads.get(S.current) : null;
  if (!t) {
    els.head.replaceChildren(...[
      h('h1', { class: 'thread-title is-static' }, 'New thread'),
      S.newProject ? h('div', { class: 'head-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openNew() }, 'Without a project')) : null,
      pathEl(S.newProject),
    ].filter(Boolean));
    return;
  }
  const title = h('input', {
    class: 'thread-title', 'aria-label': 'Thread name', spellcheck: 'false',
    onchange: (e) => api('POST', `/api/threads/${t.id}/title`, { title: e.target.value }).catch((err) => toast(err.message)),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); focusInput(); } },
  });
  title.value = t.title;
  let status;
  // Each button under its key (ROWS.head); his order sorts them at the end.
  const keyed = [];
  const actions = { push: (key, el) => keyed.push([key, el]) };
  if (t.kind === 'card') {
    status = h('span', { class: `status status-${t.state === 'ready' ? 'ready' : 'done'}` }, t.state === 'ready' ? kindLabel(t) : `${kindLabel(t)}, ${t.card?.outcome || 'decided'}`);
    if (t.state === 'ready') actions.push('requeue', h('button', { class: 'btn btn-quiet', type: 'button', onclick: requeue }, 'Requeue ', kbdFor('requeue')));
  } else if (t.state === 'working') {
    status = t.held
      ? h('span', { class: `status ${t.held.kind === 'gate' ? 'status-gated' : 'status-held'}` }, heldText(t.held))
      : h('span', { class: 'status status-working' }, h('span', { class: 'pulse' }), 'Claude is working', t.lastTier ? ` · ${tierText(t.lastTier)}` : '');
    actions.push('stop', h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/stop`, {}).catch((e) => toast(e.message)) }, t.held?.kind === 'gate' ? 'Take it back' : t.held ? 'Cancel the hold' : 'Stop'));
  } else if (t.state === 'ready' && t.kind === 'event' && t.event) {
    status = h('span', { class: 'status status-ready' }, `${eventPhase(t.event)} · ${eventWhen(t.event)}${t.event.where ? ` · ${t.event.where}` : ''}`);
  } else if (t.state === 'ready') {
    status = h('span', { class: 'status status-ready' }, 'Waiting for you');
    // Stopped with an error: one click runs it once more, from where it stopped.
    if (t.error) {
      actions.push('retry', h('button', {
        class: 'btn btn-retry', type: 'button', title: `The last turn ended on an error: ${t.error}\nTry again: Claude carries on where it stopped. You can also just write.`,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/retry`, {})).thread); renderHead(); renderRail(); } catch (err) { toast(err.message); renderHead(); }
        },
      }, 'Try again'));
    }
    // What the last turn was worth, and the way to say "that deserved more".
    if (t.lastTier && t.kind !== 'card') {
      const label = S.settings.tiers?.[t.lastTier]?.label || t.lastTier;
      const top = t.lastTier === (S.settings.tierNames || []).at(-1);
      actions.push('tier-again', h('button', {
        class: 'btn btn-quiet btn-tier', type: 'button', disabled: top,
        title: top ? `This ran on ${label}, the highest tier.` : `This ran on ${label}${t.keepTier ? ' (kept for this thread)' : ' (picked for the message)'}. Run the same message again one tier up, and keep that tier for this thread.`,
        onclick: async () => {
          try { const out = await api('POST', `/api/threads/${t.id}/again`, {}); S.threads.set(t.id, out.thread); toast(`Again on ${S.settings.tiers?.[out.tier]?.label || out.tier}.`); } catch (err) { toast(err.message); }
        },
      }, label, top ? null : h('span', { class: 'tier-up', 'aria-hidden': 'true' }, '↑')));
    }
    actions.push('requeue', h('button', { class: 'btn btn-quiet btn-requeue', type: 'button', title: 'Not now: put it back and show me the next', onclick: requeue }, 'Requeue ', kbdFor('requeue')));
  } else {
    status = h('span', { class: 'status status-done' }, t.archived ? 'Archived: done, and in the brain' : 'Done');
    actions.push('reopen', h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/state`, { state: 'ready' }).catch((e) => toast(e.message)) }, 'Reopen'));
  }
  if (t.kind === 'event' && t.event?.started) {
    const on = S.panel?.kind === 'notes' && S.panel.threadId === t.id;
    actions.push('notes', h('button', {
      class: `btn btn-quiet${on || t.notes?.text?.trim() ? ' is-on' : ''}`, type: 'button',
      title: 'Notes during the call: Enter makes a new line, saved as you type. Also under the briefing when it is open.',
      onclick: () => { if (on) closePanel(); else openPanel({ kind: 'notes', threadId: t.id }); renderHead(); },
    }, 'Notes'));
  }
  const files = t.kind === 'card' ? [] : S.view?.artifacts || [];
  if (files.length) {
    actions.push('files', h('button', { class: 'btn btn-quiet', type: 'button', onclick: toggleFiles }, `${files.length} ${files.length === 1 ? 'file' : 'files'} `, kbdFor('files')));
  }
  if (t.kind !== 'card' && t.repo) {
    const shortName = t.repo.split('/').pop();
    actions.push('repo', h('button', { class: `btn btn-quiet repo-btn${S.panel?.kind === 'repo' ? ' is-on' : ''}`, type: 'button', title: `This thread works in ${t.repo}${t.repoBranch ? ` on ${t.repoBranch}` : ''}`, onclick: toggleRepo },
      h('span', { class: 'repo-glyph', 'aria-hidden': 'true' }, '⑂'), shortName, t.repoBranch ? h('span', { class: 'repo-dot', title: 'Has work on its branch' }) : null));
  }
  if (t.kind !== 'card' && t.state !== 'done') {
    const on = isPinned(t);
    actions.push('pin', h('button', {
      class: `btn btn-quiet pin-btn${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on),
      title: on ? 'Pinned on top of the inbox, outside the queue. Click to unpin: it goes back among the other threads.' : 'Pin this thread on top of the inbox. It leaves the queue and stays there until you unpin or close it.',
      onclick: async () => {
        try {
          S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/pin`, { pinned: !on })).thread);
          renderRail(); renderHead();
        } catch (err) { toast(err.message); }
      },
    }, on ? 'Unpin' : 'Pin'));
  }
  // His correction of the app's sorting for Focus: "Later" sends a thread under "waiting
  // for later", "Back to focus" keeps one in the queue. It only changes things in Focus.
  if (t.state !== 'done') {
    const on = isLater(t);
    const mine = typeof t.later === 'boolean';
    actions.push('later', h('button', {
      class: `btn btn-quiet later-btn${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on),
      title: on
        ? `${mine ? 'You marked this "Later"' : 'Started by the app'}: in Focus it waits under "waiting for later". Click to keep it in your Focus queue.`
        : `In your Focus queue${mine ? ', as you marked it' : ''}. Click to mark it "Later": in Focus it waits under "waiting for later". In Catch-up nothing changes.`,
      onclick: () => setLater(t, !on),
    }, on ? 'Back to focus' : 'Later'));
  }
  if (t.state !== 'working') actions.push('delete', deleteButton(t));
  const place = rowOrder('head');
  const sorted = keyed.sort((a, b) => place.indexOf(a[0]) - place.indexOf(b[0])).map(([, el]) => el);
  els.head.replaceChildren(...[title, status, h('div', { class: 'head-actions' }, sorted), t.kind === 'card' ? null : pathEl(t.project)].filter(Boolean));
  markGated(t);
}

// While a thread waits for the lock, what he sent since Claude's last answer is shown in
// the queued colour, so it is plain that it has not started yet.
function markGated(t) {
  const gated = t?.state === 'working' && t.held?.kind === 'gate';
  const all = [...els.messages.children];
  let tail = true;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const el = all[i];
    if (el.classList.contains('msg-claude')) tail = false;
    if (!el.classList.contains('msg-you')) continue;
    el.classList.toggle('is-gated', gated && tail);
    const time = el.querySelector('.msg-time');
    if (time && gated && tail) time.dataset.gateNote = t.held.reason === 'handover' ? 'queued, starts on the Pi after the handover' : 'queued, starts after the update';
  }
}

function renderComposer() {
  const t = S.current ? S.threads.get(S.current) : null;
  els.composer.hidden = Boolean(S.pad) || t?.kind === 'card';
  // A spin-off needs a thread to start from.
  els.spin.hidden = !t;
  // Both wordings; the styles show the short one where the thread's column is narrow.
  if (!els.spin.firstElementChild) els.spin.replaceChildren(h('span', { class: 'spin-long' }, 'Send into spin-off'), h('span', { class: 'spin-short' }, 'Spin off'));
  let verb = 'Send';
  if (!t) {
    els.input.placeholder = 'What should Claude work on?';
    verb = 'Start';
  } else if (t.state === 'working') {
    els.input.placeholder = t.held ? (t.held.kind === 'gate' ? 'Add to it. It goes along when it starts.' : t.held.kind && t.held.kind !== 'limit' ? 'Reply. Claude starts on it at once.' : 'Add to this thread. Claude gets it when the limit lifts.') : 'Add to this thread. Then pick: Claude reads it now, or it runs next.';
    verb = t.held?.kind && t.held.kind !== 'limit' ? 'Send' : 'Add';
  } else {
    els.input.placeholder = t.state === 'done' ? 'Reply to reopen this thread.'
      : t.kind === 'event' && t.event && Date.now() > t.event.end ? 'How did it go?' : 'Reply.';
  }
  els.send.dataset.verb = verb;
  els.send.textContent = verb;
  renderSettings();
  els.defer.hidden = !t || t.state === 'done';
  if (armedDefer && armedDefer !== t?.id) disarmDefer();
  renderDoneButton();
  renderAttached();
  renderPicks();
  renderReplies();
}

// Check for updates now. If a new version waits for Claude, the button offers to update
// anyway (that turn is cut off). The page reloads by itself once the app is back.
function updateButton() {
  const out = h('span', { class: 'panel-note update-out' });
  const go = async (force) => {
    button.disabled = true;
    out.textContent = force ? 'Updating…' : 'Looking…';
    try {
      const r = await api('POST', '/api/update/check', { force });
      const say = {
        current: 'This is the newest version.',
        updating: 'Updating. The app restarts and this page reloads in a few seconds.',
        offline: 'GitHub is not reachable right now.',
        skipped: 'The newest version did not start last time, so the app stays on this one.',
        busy: 'A check is already running; try again in a moment.',
        'not-restarted': "The Pi's update script did not restart the app; see its update.log.",
        error: `It did not work: ${r.status?.error || 'see the log'}.`,
      }[r.outcome];
      if (r.outcome === 'waiting') {
        out.replaceChildren(`A new version (${r.status.available || r.status.waiting}) is there while Claude works. `,
          h('button', { class: 'link', type: 'button', onclick: async () => { try { await api('POST', '/api/update/lock', { on: true }); out.textContent = 'Locked: the app updates as soon as nothing runs.'; checkUpdate(); } catch (err) { out.textContent = err.message; } } }, 'Lock for update'),
          ' (waits for it) or ', h('button', { class: 'link', type: 'button', onclick: () => go(true) }, 'update now'), ' (cuts it off).');
        checkUpdate();
      } else out.textContent = say || r.outcome;
    } catch (err) { out.textContent = err.message; }
    button.disabled = false;
  };
  const button = h('button', { class: 'btn', type: 'button', onclick: () => go(false) }, 'Check for updates');
  return h('div', { class: 'update-row' }, button, out);
}

// Quick select: a row of choices over the reply box. 1 to 9 or a click picks one; the
// arrow keys move the highlight, and Enter, or Send once more, takes the highlighted one.
// Each row starts on its default, so every message starts from Default again. Escape goes
// back to writing. Nothing is sent until one is picked.
//
// Two rows use it. "How much?", the five tiers, where a message starts new work (Send,
// Start, a spin-off, a "Next"); never for "Done", which Claude does not answer, nor for a
// message added into the running turn. And "When?", while Claude works: "Add now"
// (Claude reads it at its next step) or "Next" (runs after the turn, with its own tier).
const asksTier = () => S.settings.tier === 'ask';
function askChoice({ label, aria, items, def, go }) {
  closeTierAsk();
  const pick = (key) => { closeTierAsk(); go(key); };
  const buttons = items.map((it, i) => h('button', {
    class: 'tier-ask-btn', type: 'button', title: it.about || '',
    onclick: () => pick(it.key),
  }, h('kbd', {}, String(i + 1)), it.label));
  const row = h('div', { class: 'tier-ask', role: 'group', 'aria-label': aria || label },
    h('span', { class: 'tier-ask-label' }, label),
    ...buttons,
    h('button', { class: 'tier-ask-x', type: 'button', title: 'Back to writing (Esc)', 'aria-label': 'Back to writing', onclick: closeTierAsk }, '×'));
  const ask = {
    row, items, buttons, pick, sel: Math.max(0, items.findIndex((it) => it.key === def)),
    move(by) { this.sel = (this.sel + by + items.length) % items.length; this.mark(); },
    mark() { buttons.forEach((b, i) => b.classList.toggle('is-last', i === this.sel)); },
    take() { this.pick(items[this.sel].key); },
    // One press of Send or Enter only opens the row. The Enter that opened it must be let
    // go before Enter can take a choice (a held key repeats), and a second Send within a
    // moment of the first is the same press bouncing, not his second click.
    openedAt: performance.now(),
    enterFree: !enterDown,
  };
  ask.mark();
  els.composer.prepend(row);
  tierAsk = ask;
  els.input.focus();
}
function askTier(go) {
  const names = S.settings.tierNames || [];
  askChoice({
    label: 'How much?', aria: 'How much is this worth?',
    items: names.map((n) => ({ key: n, label: S.settings.tiers?.[n]?.label || n, about: S.settings.tiers?.[n]?.about || '' })),
    def: names.includes('default') ? 'default' : names[Math.floor(names.length / 2)],
    go,
  });
}
function askWhen(go) {
  askChoice({
    label: 'When?', aria: 'When should Claude get this?',
    items: [
      { key: 'add', label: 'Add now', about: 'Claude reads it at its next step, in the work that is running.' },
      { key: 'next', label: 'Next', about: 'Runs after this turn, as a new command. The supervisor holds it if the reply asks you something first.' },
    ],
    def: 'add',
    go,
  });
}
function closeTierAsk() { tierAsk?.row.remove(); tierAsk = null; }
// Whether Enter is held down right now, so the row knows if the press that opened it is
// still going on.
let enterDown = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterDown = true; }, true);
document.addEventListener('keyup', (e) => {
  if (e.key !== 'Enter') return;
  enterDown = false;
  if (tierAsk) tierAsk.enterFree = true;
}, true);
window.addEventListener('blur', () => { enterDown = false; if (tierAsk) tierAsk.enterFree = true; });

// One button for both, always called "Done": with text it keeps the message and closes
// (Claude does not answer), with an empty box it just closes.
function renderDoneButton() {
  const t = S.current ? S.threads.get(S.current) : null;
  const empty = !els.input.value.trim() && !attachedNow().length;
  els.sendDone.textContent = 'Done';
  els.sendDone.disabled = empty && (!t || t.state !== 'ready');
  renderPicks();
}

// Defer changes a lot (the thread becomes a line in Next Actions.md and is deleted), so
// it asks once more, in place: the first click only arms it.
function disarmDefer() {
  armedDefer = '';
  clearTimeout(armedDeferTimer);
  els.defer.classList.remove('is-armed');
  els.defer.textContent = 'Defer';
}

async function deferThread() {
  const t = S.current && S.threads.get(S.current);
  if (!t || t.kind === 'card') return;
  if (t.state === 'working') { toast('Claude is still working on this. Defer it when the turn has ended.'); return; }
  if (armedDefer !== t.id) {
    armedDefer = t.id;
    els.defer.classList.add('is-armed');
    els.defer.textContent = 'Defer, sure?';
    clearTimeout(armedDeferTimer);
    armedDeferTimer = setTimeout(disarmDefer, 4000);
    return;
  }
  disarmDefer();
  try {
    draftPending.delete(t.id);
    const out = await api('POST', `/api/threads/${t.id}/defer`, { text: els.input.value.trim() });
    S.threads.set(t.id, out.thread);
    renderTree();
    els.input.value = '';
    autosize();
    forgetDraft(t.id);
    toast('Deferred. It sleeps under Next actions in Brain; the next brain update writes it into Next Actions.md.');
    advance(t.id);
  } catch (err) { toast(err.message); }
}

// ---------- files attached to the message being written ----------

const fileSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const attachKey = () => S.current || 'new';
const attachedNow = () => S.attach.get(attachKey()) || [];

function renderAttached() {
  const list = attachedNow();
  els.attached.hidden = !list.length;
  els.attached.replaceChildren(...list.map((f) => h('span', { class: `chip${f.id ? '' : f.error ? ' is-failed' : ' is-loading'}`, title: f.error || f.name },
    h('span', { class: 'chip-name' }, f.name),
    h('span', { class: 'chip-size' }, f.error ? 'failed' : f.id ? fileSize(f.size) : 'uploading…'),
    h('button', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { S.attach.set(attachKey(), attachedNow().filter((x) => x !== f)); renderAttached(); } }, '×'),
  )));
}

const asBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error('The file could not be read.'));
  reader.readAsDataURL(file);
});

// Each file is uploaded as soon as it is picked and waits for the message to be sent.
function addFiles(files) {
  const key = attachKey();
  for (const file of files) {
    const entry = { name: file.name || 'pasted file', size: file.size, id: '', error: '' };
    S.attach.set(key, [...(S.attach.get(key) || []), entry]);
    if (file.size > 25 * 1024 * 1024) { entry.error = 'Larger than 25 MB'; continue; }
    asBase64(file)
      .then((data) => api('POST', '/api/uploads', { name: entry.name, data }))
      .then((out) => { entry.id = out.id; entry.name = out.name; entry.size = out.size; })
      .catch((err) => { entry.error = err.message; toast(`${entry.name}: ${err.message}`); })
      .finally(() => { if (attachKey() === key) renderAttached(); });
  }
  renderAttached();
}

// What a message carries: the uploaded files' ids. Null while one is still on its way.
function filesToSend() {
  const list = attachedNow().filter((f) => !f.error);
  if (list.some((f) => !f.id)) { toast('A file is still uploading. One moment.'); return null; }
  return list.map((f) => f.id);
}

function renderEmpty() {
  const ready = inbox().length;
  const busy = working().length;
  let line = 'Nothing is waiting for you.';
  if (busy) line += ` Claude is working on ${busy} ${busy === 1 ? 'thread' : 'threads'}; the first one to finish opens here.`;
  els.messages.replaceChildren(h('div', { class: 'empty' },
    h('p', { class: 'empty-lead' }, S.newProject ? `Start a thread on ${S.newProject}. Claude begins with the project’s notes loaded.` : ready ? 'Start something new here, or pick a thread from the inbox.' : line),
    h('p', { class: 'empty-sub' }, 'Each thread is its own conversation. Claude reads your brain before answering, and nothing reaches the brain until you update it.'),
  ));
}

// ---------- what is typed and not sent ----------
//
// Nothing typed in the reply box is lost: every keystroke is kept on this device at
// once (localStorage, which survives closing the page or the browser), and sent to the
// app a moment later, which keeps it on disk and passes it to the other devices with
// the rest of its data. When the page starts, it takes whichever copy is newer.
// Sending, spinning off or deferring empties the draft everywhere.

const DRAFT_PREFIX = 'app-ai-draft:';
const draftKey = () => S.current || 'new';
const draftPending = new Map(); // key -> { text, at } not at the app yet
let draftTimer = 0;

function localDraft(key) {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_PREFIX + key) || 'null'); return d && typeof d.text === 'string' ? d : null; } catch { return null; }
}
function keepLocal(key, d) {
  try {
    if (d.text) localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(d));
    else localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ text: '', at: d.at })); // remembered as emptied, so an older copy elsewhere cannot win
  } catch { /* storage full or private mode: the app's copy still holds it */ }
}

// Sends what is waiting to the app. `leaving`: the page is going away, so the request
// has to outlive it.
function flushDrafts(leaving = false) {
  clearTimeout(draftTimer);
  for (const [key, d] of draftPending) {
    draftPending.delete(key);
    fetch(`/api/drafts/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d), keepalive: leaving })
      .catch(() => { if (!draftPending.has(key)) draftPending.set(key, d); }); // tried again with the next change, or when the page loads
  }
}

function setDraft(key, text, at = Date.now()) {
  const d = { text, at };
  if (text) S.drafts.set(key, text); else S.drafts.delete(key);
  keepLocal(key, d);
  draftPending.set(key, d);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => flushDrafts(), 800);
}

// The message went out (the app has already emptied its copy): forget it here too,
// including a change still waiting to be sent, which would otherwise bring it back.
function forgetDraft(key) {
  draftPending.delete(key);
  S.drafts.delete(key);
  keepLocal(key, { text: '', at: Date.now() });
}

// Which draft the box is showing. Saving goes there, never to whatever thread happens
// to be current: while the page starts or switches threads the box can be empty
// without anything having been deleted.
let shownDraft = null;

function saveDraft(typing = false) {
  if (S.pad || els.composer.hidden) return;
  if (typing) shownDraft = draftKey();
  const key = shownDraft;
  if (!key) return;
  if ((S.drafts.get(key) || '') !== els.input.value) setDraft(key, els.input.value);
}

function restoreDraft() {
  shownDraft = draftKey();
  els.input.value = S.drafts.get(shownDraft) || '';
  autosize();
  renderDoneButton();
}

// On start: the app's drafts and this device's, the newer of each. A copy of this
// device's that the app has not seen yet is sent along.
async function loadDrafts() {
  let remote = {};
  try { remote = (await api('GET', '/api/drafts')).drafts || {}; } catch { /* offline: this device's copies */ }
  const keys = new Set(Object.keys(remote));
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k?.startsWith(DRAFT_PREFIX)) keys.add(k.slice(DRAFT_PREFIX.length));
  }
  const month = 30 * 24 * 3600_000;
  for (const key of keys) {
    const here = localDraft(key);
    const there = remote[key];
    // A thread that no longer exists takes its draft with it.
    if (key !== 'new' && !S.threads.has(key)) { try { localStorage.removeItem(DRAFT_PREFIX + key); } catch { /* fine */ } continue; }
    if (here && !here.text && Date.now() - here.at > month) { try { localStorage.removeItem(DRAFT_PREFIX + key); } catch { /* fine */ } }
    const newer = !there || (here && here.at > there.at) ? here : there;
    if (!newer) continue;
    if (newer === here && (!there || here.at > there.at)) { draftPending.set(key, here); }
    else keepLocal(key, there);
    if (newer.text) S.drafts.set(key, newer.text); else S.drafts.delete(key);
  }
  if (draftPending.size) flushDrafts();
  // The box he is looking at: filled if it is empty; what he is typing right now wins.
  if (!S.pad && !els.input.value) restoreDraft();
}

// Leaving the page, hiding it (the phone locks, the app is switched away) or closing it:
// what is typed goes out now rather than in a moment.
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveDraft(); flushDrafts(true); } });
window.addEventListener('pagehide', () => { saveDraft(); flushDrafts(true); });

// ---------- an opportunity or chase card ----------

// A brief written as one block of prose is shown as a lead sentence and points, so it
// can be taken in at a glance. One that already has its own lines or list is left alone.
function briefMarkdown(text) {
  const t = text.trim();
  if (/\n\s*[-*\d]|\n\n/.test(t)) return t;
  const parts = t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) || [t];
  if (parts.length < 2) return t;
  return `**${parts[0]}**\n\n${parts.slice(1).map((x) => `- ${x}`).join('\n')}`;
}

async function renderCard(t) {
  const info = S.view.artifacts.find((a) => a.name === 'Message.md');
  const raw = await (await fetch(`/api/threads/${t.id}/artifact?name=Message.md`)).text();
  if (t.id !== S.current) return;
  const card = t.card || {};
  const decided = t.state !== 'ready';
  const work = card.channel === 'thread'; // a proposal: accepting starts a thread
  const head = h('div', { class: 'card-head' },
    h('p', { class: 'card-why' }, card.why || ''),
    work
      ? h('p', { class: 'card-to' }, 'Claude proposes to do this in a thread', t.project ? [' for ', h('strong', {}, t.project)] : null, '. The text is the brief; change it if you like.')
      : h('p', { class: 'card-to' }, card.channel === 'linkedin' ? 'LinkedIn note to ' : card.channel === 'mail' ? 'Mail to ' : 'Message to ', h('strong', {}, card.to || 'someone'),
        card.link ? [' (', h('a', { href: card.link, target: '_blank', rel: 'noopener noreferrer' }, 'open their page'), ')'] : null),
  );
  const decide = async (outcome) => {
    try {
      await flush();
      if (outcome === 'accepted' && !work) {
        await copyFilled(area.value).catch(() => {});
        if (card.link) window.open(card.link, '_blank', 'noopener');
      }
      const out = await api('POST', `/api/threads/${t.id}/card`, { outcome, reason: reason.value });
      S.threads.set(t.id, out.thread);
      if (out.started) S.threads.set(out.started.id, out.started);
      toast(outcome !== 'accepted' ? 'Declined.' : work ? 'Accepted. Claude has started on it.' : 'Accepted. The text is copied.');
      advance(t.id);
    } catch (err) { toast(err.message); }
  };

  // What he wants to say about the card, for either verdict: why not, or what it got wrong.
  const reason = h('textarea', { class: 'card-reason', rows: '1', maxlength: '1000', spellcheck: 'true',
    placeholder: phone.matches ? 'Optional: your reason' : 'Optional: your reason, or what is outdated here',
    title: 'Kept with your decision, and it reaches the brain with the next update',
    'aria-label': 'Your reason, optional', oninput: (e) => grow(e.target) });
  let area = null;
  let flush = async () => {};
  let bodyEl;
  if (parseMail(raw)) {
    bodyEl = mailCard(t.id, 'Message.md', raw, info, { onDecided: () => advance(t.id), reason: () => reason.value });
  } else {
    area = h('textarea', { class: `card-text${work ? ' is-brief' : ''}`, spellcheck: 'true', disabled: decided, 'aria-label': work ? 'The brief. Edit it here.' : 'The message. Edit it here.' });
    area.value = raw.trim();
    let dirty = false;
    // A save already on its way is waited for too, so a decision never overtakes it.
    let inflight = Promise.resolve();
    flush = async () => {
      await inflight.catch(() => {});
      if (!dirty) return;
      dirty = false;
      inflight = api('POST', `/api/threads/${t.id}/artifact/save`, { name: 'Message.md', content: `${area.value.trim()}\n` });
      await inflight;
    };
    const soon = debounce(() => flush().catch((e) => toast(e.message)), 700);
    area.addEventListener('input', () => { dirty = true; grow(area); soon(); });
    bodyEl = area;
    requestAnimationFrame(() => grow(area));
    keepGrown(area);
    if (work) {
      // A brief is read far more often than it is changed: show it formatted, and turn
      // it into the editable text on a click.
      const view = h('div', { class: 'brief', tabindex: decided ? null : '0', title: decided ? null : 'Click to edit' });
      const show = () => { view.replaceChildren(renderMarkdown(briefMarkdown(area.value))); };
      const edit = () => { if (decided) return; view.hidden = true; area.hidden = false; grow(area); area.focus(); };
      area.hidden = true;
      area.addEventListener('blur', () => { show(); area.hidden = true; view.hidden = false; });
      view.addEventListener('click', edit);
      view.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); edit(); } });
      show();
      bodyEl = h('div', {}, view, area);
    }
  }
  const buttons = decided ? h('p', { class: 'card-done' }, `You ${card.outcome || 'decided'} this${card.how ? ` (${card.how})` : ''}.${card.reason ? ` You wrote: “${card.reason}”` : ''}`)
    : h('div', { class: 'card-actions' },
      parseMail(raw) ? null : h('button', { class: 'btn btn-send', type: 'button', onclick: () => decide('accepted') }, work ? 'Accept and start ' : 'Accept and copy ', kbd('Y')),
      h('button', { class: 'btn', type: 'button', onclick: () => decide('declined') }, 'Decline ', kbd('N')),
      h('span', { class: 'card-hint' }, parseMail(raw) ? 'Putting it in Gmail or sending it accepts the card.' : phone.matches ? 'Edit the text first if you like. Swipe right to accept, left to decline.' : 'Edit the text first if you like. While typing: Ctrl+Enter accepts.'),
    );
  S.cardDecide = decided ? null : decide;
  S.cardIsMail = Boolean(parseMail(raw));
  els.messages.replaceChildren(h('div', { class: 'card' }, ...[head, bodyEl, decided ? null : reason, buttons].filter(Boolean)));
  enter(els.messages);
}

// ---------- opening things ----------

let openToken = 0;

async function openThread(id, { keepPanel = false, byQueue = false } = {}) {
  const meta = S.threads.get(id);
  if (!meta) return;
  saveDraft();
  closeTierAsk(); // a question about the message in the thread he is leaving
  if (phone.matches) setRail(false);
  if (!byQueue && meta.state === 'ready' && inbox()[0]?.id !== id) api('POST', '/api/queue/opened', { id }).catch(() => {});
  const token = ++openToken;
  S.pad = null;
  S.current = id;
  S.newProject = '';
  S.view = null;
  S.live = null;
  S.cardDecide = null;
  liveEl = null;
  if (!keepPanel && S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderTree();
  renderHead();
  renderComposer();
  restoreDraft();
  els.messages.replaceChildren();
  els.messages.className = 'messages quotable';
  if (meta.kind !== 'card') focusInput();
  else document.activeElement?.blur();
  let data;
  try {
    data = await api('GET', `/api/threads/${id}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (token !== openToken) return;
  S.threads.set(id, data.thread);
  S.view = { messages: data.messages, artifacts: data.artifacts };
  renderHead();
  if (data.thread.kind === 'card') { await renderCard(data.thread); return; }
  S.live = data.thread.state === 'working' ? (data.live || []) : null;
  els.messages.replaceChildren(...data.messages.map((m) => messageEl(id, m)));
  markGated(data.thread);
  enter(els.messages);
  placeLevel();
  renderQueued();
  if (S.live) renderLive();
  renderPicks();
  upgradeMailCards();
  // Start reading at Florian's last message, so he sees what he asked before Claude's answer;
  // without one (a thread the app started), at the start of Claude's latest message.
  const anchor = [...els.messages.querySelectorAll('.msg-you')].at(-1)
    || [...els.messages.querySelectorAll('.msg-claude')].at(-1);
  if (anchor && !S.live) els.scroller.scrollTop = Math.max(0, anchor.offsetTop - 24);
  else els.scroller.scrollTop = els.scroller.scrollHeight;
}

// After a lost connection (the app restarted, the phone woke up): the open thread is
// brought up to date where it stands. Opening it again would empty and refill the page,
// jump the scroll, pull the cursor out of whatever he was typing in, and close the quick
// select; here only what changed is drawn, and nothing at all when nothing did.
async function refreshThread() {
  const id = S.current;
  if (!id || S.pad) return;
  if (!S.view) { openThread(id, { keepPanel: true, byQueue: true }); return; } // it never loaded
  let data;
  try { data = await api('GET', `/api/threads/${id}`); } catch { return; }
  if (S.current !== id || !S.view) return;
  const was = S.view.messages;
  const same = was.length === data.messages.length && was.at(-1)?.id === data.messages.at(-1)?.id;
  S.threads.set(id, data.thread);
  S.view.artifacts = data.artifacts;
  if (data.thread.kind === 'card') return;
  const working = data.thread.state === 'working';
  if (!document.activeElement?.classList.contains('thread-title')) renderHead();
  renderComposer();
  if (same) {
    if (working) { S.live = data.live || []; scheduleLive(); } else if (S.live) { S.live = null; liveEl?.remove(); liveEl = null; }
    renderQueued();
    return;
  }
  const top = els.scroller.scrollTop;
  const stick = nearBottom();
  S.view.messages = data.messages;
  S.live = working ? (data.live || []) : null;
  liveEl = null;
  els.messages.replaceChildren(...data.messages.map((m) => messageEl(id, m)));
  markGated(data.thread);
  placeLevel();
  renderQueued();
  if (S.live) renderLive();
  renderPicks();
  upgradeMailCards();
  els.scroller.scrollTop = stick ? els.scroller.scrollHeight : top;
}

function openNew(project = '') {
  saveDraft();
  closeTierAsk();
  if (phone.matches) setRail(false);
  openToken += 1;
  S.pad = null;
  S.current = null;
  S.newProject = project;
  S.view = null;
  S.live = null;
  S.cardDecide = null;
  liveEl = null;
  if (S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderTree();
  renderHead();
  renderComposer();
  restoreDraft();
  els.messages.className = 'messages quotable';
  renderEmpty();
  enter(els.messages);
  focusInput();
}

// The scratchpad: a plain page to write in. It saves as you type. Claude never reads it.
// Switched off 15-11-2026 (Florian never used it: a thread closed with Done is a note
// too, and sorts better): no button, no Alt P. The code and the file stay.
function leavePad() {
  const back = S.lastThread && S.threads.has(S.lastThread) ? S.lastThread : inbox()[0]?.id;
  if (back) openThread(back, { byQueue: true });
  else openNew();
}

async function openPad() {
  if (S.pad) { leavePad(); return; }
  saveDraft();
  if (phone.matches) setRail(false);
  const token = ++openToken;
  S.lastThread = S.current;
  S.pad = 'scratchpad';
  S.current = null;
  S.view = null;
  S.live = null;
  S.cardDecide = null;
  if (S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderTree();
  renderComposer();
  const state = h('span', { class: 'status' });
  els.head.replaceChildren(h('h1', { class: 'thread-title is-static' }, 'Scratchpad'), state,
    h('div', { class: 'head-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', onclick: leavePad }, 'Back ', kbd('Alt P'))));
  els.messages.className = 'messages is-pad';
  els.messages.replaceChildren(h('p', { class: 'pad-about' }, 'Loading…'));
  let text = '';
  try {
    text = (await api('GET', '/api/pads/scratchpad')).text;
  } catch (err) { toast(err.message); }
  if (token !== openToken) return;
  const area = h('textarea', { class: 'pad', spellcheck: 'true', 'aria-label': 'Scratchpad' });
  area.value = text;
  const save = debounce(async () => {
    try {
      await api('PUT', '/api/pads/scratchpad', { text: area.value });
      state.textContent = `Saved ${clock(Date.now())}`;
    } catch (err) { state.textContent = 'Not saved'; toast(err.message); }
  }, 500);
  area.addEventListener('input', () => { state.textContent = ''; save(); });
  els.messages.replaceChildren(h('p', { class: 'pad-about' }, 'Yours alone. It saves as you type. Claude never reads it, in any thread or run.'), area);
  enter(els.messages);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// `done` is "send and done": the message is kept, the thread closes, Claude does not answer.
// `say` goes out in place of what the box holds (the Agree button).
async function send(done = false, tier = '', mode = '', say = '') {
  // Send once more while quick select asks: the highlighted choice.
  if (tierAsk && !done && !tier && !mode) {
    if (performance.now() - tierAsk.openedAt > 350) tierAsk.take();
    return;
  }
  const text = say || els.input.value.trim();
  if (S.pad || sending) return; // a second Enter while the first is on its way sends nothing twice
  const files = filesToSend();
  const answers = S.current ? answersToSend() : [];
  // "Done" with an empty box closes the thread. A Yes or No on a proposed line is recorded
  // already; a picked answer goes along and is kept for the brain update.
  if (done && files && !text && !files.length && !answers.some((a) => !a.confirm)) return markDone();
  if (!files || (!text && !files.length && !answers.length)) return;
  // Quick select: nothing goes until he has picked how much it is worth. Not for
  // "Done": Claude does not answer that, so there is nothing to pick. Not in a thread
  // that keeps a tier ("Again, higher") either.
  const t = S.current ? S.threads.get(S.current) : null;
  // While Claude works: into the running turn, or next. A message added into the running
  // turn belongs to that work and gets its tier; a "Next" is new work and may get its own.
  const running = t?.state === 'working' && !t.held;
  if (!done && running && !mode) return askWhen((m) => send(false, '', m, say));
  if (!done && running && mode === 'next' && !tier && !t?.keepTier && asksTier()) return askTier((n) => send(false, n, 'next', say));
  if (!done && !tier && !t?.keepTier && t?.state !== 'working' && asksTier()) return askTier((n) => send(false, n, '', say));
  closeTierAsk();
  const from = S.current;
  els.send.disabled = true;
  els.sendDone.disabled = true;
  sending = true;
  draftPending.delete(from || 'new'); // the text is going out; a delayed save of it must not follow
  try {
    if (from) {
      const out = await api('POST', `/api/threads/${from}/messages`, { text, files, done, answers, tier: done ? '' : tier, mode: mode || 'add' });
      S.threads.set(from, out.thread);
      dropPicks(from, answers);
      if (!done && running && !out.message) toast('Queued as Next: it runs when this turn ends.');
    } else {
      const out = await api('POST', '/api/threads', { text, files, done, tier: done ? '' : tier, project: S.newProject });
      S.threads.set(out.thread.id, out.thread);
      S.newProject = '';
    }
    // He may have moved to another thread while it was on its way (a slow line): then the
    // box holds that thread's text, which stays, and he stays where he is.
    const still = S.current === from;
    if (!say) {
      if (still) { els.input.value = ''; autosize(); }
      forgetDraft(from || 'new');
    }
    S.attach.delete(from || 'new');
    if (done) toast(from && S.threads.get(from)?.state === 'working' ? 'Kept. The thread closes when this turn ends; Claude does not answer it.' : 'Kept for the brain update. Done, with no answer.');
    // An event's thread is a session: it stays open while Claude answers.
    if (!still || (!done && from && S.threads.get(from)?.kind === 'event')) { renderRail(); return; }
    advance(from);
  } catch (err) {
    toast(err.message);
  } finally {
    sending = false;
    els.send.disabled = false;
    renderDoneButton();
  }
}

// "Send into spin-off": the message starts a new thread that begins as a copy of this
// one. Nothing is sent here; this thread goes to the back of the queue.
async function spinOff(tier = '') {
  const text = els.input.value.trim();
  const from = S.current;
  if (!from || S.pad) return;
  const files = filesToSend();
  if (!files) return;
  if (!text && !files.length) { toast('Write what the spin-off should do first.'); return; }
  // The spin-off starts a turn of its own, so quick select asks here too.
  if (!tier && asksTier()) return askTier((n) => spinOff(n));
  closeTierAsk();
  els.spin.disabled = true;
  draftPending.delete(from);
  try {
    const out = await api('POST', `/api/threads/${from}/spinoff`, { text, files, tier });
    S.threads.set(out.thread.id, out.thread);
    S.threads.set(out.from.id, out.from);
    const still = S.current === from;
    if (still) { els.input.value = ''; autosize(); }
    forgetDraft(from);
    S.attach.delete(from);
    toast(`Spun off: “${clip(out.thread.title, 48)}”`);
    if (still) advance(from); else renderRail();
  } catch (err) {
    toast(err.message);
  } finally {
    els.spin.disabled = false;
  }
}

function onThreadDeleted({ id }) {
  if (!S.threads.delete(id)) return;
  S.drafts.delete(id);
  S.picks.delete(id);
  draftPending.delete(id);
  try { localStorage.removeItem(DRAFT_PREFIX + id); localStorage.removeItem(PICKS_PREFIX + id); } catch { /* fine */ }
  if (S.lastThread === id) S.lastThread = null;
  if (S.current === id) {
    if (S.panel) closePanel();
    const next = inbox()[0];
    if (next) openThread(next.id, { byQueue: true });
    else openNew();
  } else {
    renderRail();
    renderTree();
    renderComposer();
  }
  if (S.brain) { S.brain.waiting = all().filter(isUnfiled).length; renderBrain(); }
}

async function requeue() {
  const t = S.current && S.threads.get(S.current);
  if (!t || t.state !== 'ready') return;
  if (!nextReady(t.id)) { toast('Nothing else is waiting.'); return; }
  try {
    const out = await api('POST', `/api/threads/${t.id}/skip`, {});
    S.threads.set(t.id, out.thread);
    advance(t.id);
  } catch (err) { toast(err.message); }
}

async function markDone() {
  const t = S.current && S.threads.get(S.current);
  if (!t || t.state !== 'ready' || t.kind === 'card') return;
  try {
    const out = await api('POST', `/api/threads/${t.id}/state`, { state: 'done' });
    S.threads.set(t.id, out.thread);
    advance(t.id);
  } catch (err) { toast(err.message); }
}

function step(direction) {
  const order = [...pinned(), ...inbox(), ...working(), ...(S.showDone ? done() : [])];
  if (!order.length) return;
  const i = order.findIndex((t) => t.id === S.current);
  const next = order[(i + direction + order.length) % order.length] || order[0];
  openThread(next.id);
}

// ---------- the side panel ----------

let panelTimer = 0;

function closePanel() {
  flushNotes();
  S.panel = null;
  els.app.classList.remove('has-panel');
  clearTimeout(panelTimer);
  // The panel slides shut first; its content goes once it is out of sight.
  panelTimer = setTimeout(() => {
    if (S.panel) return;
    els.panel.hidden = true;
    els.panel.replaceChildren();
  }, reducedMotion.matches ? 0 : 240);
}

function panelFrame(title, tools, body) {
  els.panel.replaceChildren(
    h('header', { class: 'panel-head' },
      h('h2', { class: 'panel-title', title }, title),
      h('div', { class: 'panel-tools' }, tools, h('button', { class: 'btn btn-quiet', type: 'button', onclick: closePanel }, 'Close ', kbd('Esc'))),
    ),
    body,
  );
  clearTimeout(panelTimer);
  const wasOpen = els.app.classList.contains('has-panel');
  els.panel.hidden = false;
  if (!wasOpen) void els.panel.offsetWidth;
  els.app.classList.add('has-panel');
  if (wasOpen) enter(els.panel.lastElementChild, 'swap');
}

const TEXT_TYPES = ['md', 'txt', 'csv', 'json', 'js', 'mjs', 'ts', 'py', 'css', 'sh', 'ps1', 'yml', 'yaml', 'xml', 'sql', 'tex'];
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

async function openPanel(panel) {
  flushNotes();
  if (phone.matches) setRail(false);
  S.panel = panel;
  if (panel.kind === 'artifact') return showArtifact(panel);
  if (panel.kind === 'note') return showNote(panel);
  if (panel.kind === 'run') return showRun(panel.run);
  if (panel.kind === 'repo') return showRepo(panel);
  if (panel.kind === 'notes') return panelFrame('Notes during the call', [], notesBox(panel.threadId, { alone: true }));
  return showFiles();
}

// Notes during an event (Florian, 23-11-2026): "give me a way to enter notes during the
// meeting, like a text field. the chat field is not really viable for that because it
// sends with enter." Under the file in the side panel of an event thread, or alone from
// the Notes button. Enter makes a new line; the text is saved as he types, with the
// thread, and the brain update reads it even if he never sends it.

function notesBox(threadId, { alone = false } = {}) {
  const t = S.threads.get(threadId);
  const state = h('span', { class: 'notes-state' }, t?.notes?.ts ? `saved ${stamp(t.notes.ts)}` : 'Enter makes a new line · saved as you type');
  const area = h('textarea', { class: 'notes-text', placeholder: 'Type during the call…', 'aria-label': 'Notes during the call', spellcheck: 'true' });
  area.value = notesDraft.get(threadId) ?? t?.notes?.text ?? '';
  let timer = 0;
  const save = async () => {
    clearTimeout(timer);
    if (!notesDraft.has(threadId)) return;
    const text = notesDraft.get(threadId);
    try {
      const out = await api('PUT', `/api/threads/${threadId}/notes`, { text });
      if (notesDraft.get(threadId) === text) notesDraft.delete(threadId);
      const meta = S.threads.get(threadId);
      if (meta && out.notes) S.threads.set(threadId, { ...meta, notes: out.notes });
      if (state.isConnected && !notesDraft.has(threadId)) state.textContent = out.notes?.ts ? `saved ${stamp(out.notes.ts)}` : 'saved';
    } catch (err) {
      if (state.isConnected) state.textContent = `not saved: ${err.message}`;
    }
  };
  flushNotes = save;
  area.addEventListener('input', () => {
    notesDraft.set(threadId, area.value);
    state.textContent = 'saving…';
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  });
  area.addEventListener('blur', save);
  const send = h('button', {
    class: 'btn', type: 'button', title: 'Send the notes as your message, and Claude starts the debrief',
    onclick: async () => {
      const text = area.value.trim();
      if (!text) { toast('No notes yet.'); return; }
      notesDraft.set(threadId, area.value);
      await save();
      try {
        await api('POST', `/api/threads/${threadId}/messages`, { text: `My notes from ${S.threads.get(threadId)?.title || 'the call'}, for the debrief:\n\n${text}` });
        toast('Sent to Claude.');
      } catch (err) { toast(err.message); }
    },
  }, 'Send to Claude for the debrief');
  return h('section', { class: `notes-box${alone ? ' is-alone' : ''}` },
    h('div', { class: 'notes-head' }, h('span', {}, 'Notes during the call'), state),
    area,
    h('div', { class: 'notes-acts' }, send));
}

function toggleFiles() {
  if (S.panel && (S.panel.kind === 'artifact' || S.panel.kind === 'files')) { closePanel(); return; }
  const files = S.view?.artifacts || [];
  if (!files.length) { toast('Claude has not made a file in this thread.'); return; }
  if (files.length === 1) openPanel({ kind: 'artifact', threadId: S.current, name: files[0].name });
  else openPanel({ kind: 'files' });
}

// ---------- the repo a thread works in ----------

function toggleRepo() {
  if (S.panel?.kind === 'repo') { closePanel(); renderHead(); return; }
  openPanel({ kind: 'repo', threadId: S.current });
  renderHead();
}

// A git diff, coloured by line.
function renderGitDiff(text) {
  const lines = text.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename (from|to))/.test(l));
  return h('pre', { class: 'git-diff' }, lines.map((l) => h('span', { class: l.startsWith('+') ? 'is-add' : l.startsWith('-') ? 'is-del' : l.startsWith('@@') ? 'is-hunk' : '' }, `${l}\n`)));
}

function armedButton(label, armedLabel, run) {
  const button = h('button', { class: 'btn', type: 'button' }, label);
  let armed = 0;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = armedLabel;
      button.classList.add('btn-danger');
      armed = setTimeout(() => { armed = 0; button.textContent = label; button.classList.remove('btn-danger'); }, 4000);
      return;
    }
    clearTimeout(armed);
    button.disabled = true;
    button.textContent = 'One moment…';
    try { await run(); } catch (err) { toast(err.message); button.disabled = false; button.textContent = label; button.classList.remove('btn-danger'); armed = 0; }
  });
  return button;
}

async function showRepo(panel) {
  const { threadId } = panel;
  const t = S.threads.get(threadId);
  if (!t) return closePanel();
  const body = h('div', { class: 'panel-body repo-panel' });
  const repoTitle = t.repo || 'No repo';
  if (!body.isConnected) panelFrame(repoTitle, [], body);

  // Which repo: change it here, or let Claude open one when you ask in the thread.
  const picker = h('input', { class: 'input repo-input', list: 'repo-list', placeholder: 'owner/name or just name', value: t.repo || '', spellcheck: 'false', 'aria-label': 'Repo' });
  const list = h('datalist', { id: 'repo-list' });
  api('GET', '/api/repos').then((r) => list.replaceChildren(...r.repos.map((n) => h('option', { value: n })))).catch(() => {});
  const change = async () => {
    const value = picker.value.trim();
    if (value === (t.repo || '')) return;
    try {
      const out = await api('POST', `/api/threads/${threadId}/repo`, { repo: value });
      S.threads.set(threadId, out.thread);
      renderHead();
      showRepo(panel);
    } catch (err) { toast(err.message); picker.value = t.repo || ''; }
  };
  picker.addEventListener('change', change);
  picker.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); picker.blur(); } });
  body.append(h('div', { class: 'repo-pick' }, h('label', { class: 'panel-note' }, 'Works in'), picker, list));

  if (!t.repo) {
    body.append(h('p', { class: 'panel-note' }, 'Pick a repo, or just tell Claude in the thread which one to work in.'));
    return;
  }
  let st;
  try { st = (await api('GET', `/api/threads/${threadId}/repo`)).status; } catch (err) {
    body.append(h('p', { class: 'panel-note is-error' }, err.message));
    return;
  }
  if (S.panel !== panel) return;
  const tools = [h('a', { class: 'btn btn-quiet', href: st.url, target: '_blank', rel: 'noopener' }, 'GitHub')];
  panelFrame(st.repo, tools, body);

  if (st.holder) body.append(h('p', { class: 'panel-note repo-busy' }, `${st.holderJob ? st.holder : `“${st.holder}”`} is working in this repo right now. This thread waits for it before Claude touches the repo.`));
  if (!st.cloned || !st.branch) {
    body.append(h('p', { class: 'panel-note' }, st.merged ? 'Merged into ' + st.main + '. The next change Claude makes starts a fresh branch.'
      : !st.cloned ? 'Not on the app’s machine yet. It is cloned the moment Claude opens it.'
        : 'Claude has not changed anything here yet. The first change starts a branch of its own for this thread.'));
    return;
  }

  body.append(h('p', { class: 'repo-branch' }, h('code', {}, st.branch), ` → ${st.main}`,
    h('span', { class: 'panel-note' }, ` · ${st.ahead} ${st.ahead === 1 ? 'commit' : 'commits'}${st.uncommitted ? ', plus changes not yet committed' : ''} · ${st.pushed ? 'pushed' : 'only here, not on GitHub'}`)));

  // The buttons: nothing leaves the machine without them.
  const busy = t.state === 'working' || Boolean(st.holder);
  const actions = h('div', { class: 'repo-actions' });
  if (busy) actions.append(h('p', { class: 'panel-note' }, 'Buttons come back when Claude’s turn ends.'));
  else if (st.ahead || st.uncommitted) {
    actions.append(
      h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        const btn = e.currentTarget; // gone from the event once it awaits
        btn.disabled = true;
        try { const out = await api('POST', `/api/threads/${threadId}/repo/push`, {}); toast('Pushed.'); window.open(out.compare, '_blank', 'noopener'); showRepo(panel); } catch (err) { toast(err.message); btn.disabled = false; }
      } }, st.pushed ? 'Open pull request' : 'Push and open pull request'),
      armedButton(`Merge into ${st.main}`, `Merge into ${st.main} and push`, async () => {
        await api('POST', `/api/threads/${threadId}/repo/merge`, {});
        toast(`Merged into ${st.main}.`);
        showRepo(panel);
      }),
    );
    if (!st.pushed && st.ahead) actions.append(h('button', { class: 'btn btn-quiet', type: 'button', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await api('POST', `/api/threads/${threadId}/repo/push`, {}); toast('Pushed the branch.'); showRepo(panel); } catch (err) { toast(err.message); btn.disabled = false; }
    } }, 'Only push'));
  }
  body.append(actions);

  if (st.commits.length) {
    body.append(h('h3', { class: 'repo-h' }, 'Commits'), h('ul', { class: 'repo-commits' }, st.commits.map((c) => {
      const [hash, ...rest] = c.split(' ');
      return h('li', {}, h('code', {}, hash), ' ', rest.join(' '));
    })));
  }
  if (st.files.length) {
    body.append(h('h3', { class: 'repo-h' }, `Changed files (${st.files.length})`));
    const word = { A: 'new', M: 'changed', D: 'deleted', R: 'moved' };
    for (const f of st.files) {
      const box = h('div', { class: 'repo-diff' });
      const row = h('details', { class: 'repo-file', ontoggle: async (e) => {
        if (!e.currentTarget.open || box.childElementCount) return;
        box.append(h('p', { class: 'panel-note' }, 'Loading…'));
        try {
          const text = await (await fetch(`/api/threads/${threadId}/repo/diff?file=${encodeURIComponent(f.name)}`)).text();
          box.replaceChildren(text.trim() ? renderGitDiff(text) : h('p', { class: 'panel-note' }, 'No text changes to show.'));
        } catch (err) { box.replaceChildren(h('p', { class: 'panel-note is-error' }, err.message)); }
      } },
      h('summary', {}, h('span', { class: `change change-${f.status}` }, word[f.status] || f.status), h('span', { class: 'repo-file-name' }, f.name)), box);
      body.append(row);
    }
  }
}

function showFiles() {
  const files = S.view?.artifacts || [];
  panelFrame('Files in this thread', [], h('div', { class: 'panel-body' },
    files.map((f) => artifactCard(S.current, { name: f.name, v: f.versions.at(-1).v })),
  ));
}

async function showArtifact(panel) {
  const { threadId, name } = panel;
  const info = (S.view?.artifacts || []).find((a) => a.name === name);
  const versions = info ? info.versions.map((x) => x.v) : [panel.v || 1];
  const latest = versions.at(-1);
  const v = panel.v && versions.includes(panel.v) ? panel.v : latest;
  panel.v = v;
  panel.followLatest = v === latest;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const url = `/api/threads/${threadId}/artifact?name=${encodeURIComponent(name)}&v=${v}`;
  const isText = TEXT_TYPES.includes(ext);
  const source = `(${name}${versions.length > 1 ? ` v${v}` : ''})`;
  const by = (n) => (info?.versions.find((x) => x.v === n)?.by === 'you' ? ', your edit' : '');

  const tools = [];
  if (versions.length > 1) {
    const select = h('select', { class: 'select', 'aria-label': 'Version', onchange: (e) => openPanel({ ...panel, v: Number(e.target.value), diff: panel.diff }) },
      versions.map((n) => h('option', { value: n, selected: n === v }, `Version ${n}${n === latest ? ', latest' : ''}${by(n)}`)));
    tools.push(select);
    if (isText && v > versions[0]) {
      tools.push(h('button', { class: `btn btn-quiet${panel.diff ? ' is-on' : ''}`, type: 'button', onclick: () => openPanel({ ...panel, diff: !panel.diff }) }, panel.diff ? 'Hide changes' : 'Show changes'));
    }
  }
  let text = null;
  if (isText) {
    tools.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: async () => { try { await copyFilled(text ?? ''); toast('Copied.'); } catch (err) { toast(err.message || 'Could not copy.'); } } }, 'Copy'));
  }
  if (S.config.local) tools.push(h('button', { class: 'btn btn-quiet', type: 'button', title: 'Open with the program your computer uses for this kind of file', onclick: () => api('POST', `/api/threads/${threadId}/artifact/open`, { name }).catch((e) => toast(e.message)) }, 'Open in app'));
  tools.push(h('a', { class: 'btn btn-quiet', href: `${url}&download=1` }, 'Download'));

  const body = h('div', { class: 'panel-body quotable', dataset: { quoteSource: source } });
  panelFrame(name, tools, body);
  if (S.threads.get(threadId)?.kind === 'event') els.panel.append(notesBox(threadId));

  try {
    if (isText) {
      text = await (await fetch(url)).text();
      if (S.panel !== panel) return;
      // A mail is shown without its header lines; they are on the card.
      const shown = (t) => (parseMail(t) ? `To: ${parseMail(t).to}\nSubject: ${parseMail(t).subject}\n\n${parseMail(t).body}` : t);
      if (panel.diff && v > versions[0]) {
        const prev = versions[versions.indexOf(v) - 1];
        const before = await (await fetch(`/api/threads/${threadId}/artifact?name=${encodeURIComponent(name)}&v=${prev}`)).text();
        if (S.panel !== panel) return;
        body.append(h('p', { class: 'diff-legend' }, `Changes from version ${prev} to version ${v}${by(v)}: `, h('ins', {}, 'added'), ' ', h('del', {}, 'removed')), renderDiff(shown(before), shown(text)));
      } else if (parseMail(text)) body.append(h('pre', { class: 'mail-plain' }, shown(text)));
      else if (ext === 'md' || ext === 'txt') body.append(renderMarkdown(text));
      else body.append(highlightPlain(text, name));
    } else if (ext === 'html' || ext === 'htm') {
      body.classList.add('is-frame');
      body.append(h('iframe', { class: 'frame', src: url, sandbox: 'allow-scripts allow-popups', title: name }));
    } else if (IMAGE_TYPES.includes(ext)) {
      body.append(h('img', { class: 'image', src: url, alt: name }));
    } else if (ext === 'pdf') {
      body.classList.add('is-frame');
      body.append(h('iframe', { class: 'frame', src: url, title: name }));
    } else {
      body.append(h('p', { class: 'panel-note' }, S.config.local ? 'This kind of file cannot be shown here. Use “Open in app”.' : 'This kind of file cannot be shown here. Download it to open it.'));
    }
  } catch (err) {
    body.append(h('p', { class: 'panel-note is-error' }, `The file could not be loaded: ${err.message}`));
  }
}

async function showNote(panel) {
  const body = h('div', { class: 'panel-body quotable' });
  panelFrame(panel.link, [], body);
  try {
    const note = await api('GET', `/api/vault?link=${encodeURIComponent(panel.link)}`);
    if (S.panel !== panel) return;
    panelFrame(note.path, [], body);
    body.dataset.quoteSource = `(${note.path})`;
    if (note.binary) body.append(h('p', { class: 'panel-note' }, 'This vault file is not text.'));
    else if (note.path.endsWith('.md')) body.append(renderMarkdown(note.text.replace(/^---\n[\s\S]*?\n---\n/, '')));
    else body.append(highlightPlain(note.text, note.path));
  } catch (err) {
    body.append(h('p', { class: 'panel-note is-error' }, err.message));
  }
}

function showRun(run) {
  const body = h('div', { class: 'panel-body' });
  const change = { A: 'new', M: 'changed', D: 'deleted', R: 'moved' };
  if (run.status === 'held') {
    body.append(h('p', { class: 'panel-note' }, run.error),
      h('p', { class: 'panel-note' }, 'Nothing counts as filed yet. You can also press Update brain yourself once the limit has lifted.'));
  } else if (run.status === 'failed') {
    body.append(h('p', { class: 'panel-note is-error' }, `This update failed and wrote nothing: ${run.error}`),
      h('p', { class: 'panel-note' }, run.threadId ? 'Nothing counts as filed. Say “retry” in its thread, or ask Claude there to look into it.' : 'Nothing counts as filed. Update the brain again when the cause is fixed.'));
    if (run.threadId && S.threads.has(run.threadId)) body.append(h('button', { class: 'btn btn-brain', type: 'button', onclick: () => openThread(run.threadId, { keepPanel: true }) }, 'Open its thread'));
  } else {
    const took = [];
    if (run.threads.length) took.push(`${run.threads.length} ${run.threads.length === 1 ? 'thread' : 'threads'} (${run.threads.join(', ')})`);
    if (run.notes) took.push('your notes for Claude');
    if (run.cardCount) took.push(`${run.cardCount} ${run.cardCount === 1 ? 'card' : 'cards'} you decided`);
    if (run.mailCount) took.push(`${run.mailCount} mail ${run.mailCount === 1 ? 'conversation' : 'conversations'}`);
    body.append(h('p', { class: 'panel-note' }, took.length ? `Read: ${took.join('; ')}.` : 'There was nothing new to read.'));
    if (run.mailError) body.append(h('p', { class: 'panel-note is-error' }, `Mail could not be read, so it waits for the next update: ${run.mailError}`));
    if (run.status === 'nothing') body.append(h('p', { class: 'panel-note' }, 'Nothing in it needed filing.'));
    if (run.commit) {
      body.append(h('p', { class: `panel-note${run.pushed ? '' : ' is-error'}` },
        run.pushed ? `Committed and pushed as ${run.commit}: “${run.subject}”.`
          : `Committed as ${run.commit}, but the push failed (${run.pushError}). The app pushes it the next time it reaches GitHub.`));
    }
    if (run.changes?.length) {
      body.append(h('ul', { class: 'changes' }, run.changes.map((c) => h('li', {},
        h('span', { class: `change change-${c.change[0]}` }, change[c.change[0]] || c.change),
        h('a', { class: 'wikilink', href: '#', dataset: { wiki: c.path } }, c.path)))));
    }
    if (run.written) body.append(renderMarkdown(run.written));
    const own = run.threadId || run.questionsThread;
    if (own && S.threads.has(own)) {
      body.append(h('button', { class: 'btn btn-brain', type: 'button', onclick: () => openThread(own, { keepPanel: true }) }, run.hasQuestions ? 'Open Claude’s questions' : 'Open its thread'));
    }
    if (run.replyThreads?.length) body.append(h('p', { class: 'panel-note' }, `${run.replyThreads.length} ${run.replyThreads.length === 1 ? 'mail needs' : 'mails need'} an answer. Claude is drafting; ${run.replyThreads.length === 1 ? 'it appears' : 'they appear'} in the queue.`));
    if (run.restored?.length) body.append(h('p', { class: 'panel-note' }, `Left untouched on purpose: ${run.restored.join(', ')}.`));
    if (run.redacted?.length) body.append(h('p', { class: 'panel-note' }, `A secret value was in ${run.redacted.join(', ')}; it went in as its placeholder, not as the value.`));
  }
  panelFrame(`Brain update, ${stamp(run.finishedAt)}`, [], body);
}

// ---------- the settings window ----------

let settingsToken = 0;

function openSettings(tab = S.settingsTab) {
  S.settingsTab = tab;
  if (phone.matches) setRail(false);
  for (const b of els.settings.querySelectorAll('.window-tab')) b.classList.toggle('is-on', b.dataset.tab === tab);
  if (!els.settings.open) els.settings.showModal();
  const token = ++settingsToken;
  els.settingsBody.replaceChildren();
  els.settingsBody.scrollTop = 0;
  if (tab === 'general') return fillGeneral(els.settingsBody);
  if (tab === 'queue') return fillQueue(els.settingsBody, token);
  if (tab === 'keys') return fillKeys(els.settingsBody);
  if (tab === 'stats') return fillStats(els.settingsBody, token);
  if (tab === 'layout') return fillLayout(els.settingsBody);
  if (tab === 'system') return fillSystem(els.settingsBody, token);
  return fillConnections(els.settingsBody, token);
}

// General: how the app looks on this device, and when it sends you to sleep.
function fillGeneral(body) {
  body.append(...lookFields(), ...sleepFields());
}

for (const b of els.settings.querySelectorAll('.window-tab')) b.addEventListener('click', () => openSettings(b.dataset.tab));
els.settingsClose.addEventListener('click', () => els.settings.close());
els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
els.openSettings.addEventListener('click', () => openSettings());

// Stats: what happened, by week. Counted from what the app and the vault already keep.
// The app keeps the last count and hands it over at once; while a newer one runs, the
// table shows the kept one with its time and is filled in again when the count is done.
// The very first time there is nothing kept, so grey bars in the table's shape stand in.
const STATS_SHAPE = [['Threads', 2], ['Mail', 2], ['Opportunities', 2], ['Brain', 5], ['Code', 1], ['Claude', 1]];
function statsPlaceholder() {
  const bar = () => h('td', {}, h('span', { class: 'stats-bar' }));
  return h('table', { class: 'stats is-loading', 'aria-busy': 'true', 'aria-label': 'Counting' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), ...['This week', 'Last week', 'Last 4 weeks', 'All time'].map((l) => h('th', {}, l)))),
    ...STATS_SHAPE.map(([g, n]) => h('tbody', {},
      h('tr', { class: 'stats-group' }, h('th', { colspan: '5' }, g)),
      ...Array.from({ length: n }, () => h('tr', {}, h('td', { class: 'stats-label' }, h('span', { class: 'stats-bar is-wide' })), bar(), bar(), bar(), bar())))));
}

async function fillStats(body, token) {
  body.replaceChildren(h('h3', { class: 'window-head' }, 'Stats'), statsPlaceholder());
  let s;
  try { s = await api('GET', '/api/stats'); } catch (err) { body.replaceChildren(h('h3', { class: 'window-head' }, 'Stats'), h('p', { class: 'panel-note is-error' }, err.message)); return; }
  if (token !== settingsToken) return;
  showStats(body, s);
  // A newer count is running: the kept one is on screen, the new one replaces it when it is in.
  if (!s.refreshing) return;
  try { s = await api('GET', '/api/stats?wait=1'); } catch { return; }
  if (token === settingsToken) showStats(body, s);
}

function showStats(body, s) {
  const groups = [...new Set(s.rows.map((r) => r.group))];
  const cell = (v) => h('td', { class: v ? '' : 'is-zero' }, String(v));
  body.replaceChildren(
    h('h3', { class: 'window-head' }, 'Stats ', h('span', { class: 'status' }, `as of ${clock(s.asOf)}${s.refreshing ? ' · counting again…' : ''}`)),
    h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), ...s.periods.map((p) => h('th', {}, p.label)))),
      ...groups.map((g) => h('tbody', {},
        h('tr', { class: 'stats-group' }, h('th', { colspan: String(s.periods.length + 1) }, g)),
        ...s.rows.filter((r) => r.group === g).map((r) => h('tr', {}, h('td', { class: 'stats-label' }, r.label), ...s.periods.map((p) => cell(r.values[p.key])))))),
      h('tbody', {},
        h('tr', { class: 'stats-group' }, h('th', { colspan: String(s.periods.length + 1) }, 'Claude')),
        h('tr', {}, h('td', { class: 'stats-label' }, 'Cost (API prices)'), ...s.periods.map((p) => h('td', {}, `$${s.cost[p.key].toFixed(2)}`))))),
    h('p', { class: 'panel-note' }, `Weeks start on Monday. "All time" goes back to ${new Date(s.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}. Projects started and closed, people and areas come from the vault's history (a project note removed is a project closed); merges from the repos this app works in; the rest from the app's own records.`));
}

// ---------- daily reports ----------
//
// Florian, 24-11-2026: a button beside the laptop's, to look through what he did each day:
// the days on the left, the report on the right. Results first, thinking last and faint;
// a line opens the thread, mail or note it rests on. Written by the app in the evening
// (server/days.js); "so far" writes it now.

const reportsWin = $('reports');
const reportsBody = $('reports-body');
const reportsDays = $('reports-days');
const REPORT_SEEN = 'app-ai-report-seen';
let reportsNow = null; // what the app says: the days, and what is being written
let reportDay = '';
let reportShown = null; // { day, report } on screen
let reportToken = 0;
const reportDrafts = new Map(); // day -> text typed into "What's missing?" and not added
const REPORT_LEVELS = {
  result: ['Results', 'something changed'],
  out: ['Put out', 'sent or said, still open'],
  made: ['Made', ''],
  thought: ['Decided and thought', ''],
};
const reportDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const dmy = (day) => day.split('-').reverse().join('-');
function reportName(day) {
  if (day === reportsNow?.today) return 'Today';
  const d = reportDate(day);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${dmy(day).slice(0, 5)}`;
}

// The dot on the button: a report he has not opened yet.
function markReports() {
  const latest = Math.max(0, ...(reportsNow?.days || []).filter((d) => d.lines).map((d) => d.madeAt));
  let seen = 0;
  try { seen = Number(localStorage.getItem(REPORT_SEEN)) || 0; } catch { /* private mode */ }
  if (reportsWin.open && latest > seen) { try { localStorage.setItem(REPORT_SEEN, String(latest)); } catch { /* fine */ } seen = latest; }
  $('reports-new').hidden = !(latest > seen);
}

async function loadReports() {
  try { reportsNow = await api('GET', '/api/reports'); markReports(); } catch { /* the page says so itself */ }
}

function onReports(st) {
  const entry = (list, day) => list?.days?.find((d) => d.day === day);
  const before = entry(reportsNow, reportDay);
  reportsNow = st;
  markReports();
  if (!reportsWin.open) return;
  drawReportDays();
  const now = entry(st, reportDay);
  if (now?.madeAt !== before?.madeAt || now?.lines !== before?.lines) showReport(reportDay);
  else drawReport();
}

async function openReports(day = '') {
  if (phone.matches) setRail(false);
  if (!reportsWin.open) reportsWin.showModal();
  if (!reportsNow) reportsBody.replaceChildren(h('p', { class: 'panel-note' }, 'Loading…'));
  await loadReports();
  // Today once it is written, otherwise the last day that is.
  showReport(day || reportsNow?.days.find((d) => d.lines)?.day || reportsNow?.today || '');
}

function drawReportDays() {
  if (!reportsNow) return;
  reportsDays.replaceChildren(h('h2', { class: 'window-title' }, 'Reports'),
    ...reportsNow.days.map((d) => h('button', { class: `window-tab reports-day${d.day === reportDay ? ' is-on' : ''}${d.lines ? '' : ' is-none'}`, type: 'button', title: d.headline || '', onclick: () => showReport(d.day) }, reportName(d.day))));
  reportsDays.querySelector('.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function showReport(day) {
  if (!day) return;
  const token = ++reportToken;
  const moved = reportDay !== day;
  reportDay = day;
  drawReportDays();
  if (moved) { reportShown = null; reportsBody.replaceChildren(h('p', { class: 'panel-note' }, 'Loading…')); }
  let report = null;
  try { report = (await api('GET', `/api/reports/${day}`)).report; } catch (err) { if (token === reportToken) reportsBody.replaceChildren(h('p', { class: 'panel-note is-error' }, err.message)); return; }
  if (token !== reportToken) return;
  reportShown = { day, report };
  drawReport();
  if (moved) reportsBody.scrollTop = 0;
}

async function writeReportNow(day) {
  try { onReports(await api('POST', `/api/reports/${day}/make`, {})); } catch (err) { toast(err.message); }
}

// Where a line comes from: the thread, the mail or the note.
function reportSource(s) {
  const label = clip(s.title || s.name || 'Source', 46);
  if (s.kind === 'mail') return h('a', { class: 'report-src', href: s.href, target: '_blank', rel: 'noopener', title: `The mail “${s.title}” in Gmail` }, label);
  if (s.kind === 'note') return h('button', { class: 'report-src', type: 'button', title: 'Open the note', onclick: () => { reportsWin.close(); openPanel({ kind: 'note', link: s.name }); } }, label);
  const there = S.threads.has(s.id);
  return h('button', { class: 'report-src', type: 'button', disabled: !there, title: there ? 'Open the thread' : 'The thread is no longer in the app', onclick: () => { reportsWin.close(); openThread(s.id); } }, label);
}

function drawReport() {
  if (!reportShown || reportShown.day !== reportDay) return;
  const { day, report } = reportShown;
  const entry = reportsNow?.days.find((d) => d.day === day);
  const busy = reportsNow?.running === day || Boolean(reportsNow?.pending?.includes(day));
  const today = day === reportsNow?.today;
  const title = `${reportDate(day).toLocaleDateString('en-GB', { weekday: 'long' })}, ${dmy(day)}`;
  const items = report?.items || [];
  const write = h('button', { class: 'btn btn-quiet', type: 'button', disabled: busy, onclick: () => writeReportNow(day) },
    busy ? 'Writing…' : items.length ? 'Write again' : today ? 'Write it so far' : 'Write this day');
  const when = busy ? 'being written, takes about three minutes' : items.length ? `written ${stamp(report.madeAt)}` : '';
  const idle = report?.madeAt ? 'Nothing recorded for this day.'
    : today && reportsNow?.at ? `Written at ${reportsNow.at}.` : 'No report for this day yet.';
  const old = reportsBody.querySelector('.report-missing');
  const focused = old && document.activeElement === old ? [old.selectionStart, old.selectionEnd] : null;
  const field = h('textarea', { class: 'report-missing', rows: '2', placeholder: 'A call, a meeting, a message the app cannot see…', 'aria-label': 'What is missing in this report', oninput: () => reportDrafts.set(day, field.value) });
  field.value = reportDrafts.get(day) || '';
  const addIt = async () => {
    const text = field.value.trim();
    if (!text) return;
    try {
      const st = await api('POST', `/api/reports/${day}/add`, { text });
      reportDrafts.delete(day);
      reportsNow = st;
      await showReport(day);
    } catch (err) { toast(err.message); }
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); addIt(); }
  });
  const at = reportsBody.scrollTop;
  reportsBody.replaceChildren(...[
    h('h3', { class: 'window-head' }, title),
    h('p', { class: 'report-when' }, h('span', { class: 'status' }, when || idle), write),
    entry?.error && !busy ? h('p', { class: 'panel-note is-error' }, `The last try failed: ${entry.error}`) : null,
    report?.headline ? h('p', { class: 'report-line' }, report.headline) : null,
    ...Object.entries(REPORT_LEVELS).map(([key, [name, about]]) => {
      const list = items.filter((i) => i.level === key);
      if (!list.length) return null;
      return h('section', { class: `report-level is-${key}` },
        h('h4', {}, name, about ? h('span', {}, about) : null),
        h('ol', {}, list.map((i) => h('li', {},
          h('p', {}, i.area ? h('strong', {}, i.area) : null, i.area ? ' · ' : null, i.text),
          i.sources?.length ? h('div', { class: 'report-srcs' }, i.sources.map(reportSource)) : null))));
    }),
    report?.split?.length ? h('p', { class: 'report-split' }, `Where your ${plural(report.messages, 'message', 'messages')} went: ${report.split.map((s) => `${s.area} ${s.n}`).join(' · ')}`) : null,
    h('div', { class: 'report-add' },
      h('h4', {}, 'What’s missing?'),
      report?.added?.length ? h('ul', {}, report.added.map((a) => h('li', {}, a.text))) : null,
      field,
      h('div', { class: 'report-add-foot' }, h('span', { class: 'panel-note' }, 'Goes into the report, and to the next brain update as your words.'), h('button', { class: 'btn btn-brain', type: 'button', onclick: addIt }, 'Add'))),
  ].filter(Boolean));
  reportsBody.scrollTop = at;
  if (focused) { field.focus(); field.setSelectionRange(...focused); }
}

$('open-reports').addEventListener('click', () => openReports());
$('reports-close').addEventListener('click', () => reportsWin.close());
reportsWin.addEventListener('click', (e) => { if (e.target === reportsWin) reportsWin.close(); });
// Arrow keys page through the days: left is the day before.
reportsWin.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('textarea')) return;
  const list = reportsNow?.days || [];
  const next = list[list.findIndex((d) => d.day === reportDay) + (e.key === 'ArrowLeft' ? 1 : -1)];
  if (next) { e.preventDefault(); showReport(next.day); }
});

// Connections and System both read /api/connections and show it as blocks.
async function loadConnections(body, token, title) {
  body.append(h('h3', { class: 'window-head' }, title));
  let c;
  try {
    c = await api('GET', '/api/connections');
  } catch (err) {
    body.append(h('p', { class: 'panel-note is-error' }, err.message));
    return null;
  }
  if (token !== settingsToken) return null;
  S.connections = c;
  return c;
}
const connBlock = (title, state, ...rest) => h('section', { class: 'conn-block' },
  h('h3', { class: 'conn-title' }, title, h('span', { class: `conn-state${state.on ? ' is-on' : ''}${state.bad ? ' is-error' : ''}` }, state.text)), ...rest);
const connNote = (text) => h('p', { class: 'panel-note' }, text);

// What the app is linked to: Google, a phone number, the data repo.
async function fillConnections(body, token) {
  const c = await loadConnections(body, token, 'Connections');
  if (!c) return;
  const block = connBlock;
  const note = connNote;

  const g = c.google;
  if (g.connected) {
    body.append(block('Gmail and Calendar', { on: true, text: 'connected' },
      note(`Signed in${g.email ? ` as ${g.email}` : ''}. Threads can search and read your mail, read your calendar and add entries. Only the buttons on a mail put it into Gmail or send it, and only when you press them.`),
      g.canArchive ? null : h('p', { class: 'panel-note is-error' }, 'Connect again to let Send archive a reply’s conversation in Gmail: press “Connect Google again” and allow all permissions.'),
      g.canArchive ? null : h('a', { class: 'btn btn-brain', href: '/auth/google' }, 'Connect Google again'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await api('POST', '/api/google/disconnect', {}); toast('Disconnected.'); openSettings('connections'); } }, 'Disconnect')));
  } else if (g.configured) {
    body.append(block('Gmail and Calendar', { text: 'not connected' },
      note('Sign in with Google once. Threads can then read your mail and calendar, "Update Gmail" takes in new mail, and the buttons on a mail work.'),
      h('a', { class: 'btn btn-brain', href: '/auth/google' }, 'Connect Google')));
  } else {
    body.append(block('Gmail and Calendar', { text: 'not set up' },
      note('This needs a Google client id and secret in config.json first. The steps are in docs/google.md in the app’s folder; they take about ten minutes, once.')));
  }

  const v = c.voice;
  body.append(block('Calling by phone', v.ready ? { on: true, text: 'ready' } : { text: v.enabled ? 'incomplete' : 'off' },
    note(v.ready ? 'Call your Twilio number from one of your allowed phones.'
      : v.enabled ? `Switched on, but config.json still lacks: ${v.missing.join(', ')}. See docs/calling.md.`
        : 'Off. The Talk page does the same from your phone’s browser, for free. A real phone number needs Twilio: docs/calling.md.')));
}

// System: the app itself running, not you: its version and updates, its backup to GitHub,
// and where it runs.
async function fillSystem(body, token) {
  const c = await loadConnections(body, token, 'System');
  if (!c) return;
  const block = connBlock;
  const note = connNote;

  if (c.app?.commit) {
    const when = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    body.append(block('Version and updates', { text: `${c.app.commit}${c.app.date ? ` · ${when(Date.parse(c.app.date))}` : ''}` },
      note(`${c.app.subject}.${c.app.startedAt ? ` Running since ${when(c.app.startedAt)}.` : ''}${c.app.update?.enabled ? ` Updates itself from GitHub every ten minutes${c.app.update.waiting ? `; a new version is waiting until Claude has finished` : ''}.` : ''}`),
      c.app.update?.enabled ? updateButton() : null));
  }

  const d = c.data;
  body.append(block('Backup to GitHub', d.error ? { bad: true, text: 'not saving' } : d.enabled ? { on: true, text: d.lastPush ? `saved ${stamp(d.lastPush)}` : 'on' } : { text: 'off' },
    note(d.error || (d.enabled
      ? `Threads, water levels, the scratchpad and what the queue has learned are committed and pushed to ${d.repo} every few minutes. Secrets and the brain clone are left out.`
      : 'The state stays on this computer only. Set dataRepo in config.json to save it to GitHub.'))));

  const r = c.remote;
  body.append(block('Where the app runs', { on: true, text: r.local ? 'this computer' : 'another computer' },
    note(r.local
      ? (r.allowedHosts.length ? `Also reachable as ${r.allowedHosts.join(', ')}.` : 'Only this computer can reach it. To reach it from your phone or run it on a Raspberry Pi, see docs/pi.md.')
      : `You are reaching it at ${location.host}.`)));
}

// Light or dark, chosen per device (a phone at night, a laptop in daylight).
function applyLook(pick) {
  try { if (pick) localStorage.setItem('app-ai-look', pick); else localStorage.removeItem('app-ai-look'); } catch { /* private mode */ }
  const light = pick ? pick === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f3ebdc' : '#1b1d2a');
}
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { let pick = ''; try { pick = localStorage.getItem('app-ai-look') || ''; } catch { /* fine */ } if (!pick) applyLook(''); });
applyLook((() => { try { return localStorage.getItem('app-ai-look') || ''; } catch { return ''; } })());

function lookFields() {
  let now = '';
  try { now = localStorage.getItem('app-ai-look') || ''; } catch { /* fine */ }
  const option = (value, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'look', checked: now === value, onchange: () => applyLook(value) }), ` ${label}`);
  return [
    h('h3', { class: 'window-head' }, 'Look'),
    h('p', { class: 'panel-note' }, 'Dark, or light on beige paper. Chosen on each device by itself.'),
    h('div', { class: 'sleep-fields' }, option('dark', 'Dark'), option('light', 'Light'), option('', 'Like this device')),
    h('p', { class: 'panel-note' }, 'The colour of what is yours (what waits for you, Send, your move), and the size of the text in a thread. These two are the same on every device.'),
    h('div', { class: 'sleep-fields look-accents' }, ACCENTS.map(([value, label]) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'accent', checked: (S.settings.look?.accent || '') === value, onchange: () => saveSetting({ look: { ...S.settings.look, accent: value } }) }),
      h('span', { class: 'swatch', dataset: { accent: value }, 'aria-hidden': 'true' }), label))),
    h('div', { class: 'sleep-fields' }, 'Text ', SIZES.map(([value, label]) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'size', checked: (S.settings.look?.size || '') === value, onchange: () => saveSetting({ look: { ...S.settings.look, size: value } }) }), ` ${label}`))),
  ];
}

function sleepFields() {
  const sl = S.settings.sleep || { on: true, from: '00:00', to: '08:00' };
  const save = (patch) => {
    S.settings = { ...S.settings, sleep: { ...sl, ...patch } };
    api('PUT', '/api/settings', { sleep: patch }).catch((e) => toast(e.message));
    checkSleep();
  };
  const time = (key) => h('input', { class: 'sleep-time', type: 'time', value: sl[key], 'aria-label': key === 'from' ? 'Sleep from' : 'Sleep until', onchange: (e) => { if (e.target.value) save({ [key]: e.target.value }); } });
  const on = h('input', { type: 'checkbox', checked: sl.on, onchange: (e) => save({ on: e.target.checked }) });
  return [
    h('h3', { class: 'window-head' }, 'Sleep time'),
    h('p', { class: 'panel-note' }, 'In this time the app shows a go-to-sleep screen instead of the queue. You can get past it, but it comes back every time you open the app again.'),
    h('div', { class: 'sleep-fields' }, h('label', { class: 'check' }, on, ' On'), ' from ', time('from'), ' to ', time('to')),
  ];
}

async function fillQueue(body, token) {
  const state = h('span', { class: 'status' });
  body.append(h('h3', { class: 'window-head' }, 'What the queue has learned ', state),
    h('p', { class: 'panel-note' }, 'The queue reads this every time it orders what is waiting. It is rewritten from your choices now and then: what you answer, put off, close, drag, accept and decline, and the reasons you give. Correct it or add your own lines, and they are kept.'));
  let text = '';
  try { text = (await api('GET', '/api/pads/profile')).text; } catch (err) { toast(err.message); }
  if (token !== settingsToken) return;
  const area = h('textarea', { class: 'pad', spellcheck: 'true', 'aria-label': 'What the queue has learned', placeholder: 'Nothing learned yet. It appears after your first thirty choices; you can also write your own lines here.' });
  area.value = text;
  const save = debounce(async () => {
    try { await api('PUT', '/api/pads/profile', { text: area.value }); state.textContent = `Saved ${clock(Date.now())}`; }
    catch (err) { state.textContent = 'Not saved'; toast(err.message); }
  }, 500);
  area.addEventListener('input', () => { state.textContent = ''; save(); });
  body.append(area);
}

// Layout: which parts of the page are there. Each change shows at once, behind this window.
function fillLayout(body) {
  const hidden = hiddenParts();
  const groups = [...new Set(PARTS.map((p) => p.group))];
  body.append(
    h('h3', { class: 'window-head' }, 'Layout'),
    h('p', { class: 'panel-note' }, 'Switch off what you do not use. It changes on the laptop, the Pi and your phone alike, and the keys keep working.'),
    h('div', { class: 'layout-btns' },
      h('button', { class: 'btn btn-brain', type: 'button', onclick: () => { els.settings.close(); startArranging(); } }, 'Pick on the page'),
      hidden.size ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: async () => {
        S.settings = { ...S.settings, hidden: [] }; applyParts(); renderRail(); renderTree();
        try { await api('PUT', '/api/settings', { hidden: [] }); } catch (err) { toast(err.message); }
        openSettings('layout');
      } }, `Show all ${hidden.size} again`) : null),
    h('div', { class: 'layout' }, ...groups.map((g) => h('section', { class: 'layout-group' },
      h('h4', { class: 'layout-head' }, g),
      ...PARTS.filter((p) => p.group === g).map((p) => h('label', { class: 'check layout-row' },
        h('input', { type: 'checkbox', checked: !hidden.has(p.key), onchange: (e) => setPart(p.key, e.target.checked) }), ` ${p.label}`))))),
    h('p', { class: 'panel-note' }, 'The right bar is only there on a wide window; on a narrower one, and on the phone, the same lists are under Brain in the inbox drawer.'),
    ...orderFields(), ...replyFields());
}

// "Pick on the page": everything that can go is outlined; a click hides it, or brings a
// faded one back. Nothing else reacts to clicks until Done (or Escape).
let arrangeWasPinned = false;
const arrangeBar = h('div', { class: 'arrange-bar', role: 'dialog', 'aria-label': 'Pick what to hide', hidden: true });
document.body.append(arrangeBar);
const arrangeCss = h('style', {});
document.head.append(arrangeCss);
function partAt(el) {
  for (let x = el; x && x !== document.body; x = x.parentElement) {
    const p = PARTS.find((q) => q.sel && x.matches(q.sel));
    if (p) return p;
  }
  return null;
}
function renderArrangeBar() {
  const n = hiddenParts().size;
  arrangeBar.replaceChildren(
    h('span', { class: 'arrange-text' }, 'Click a part to hide it; click a faded one to bring it back.', n ? h('span', { class: 'arrange-n' }, ` ${n} hidden`) : null),
    h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => setPart('tree', partHidden('tree')).then(renderArrangeBar) }, partHidden('tree') ? 'Show the right bar' : 'Hide the right bar'),
    h('button', { class: 'btn btn-send', type: 'button', onclick: stopArranging }, 'Done'));
}
function startArranging() {
  arranging = true;
  document.documentElement.classList.add('is-arranging');
  arrangeCss.textContent = `html.is-arranging :is(${PARTS.filter((p) => p.sel).map((p) => p.sel).join(', ')}) { outline: 1.5px dashed var(--you); outline-offset: 2px; cursor: pointer !important; }`;
  // The drawer stays open meanwhile, so its parts can be picked too.
  arrangeWasPinned = els.app.classList.contains('rail-pinned');
  if (!phone.matches) setPinned(true); else setRail(true);
  arrangeBar.hidden = false;
  renderArrangeBar();
  renderRail(); renderTree();
}
function stopArranging() {
  arranging = false;
  document.documentElement.classList.remove('is-arranging');
  arrangeCss.textContent = '';
  arrangeBar.hidden = true;
  if (!phone.matches) setPinned(arrangeWasPinned); else setRail(false);
  renderRail(); renderTree();
}
for (const type of ['pointerdown', 'mousedown', 'click']) {
  document.addEventListener(type, (e) => {
    if (!arranging || e.target.closest?.('.arrange-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    if (type !== 'click') return;
    const p = partAt(e.target);
    if (p) setPart(p.key, partHidden(p.key)).then(renderArrangeBar);
  }, true);
}
document.addEventListener('keydown', (e) => { if (arranging && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopArranging(); } }, true);

function fillKeys(body) {
  const fixed = {
    Writing: [
      ['Enter', 'Send, then open what the queue puts next'],
      ['Shift Enter', 'New line'],
      ['Ctrl Enter', 'Send and done: the message is kept for the brain update and the thread closes, with no answer from Claude'],
      ['Alt Enter', 'Send into a spin-off: a new thread that starts as a copy of this one'],
    ],
    Threads: [['Y / N', 'On a card: accept / decline (Alt Y, Alt N or Ctrl Enter while typing)']],
    'Showing and hiding': [['Ctrl K', 'Search every thread, or run a command'], ['Esc', 'Close the side panel or this window']],
  };
  const mine = S.settings.keys || {};
  // "Change" waits for the next key: a letter or a digit takes it, Escape leaves it.
  const change = (action, button) => {
    button.textContent = 'Press a letter… (Esc leaves it)';
    button.disabled = true;
    const take = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Alt', 'Control', 'Shift', 'Meta'].includes(e.key)) return;
      window.removeEventListener('keydown', take, true);
      if (e.key !== 'Escape' && /^(Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backquote|BracketLeft|BracketRight|Backslash)$/.test(e.code)) {
        // The key leaves whichever action he had given it to before.
        const keys = Object.fromEntries(Object.entries(mine).filter(([id, code]) => id !== action.id && code !== e.code));
        if (e.code !== action.code || keyMap().get(e.code) !== action.id) keys[action.id] = e.code;
        saveSetting({ keys });
        if (S.current) renderHead();
      }
      openSettings('keys');
    };
    window.addEventListener('keydown', take, true);
  };
  const row = (action) => {
    const hint = keyHint(action.id);
    return [
      h('dt', {}, hint ? kbd(hint) : h('span', { class: 'key-none' }, 'no key')),
      h('dd', {}, action.text, ' ', h('button', { class: 'link key-change', type: 'button', onclick: (e) => change(action, e.currentTarget) }, 'Change')),
    ];
  };
  const groups = ['Writing', 'Threads', 'Showing and hiding', 'Brain'];
  body.append(h('h3', { class: 'window-head' }, 'Shortcuts'),
    h('p', { class: 'panel-note' }, 'The keys with Alt are yours: “Change”, then press the letter or digit you want. A key you give to one action is taken from the one that had it. Some belong to the browser and will not arrive (Alt D, Alt F).',
      Object.keys(mine).length ? [' ', h('button', { class: 'link', type: 'button', onclick: async () => { await saveSetting({ keys: {} }); if (S.current) renderHead(); openSettings('keys'); } }, 'The app’s own keys')] : null),
    ...groups.map((g) => h('section', { class: 'keys-group' },
      h('h4', { class: 'layout-head' }, g),
      h('dl', { class: 'keys' },
        (fixed[g] || []).filter(([k]) => g !== 'Threads').map(([k, text]) => [h('dt', {}, kbd(k)), h('dd', {}, text)]),
        KEY_ACTIONS.filter((a) => a.group === g).map(row),
        g === 'Threads' ? fixed.Threads.map(([k, text]) => [h('dt', {}, kbd(k)), h('dd', {}, text)]) : null))),
    h('p', { class: 'panel-note' }, 'Select any text in a reply, a file or a vault note to quote it in your reply. Drag a thread to reorder the inbox, onto Done to close it, or onto a folder to file it.'));
}

// ---------- Settings: the order of the buttons, and his own reply buttons ----------

function orderFields() {
  return [
    h('h3', { class: 'window-head' }, 'Order of the buttons'),
    h('p', { class: 'panel-note' }, 'Drag a button to where you want it, or move it with its arrows. “↔ gap” is the empty space: what stands after it sits on the right. The thread header shows only the buttons that fit the thread’s state.'),
    ...Object.keys(ROWS).map(orderRow),
  ];
}
function orderRow(row) {
  const box = h('section', { class: 'order-row' });
  const names = Object.fromEntries(ROWS[row].items.map((i) => [i[0], i[1]]));
  let dragged = '';
  const save = (keys) => {
    const order = { ...(S.settings.order || {}) };
    if (keys) order[row] = keys; else delete order[row];
    saveSetting({ order });
    if (row === 'head') renderHead();
    draw();
  };
  const move = (key, to) => {
    const keys = rowOrder(row).filter((k) => k !== key);
    keys.splice(Math.max(0, Math.min(keys.length, to)), 0, key);
    save(keys);
  };
  function draw() {
    const keys = rowOrder(row);
    box.replaceChildren(
      h('div', { class: 'order-head' },
        h('h4', { class: 'layout-head' }, ROWS[row].label),
        S.settings.order?.[row]?.length ? h('button', { class: 'link', type: 'button', onclick: () => save(null) }, 'The app’s own order') : null),
      h('div', { class: 'order-chips' }, keys.map((key, i) => {
        const chip = h('span', { class: `order-chip${key === 'gap' ? ' is-gap' : ''}`, draggable: 'true', dataset: { key } },
          h('button', { class: 'order-move', type: 'button', disabled: i === 0, 'aria-label': `Move ${names[key]} left`, onclick: () => move(key, i - 1) }, '‹'),
          h('span', { class: 'order-name' }, names[key]),
          h('button', { class: 'order-move', type: 'button', disabled: i === keys.length - 1, 'aria-label': `Move ${names[key]} right`, onclick: () => move(key, i + 1) }, '›'));
        chip.addEventListener('dragstart', (e) => { dragged = key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); chip.classList.add('is-dragged'); });
        chip.addEventListener('dragend', () => { dragged = ''; draw(); });
        chip.addEventListener('dragover', (e) => {
          if (!dragged || dragged === key) return;
          e.preventDefault();
          const r = chip.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          chip.classList.toggle('drop-after', after);
          chip.classList.toggle('drop-before', !after);
        });
        chip.addEventListener('dragleave', () => chip.classList.remove('drop-after', 'drop-before'));
        chip.addEventListener('drop', (e) => {
          if (!dragged || dragged === key) return;
          e.preventDefault();
          const after = chip.classList.contains('drop-after');
          const rest = rowOrder(row).filter((k) => k !== dragged);
          const was = dragged;
          dragged = '';
          rest.splice(rest.indexOf(key) + (after ? 1 : 0), 0, was);
          save(rest);
        });
        return chip;
      })));
  }
  draw();
  return box;
}

function replyFields() {
  const rows = h('div', { class: 'reply-rows' });
  const collect = () => [...rows.children].map((r) => ({ label: r.children[0].value.trim(), text: r.children[1].value.trim() })).filter((r) => r.text || r.label)
    .map((r) => ({ label: r.label || r.text.slice(0, 24), text: r.text || r.label }));
  const save = () => saveSetting({ replies: collect() });
  const add = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Add a button');
  const row = (r = { label: '', text: '' }) => {
    const el = h('div', { class: 'reply-row' },
      h('input', { class: 'reply-label', type: 'text', maxlength: '24', placeholder: 'On the button', 'aria-label': 'What the button says', onchange: save }),
      h('input', { class: 'reply-text', type: 'text', maxlength: '600', placeholder: 'What it sends, e.g. “Build it.”', 'aria-label': 'What the button sends', onchange: save }),
      h('button', { class: 'btn btn-quiet btn-icon', type: 'button', 'aria-label': 'Remove this button', title: 'Remove', onclick: () => { el.remove(); save(); add.disabled = false; } }, '×'));
    el.children[0].value = r.label;
    el.children[1].value = r.text;
    return el;
  };
  rows.append(...(S.settings.replies || []).map(row));
  add.disabled = rows.children.length >= 8;
  add.addEventListener('click', () => { rows.append(row()); rows.lastChild.children[0].focus(); add.disabled = rows.children.length >= 8; });
  return [
    h('h3', { class: 'window-head' }, 'Your own reply buttons'),
    h('p', { class: 'panel-note' }, 'For what you write again and again. A button stands next to Send and sends its text with one click (with what you typed left in the box), like Agree. Up to eight; place them with “Your own buttons” in the reply box’s order above.'),
    rows, h('div', {}, add),
  ];
}

// ---------- search and commands (Ctrl K) ----------
//
// One box for getting anywhere: a thread by its name (done and archived ones too), a
// thread by something that was said in it, or a command. Names and commands are matched
// here at once; the conversations are searched by the app a moment after he stops typing.

const palette = { el: $('palette'), input: $('palette-input'), list: $('palette-list'), rows: [], at: 0, hits: [], hitsFor: '', token: 0 };

function paletteCommands() {
  const settingsTab = (tab, name) => ({ title: `Settings: ${name}`, run: () => openSettings(tab) });
  const t = S.current ? S.threads.get(S.current) : null;
  return [
    { title: 'New thread', hint: keyHint('new'), run: () => openNew() },
    t?.state === 'ready' ? { title: 'Requeue this thread', hint: keyHint('requeue'), run: requeue } : null,
    t?.state === 'ready' && t.kind !== 'card' ? { title: 'Done: close this thread', hint: keyHint('done'), run: markDone } : null,
    { title: 'Update the brain', hint: keyHint('brain'), run: () => updateBrain() },
    { title: 'Daily reports', run: () => $('open-reports').click() },
    { title: 'Catch-up or Focus', run: () => $('focus-toggle').click() },
    { title: 'Show or hide the inbox', hint: keyHint('inbox'), run: () => setRail(!els.app.classList.contains('rail-open')) },
    { title: 'Layout: pick on the page what to hide', run: () => startArranging() },
    settingsTab('general', 'General (look, sleep time)'), settingsTab('layout', 'Layout (what shows, button order, your own buttons)'), settingsTab('keys', 'Shortcuts'),
    settingsTab('queue', 'Queue'), settingsTab('connections', 'Connections'), settingsTab('stats', 'Stats'), settingsTab('system', 'System'),
    { title: 'Talk to the host', run: () => { location.href = '/walk'; } },
  ].filter(Boolean);
}

const stateWord = (t) => (t.state === 'working' ? (t.held ? 'held' : 'Claude is working') : t.state === 'ready' ? 'waiting for you' : t.archived ? 'archived' : t.deferred ? 'deferred' : 'done');
const stateClass = (t) => (t.kind === 'event' ? 'event' : t.state === 'working' ? 'working' : t.state === 'ready' ? 'ready' : 'done');
const lastTouched = (t) => Math.max(t.lastUserAt || 0, t.updatedAt || 0, t.doneAt || 0);

function drawPalette() {
  const q = palette.input.value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const has = (text) => words.every((w) => text.toLowerCase().includes(w));
  const rank = { ready: 0, working: 1, done: 2 };
  const threads = all().filter((t) => t.kind !== 'card' && (!q || has(`${t.title} ${t.project || ''}`)))
    .sort((a, b) => (q ? (rank[a.state] ?? 2) - (rank[b.state] ?? 2) : 0) || lastTouched(b) - lastTouched(a))
    .slice(0, q ? 12 : 6);
  const commands = paletteCommands().filter((c) => !q || has(c.title));
  const named = new Set(threads.map((t) => t.id));
  const hits = palette.hitsFor === q ? palette.hits.filter((x) => !named.has(x.id) && S.threads.has(x.id)).slice(0, 12) : [];
  const threadRow = (t, sub, find = '') => ({
    run: () => openFound(t.id, find),
    el: h('span', { class: 'palette-main' },
      h('span', { class: `palette-dot is-${stateClass(t)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'palette-text' }, h('span', { class: 'palette-title' }, t.title), h('span', { class: 'palette-sub' }, sub))),
  });
  const sections = [
    [q ? 'Threads' : 'Recent threads', threads.map((t) => threadRow(t, [stateWord(t), t.project, ago(lastTouched(t))].filter(Boolean).join(' · ')))],
    ['Commands', commands.map((c) => ({ run: c.run, el: h('span', { class: 'palette-main' }, h('span', { class: 'palette-dot is-command', 'aria-hidden': 'true' }), h('span', { class: 'palette-text' }, h('span', { class: 'palette-title' }, c.title)), c.hint ? h('kbd', {}, c.hint) : null) }))],
    ['Said in a thread', hits.map((x) => threadRow(S.threads.get(x.id), `${{ you: 'You', claude: 'Claude', app: 'The app' }[x.who] || ''}: ${x.snippet}`, words[0]))],
  ];
  palette.rows = [];
  const out = [];
  for (const [title, rows] of sections) {
    if (!rows.length) continue;
    out.push(h('p', { class: 'palette-head' }, title));
    for (const r of rows) {
      const i = palette.rows.length;
      const el = h('button', { class: 'palette-row', type: 'button', role: 'option', onclick: () => runPalette(i), onpointermove: () => { if (palette.at !== i) { palette.at = i; markPalette(); } } }, r.el);
      palette.rows.push({ run: r.run, el });
      out.push(el);
    }
  }
  if (!palette.rows.length) out.push(h('p', { class: 'palette-none' }, q.length < 2 ? 'Nothing by that name.' : palette.hitsFor === q ? 'Nothing found, in no thread’s name and in no conversation.' : 'Searching the conversations…'));
  palette.list.replaceChildren(...out);
  palette.at = Math.min(palette.at, Math.max(0, palette.rows.length - 1));
  markPalette();
}
function markPalette() {
  palette.rows.forEach((r, i) => { r.el.classList.toggle('is-on', i === palette.at); r.el.setAttribute('aria-selected', String(i === palette.at)); });
  palette.rows[palette.at]?.el.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) {
  const row = palette.rows[i];
  if (!row) return;
  palette.el.close();
  row.run();
}
const searchSoon = debounce(async () => {
  const q = palette.input.value.trim().toLowerCase();
  if (q.length < 2) return;
  const token = ++palette.token;
  try {
    const { hits } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    if (token !== palette.token || palette.input.value.trim().toLowerCase() !== q) return;
    palette.hits = hits;
    palette.hitsFor = q;
    if (palette.el.open) drawPalette();
  } catch { /* the names still work */ }
}, 220);
function togglePalette() {
  if (palette.el.open) { palette.el.close(); return; }
  if (!sleepScreen.hidden) return;
  if (els.settings.open) els.settings.close();
  palette.input.value = '';
  palette.at = 0;
  palette.el.showModal();
  drawPalette();
  palette.input.focus();
}
// Opens a thread found by what was said in it, at the place where it was said.
async function openFound(id, word) {
  await openThread(id);
  if (!word || S.current !== id) return;
  const place = [...els.messages.querySelectorAll('.msg')].reverse().find((m) => m.textContent.toLowerCase().includes(word));
  if (!place) return;
  els.scroller.scrollTop = Math.max(0, place.offsetTop - 24);
  place.classList.add('is-found');
  setTimeout(() => place.classList.remove('is-found'), 2600);
}
palette.input.addEventListener('input', () => { palette.at = 0; drawPalette(); searchSoon(); });
palette.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = palette.rows.length;
    if (n) { palette.at = (palette.at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; markPalette(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (!e.repeat) runPalette(palette.at);
  }
});
palette.el.addEventListener('click', (e) => { if (e.target === palette.el) palette.el.close(); });
palette.el.addEventListener('close', () => { if (!els.composer.hidden && !document.querySelector('dialog[open]')) focusInput(); });
$('open-search').addEventListener('click', () => togglePalette());

// ---------- sleep time ----------
//
// Between the sleep hours the app covers itself with a go-to-sleep screen. Getting past it
// lasts only as long as this window stays open: opening the app again, or coming back to it
// after a while away, brings the screen back.

const minutesOf = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
// The last sleep hours are kept here, so the screen is up before anything is loaded and
// the app is never seen for a moment first.
const SLEEP_SAVED = 'app-ai-sleep';
// Until when the screen was waved away. Kept for this window only (sessionStorage), so a
// reload the app does by itself (after updating) does not bring it back; opening the app
// again does.
let sleepPassed = Number(sessionStorage.getItem('app-ai-sleep-passed')) || 0;
const passSleep = (until) => { sleepPassed = until; try { sessionStorage.setItem('app-ai-sleep-passed', String(until)); } catch { /* fine */ } };
let hiddenSince = 0;

function sleepWindow(now = new Date()) {
  let sl = S.settings?.sleep;
  if (!sl) { try { sl = JSON.parse(localStorage.getItem(SLEEP_SAVED) || 'null'); } catch { sl = null; } }
  if (!sl?.on) return null;
  const from = minutesOf(sl.from);
  const to = minutesOf(sl.to);
  const m = now.getHours() * 60 + now.getMinutes();
  const inside = from < to ? m >= from && m < to : from > to ? m >= from || m < to : false;
  if (!inside) return null;
  const end = new Date(now);
  end.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end <= now) end.setDate(end.getDate() + 1);
  return { until: sl.to, end: end.getTime() };
}

const sleepScreen = h('div', { class: 'sleep', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Time to sleep' });
document.body.append(sleepScreen);
checkSleepEarly();

// Before anything is loaded: the hours from the last visit decide whether the screen is
// up straight away. Whatever the app then says replaces it.
function checkSleepEarly() {
  if (sleepWindow()) { checkSleep(); return; }
  // Nothing remembered yet: wait for the app's own answer rather than show the queue
  // and cover it a moment later.
  if (localStorage.getItem(SLEEP_SAVED)) document.body.classList.remove('is-booting');
  setTimeout(() => document.body.classList.remove('is-booting'), 3000);
}

function checkSleep() {
  if (S.settings?.sleep) { try { localStorage.setItem(SLEEP_SAVED, JSON.stringify(S.settings.sleep)); } catch { /* fine */ } }
  const w = sleepWindow();
  const show = Boolean(w) && Date.now() >= sleepPassed;
  if (!show) {
    if (!sleepScreen.hidden) { sleepScreen.hidden = true; document.body.classList.remove('is-asleep'); }
    document.body.classList.remove('is-booting');
    return;
  }
  const now = new Date();
  sleepScreen.replaceChildren(h('div', { class: 'sleep-inner' },
    h('div', { class: 'sleep-moon', 'aria-hidden': 'true' }),
    h('h1', { class: 'sleep-title' }, 'Time to sleep.'),
    h('p', { class: 'sleep-text' }, `It is ${clock(now.getTime())}. Everything here is still here at ${w.until}, and the queue keeps until then.`),
    h('button', { class: 'btn btn-quiet sleep-pass', type: 'button', onclick: () => { passSleep(w.end); checkSleep(); } }, 'Let me in anyway'),
  ));
  document.body.classList.remove('is-booting');
  if (sleepScreen.hidden) {
    sleepScreen.hidden = false;
    document.body.classList.add('is-asleep');
    // At the very start the pickers do not exist yet (closePickers is defined further
    // down): calling it then stopped the whole page, 17-11-2026.
    try { closePickers(); } catch { /* nothing open yet */ }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }
}

setInterval(checkSleep, 30 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenSince = Date.now(); return; }
  // Away for a while counts as opening the app again.
  if (hiddenSince && Date.now() - hiddenSince > 10 * 60 * 1000) passSleep(0);
  hiddenSince = 0;
  checkSleep();
});

// ---------- the status line: which computer, and whether the laptop can sleep ----------
//
// On the laptop the page always comes from the laptop, and the laptop does the work. The
// status line under the top bar says what is still running or not saved yet, when it is
// safe to suspend the laptop, and offers to hand everything over to the Pi (and back).

let statusNow = null;
// The server, for the Pi. (Not the Raspberry Pi logo: that mark is the Foundation's.)
const BOARD = '<svg class="board" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="6" rx="1.5"/><rect x="3.5" y="14" width="17" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01M10 7h4M10 17h4"/></svg>';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const quoted = (list, n = 2) => list.slice(0, n).map((t) => `“${clip(t.title, 30)}”`).join(', ') + (list.length > n ? ` and ${list.length - n} more` : '');

function renderStatus() {
  const bar = document.getElementById('statusbar');
  const st = statusNow;
  if (!st?.show) { bar.hidden = true; document.getElementById('laptop-status').hidden = true; document.getElementById('status-pop').hidden = true; document.getElementById('talk-link').href = '/walk'; return; }
  const l = st.link;
  const pi = l.remoteName && l.remoteName !== 'Pi' ? l.remoteName : 'Server';
  const lap = l.localName || 'Laptop';
  const onPi = l.enabled && l.active === 'remote';
  // What still keeps the laptop from sleeping, or from handing over.
  const running = [];
  if (st.busy.threads.length) running.push(`Claude is working on ${quoted(st.busy.threads)}`);
  if (st.busy.extracting) running.push('the brain update is running');
  if (st.busy.cards) running.push('the app is looking for new cards');
  const unsaved = st.saved.enabled && (st.saved.files || st.saved.ahead);
  // Four stages. Locked means the app starts nothing by itself; anything sent unlocks it.
  const stage = st.stage || 'busy';
  let tone = { safe: 'safe', 'getting-ready': 'ready', busy: 'busy', idle: 'idle' }[stage] || 'busy';
  let text;
  const buttons = [];
  const act = (label, choice, opts = {}) => h('button', { class: `btn ${opts.quiet ? 'btn-quiet' : ''} status-btn`, type: 'button', disabled: Boolean(opts.off), title: opts.title || '', onclick: async () => {
    try { statusNow = { ...st, link: await api('POST', '/api/link', { choice }) }; renderStatus(); setTimeout(checkStatus, 400); } catch (err) { toast(err.message); }
  } }, label);
  const lockButton = (on) => h('button', { class: `btn ${on ? '' : 'btn-quiet'} status-btn`, type: 'button', title: on ? 'Work as usual again: the app may start work by itself.' : 'Finish what is running, start nothing new, save everything, and say when it is safe to suspend. Anything you send unlocks it again.', onclick: async () => {
    try { await api('POST', '/api/status/finalize', { on: !on }); checkStatus(); } catch (err) { toast(err.message); }
  } }, on ? 'Unlock' : 'Get ready to suspend');

  if (l.enabled && l.step && l.choice === 'remote' && !onPi) {
    tone = 'ready';
    const finished = [
      ...(st.busy.threads.length ? [`Claude has finished ${quoted(st.busy.threads)}`] : []),
      ...(st.busy.extracting ? ['the brain update is through'] : []),
      ...(st.busy.cards ? ['the card run is through'] : []),
    ];
    text = l.step === 'Waiting for Claude to finish here'
      ? `Handover as soon as ${finished.join(' and ') || 'Claude has finished here'}. Anything new is queued and starts on the ${pi.toLowerCase()}. Keep awake.`
      : `Handover: ${l.step.toLowerCase()}… Keep awake.`;
    buttons.push(act('Cancel', 'local', { quiet: true }));
  } else if (l.enabled && l.step && onPi) {
    tone = 'ready';
    text = `Taking everything back: ${l.step.toLowerCase()}…`;
  } else if (onPi && !l.online) {
    // Handed over, and the server does not answer: it stays handed over until he takes
    // it back, so the row says so and offers it.
    tone = 'ready';
    text = `The ${pi.toLowerCase()} is not answering. Everything stays with it until you take it back.`;
    buttons.push(act(`Take back to the ${lap}`, 'local', { title: `The ${lap} works with what the ${pi.toLowerCase()} last saved to GitHub; the rest comes over when it is back.` }));
  } else if (onPi) {
    tone = 'safe';
    text = `Handed over. Safe to suspend the ${lap}.`;
    buttons.push(act(`Take back to the ${lap}`, 'local', { quiet: true }));
  } else {
    if (stage === 'safe') text = 'Safe to suspend.';
    else if (stage === 'getting-ready') text = running.length ? `Getting ready: ${running.join(', ')}.` : 'Getting ready: saving…';
    else if (stage === 'idle') text = 'Nothing running. Not locked.';
    else if (running.length) text = `${running.join(', ').replace(/^./, (c) => c.toUpperCase())}. Keep awake.`;
    else text = st.saved.error ? `Not saved to GitHub: ${st.saved.error}` : 'Saving to GitHub…';
    if (l.note) text = `${text} ${l.note}`;
    buttons.push(lockButton(Boolean(l.finalizing)));
    if (l.enabled) {
      const missing = [...running, ...(unsaved ? [plural(st.saved.files + st.saved.ahead, 'change', 'changes') + ' not on GitHub yet'] : [])];
      const title = !l.online ? `The ${pi.toLowerCase()} is not reachable.`
        : missing.length ? `Still to transfer: ${missing.join('; ')}. The handover waits for that.` : `Ready: everything is saved, the ${pi.toLowerCase()} can take over now.`;
      buttons.push(h('span', { class: `status-ready ${l.online ? (missing.length ? 'is-wait' : 'is-go') : 'is-off'}`, title },
        !l.online ? `${pi} off` : missing.length ? `waits for ${missing.length === 1 ? 'one thing' : `${missing.length} things`}` : 'ready'));
      buttons.push(act(h('span', { class: 'pi-name' }, svg(BOARD), 'Handover'), 'remote', { off: !l.online, title: l.online ? `The ${lap} saves everything, the ${pi.toLowerCase()} takes it in and does the work until the ${lap} takes it back.` : `The ${pi.toLowerCase()} is not reachable.` }));
    }
  }
  const warn = st.unpushed.length
    ? h('span', { class: 'status-warn', title: `${st.unpushed.map((u) => `“${u.title}”: ${plural(u.commits, 'commit', 'commits')} in ${u.repo}`).join('\n')}\n\nThis repo work is only on the ${lap}. Push it in the thread's repo panel to have it on the ${pi}.` },
      `${plural(st.unpushed.length, 'repo branch', 'repo branches')} only on the ${lap}`)
    : null;
  // Quiet by default: a small item in the top bar, with this in a panel when clicked.
  // The full row under the top bar only when something bigger is going on: while getting
  // ready to suspend or handing over (until it is safe), when saving to GitHub fails, or
  // when the server stops answering. Colour only then, and nothing moves.
  // Repo work only on this computer is not one of those by itself: an unmerged or unpushed
  // branch is the usual state of a thread that works in a repo, so it is in the panel and
  // nothing else. It only comes out when he is leaving this computer, because that is
  // when it would be left behind (Florian, 18-11-2026: the row was interrupting, the
  // laptop item had been made quiet on purpose).
  const failing = Boolean(st.saved.error);
  const steps = Boolean(l.enabled && l.step);
  const piGone = onPi && !l.online;
  const leaving = Boolean(l.finalizing) || steps || onPi;
  const leftBehind = Boolean(warn) && leaving;
  const loud = Boolean(l.finalizing) || steps || failing || piGone || leftBehind;
  const mark = failing || leftBehind || piGone ? 'warn' : (stage === 'safe' && l.finalizing) || onPi ? 'safe' : steps || (l.finalizing && stage !== 'safe') ? 'ready' : 'calm';
  const side = () => h('span', { class: 'status-side' }, h('span', { class: `status-dot is-${mark}`, 'aria-hidden': 'true' }), onPi ? h('span', { class: 'pi-name' }, svg(BOARD), pi) : lap);
  const parts = () => [h('span', { class: 'status-text', role: 'status' }, text), warn, h('span', { class: 'status-actions' }, buttons)].filter(Boolean);
  // The buttons are one set of elements: in the panel while it is open, else in the row.
  const pop = document.getElementById('status-pop');
  bar.hidden = !loud;
  bar.className = `statusbar is-${mark}`;
  if (loud) bar.replaceChildren(side(), ...(pop.hidden ? parts() : [h('span', { class: 'status-text', role: 'status' }, text)]));
  const item = document.getElementById('laptop-status');
  item.hidden = false;
  item.className = `top-btn top-laptop is-${mark}`;
  item.title = `${onPi ? pi : lap}: ${text}`;
  const short = onPi ? 'handed over' : mark === 'safe' ? 'safe to suspend' : mark === 'ready' ? 'getting ready' : '';
  item.replaceChildren(h('span', { class: `status-dot is-${mark}`, 'aria-hidden': 'true' }), h('span', { class: 'top-label' }, onPi ? pi : lap), ...(short ? [h('span', { class: 'top-sub' }, short)] : []));
  if (!pop.hidden) pop.replaceChildren(h('div', { class: 'pop-head' }, side()), ...parts());
  // Talking goes to wherever the threads are.
  document.getElementById('talk-link').href = onPi ? `${l.remote}/walk` : '/walk';
}

// The panel under the laptop item: opened and closed by clicking it, closed by a click
// elsewhere or Escape.
function toggleStatusPop(open) {
  const pop = document.getElementById('status-pop');
  const item = document.getElementById('laptop-status');
  pop.hidden = !(open ?? pop.hidden);
  item.classList.toggle('is-on', !pop.hidden);
  item.setAttribute('aria-expanded', String(!pop.hidden));
  renderStatus(); // the buttons move between the panel and the row
}
document.getElementById('laptop-status').addEventListener('click', (e) => { e.stopPropagation(); toggleStatusPop(); });
document.getElementById('status-pop').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!document.getElementById('status-pop').hidden) toggleStatusPop(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('status-pop').hidden) toggleStatusPop(false); });

async function checkStatus() {
  try {
    const next = await (await fetch('/api/status')).json();
    const moved = statusNow?.link && statusNow.link.active !== next.link.active;
    statusNow = next;
    renderStatus();
    if (moved) toast(next.link.active === 'remote' ? `Handed over to the ${next.link.remoteName}. Safe to suspend.` : `Back on the ${next.link.localName}.`);
  } catch { /* the app is not running; the page says so itself */ }
}
checkStatus();
setInterval(() => { if (!document.hidden) checkStatus(); }, 4000);

// ---------- a new version of the app ----------
//
// Florian, 23-11-2026: the app never locks by itself for an update. While Claude works, a
// line at the top says a new version is there. "Lock for update" lets what runs finish,
// queues everything new (in its own colour), and restarts as soon as nothing runs; then
// what was queued starts. "Update now" takes it at once and cuts off what runs (that
// carries on by itself after the restart). On the phone and when handed over, this is
// the Pi's version. The lock for a handover is shown in the status row, not here.

let updateNow = null;
let updateNoteSeen = null;
function renderUpdate() {
  const bar = document.getElementById('updatebar');
  const u = updateNow;
  const forUpdate = u?.lock?.locked && u.lock.reason === 'update';
  if (!u || (!u.available && !forUpdate && !u.applying)) { bar.hidden = true; return; }
  const waits = u.waitsFor || [];
  const post = async (route, body) => {
    try { const out = await api('POST', route, body); updateNow = out.status ? { ...updateNow, ...out.status } : updateNow; renderUpdate(); setTimeout(checkUpdate, 300); } catch (err) { toast(err.message); }
  };
  const btn = (label, onclick, { quiet = false, title = '' } = {}) => h('button', { class: `btn ${quiet ? 'btn-quiet' : ''} status-btn`, type: 'button', title, onclick }, label);
  const now = btn('Update now', () => post('/api/update/check', { force: true }), { quiet: true, title: waits.length ? `Takes the new version at once and cuts off what runs (${waits.map((w) => w.title).join(', ')}). That carries on by itself after the restart.` : 'Takes the new version at once.' });
  let text;
  const buttons = [];
  if (u.applying) text = 'Updating: the app restarts and this page reloads in a moment.';
  else if (forUpdate) {
    text = waits.length ? `Locked for the update: waiting for ${quoted(waits)}. Anything new is queued.` : 'Locked for the update: restarting…';
    if (u.queued) text += ` ${plural(u.queued, 'thing', 'things')} queued.`;
    buttons.push(btn('Unlock', () => post('/api/update/lock', { on: false }), { quiet: true, title: 'Work as usual again; what was queued starts now.' }));
    if (waits.length) buttons.push(now);
  } else {
    text = `New version of the app${u.subject ? `: ${clip(u.subject, 80)}` : ''}.`;
    buttons.push(btn('Lock for update', () => post('/api/update/lock', { on: true }), { title: 'What runs finishes; everything new (your messages, Claude carrying on, the brain update) waits in its own colour. As soon as nothing runs, the app restarts and starts what waited.' }));
    buttons.push(now);
  }
  bar.hidden = false;
  bar.className = `updatebar${forUpdate || u.applying ? ' is-locked' : ''}`;
  bar.replaceChildren(h('span', { class: 'update-dot', 'aria-hidden': 'true' }), h('span', { class: 'status-text' }, text), h('span', { class: 'status-actions' }, buttons));
}

async function checkUpdate() {
  try {
    const next = await (await fetch('/api/update')).json();
    // Why a lock ended without an update, once.
    if (updateNoteSeen !== null && next.note && next.note !== updateNoteSeen) toast(next.note);
    updateNoteSeen = next.note || '';
    updateNow = next;
    renderUpdate();
  } catch { /* the app is restarting, or not running */ }
}
checkUpdate();
// Often while locked, so the line follows what still runs; otherwise now and then (the
// live updates say when a new version comes in).
setInterval(() => { if (!document.hidden && (updateNow?.lock?.locked || updateNow?.applying || updateNow?.available)) checkUpdate(); }, 4000);
setInterval(() => { if (!document.hidden) checkUpdate(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStatus(); });

// ---------- usage: what Claude used through this app ----------
//
// From what the Agent SDK reports per run: tokens, and what the run would have cost on
// the API. Not the plan's limit, which the SDK does not report.

let usageNow = null;
const money = (n) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function renderUsage() {
  const box = document.getElementById('usage');
  if (!usageNow || box.classList.contains('is-open')) return;
  const u = usageNow;
  const button = h('button', { class: 'top-btn usage-btn', type: 'button', 'aria-haspopup': 'menu', title: 'What Claude used through this app today, at API prices. Click for more.' },
    h('span', { class: 'top-label' }, money(u.today.cost)), h('span', { class: 'events-when' }, 'today'));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (box.classList.contains('is-open')) { closePickers(); return; }
    closePickers();
    box.classList.add('is-open');
    const line = (label, x) => h('div', { class: 'usage-line' }, h('span', {}, label), h('span', { class: 'usage-num' }, `${money(x.cost)} · ${tokens(x.out)} out · ${plural(x.runs, 'run', 'runs')}`));
    const max = Math.max(0.01, ...u.days.map((d) => d.cost));
    box.append(h('div', { class: 'pick-menu usage-menu', role: 'menu' },
      line('Last 5 hours', u.fiveHours), line('Today', u.today), line('7 days', u.week),
      u.byKind.length ? h('p', { class: 'events-head' }, 'Today, by kind') : null,
      ...u.byKind.map((k) => line(k.kind, k)),
      h('p', { class: 'events-head' }, 'Per day'),
      h('div', { class: 'usage-bars' }, ...u.days.map((d) => h('div', { class: 'usage-bar', title: `${new Date(d.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${money(d.cost)}, ${plural(d.runs, 'run', 'runs')}` },
        h('span', { style: `height:${Math.max(2, Math.round((d.cost / max) * 44))}px` }), h('small', {}, new Date(d.day).toLocaleDateString(undefined, { weekday: 'narrow' }))))),
      h('p', { class: 'link-status' }, 'What this app used on both computers, counted at API prices. On your subscription nothing is charged; how much of the plan\'s limit is left is not something the app can read.')));
  });
  box.replaceChildren(button);
}
async function checkUsage() {
  try { usageNow = await (await fetch('/api/usage')).json(); renderUsage(); } catch { /* next time */ }
}
checkUsage();
loadReports();
setInterval(() => { if (!document.hidden) checkUsage(); }, 60_000);

// ---------- events: what is coming up in the calendar ----------
//
// Each entry worth preparing has a thread of its own that opens a day before (important)
// or on the morning of the day, and stays until it is marked done: for preparing before
// and debriefing after. They are pinned on top of the inbox from the start (see
// pinnedSection) and are not in the queue, unless he unpins one.

const eventThreads = () => [...S.threads.values()].filter((t) => t.kind === 'event' && t.event);
const comingEvents = () => eventThreads().filter((t) => t.hidden && t.event.showAt > Date.now()).sort((a, b) => a.event.start - b.event.start);

function eventWhen(e) {
  const d = new Date(e.start);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400_000);
  const dayName = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${dayName} ${clock(e.start)}`;
}
function eventPhase(e) {
  const now = Date.now();
  if (now < e.start) return 'Prepare';
  if (now < e.end) return 'Now';
  return 'Debrief';
}

// The event rows say "Today 15:00": they are redrawn so that stays true.
setInterval(() => { if (!document.hidden) renderRail(); }, 60_000);

// ---------- pickers: model and effort ----------

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const closePickers = () => { for (const el of document.querySelectorAll('.pick.is-open')) { el.classList.remove('is-open'); el.querySelector('.pick-menu')?.remove(); } renderUsage(); };

function picker(host, { options, value, onPick, name: naming, describe }) {
  const name = naming || ((m) => m.charAt(0).toUpperCase() + m.slice(1));
  const label = host.dataset.label;
  const button = h('button', { class: 'pick-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-label': `${label}: ${name(value)}` },
    h('span', { class: 'pick-label' }, label), h('span', {}, name(value)), svg(CHEVRON));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = host.classList.contains('is-open');
    closePickers();
    if (wasOpen) return;
    const menu = h('div', { class: `pick-menu${describe ? ' is-wide' : ''}`, role: 'listbox' }, options.map((o) => h('button', {
      class: `pick-opt${o === value ? ' is-on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(o === value),
      title: describe ? describe(o) : '',
      onclick: () => { closePickers(); if (o !== value) onPick(o); button.focus(); },
    }, describe ? h('span', { class: 'pick-two' }, h('span', {}, name(o)), h('span', { class: 'pick-sub' }, describe(o))) : name(o))));
    menu.addEventListener('keydown', (ev) => {
      const opts = [...menu.children];
      const i = opts.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); opts[(i + 1) % opts.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
      else if (ev.key === 'Escape') { ev.stopPropagation(); closePickers(); button.focus(); }
    });
    host.append(menu);
    host.classList.add('is-open');
    (menu.querySelector('.is-on') || menu.firstChild).focus();
  });
  host.replaceChildren(button);
  host.classList.remove('is-open');
}
document.addEventListener('click', closePickers);

// ---------- quoting: select text, comment on it ----------

function hideQuote() { els.quote.hidden = true; }

function maybeShowQuote() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || S.pad) return hideQuote();
  const text = sel.toString().trim();
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  const zone = node?.closest('.quotable');
  if (!text || !zone || node.closest('.mail, .card')) return hideQuote();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (els.quote.hidden) enter(els.quote, 'pop');
  els.quote.hidden = false;
  els.quote.style.top = `${Math.max(8, rect.top - 40)}px`;
  els.quote.style.left = `${Math.min(window.innerWidth - 150, Math.max(8, rect.left + rect.width / 2 - 60))}px`;
  els.quote.dataset.text = text;
  els.quote.dataset.source = node.closest('[data-quote-source]')?.dataset.quoteSource || '';
}

function insertQuote() {
  const { text, source } = els.quote.dataset;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (source) lines[0] = `${source} ${lines[0]}`;
  const block = `${lines.map((l) => `> ${l}`).join('\n')}\n\n`;
  const current = els.input.value;
  els.input.value = `${current}${current && !current.endsWith('\n') ? '\n\n' : ''}${block}`;
  els.input.dispatchEvent(new Event('input')); // saved as a draft, and Done and Send follow
  hideQuote();
  window.getSelection().removeAllRanges();
  focusInput();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
}

// ---------- events from the page ----------

// The box grows with what is typed. Its height includes its border (border-box), so the
// border is added to the text's height: without it the box was two pixels short, and
// every new line pushed the text up by that much. Below the limit nothing scrolls inside.
function autosize() {
  const area = els.input;
  area.style.height = 'auto';
  const border = area.offsetHeight - area.clientHeight;
  const max = window.innerHeight * 0.4;
  const want = area.scrollHeight + border;
  area.style.height = `${Math.min(want, max)}px`;
  if (want <= max) area.scrollTop = 0;
}

els.input.addEventListener('input', autosize);
els.input.addEventListener('input', renderDoneButton);
els.input.addEventListener('input', () => saveDraft(true)); // kept on every keystroke
els.defer.addEventListener('click', deferThread);
els.input.addEventListener('keydown', (e) => {
  if (tierAsk) {
    if (/^[1-9]$/.test(e.key) && tierAsk.items[Number(e.key) - 1]) { e.preventDefault(); tierAsk.pick(tierAsk.items[Number(e.key) - 1].key); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); tierAsk.move(1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); tierAsk.move(-1); return; }
    // Plain Enter takes the highlighted one. Ctrl Enter (Done) and Alt Enter (spin-off) go on below.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // Only a fresh press: not the held Enter that opened the row, not a key repeat.
      if (!e.repeat && tierAsk.enterFree) tierAsk.take();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeTierAsk(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // A held Enter is one Enter: its repeats would send the next thread's draft, or close it.
    if (e.repeat) return;
    if (e.altKey) spinOff(); else send(e.ctrlKey);
  }
});
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
els.spin.addEventListener('click', () => spinOff());
els.sendDone.addEventListener('click', () => send(true));
els.agree.addEventListener('click', () => send(false, '', '', 'Agree, go ahead.'));
els.attach.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { addFiles([...els.fileInput.files]); els.fileInput.value = ''; });
els.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
// Files dropped anywhere on the thread are attached to the message being written.
const stage = document.querySelector('.stage');
const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files') && !els.composer.hidden;
stage.addEventListener('dragover', (e) => { if (carriesFiles(e)) { e.preventDefault(); stage.classList.add('is-dropping'); } });
stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('is-dropping'); });
stage.addEventListener('drop', (e) => {
  stage.classList.remove('is-dropping');
  if (!carriesFiles(e)) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
$('new-thread').addEventListener('click', () => openNew());
els.tabQueue.addEventListener('click', () => setTab('queue'));
els.tabProjects.addEventListener('click', () => setTab('projects'));
// Arrow keys on the tabs move between the two panes, as on any tab list.
for (const tab of [els.tabQueue, els.tabProjects]) tab.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  setTab(e.key === 'ArrowRight' ? 'projects' : 'queue');
  (S.tab === 'projects' ? els.tabProjects : els.tabQueue).focus();
});
els.quote.addEventListener('mousedown', (e) => e.preventDefault());
els.quote.addEventListener('click', insertQuote);
document.addEventListener('mouseup', () => setTimeout(maybeShowQuote, 0));
document.addEventListener('keyup', (e) => { if (e.shiftKey) maybeShowQuote(); });
els.scroller.addEventListener('scroll', hideQuote, { passive: true });

// How much a message is worth. One switch, the same in every thread: Auto, where a
// cheap model picks per message, or Quick select, where sending asks. The single tiers
// are not offered here; quick select is how one is chosen. A thread that keeps a tier
// ("Again, higher") says so; picking either option lets it go.
function renderSettings() {
  if (els.tier.classList.contains('is-open')) return; // he is choosing: redrawing would close the menu
  const s = S.settings;
  const t = S.current ? S.threads.get(S.current) : null;
  const kept = t?.keepTier && (s.tierNames || []).includes(t.keepTier) ? t.keepTier : '';
  const mode = s.tier === 'ask' ? 'ask' : 'auto'; // an older state may still name a tier
  picker(els.tier, {
    options: ['auto', 'ask'],
    value: kept ? 'kept' : mode,
    name: (n) => (n === 'auto' ? 'Auto' : n === 'ask' ? 'Quick select' : `${s.tiers?.[kept]?.label || kept}, kept`),
    describe: (n) => (n === 'auto' ? 'Picked per message by a cheap model, so you never have to choose.'
      : 'Send asks first: five buttons over the box, 1 to 5, or Enter for Default (3).'),
    onPick: (n) => {
      closeTierAsk();
      if (kept) {
        api('POST', `/api/threads/${t.id}/tier`, { tier: '' })
          .then((out) => { S.threads.set(t.id, out.thread); renderSettings(); renderHead(); })
          .catch((e) => toast(e.message));
      }
      if (n === mode) return;
      S.settings = { ...S.settings, tier: n };
      renderSettings();
      api('PUT', '/api/settings', { tier: n }).catch((e) => toast(e.message));
    },
  });
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-wiki]');
  if (link) {
    e.preventDefault();
    openPanel({ kind: 'note', link: link.dataset.wiki });
    return;
  }
  const copy = e.target.closest('.code-copy');
  if (copy) {
    copyFilled(copy.parentElement.querySelector('code').textContent).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    return;
  }
  const yesNo = e.target.closest('.confirm-btn');
  if (!yesNo || !els.messages.contains(yesNo) || yesNo.closest('.is-live')) return;
  if (yesNo.classList.contains('confirm-all')) answerAll(yesNo);
  else if (yesNo.closest('.ask-line')) pickAnswer(yesNo.closest('.ask-line'), yesNo.dataset.answer);
  else answerLine(yesNo.closest('li.confirm-line'), yesNo.dataset.answer);
  focusInput(); // Enter sends what he picked
});

// Yes or No on a line Claude proposed. The answer shows on the line at once; the app
// writes it into the thread, where the next turn and the brain update read it, sent or
// not. Clicking it once more takes it back, until it has gone to Claude.
async function answerLine(li, answer, { keep = false } = {}) {
  const threadId = S.current;
  if (!li || !threadId) return;
  const before = li.classList.contains('is-yes') ? 'yes' : li.classList.contains('is-no') ? 'no' : '';
  if (before === answer) {
    if (keep || !waitingConfirms().some((c) => c.el === li)) return;
    answer = '';
  }
  setLineState(li, answer);
  try {
    const out = await api('POST', `/api/threads/${threadId}/confirm`, { line: li.dataset.line, group: li.dataset.group || '', mid: midOf(li), answer });
    // The message arrives on the page by itself too; the row need not wait for it.
    if (threadId === S.current && S.view && !S.view.messages.some((m) => m.id === out.message.id)) S.view.messages.push(out.message);
    if (out.thread) S.threads.set(threadId, out.thread);
    if (threadId === S.current) { markLines(); renderComposer(); }
  } catch (err) {
    setLineState(li, before);
    toast(err.message);
  }
}

async function answerAll(btn) {
  for (const el of btn.closest('.block').querySelectorAll('[data-yes]')) {
    if (el.classList.contains('ask-line')) pickAnswer(el, el.dataset.yes, { keep: true });
    else await answerLine(el, 'yes', { keep: true });
  }
}

// ---------- answers picked with buttons, not sent yet ----------
//
// A question in "Your move" may offer answers (markdown.js, askLines). A click only picks
// one: it shows in the row over the reply box and goes out with Send, with or without
// text (Florian, 24-11-2026). Picks are kept on this device until then. A Yes or No on a
// proposed line stands in the row too, until it has gone to Claude.

const PICKS_PREFIX = 'app-ai-picks:';
const pickKey = (mid, line) => `${mid}\n${line}`;
const midOf = (el) => el.closest('.msg')?.dataset.mid || '';

function picksOf(threadId) {
  if (!threadId) return new Map();
  if (!S.picks.has(threadId)) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(PICKS_PREFIX + threadId) || '[]'); } catch { /* none */ }
    S.picks.set(threadId, new Map((Array.isArray(list) ? list : []).map((p) => [pickKey(p.mid, p.line), p])));
  }
  return S.picks.get(threadId);
}

function keepPicks(threadId) {
  const list = [...picksOf(threadId).values()];
  try {
    if (list.length) localStorage.setItem(PICKS_PREFIX + threadId, JSON.stringify(list));
    else localStorage.removeItem(PICKS_PREFIX + threadId);
  } catch { /* kept in the page only */ }
}

// Clicking the picked answer again takes it back.
function pickAnswer(el, answer, { keep = false } = {}) {
  const threadId = S.current;
  if (!el || !threadId) return;
  const picks = picksOf(threadId);
  const mid = midOf(el);
  const key = pickKey(mid, el.dataset.line);
  if (picks.get(key)?.answer === answer) { if (keep) return; picks.delete(key); }
  else if (sentAnswers().get(key) === answer) picks.delete(key); // back to what he sent
  else picks.set(key, { mid, line: el.dataset.line, short: el.dataset.short || '', group: el.dataset.group || '', answer });
  keepPicks(threadId);
  markLines();
  renderComposer();
}

// The answers that went out with his messages.
function sentAnswers() {
  const out = new Map();
  for (const m of S.view?.messages || []) for (const a of m.answers || []) if (!a.confirm) out.set(pickKey(a.mid, a.line), a.answer);
  return out;
}

// Yes and No clicks that have not gone to Claude yet, with the line they stand on.
function waitingConfirms() {
  const unsent = S.threads.get(S.current)?.unsent || [];
  const last = new Map();
  for (const m of S.view?.messages || []) if (m.confirm?.line) last.set(pickKey(m.confirm.mid || '', m.confirm.line), m);
  return [...last.values()].filter((m) => m.confirm.answer && unsent.includes(m.text)).map((m) => {
    const el = [...els.messages.querySelectorAll('li.confirm-line')].find((li) => li.dataset.line === m.confirm.line && (!m.confirm.mid || midOf(li) === m.confirm.mid));
    return { ...m.confirm, mid: m.confirm.mid || '', short: el?.dataset.short || clip(m.confirm.line, 46), el };
  });
}

function answersToSend() {
  return [
    ...waitingConfirms().map(({ el, ...c }) => ({ ...c, confirm: true })),
    ...picksOf(S.current).values(),
  ];
}

function dropPicks(threadId, sent) {
  const picks = picksOf(threadId);
  for (const a of sent) {
    const key = pickKey(a.mid, a.line);
    if (!a.confirm && picks.get(key)?.answer === a.answer) picks.delete(key);
  }
  keepPicks(threadId);
}

// The row over the reply box, what Send says, and whether Agree shows: while nothing is
// typed or picked and Claude's last reply offers no buttons of its own.
function renderPicks() {
  const t = S.current ? S.threads.get(S.current) : null;
  const ready = Boolean(t && S.view && t.kind !== 'card' && !S.pad);
  const list = ready ? answersToSend() : [];
  const text = els.input.value.trim();
  els.picks.hidden = !list.length;
  els.picks.replaceChildren(...(list.length ? [h('span', {}, 'Goes with it:')] : []), ...list.map((a) => h('span', { class: 'pick-chip', title: a.line },
    `${a.short || a.line}: `, h('b', {}, a.confirm ? (a.answer === 'no' ? 'No' : 'Yes') : a.answer),
    h('button', { type: 'button', title: 'Take it back', 'aria-label': 'Take it back', onclick: () => takeBack(a) }, '×'))));
  const verb = els.send.dataset.verb || 'Send';
  els.send.textContent = list.length ? `${verb} ${plural(list.length, 'answer', 'answers')}${text ? ' + text' : ''}` : verb;
  // An answer picked in an empty box can close the thread with Done, kept for the brain update.
  if (list.length && t.state === 'ready') els.sendDone.disabled = false;
  const last = ready ? S.view.messages.filter((m) => !m.event).at(-1) : null;
  const lastEl = last?.role === 'assistant' ? els.messages.querySelector(`.msg-claude[data-mid="${CSS.escape(last.id || '')}"]`) : null;
  els.agree.hidden = !(lastEl && !last.error && !last.stopped && t.state === 'ready' && !list.length && !text && !attachedNow().length && !lastEl.querySelector('.ask-line, .confirm-line'));
}

function takeBack(a) {
  if (a.confirm) {
    const c = waitingConfirms().find((x) => x.line === a.line && x.mid === a.mid);
    if (c?.el) answerLine(c.el, c.answer);
    return;
  }
  picksOf(S.current).delete(pickKey(a.mid, a.line));
  keepPicks(S.current);
  markLines();
  renderComposer();
}

function setLineState(li, answer) {
  li.classList.toggle('is-yes', answer === 'yes');
  li.classList.toggle('is-no', answer === 'no');
}

// The last answer to each line in this thread, from its notes. One that names its reply
// counts there only (older ones do not).
function lineAnswers() {
  const out = new Map();
  for (const m of S.view?.messages || []) if (m.confirm?.line) out.set(pickKey(m.confirm.mid || '', m.confirm.line), m.confirm.answer);
  return out;
}

function markLines(root = els.messages) {
  const lines = root.querySelectorAll('li.confirm-line, .ask-line');
  if (!lines.length) return;
  const answers = lineAnswers();
  const sent = sentAnswers();
  const picks = picksOf(S.current);
  for (const el of lines) {
    const key = pickKey(midOf(el), el.dataset.line);
    if (el.matches('.ask-line')) {
      const answer = picks.get(key)?.answer ?? sent.get(key);
      for (const b of el.querySelectorAll('.confirm-btn')) b.classList.toggle('is-on', b.dataset.answer === answer);
    } else setLineState(el, answers.get(key) ?? answers.get(pickKey('', el.dataset.line)) ?? '');
  }
}

let lastKeyAt = 0;

window.addEventListener('keydown', (e) => {
  if (!sleepScreen.hidden) { if (!e.target.closest?.('.sleep')) e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (!els.quote.hidden) { hideQuote(); return; }
    if (els.settings.open || reportsWin.open || palette.el.open) return; // the window closes itself
    if (document.querySelector('.pick.is-open')) { closePickers(); return; }
    if (S.panel) { closePanel(); if (!els.composer.hidden) focusInput(); return; }
    if (typing() && S.cardDecide) document.activeElement.blur();
    return;
  }
  // On a card: Y accepts, N declines. While typing in it, Ctrl+Enter accepts.
  // A burst of keys is someone typing with the cursor in the wrong place, not a verdict.
  const burst = e.timeStamp - lastKeyAt < 400;
  lastKeyAt = e.timeStamp;
  // A window in front (Settings, Reports, search): no key decides a card behind it.
  const windowOpen = Boolean(document.querySelector('dialog[open]'));
  if (S.cardDecide && !e.metaKey && !e.repeat && !windowOpen) {
    const plain = !typing() && !e.altKey && !e.ctrlKey && !burst;
    // Alt Y by what the key says, so it is the Y key on a German keyboard too (it sits where
    // the American one has Z). Only where Alt turns the letter into a sign, by its place.
    const altY = e.altKey && (e.key.toLowerCase() === 'y' || (e.key.length !== 1 && e.code === 'KeyY'));
    const accept = (plain && e.key.toLowerCase() === 'y') || altY || (e.ctrlKey && e.key === 'Enter');
    const decline = (plain && e.key.toLowerCase() === 'n') || (e.altKey && e.code === 'KeyN' && typing());
    if (accept && !S.cardIsMail) { e.preventDefault(); S.cardDecide('accepted'); return; }
    if (decline) { e.preventDefault(); S.cardDecide('declined'); return; }
  }
  // Search and commands: Ctrl K (or Cmd K), from anywhere.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); if (!e.repeat) togglePalette(); return; }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (palette.el.open && keyMap().get(e.code) !== 'search') return; // nothing happens behind the search window
  const actions = {
    new: () => openNew(),
    requeue,
    done: markDone,
    brain: () => updateBrain(),
    files: toggleFiles,
    inbox: () => setRail(!els.app.classList.contains('rail-open')),
    next: () => step(1),
    prev: () => step(-1),
    search: () => togglePalette(),
  };
  // The keys are his (Settings → Shortcuts); the arrows always step through the inbox.
  const id = { ArrowDown: 'next', ArrowUp: 'prev' }[e.code] || keyMap().get(e.code);
  const action = actions[id];
  if (!action) return;
  e.preventDefault();
  // A held key steps on through the inbox, but never requeues or closes thread after thread.
  if (e.repeat && id !== 'next' && id !== 'prev') return;
  action();
});

// ---------- a card on the phone: swipe right to accept, left to decline ----------
//
// Only a clear sideways swipe that starts outside the text counts, and the card follows
// the finger so it is plain what letting go will do.

let swipe = null;
els.messages.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.card');
  if (!card || !S.cardDecide || e.touches.length !== 1 || e.target.closest('textarea, input, button, a, select')) return;
  swipe = { card, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, on: false };
}, { passive: true });
els.messages.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  const dx = e.touches[0].clientX - swipe.x;
  const dy = e.touches[0].clientY - swipe.y;
  if (!swipe.on) {
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // scrolling
    if (Math.abs(dx) < 14) return;
    swipe.on = true;
    swipe.card.classList.add('is-swiping');
  }
  e.preventDefault();
  swipe.dx = S.cardIsMail && dx > 0 ? 0 : dx; // a mail is accepted with its own buttons
  swipe.card.style.transform = `translateX(${swipe.dx}px) rotate(${swipe.dx / 40}deg)`;
  swipe.card.style.opacity = String(Math.max(0.35, 1 - Math.abs(swipe.dx) / 420));
  if (Math.abs(swipe.dx) > 110) swipe.card.dataset.swipe = swipe.dx > 0 ? 'accept' : 'decline';
  else delete swipe.card.dataset.swipe;
}, { passive: false });
function endSwipe(cancelled) {
  const s = swipe;
  swipe = null;
  if (!s || !s.on) return;
  const verdict = cancelled ? '' : s.card.dataset.swipe;
  s.card.classList.remove('is-swiping');
  s.card.classList.add('is-returning');
  if (verdict && S.cardDecide) {
    s.card.style.transform = `translateX(${s.dx > 0 ? 120 : -120}vw)`;
    s.card.style.opacity = '0';
    S.cardDecide(verdict === 'accept' ? 'accepted' : 'declined');
  } else {
    s.card.style.transform = '';
    s.card.style.opacity = '';
    delete s.card.dataset.swipe;
  }
}
els.messages.addEventListener('touchend', () => endSwipe(false));
els.messages.addEventListener('touchcancel', () => endSwipe(true));

// ---------- events from the server ----------

function onThread(t) {
  if (t.kind === 'event') queueMicrotask(renderRail);
  const before = S.threads.get(t.id);
  S.threads.set(t.id, t);
  renderRail();
  renderComposer();
  if (t.id === S.current && !S.pad) {
    if (!before || before.state !== t.state || before.title !== t.title || before.archived !== t.archived || before.project !== t.project || before.repo !== t.repo || before.repoBranch !== t.repoBranch) {
      const editing = document.activeElement?.classList.contains('thread-title');
      if (!editing) renderHead();
    }
    if (S.panel?.kind === 'repo' && S.panel.threadId === t.id && before && (before.state !== t.state || before.repo !== t.repo || before.repoBranch !== t.repoBranch)) showRepo(S.panel);
    if (t.kind !== 'card') {
      if (t.state === 'working' && !S.live) { S.live = []; scheduleLive(); }
      if (t.state === 'working' && S.live) scheduleLive();
      if (!before || JSON.stringify(before.queued || []) !== JSON.stringify(t.queued || []) || before.queuedHeld !== t.queuedHeld || before.state !== t.state) renderQueued();
      if (t.state !== 'working' && S.live) { S.live = null; liveEl?.remove(); liveEl = null; }
      if (!before || before.extractedCount !== t.extractedCount || before.state !== t.state) placeLevel();
    }
  }
  // On the empty screen with nothing typed, the first thread to finish opens by itself.
  const arrived = t.state === 'ready' && (!before || before.state === 'working');
  // A pinned event or a thread waiting for later is not in the queue: nothing opens then.
  const firstUp = inbox()[0];
  if (arrived && firstUp && S.current === null && !S.pad && !els.input.value.trim() && !S.newProject) openThread(firstUp.id, { byQueue: true });
  else if (S.current === null && !S.pad) renderEmpty();
  if (S.brain) {
    S.brain.waiting = all().filter(isUnfiled).length;
    renderBrain();
  }
  if (!before || before.project !== t.project || before.state !== t.state || before.title !== t.title || before.deferred !== t.deferred || before.archived !== t.archived) renderTree();
}

function onMessage({ threadId, message }) {
  if (threadId !== S.current || !S.view || S.threads.get(threadId)?.kind === 'card') return;
  if (S.view.messages.some((m) => m.id === message.id)) return; // already here, from his own click
  S.view.messages.push(message);
  // His Yes or No, perhaps clicked on another device: it shows on the line.
  if (message.confirm) { markLines(); renderPicks(); return; }
  if (message.answers) markLines();
  const stick = nearBottom();
  if (message.role === 'assistant') {
    S.live = null;
    liveEl?.remove();
    liveEl = null;
  }
  const el = messageEl(threadId, message);
  el.classList.add('arrive');
  const box = els.messages.querySelector('.queued-box');
  if (liveEl?.isConnected) liveEl.before(el);
  else if (box) box.before(el);
  else els.messages.append(el);
  markGated(S.threads.get(threadId));
  placeLevel();
  if (message.role === 'assistant') upgradeMailCards();
  if (stick || message.role === 'user') els.scroller.scrollTop = els.scroller.scrollHeight;
}

function onLive(ev) {
  if (ev.threadId !== S.current) return;
  if (ev.op === 'end') return;
  if (!S.live) S.live = [];
  if (ev.op === 'parts') {
    S.live = ev.parts.map((p) => ({ ...p }));
  } else if (ev.op === 'text') {
    while (S.live.length <= ev.index) S.live.push({ type: 'text', text: '' });
    const part = S.live[ev.index];
    if (part.type === 'text') part.text += ev.delta;
  }
  scheduleLive();
}

async function onArtifacts({ threadId }) {
  if (threadId !== S.current || !S.view) return;
  try {
    const data = await api('GET', `/api/threads/${threadId}`);
    if (threadId !== S.current || !S.view) return;
    S.view.artifacts = data.artifacts;
    if (data.thread.kind === 'card') return;
    renderHead();
    upgradeMailCards();
    if (S.panel?.kind === 'artifact' && S.panel.threadId === threadId && S.panel.followLatest) {
      openPanel({ ...S.panel, v: undefined });
    }
  } catch { /* the next event brings it */ }
}

// ---------- the connection to the app ----------
//
// Florian, 23-11-2026: almost every lost connection is the app restarting for an update,
// and the red bar made that look like a crash. So a calm pill at the top: "Updating the
// app" when the page knew a new version was coming, "Reconnecting…" otherwise, and only
// when the app stays away does it turn amber and say it is not answering.

const conn = { lostAt: 0, updating: false, shown: '', timer: null };
const CONN_BLIP_MS = 1500; // a blip this short shows nothing
const CONN_STUCK_MS = 60_000; // after this it is not a restart any more
const CONN_STUCK_UPDATE_MS = 150_000; // an update may install packages first

// A new version was announced, is being taken, or the app is locked for one.
function expectsUpdate() {
  const u = updateNow;
  return Boolean(u && (u.applying || u.available || (u.lock?.locked && u.lock.reason === 'update')));
}

// A merge's subject is 'Merge "Title" (branch)': the title is what he recognises.
function versionTitle(subject) {
  const m = /^Merge "(.+)"(?: \([^)]*\))?$/.exec(subject || '');
  return clip(m ? m[1] : subject || '', 90);
}

function renderConn() {
  const el = document.getElementById('conn');
  const gone = conn.lostAt ? Date.now() - conn.lostAt : 0;
  let state = '';
  if (!conn.lostAt) state = '';
  else if (gone > (conn.updating ? CONN_STUCK_UPDATE_MS : CONN_STUCK_MS)) state = 'stuck';
  else if (conn.updating) state = 'updating';
  else if (gone > CONN_BLIP_MS) state = 'reconnecting';
  document.body.classList.toggle('is-offline', Boolean(state));
  if (!el || state === conn.shown) return; // redrawing would restart the spinner
  conn.shown = state;
  if (!state) { el.hidden = true; return; }
  const [title, sub] = {
    updating: ['Updating the app', 'Back in a few seconds. This page reloads by itself.'],
    reconnecting: ['Reconnecting…', 'Usually the app restarting. Back in a moment.'],
    stuck: ['The app isn’t answering', 'If it does not come back, start it again with “npm start”. This page reconnects by itself.'],
  }[state];
  el.className = `conn${state === 'stuck' ? ' is-stuck' : ''}`;
  el.replaceChildren(
    h('span', { class: state === 'stuck' ? 'conn-mark' : 'conn-spin', 'aria-hidden': 'true' }),
    h('span', { class: 'conn-text' }, h('strong', {}, title), h('span', { class: 'conn-sub' }, sub)));
  el.hidden = false;
}

function connLost() {
  if (conn.lostAt) return; // the browser reports every failed retry
  conn.lostAt = Date.now();
  conn.updating = expectsUpdate();
  clearInterval(conn.timer);
  conn.timer = setInterval(renderConn, 500);
  renderConn();
}

function connBack() {
  conn.lostAt = 0;
  clearInterval(conn.timer);
  renderConn();
}

function connect() {
  const source = new EventSource('/api/events');
  const on = (name, fn) => source.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('thread', onThread);
  on('thread-deleted', onThreadDeleted);
  on('message', onMessage);
  on('live', onLive);
  on('artifacts', onArtifacts);
  on('brain', setBrain);
  on('projects', () => loadProjects()); // e.g. the Someday labels are ready
  on('state', (s) => {
    const arranged = JSON.stringify([S.settings.order, S.settings.keys, S.settings.replies]);
    S.settings = { ...S.settings, ...s };
    applyParts(); applyCustom(); renderSettings(); renderFocus(); renderRail(); renderTree(); checkSleep();
    // Arranged on another device: the thread's header follows (unless he is naming the thread).
    if (arranged !== JSON.stringify([s.order, s.keys, s.replies]) && !document.activeElement?.classList.contains('thread-title')) renderHead();
  });
  on('queue', (q) => { S.queue = q; renderRail(); renderComposer(); });
  on('cards', (c) => { const said = S.cards?.lastError; S.cards = c; renderRail(); if (c.lastError && c.lastError !== said) toast(`Looking for opportunities failed: ${c.lastError}`); });
  on('report', onReports);
  on('connections', () => { if (els.settings.open && S.settingsTab === 'connections') openSettings('connections'); });
  // The event itself says "applying" a moment before the restart; the fetch may not get through.
  on('update', (u) => { updateNow = { ...updateNow, ...u }; renderUpdate(); checkUpdate(); });
  // The page listens first and reads the state second, so nothing that happens in
  // between is missed. After a lost connection it reads the state again.
  let started = false;
  source.onerror = () => { connLost(); checkStatus(); };
  source.onopen = async () => {
    connBack();
    const before = S.connections?.app?.commit;
    try {
      await load();
    } catch { return; }
    // The app updated itself and restarted: take the new version of the page too, and say
    // so once it is loaded.
    if (before && S.connections?.app?.commit && S.connections.app.commit !== before) {
      try { sessionStorage.setItem('app-updated', S.connections.app.subject || ''); } catch { /* no toast then */ }
      location.reload();
      return;
    }
    if (!started) {
      started = true;
      let updated = null;
      try { updated = sessionStorage.getItem('app-updated'); sessionStorage.removeItem('app-updated'); } catch { /* fine */ }
      if (updated !== null) toast(updated ? `Updated · ${versionTitle(updated)}` : 'Updated to the new version.');
      if (S.config.fake) document.body.classList.add('is-fake');
      loadProjects();
      const first = inbox()[0];
      if (first) openThread(first.id, { byQueue: true });
      else openNew();
      setInterval(renderRail, 30_000);
      setInterval(loadProjects, 5 * 60_000);
      // Back from signing in with Google: show that it worked.
      if (new URLSearchParams(location.search).has('google')) { history.replaceState(null, '', '/'); openSettings('connections'); }
    } else if (S.current && S.threads.has(S.current)) {
      refreshThread();
    } else if (S.current) {
      // The side changed and this thread is not there (yet).
      const first = inbox()[0];
      if (first) openThread(first.id, { byQueue: true });
      else openNew();
    }
    if (started) loadProjects();
  };
}

async function load() {
  const state = await api('GET', '/api/state');
  S.threads = new Map(state.threads.map((t) => [t.id, t]));
  S.config = state.config;
  S.connections = state.connections;
  S.settings = state.settings;
  applyParts();
  applyCustom();
  checkSleep();
  navigator.clearAppBadge?.().catch(() => {}); // the old count, from before it was taken off
  S.queue = state.queue;
  S.cards = state.cards;
  S.brain = state.brain;
  renderSettings();
  renderFocus();
  renderRail();
  renderTree();
  renderBrain();
  if (!draftsLoaded) { draftsLoaded = true; await loadDrafts(); }
}
let draftsLoaded = false;

function boot() {
  els.messages.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'empty-sub' }, 'Connecting to the app…')));
  connect();
  // If the app is not running, say so instead of waiting silently.
  setTimeout(() => {
    if (!S.brain) els.messages.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'empty-lead' }, 'The app is not running.'), h('p', { class: 'empty-sub' }, 'Start it with “npm start” in the app’s folder. This page connects by itself.')));
  }, 4000);
}

// Video Kit runs beside the app on this computer (server/videokit.js); the link is only
// useful in this computer's own browser.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  fetch('/api/videokit').then((r) => (r.ok ? r.json() : null)).then((v) => {
    const a = document.getElementById('videokit-link');
    if (v?.url && a) { a.href = v.url; a.hidden = false; }
  }).catch(() => {});
}

boot();
