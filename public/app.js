// The interface. One loop: the app shows what the queue puts first, you reply or decide,
// and it brings up the next thing.

import { renderMarkdown, highlightPlain } from '/markdown.js';
import { renderDiff } from '/diff.js';
import { parseMail, serializeMail } from '/mail.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), lists: $('rail-lists'), paneQueue: $('pane-queue'), paneFolders: $('pane-folders'), brain: $('brain'), head: $('thread-head'),
  scroller: $('scroller'), messages: $('messages'), composer: $('composer'), input: $('input'),
  send: $('send'), spin: $('spin'), sendDone: $('send-done'), defer: $('defer'), attach: $('attach'), fileInput: $('file-input'), attached: $('attached'), panel: $('panel'), quote: $('quote-btn'), toast: $('toast'),
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
  settingsTab: 'queue',
  lastThread: null, // where to go back to from the scratchpad
  panel: null,
  drafts: new Map(),
  attach: new Map(), // files picked for a message not sent yet, by thread ('new' for a new one)
  showDone: false,
};

// Declared up here because opening a thread touches them, whenever that first happens.
let tierAsk = null; // the quick-select row over the reply box, while it asks
let armedDefer = ''; // the thread whose Defer button was clicked once
let armedDeferTimer = 0;

// ---------- parts of the page he can switch off ----------
//
// Settings → Layout lists them; "Pick on the page" lets him click them away instead.
// Hidden parts are hidden by CSS, so anything drawn later is hidden too; their keys
// still work. Saved with the app's state, so laptop, Pi and phone look the same; a copy
// in this browser hides them before the page has loaded.
const PARTS = [
  { group: 'Top bar', key: 'focus', label: 'Focus switch (Everything / Focus)', sel: '#focus-toggle' },
  { group: 'Top bar', key: 'computer', label: 'Which computer works (Laptop / Pi)', sel: '.laptop-wrap' },
  { group: 'Top bar', key: 'usage', label: 'What Claude used today', sel: '#usage' },
  { group: 'Top bar', key: 'videokit', label: 'Video Kit', sel: '#videokit-link' },
  { group: 'Top bar', key: 'talk', label: 'Talk', sel: '#talk-link' },
  { group: 'Inbox drawer', key: 'new-thread', label: 'New thread button (Alt N still works)', sel: '#new-thread' },
  { group: 'Inbox drawer', key: 'coming', label: 'Events coming later', sel: '[data-part="coming"]' },
  { group: 'Inbox drawer', key: 'opportunities', label: 'Look for opportunities', sel: '.group-foot' },
  { group: 'Inbox drawer', key: 'done-list', label: 'Done', sel: '.group[data-drop="done"]' },
  { group: 'Inbox drawer', key: 'next-actions', label: 'Next actions, asleep', sel: '[data-part="next-actions"]' },
  { group: 'Inbox drawer', key: 'gmail', label: 'Update Gmail', sel: '.brain-gmail, .brain-sub.is-mail' },
  { group: 'Right bar', key: 'tree', label: 'The right bar (Folders moves into the inbox drawer)', sel: '' },
  { group: 'Right bar', key: 'tree-people', label: 'People', sel: '.slide-tab[data-part="tree-people"]', redraw: true },
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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
  const at = holdClock(held.until);
  if (held.kind === 'retry') return `Ended on an error · tries again by itself at ${at}`;
  if (held.kind === 'continue') return `Waiting for ${held.reason || 'work still running'} · carries on by itself at ${at}`;
  if (held.kind === 'merge') return `Could not merge · Claude fixes it by itself at ${at}`;
  return `Held by the ${LIMIT_NAMES[held.type] || 'usage limit'} · carries on at ${at}`;
}
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
// Focus: only his own threads in the queue. What the app started and he has not
// answered (cards, proposals, the brain update's questions, mail to answer, check-ins,
// repairs) waits under "waiting for later". His "Later" mark corrects that both ways:
// `later` true sends any thread there, false keeps any in the queue. The same rule as
// the server's (store.isLater).
const APP_KINDS = new Set(['card', 'brain-update', 'mail-reply', 'checkin-active', 'checkin-paused', 'checkin-areas', 'repair', 'prep']);
const isAppThread = (t) => APP_KINDS.has(t.kind) && !(t.lastUserAt > 0);
const isLater = (t) => (typeof t.later === 'boolean' ? t.later : isAppThread(t));
const focusOn = () => Boolean(S.settings.focus?.on) && (!S.settings.focus.until || Date.now() < S.settings.focus.until);
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

const KIND = { event: 'Event', repair: 'Repair', 'next-action': 'Next action', 'brain-update': 'Questions', 'mail-reply': 'Mail to answer', prep: 'Coming up', 'checkin-active': 'Check-in', 'checkin-paused': 'Paused', 'checkin-areas': 'New project?' };
// What kind of work a thread he started himself is; the app works it out with the name.
const TYPE = { thinking: 'Thinking', mail: 'Mail', build: 'Build', document: 'Document', question: 'Question' };
function kindLabel(t) {
  if (t.kind === 'card') return { chase: 'Chase', proposal: 'Proposal' }[t.card?.type] || 'Opportunity';
  return KIND[t.kind] || TYPE[t.type] || '';
}

// ---------- the inbox ----------

function railItem(t) {
  let sub = '';
  if (t.state === 'working' && t.held) sub = `${t.held.kind && t.held.kind !== 'limit' ? 'Carries on by itself' : 'Held: carries on'} at ${holdClock(t.held.until)}${t.doneAfter ? ', closes when finished' : ''}`;
  else if (t.state === 'working') sub = `${t.activity || 'Working'}${t.doneAfter ? ', closes when finished' : ''}`;
  else if (t.state === 'ready') sub = t.error ? 'Stopped with an error' : `waiting ${ago(t.queuedAt)}`;
  else sub = isUnfiled(t) ? 'not in the brain yet' : 'in the brain, archived with the next update';
  const label = kindLabel(t);
  return h('button', {
    class: `item item-${t.state}${t.id === S.current ? ' is-current' : ''}${t.error ? ' has-error' : ''}${t.kind === 'card' ? ' is-card' : ''}${t.later === true ? ' is-later' : ''}`,
    type: 'button',
    title: t.title,
    dataset: { id: t.id },
    onclick: () => openThread(t.id),
  },
    h('span', { class: 'item-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'item-text' },
      h('span', { class: 'item-title' }, t.title),
      h('span', { class: 'item-sub' }, label ? h('span', { class: 'tag' }, label) : null, t.project ? `${t.project}, ` : '', sub),
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
  const laterLine = waits.length ? h('div', { class: `coming later${laterOpen ? ' is-open' : ''}`, dataset: { drop: 'later' } },
    h('button', { class: 'coming-head', type: 'button', 'aria-expanded': String(laterOpen), title: 'Started by the app (cards, proposals, questions, mail to answer, check-ins) or marked "Later" by you. They come back into the queue when focus ends. Drop a thread here to mark it "Later".', onclick: () => { laterOpen = !laterOpen; renderRail(); } },
      `${waits.length} waiting for later`, h('span', { class: 'coming-next' }, ' · focus')),
    h('div', { class: 'coming-list' }, ...waits.map(railItem))) : null;
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
  parts.push(...sleepingSection());
  return parts;
}

let laterOpen = false;

// The focus switch in the top bar. It ends by itself at his sleep time.
function renderFocus() {
  const b = document.getElementById('focus-toggle');
  const on = focusOn();
  b.classList.toggle('is-on', on);
  b.setAttribute('aria-pressed', String(on));
  const until = on && S.settings.focus.until ? clock(S.settings.focus.until) : '';
  b.title = on
    ? `Focus: only your own threads in the queue; what the app made waits, and no new cards are made. Ends by itself at ${until}. Click to see everything again.`
    : 'Focus: work through your own threads only. Cards, proposals, questions, mail to answer and check-ins wait until it ends (at your sleep time, or when you click again).';
  b.replaceChildren(svg('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>'),
    h('span', { class: 'top-label' }, on ? 'Focus' : 'Everything'), ...(on && until ? [h('span', { class: 'top-sub' }, `until ${until}`)] : []));
}
document.getElementById('focus-toggle').addEventListener('click', async () => {
  const on = !focusOn();
  try {
    S.settings = { ...S.settings, ...(await api('PUT', '/api/settings', { focus: on })) };
    renderFocus(); renderRail(); renderComposer();
    toast(on ? 'Focus: only your own threads until your sleep time.' : 'Everything again.');
  } catch (err) { toast(err.message); }
});
// It ends by itself: checked every minute, like the event times.
setInterval(() => { if (S.settings.focus?.on && !focusOn()) { S.settings = { ...S.settings, focus: { on: false, until: 0 } }; renderFocus(); renderRail(); } }, 60_000);

// Next Actions, asleep: lines of Next Actions.md, and threads deferred until the next
// brain update writes their line. Waking one asks once more, in place: a next action
// started by accident is a real nuisance.
let armedWake = '';
function sleepingSection() {
  const asleep = S.next?.actions || [];
  const deferred = (S.next?.deferred || []).filter((d) => S.threads.get(d.id)?.deferred);
  for (const t of all()) if (t.deferred && !t.archived && !deferred.some((d) => d.id === t.id)) deferred.push({ id: t.id, title: t.title, project: t.project || '' });
  if (asleep.length || deferred.length) {
    const wake = async (a, button) => {
      // Once more, in place: the first click only arms it.
      if (armedWake !== a.text) {
        armedWake = a.text;
        renderRail();
        setTimeout(() => { if (armedWake === a.text) { armedWake = ''; renderRail(); } }, 4000);
        return;
      }
      armedWake = '';
      button.disabled = true;
      try {
        const out = await api('POST', '/api/next-actions/wake', { project: a.project, text: a.text });
        S.threads.set(out.thread.id, out.thread);
        S.next = { ...S.next, actions: S.next.actions.filter((x) => x !== a) };
        openThread(out.thread.id);
      } catch (err) { toast(err.message); button.disabled = false; }
    };
    return [section('Next actions', asleep.length + deferred.length, [
      ...asleep.map((a) => h('button', { class: `item sleep-item${armedWake === a.text ? ' is-armed' : ''}`, type: 'button', dataset: { id: `na-${a.text.slice(0, 40)}` }, title: `${a.show}\n\nAsleep in Next Actions.md. Waking it makes it a thread in the inbox, opening with a brief.`, onclick: (e) => wake(a, e.currentTarget) },
        h('span', { class: 'item-mark', 'aria-hidden': 'true' }), h('span', { class: 'sleep-z', 'aria-hidden': 'true' }, armedWake === a.text ? '→' : 'z'),
        h('span', { class: 'sleep-main' }, h('span', { class: 'sleep-text' }, a.show),
          h('span', { class: 'sleep-sub' }, armedWake === a.text ? 'Click again to start it' : (a.project || 'no project'))))),
      ...deferred.map((d) => h('button', { class: `item sleep-item is-deferred${d.id === S.current ? ' is-current' : ''}`, type: 'button', dataset: { id: d.id }, title: 'Deferred. The next brain update writes it into Next Actions.md and deletes the thread. Reply in it to wake it again.', onclick: () => openThread(d.id) },
        h('span', { class: 'item-mark', 'aria-hidden': 'true' }), h('span', { class: 'sleep-z', 'aria-hidden': 'true' }, 'z'),
        h('span', { class: 'sleep-main' }, h('span', { class: 'sleep-text' }, d.title), h('span', { class: 'sleep-sub' }, 'deferred · written at the next brain update')))),
    ], null, null, 'next-actions')];
  }
  return [];
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
    coming.length ? h('div', { class: `coming${comingOpen || coming.some((t) => t.id === armedEvent) ? ' is-open' : ''}`, dataset: { part: 'coming' } },
      h('button', { class: 'coming-head', type: 'button', 'aria-expanded': String(comingOpen), title: 'Events from your calendar that open by themselves later. Hover or click to see them.', onclick: () => { comingOpen = !comingOpen; renderRail(); } },
        `${coming.length} coming`, h('span', { class: 'coming-next' }, ` · next ${eventWhen(coming[0].event).toLowerCase()}`)),
      h('div', { class: 'coming-list' }, ...coming.map((t) => item(t, true)))) : null,
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
    paused.length ? h('div', { class: 'out-folded', dataset: { part: 'tree-paused' } },
      h('div', { class: 'out-folded-head' }, `${paused.length} paused`),
      h('div', { class: 'out-list out-folded-list' }, ...paused.map((p) => row({ ...p, sub: areaOf.get(p.name) || '' }, true)))) : null,
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

// The outline is up to three slides side by side: projects under their areas; people;
// Someday. Swipe or scroll sideways and it snaps; the words on top jump. People and
// Someday can be switched off in Settings → Layout.
const SLIDES = [
  { key: 'projects', label: 'Projects' },
  { key: 'people', label: 'People', part: 'tree-people' },
  { key: 'someday', label: 'Someday', part: 'tree-someday' },
];
const shownSlides = () => SLIDES.filter((s) => !s.part || arranging || !partHidden(s.part));
const slideIndex = () => Math.max(0, shownSlides().findIndex((s) => s.key === (tree.slide || 'projects')));
function slideNodes() {
  const nodes = treeNodes();
  if (Array.isArray(nodes)) return nodes;
  const slides = shownSlides();
  if (!slides.some((s) => s.key === tree.slide)) tree.slide = 'projects';
  const content = { projects: nodes.first, people: nodes.second, someday: nodes.third };
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
      class: `slide-tab${slideIndex() === i ? ' is-on' : ''}`, type: 'button', role: 'tab', dataset: s.part ? { part: s.part } : {}, onclick: () => go(i),
    }, s.label)))
    : h('div', { class: 'slide-nav is-single' }, h('span', { class: 'slide-title' }, slides[0].label));
  const box = h('div', { class: 'slides' }, ...slides.map((s) => h('div', { class: 'slide' }, ...content[s.key])));
  box.addEventListener('scroll', () => {
    if (heading) {
      if (Math.abs(box.scrollLeft - heading.left) > 2 && Date.now() < heading.until) return;
      heading = null;
    }
    const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
    if (slides[i] && slides[i].key !== tree.slide) { tree.slide = slides[i].key; markSlide(); }
  }, { passive: true });
  return [nav, box];
}
function markSlide() { els.tree.querySelectorAll('.slide-tab').forEach((b, i) => b.classList.toggle('is-on', i === slideIndex())); }

// The right bar is there on a wide window, unless he switched it off; then the outline
// is under "Folders" in the inbox drawer, as on a narrower window.
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
  return [...n.first,
    ...(partHidden('tree-people') ? [] : n.second),
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

function renderRail() {
  // While a thread is being dragged the lists stay as they are; they are drawn afresh on the drop.
  if (drag?.active) { drag.stale = true; return; }
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
    rows.push(h('p', { class: 'brain-line is-running' }, h('span', { class: 'mark-live' }, svg(MARK)), b.mailOnly ? 'Taking in new mail' : 'Updating the brain'));
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
    else toast(`${last.mailOnly ? 'Mail taken in' : 'Brain updated'}: ${last.changes.length} ${last.changes.length === 1 ? 'file' : 'files'}${last.hasQuestions ? ', and Claude has questions for you' : ''}${last.replyThreads?.length ? `, ${last.replyThreads.length} to answer` : ''}.`);
    if (S.panel?.kind === 'run') openPanel({ kind: 'run', run: last });
    loadProjects();
  }
}

async function updateBrain(only = '') {
  try {
    const out = await api('POST', '/api/brain/extract', { only });
    if (!out.started) toast(out.reason);
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
    container.replaceChildren(...partNodes(threadId, parts, { live }));
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
      m.text ? h('div', { class: 'msg-body' }, renderMarkdown(m.text)) : null,
      m.files?.length ? h('div', { class: 'msg-files' }, m.files.map((f) => h('a', {
        class: 'chip', href: `/api/threads/${threadId}/upload?name=${encodeURIComponent(f.name)}`, target: '_blank', rel: 'noopener', title: `Open ${f.name}`,
      }, h('span', { class: 'chip-name' }, f.name), h('span', { class: 'chip-size' }, fileSize(f.size))))) : null,
      h('time', { class: 'msg-time' }, stamp(m.ts), m.unanswered ? ' · sent and done, no answer' : ''),
    );
  }
  const body = h('div', { class: 'msg-body' });
  partsInto(body, threadId, m.parts || []);
  const el = h('article', { class: 'msg msg-claude' }, body);
  const tier = tierText(m.tier || (isLastAnswer(threadId, m) ? S.threads.get(threadId)?.lastTier : ''));
  if (m.ts || tier) el.append(h('p', { class: 'msg-time msg-tier', title: tier ? 'The effort this answer ran on' : '' }, m.ts ? stamp(m.ts) : '', m.ts && tier ? ' · ' : '', tier));
  if (m.stopped) el.append(h('p', { class: 'msg-note' }, 'You stopped Claude here.'));
  if (m.limit) el.append(h('p', { class: 'msg-note' }, `Claude's ${LIMIT_NAMES[m.limit.type] || 'usage limit'} cut the turn off here. The app carries on by itself when it lifts.`));
  if (m.error) el.append(h('p', { class: 'msg-note is-error' }, m.error));
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
    els.messages.append(liveEl);
  }
  partsInto(liveEl.firstChild, S.current, S.live, { live: true });
  if (!S.live.length) liveEl.firstChild.append(h('p', { class: 'starting' }, h('span', { class: 'pulse' }), S.threads.get(S.current)?.activity || 'Starting'));
  if (stick) els.scroller.scrollTop = els.scroller.scrollHeight;
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
  const actions = [];
  if (t.kind === 'card') {
    status = h('span', { class: `status status-${t.state === 'ready' ? 'ready' : 'done'}` }, t.state === 'ready' ? kindLabel(t) : `${kindLabel(t)}, ${t.card?.outcome || 'decided'}`);
    if (t.state === 'ready') actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: requeue }, 'Requeue ', kbd('Alt S')));
  } else if (t.state === 'working') {
    status = t.held
      ? h('span', { class: 'status status-held' }, heldText(t.held))
      : h('span', { class: 'status status-working' }, h('span', { class: 'pulse' }), 'Claude is working', t.lastTier ? ` · ${tierText(t.lastTier)}` : '');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/stop`, {}).catch((e) => toast(e.message)) }, t.held ? 'Cancel the hold' : 'Stop'));
  } else if (t.state === 'ready' && t.kind === 'event' && t.event) {
    status = h('span', { class: 'status status-ready' }, `${eventPhase(t.event)} · ${eventWhen(t.event)}${t.event.where ? ` · ${t.event.where}` : ''}`);
  } else if (t.state === 'ready') {
    status = h('span', { class: 'status status-ready' }, 'Waiting for you');
    // What the last turn was worth, and the way to say "that deserved more".
    if (t.lastTier && t.kind !== 'card') {
      const label = S.settings.tiers?.[t.lastTier]?.label || t.lastTier;
      const top = t.lastTier === (S.settings.tierNames || []).at(-1);
      actions.push(h('button', {
        class: 'btn btn-quiet btn-tier', type: 'button', disabled: top,
        title: top ? `This ran on ${label}, the highest tier.` : `This ran on ${label}${t.keepTier ? ' (kept for this thread)' : ' (picked for the message)'}. Run the same message again one tier up, and keep that tier for this thread.`,
        onclick: async () => {
          try { const out = await api('POST', `/api/threads/${t.id}/again`, {}); S.threads.set(t.id, out.thread); toast(`Again on ${S.settings.tiers?.[out.tier]?.label || out.tier}.`); } catch (err) { toast(err.message); }
        },
      }, label, top ? null : h('span', { class: 'tier-up', 'aria-hidden': 'true' }, '↑')));
    }
    actions.push(h('button', { class: 'btn btn-quiet btn-requeue', type: 'button', title: 'Not now: put it back and show me the next', onclick: requeue }, 'Requeue ', kbd('Alt S')));
  } else {
    status = h('span', { class: 'status status-done' }, t.archived ? 'Archived: done, and in the brain' : 'Done');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/state`, { state: 'ready' }).catch((e) => toast(e.message)) }, 'Reopen'));
  }
  const files = t.kind === 'card' ? [] : S.view?.artifacts || [];
  if (files.length) {
    actions.unshift(h('button', { class: 'btn btn-quiet', type: 'button', onclick: toggleFiles }, `${files.length} ${files.length === 1 ? 'file' : 'files'} `, kbd('Alt A')));
  }
  if (t.kind !== 'card' && t.repo) {
    const shortName = t.repo.split('/').pop();
    actions.unshift(h('button', { class: `btn btn-quiet repo-btn${S.panel?.kind === 'repo' ? ' is-on' : ''}`, type: 'button', title: `This thread works in ${t.repo}${t.repoBranch ? ` on ${t.repoBranch}` : ''}`, onclick: toggleRepo },
      h('span', { class: 'repo-glyph', 'aria-hidden': 'true' }, '⑂'), shortName, t.repoBranch ? h('span', { class: 'repo-dot', title: 'Has work on its branch' }) : null));
  }
  if (t.kind !== 'card' && t.state !== 'done') {
    const on = isPinned(t);
    actions.push(h('button', {
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
    actions.push(h('button', {
      class: `btn btn-quiet later-btn${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on),
      title: on
        ? `${mine ? 'You marked this "Later"' : 'Started by the app'}: in Focus it waits under "waiting for later". Click to keep it in your Focus queue.`
        : `In your Focus queue${mine ? ', as you marked it' : ''}. Click to mark it "Later": in Focus it waits under "waiting for later". In Everything nothing changes.`,
      onclick: () => setLater(t, !on),
    }, on ? 'Back to focus' : 'Later'));
  }
  if (t.state !== 'working') actions.push(deleteButton(t));
  els.head.replaceChildren(...[title, status, h('div', { class: 'head-actions' }, actions), t.kind === 'card' ? null : pathEl(t.project)].filter(Boolean));
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
    els.input.placeholder = t.held ? (t.held.kind && t.held.kind !== 'limit' ? 'Reply. Claude starts on it at once.' : 'Add to this thread. Claude gets it when the limit lifts.') : 'Add to this thread. Claude gets it when this turn ends.';
    verb = t.held?.kind && t.held.kind !== 'limit' ? 'Send' : 'Add';
  } else {
    els.input.placeholder = t.state === 'done' ? 'Reply to reopen this thread.'
      : t.kind === 'event' && t.event && Date.now() > t.event.end ? 'How did it go?' : 'Reply.';
  }
  els.send.textContent = verb;
  renderSettings();
  els.defer.hidden = !t || t.state === 'done';
  if (armedDefer && armedDefer !== t?.id) disarmDefer();
  renderDoneButton();
  renderAttached();
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
        error: `It did not work: ${r.status?.error || 'see the log'}.`,
      }[r.outcome];
      if (r.outcome === 'waiting') {
        out.replaceChildren(`A new version (${r.status.waiting}) is waiting until Claude has finished. `,
          h('button', { class: 'link', type: 'button', onclick: () => go(true) }, 'Update now anyway'), ' (cuts off what Claude is doing).');
      } else out.textContent = say || r.outcome;
    } catch (err) { out.textContent = err.message; }
    button.disabled = false;
  };
  const button = h('button', { class: 'btn', type: 'button', onclick: () => go(false) }, 'Check for updates');
  return h('div', { class: 'update-row' }, button, out);
}

// Quick select: the five tiers over the reply box, 1 to 5 or a click, Enter for Default
// (always the middle one, 3, whatever was picked last), Escape to go back to writing.
// Nothing is sent until one is picked. It asks
// where a message starts new work (Send, Start, a spin-off). Never for "Done", which
// Claude does not answer, nor for a message added while Claude is working, which runs on
// the tier of the work it belongs to. `go` gets the tier and sends.
const asksTier = () => S.settings.tier === 'ask';
function askTier(go) {
  closeTierAsk();
  const names = S.settings.tierNames || [];
  const last = names.includes('default') ? 'default' : names[Math.floor(names.length / 2)];
  const pick = (n) => { closeTierAsk(); go(n); };
  const row = h('div', { class: 'tier-ask', role: 'group', 'aria-label': 'How much is this worth?' },
    h('span', { class: 'tier-ask-label' }, 'How much?'),
    ...names.map((n, i) => h('button', {
      class: `tier-ask-btn${n === last ? ' is-last' : ''}`, type: 'button', title: S.settings.tiers?.[n]?.about || '',
      onclick: () => pick(n),
    }, h('kbd', {}, String(i + 1)), S.settings.tiers?.[n]?.label || n)),
    h('button', { class: 'tier-ask-x', type: 'button', title: 'Back to writing (Esc)', 'aria-label': 'Back to writing', onclick: closeTierAsk }, '×'));
  els.composer.prepend(row);
  tierAsk = { row, last, names, pick };
  els.input.focus();
}
function closeTierAsk() { tierAsk?.row.remove(); tierAsk = null; }

// One button for both, always called "Done": with text it keeps the message and closes
// (Claude does not answer), with an empty box it just closes.
function renderDoneButton() {
  const t = S.current ? S.threads.get(S.current) : null;
  const empty = !els.input.value.trim() && !attachedNow().length;
  els.sendDone.textContent = 'Done';
  els.sendDone.disabled = empty && (!t || t.state !== 'ready');
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
    els.input.value = '';
    autosize();
    forgetDraft(t.id);
    toast('Deferred. It sleeps under Next actions; the next brain update writes it into Next Actions.md.');
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
  enter(els.messages);
  placeLevel();
  if (S.live) renderLive();
  upgradeMailCards();
  // Start reading where Claude's latest message starts, not at its end.
  const claude = [...els.messages.querySelectorAll('.msg-claude')].at(-1);
  if (claude && !S.live) els.scroller.scrollTop = Math.max(0, claude.offsetTop - 24);
  else els.scroller.scrollTop = els.scroller.scrollHeight;
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
async function send(done = false, tier = '') {
  const text = els.input.value.trim();
  if (S.pad) return;
  const files = filesToSend();
  // "Done" with an empty box closes the thread.
  if (done && files && !text && !files.length) return markDone();
  if (!files || (!text && !files.length)) return;
  // Quick select: nothing goes until he has picked how much it is worth. Not for
  // "Done": Claude does not answer that, so there is nothing to pick. Not in a thread
  // that keeps a tier ("Again, higher") either.
  const t = S.current ? S.threads.get(S.current) : null;
  // Nor for a message added while Claude is working: it belongs to the work that is
  // running and gets the tier chosen for that.
  if (!done && !tier && !t?.keepTier && t?.state !== 'working' && asksTier()) return askTier((n) => send(false, n));
  closeTierAsk();
  const from = S.current;
  els.send.disabled = true;
  els.sendDone.disabled = true;
  draftPending.delete(from || 'new'); // the text is going out; a delayed save of it must not follow
  try {
    if (from) {
      const out = await api('POST', `/api/threads/${from}/messages`, { text, files, done, tier: done ? '' : tier });
      S.threads.set(from, out.thread);
    } else {
      const out = await api('POST', '/api/threads', { text, files, done, tier: done ? '' : tier, project: S.newProject });
      S.threads.set(out.thread.id, out.thread);
      S.newProject = '';
    }
    els.input.value = '';
    autosize();
    forgetDraft(from || 'new');
    S.attach.delete(from || 'new');
    if (done) toast(from && S.threads.get(from)?.state === 'working' ? 'Kept. The thread closes when this turn ends; Claude does not answer it.' : 'Kept for the brain update. Done, with no answer.');
    // An event's thread is a session: it stays open while Claude answers.
    if (!done && from && S.threads.get(from)?.kind === 'event') { renderRail(); return; }
    advance(from);
  } catch (err) {
    toast(err.message);
  } finally {
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
    els.input.value = '';
    autosize();
    forgetDraft(from);
    S.attach.delete(from);
    toast(`Spun off: “${clip(out.thread.title, 48)}”`);
    advance(from);
  } catch (err) {
    toast(err.message);
  } finally {
    els.spin.disabled = false;
  }
}

function onThreadDeleted({ id }) {
  if (!S.threads.delete(id)) return;
  S.drafts.delete(id);
  draftPending.delete(id);
  try { localStorage.removeItem(DRAFT_PREFIX + id); } catch { /* fine */ }
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
  if (phone.matches) setRail(false);
  S.panel = panel;
  if (panel.kind === 'artifact') return showArtifact(panel);
  if (panel.kind === 'note') return showNote(panel);
  if (panel.kind === 'run') return showRun(panel.run);
  if (panel.kind === 'repo') return showRepo(panel);
  return showFiles();
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
      h('p', { class: 'panel-note' }, 'Nothing counts as filed. Update the brain again when the cause is fixed.'));
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
    if (run.questionsThread && S.threads.has(run.questionsThread)) {
      body.append(h('button', { class: 'btn btn-brain', type: 'button', onclick: () => openThread(run.questionsThread, { keepPanel: true }) }, 'Open Claude’s questions'));
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
  if (tab === 'queue') return fillQueue(els.settingsBody, token);
  if (tab === 'keys') return fillKeys(els.settingsBody);
  if (tab === 'stats') return fillStats(els.settingsBody, token);
  if (tab === 'layout') return fillLayout(els.settingsBody);
  if (tab === 'about') return fillAbout(els.settingsBody, token);
  return fillConnections(els.settingsBody, token);
}

for (const b of els.settings.querySelectorAll('.window-tab')) b.addEventListener('click', () => openSettings(b.dataset.tab));
els.settingsClose.addEventListener('click', () => els.settings.close());
els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
els.openSettings.addEventListener('click', () => openSettings());

// Stats: what happened, by week. Counted from what the app and the vault already keep.
async function fillStats(body, token) {
  body.append(h('h3', { class: 'window-head' }, 'Stats'));
  let s;
  try { s = await api('GET', '/api/stats'); } catch (err) { body.append(h('p', { class: 'panel-note is-error' }, err.message)); return; }
  if (token !== settingsToken) return;
  const groups = [...new Set(s.rows.map((r) => r.group))];
  const cell = (v) => h('td', { class: v ? '' : 'is-zero' }, String(v));
  body.append(
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

// Connections and About both read /api/connections and show it as blocks.
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
const connBlock = (title, state, ...rest) => h('section', { class: 'conn' },
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

  const d = c.data;
  body.append(block('Saving the app’s state', d.error ? { bad: true, text: 'not saving' } : d.enabled ? { on: true, text: d.lastPush ? `saved ${stamp(d.lastPush)}` : 'on' } : { text: 'off' },
    note(d.error || (d.enabled
      ? `Threads, water levels, the scratchpad and what the queue has learned are committed and pushed to ${d.repo} every few minutes. Secrets and the brain clone are left out.`
      : 'The state stays on this computer only. Set dataRepo in config.json to save it to GitHub.'))));
}

// About: which version runs, and where.
async function fillAbout(body, token) {
  const c = await loadConnections(body, token, 'About');
  if (!c) return;
  const block = connBlock;
  const note = connNote;

  if (c.app?.commit) {
    const when = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    body.append(block('App version', { text: `${c.app.commit}${c.app.date ? ` · ${when(Date.parse(c.app.date))}` : ''}` },
      note(`${c.app.subject}.${c.app.startedAt ? ` Running since ${when(c.app.startedAt)}.` : ''}${c.app.update?.enabled ? ` Updates itself from GitHub every ten minutes${c.app.update.waiting ? `; a new version is waiting until Claude has finished` : ''}.` : ''}`),
      c.app.update?.enabled ? updateButton() : null));
  }

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
  body.append(...sleepFields());
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

// Look: light or dark, then which parts of the page are there. Each change shows at once,
// behind this window.
function fillLayout(body) {
  const hidden = hiddenParts();
  const groups = [...new Set(PARTS.map((p) => p.group))];
  body.append(
    ...lookFields(),
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
    h('p', { class: 'panel-note' }, 'The right bar is only there on a wide window; on a narrower one, and on the phone, the same lists are under Folders in the inbox drawer.'));
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
  const groups = [
    ['Writing', [
      ['Enter', 'Send, then open what the queue puts next'],
      ['Shift Enter', 'New line'],
      ['Ctrl Enter', 'Send and done: the message is kept for the brain update and the thread closes, with no answer from Claude'],
      ['Alt Enter', 'Send into a spin-off: a new thread that starts as a copy of this one'],
    ]],
    ['Threads', [
      ['Alt N', 'New thread'],
      ['Alt S', 'Requeue: not now, show me the next'],
      ['Alt X', 'Done: close this thread'],
      ['Alt J / Alt K', 'Next / previous thread in the inbox'],
      ['Y / N', 'On a card: accept / decline (Alt Y, Alt N or Ctrl Enter while typing)'],
    ]],
    ['Showing and hiding', [
      ['Alt L', 'Show or hide the inbox (or move the pointer to the left edge)'],
      ['Alt A', 'Show or hide the files Claude made in this thread'],
      ['Esc', 'Close the side panel or this window'],
    ]],
    ['Brain', [
      ['Alt U', 'Update the brain'],
    ]],
  ];
  body.append(h('h3', { class: 'window-head' }, 'Keys'),
    ...groups.map(([g, rows]) => h('section', { class: 'keys-group' },
      h('h4', { class: 'layout-head' }, g),
      h('dl', { class: 'keys' }, rows.map(([k, text]) => [h('dt', {}, kbd(k)), h('dd', {}, text)])))),
    h('p', { class: 'panel-note' }, 'Select any text in a reply, a file or a vault note to quote it in your reply. Drag a thread to reorder the inbox, onto Done to close it, or onto a folder to file it.'));
}

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
      ? `Handover as soon as ${finished.join(' and ') || 'Claude has finished here'}. Keep awake.`
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
  autosize();
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
    if (/^[1-5]$/.test(e.key) && tierAsk.names[Number(e.key) - 1]) { e.preventDefault(); tierAsk.pick(tierAsk.names[Number(e.key) - 1]); return; }
    // Plain Enter takes the last one used. Ctrl Enter (Done) and Alt Enter (spin-off) go on below.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); tierAsk.pick(tierAsk.last); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeTierAsk(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (e.altKey) spinOff(); else send(e.ctrlKey);
  }
});
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
els.spin.addEventListener('click', () => spinOff());
els.sendDone.addEventListener('click', () => send(true));
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
  }
});

let lastKeyAt = 0;

window.addEventListener('keydown', (e) => {
  if (!sleepScreen.hidden) { if (!e.target.closest?.('.sleep')) e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (!els.quote.hidden) { hideQuote(); return; }
    if (els.settings.open) return; // the window closes itself
    if (document.querySelector('.pick.is-open')) { closePickers(); return; }
    if (S.panel) { closePanel(); if (!els.composer.hidden) focusInput(); return; }
    if (typing() && S.cardDecide) document.activeElement.blur();
    return;
  }
  // On a card: Y accepts, N declines. While typing in it, Ctrl+Enter accepts.
  // A burst of keys is someone typing with the cursor in the wrong place, not a verdict.
  const burst = e.timeStamp - lastKeyAt < 400;
  lastKeyAt = e.timeStamp;
  if (S.cardDecide && !e.metaKey && !e.repeat) {
    const plain = !typing() && !e.altKey && !e.ctrlKey && !burst;
    const accept = (plain && e.key.toLowerCase() === 'y') || (e.altKey && e.code === 'KeyY') || (e.ctrlKey && e.key === 'Enter');
    const decline = (plain && e.key.toLowerCase() === 'n') || (e.altKey && e.code === 'KeyN' && typing());
    if (accept && !S.cardIsMail) { e.preventDefault(); S.cardDecide('accepted'); return; }
    if (decline) { e.preventDefault(); S.cardDecide('declined'); return; }
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const actions = {
    KeyN: () => openNew(),
    KeyS: requeue,
    KeyX: markDone,
    KeyU: () => updateBrain(),
    KeyA: toggleFiles,
    KeyL: () => setRail(!els.app.classList.contains('rail-open')),
    KeyJ: () => step(1),
    KeyK: () => step(-1),
    ArrowDown: () => step(1),
    ArrowUp: () => step(-1),
  };
  const action = actions[e.code];
  if (!action) return;
  e.preventDefault();
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
      if (t.state === 'working' && S.live && !S.live.length) scheduleLive();
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
  if (!before || before.project !== t.project || before.state !== t.state || before.title !== t.title) renderTree();
}

function onMessage({ threadId, message }) {
  if (threadId !== S.current || !S.view || S.threads.get(threadId)?.kind === 'card') return;
  S.view.messages.push(message);
  const stick = nearBottom();
  if (message.role === 'assistant') {
    S.live = null;
    liveEl?.remove();
    liveEl = null;
  }
  const el = messageEl(threadId, message);
  el.classList.add('arrive');
  if (liveEl?.isConnected) liveEl.before(el);
  else els.messages.append(el);
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
  on('state', (s) => { S.settings = { ...S.settings, ...s }; applyParts(); renderSettings(); renderFocus(); renderRail(); renderTree(); checkSleep(); });
  on('queue', (q) => { S.queue = q; renderRail(); renderComposer(); });
  on('cards', (c) => { S.cards = c; renderRail(); if (c.lastError) toast(`Looking for opportunities failed: ${c.lastError}`); });
  on('connections', () => { if (els.settings.open && S.settingsTab === 'connections') openSettings('connections'); });
  // The page listens first and reads the state second, so nothing that happens in
  // between is missed. After a lost connection it reads the state again.
  let started = false;
  source.onerror = () => { els.app.classList.add('is-offline'); checkStatus(); };
  source.onopen = async () => {
    els.app.classList.remove('is-offline');
    const before = S.connections?.app?.commit;
    try {
      await load();
    } catch { return; }
    // The app updated itself and restarted: take the new version of the page too.
    if (before && S.connections?.app?.commit && S.connections.app.commit !== before) { location.reload(); return; }
    if (!started) {
      started = true;
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
      openThread(S.current, { keepPanel: true, byQueue: true });
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
