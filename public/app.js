// The interface. One loop: the app shows what the queue puts first, you reply or decide,
// and it brings up the next thing.

import { renderMarkdown, highlightPlain } from '/markdown.js';
import { renderDiff } from '/diff.js';
import { parseMail, serializeMail } from '/mail.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), lists: $('rail-lists'), brain: $('brain'), head: $('thread-head'),
  scroller: $('scroller'), messages: $('messages'), composer: $('composer'), input: $('input'),
  send: $('send'), spin: $('spin'), sendDone: $('send-done'), attach: $('attach'), fileInput: $('file-input'), attached: $('attached'), panel: $('panel'), quote: $('quote-btn'), toast: $('toast'),
  mood: $('mood'), model: $('model'), effort: $('effort'), tabQueue: $('tab-queue'), tabProjects: $('tab-projects'),
  rail: document.querySelector('.rail'), edge: $('rail-edge'), backdrop: $('rail-backdrop'),
  pin: $('rail-pin'), railClose: $('rail-close'), tree: $('tree'),
  openInbox: $('open-inbox'), inboxCount: $('inbox-count'), openScratch: $('open-scratch'), openSettings: $('open-settings'),
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
  settings: { mood: '', model: 'opus', effort: 'high', models: [], efforts: [] },
  queue: { order: [], why: '', ranking: false },
  cards: { running: false, ready: 0 },
  projects: null,
  tab: 'queue',
  settingsTab: 'connections',
  lastThread: null, // where to go back to from the scratchpad
  panel: null,
  drafts: new Map(),
  attach: new Map(), // files picked for a message not sent yet, by thread ('new' for a new one)
  showDone: false,
};

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

let toastTimer;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  enter(els.toast, 'pop');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4500);
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

const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.isContentEditable);
};

// ---------- which thread comes next ----------

// Event threads waiting to open are not shown anywhere but in Events' "Coming".
const all = () => [...S.threads.values()].filter((t) => !t.hidden);
// What is waiting, in the queue's order; anything the queue has not placed yet follows, oldest first.
function inbox() {
  const ready = all().filter((t) => t.state === 'ready' && t.kind !== 'event').sort((a, b) => a.queuedAt - b.queuedAt);
  const pos = new Map(S.queue.order.map((id, i) => [id, i]));
  return ready.sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6));
}
const working = () => all().filter((t) => t.state === 'working' && t.kind !== 'event').sort((a, b) => a.updatedAt - b.updatedAt);
// Done lists only what is not in the brain yet: a brain update archives the rest.
const done = () => all().filter((t) => t.state === 'done' && t.kind !== 'card' && !t.archived).sort((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt));
const nextReady = (exceptId) => inbox().find((t) => t.id !== exceptId) || null;
const isUnfiled = (t) => t.kind !== 'card' && (t.lastUserAt || 0) > (t.extractedCount || 0);

function advance(fromId) {
  const next = nextReady(fromId);
  if (next) openThread(next.id, { byQueue: true });
  else openNew();
}

const KIND = { event: 'Event', 'brain-update': 'Questions', 'mail-reply': 'Mail to answer', prep: 'Coming up', 'checkin-active': 'Check-in', 'checkin-paused': 'Paused', 'checkin-areas': 'New project?' };
function kindLabel(t) {
  if (t.kind === 'card') return { chase: 'Chase', proposal: 'Proposal' }[t.card?.type] || 'Opportunity';
  return KIND[t.kind] || '';
}

// ---------- the inbox ----------

function railItem(t) {
  let sub = '';
  if (t.state === 'working') sub = `${t.activity || 'Working'}${t.doneAfter ? ', closes when finished' : ''}`;
  else if (t.state === 'ready') sub = t.error ? 'Stopped with an error' : `waiting ${ago(t.queuedAt)}`;
  else sub = isUnfiled(t) ? 'not in the brain yet' : 'in the brain, archived with the next update';
  const label = kindLabel(t);
  return h('button', {
    class: `item item-${t.state}${t.id === S.current ? ' is-current' : ''}${t.error ? ' has-error' : ''}${t.kind === 'card' ? ' is-card' : ''}`,
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

// `drop` names what dropping a thread on the section does: "queue" or "done".
const section = (label, count, items, extra, drop) => h('section', { class: 'group', dataset: drop ? { drop } : {} },
  h('h2', { class: 'group-head' }, label, count ? h('span', { class: 'count' }, String(count)) : null, extra),
  ...items,
);

function queueLists() {
  const ready = inbox();
  const busy = working();
  const closed = done();
  const parts = [];
  const note = S.queue.ranking ? 'ordering…' : S.queue.why && ready.length > 1 ? `first because: ${S.queue.why}` : '';
  parts.push(section('Next up', ready.length, [
    note ? h('p', { class: 'group-note' }, note) : null,
    ...(ready.length ? ready.map(railItem) : [h('p', { class: 'group-empty' }, busy.length ? 'Nothing yet. Claude is still working.' : 'Nothing is waiting.')]),
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

// ---------- the folder outline: areas, projects, and the threads in them ----------

const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
// The app's mark: the icon's graph without its tile.
const MARK = '<svg class="mark" viewBox="16 18 68 66" aria-hidden="true"><g stroke-width="3.2" stroke-linecap="butt"><line x1="29" y1="59" x2="26.5" y2="50.5" stroke="#8fd0a8"/><line x1="26.5" y1="50.5" x2="24" y2="42" stroke="#7aa8ff"/><line x1="24" y1="42" x2="30.5" y2="35.5" stroke="#7aa8ff"/><line x1="30.5" y1="35.5" x2="37" y2="29" stroke="#7aa8ff"/><line x1="37" y1="29" x2="46.5" y2="27.5" stroke="#7aa8ff"/><line x1="46.5" y1="27.5" x2="56" y2="26" stroke="#c3a6ff"/><line x1="56" y1="26" x2="64.5" y2="31" stroke="#c3a6ff"/><line x1="64.5" y1="31" x2="73" y2="36" stroke="#c3a6ff"/><line x1="73" y1="36" x2="74" y2="45" stroke="#c3a6ff"/><line x1="74" y1="45" x2="75" y2="54" stroke="#f5b75c"/><line x1="75" y1="54" x2="66.5" y2="58" stroke="#f5b75c"/><line x1="66.5" y1="58" x2="58" y2="62" stroke="#f5b75c"/><line x1="58" y1="62" x2="43.5" y2="60.5" stroke="#f5b75c"/><line x1="43.5" y1="60.5" x2="29" y2="59" stroke="#8fd0a8"/><line x1="47" y1="45" x2="35.5" y2="43.5" stroke="#f5b75c"/><line x1="35.5" y1="43.5" x2="24" y2="42" stroke="#7aa8ff"/><line x1="47" y1="45" x2="42" y2="37" stroke="#f5b75c"/><line x1="42" y1="37" x2="37" y2="29" stroke="#7aa8ff"/><line x1="47" y1="45" x2="60" y2="40.5" stroke="#f5b75c"/><line x1="60" y1="40.5" x2="73" y2="36" stroke="#c3a6ff"/><line x1="47" y1="45" x2="52.5" y2="53.5" stroke="#f5b75c"/><line x1="52.5" y1="53.5" x2="58" y2="62" stroke="#f5b75c"/><line x1="58" y1="62" x2="59" y2="68.5" stroke="#f5b75c"/><line x1="59" y1="68.5" x2="60" y2="75" stroke="#f5b75c"/></g><circle cx="29" cy="59" r="3.6" fill="var(--mark-ground, #171924)" stroke="#8fd0a8" stroke-width="3.2"/><circle cx="24" cy="42" r="3.6" fill="var(--mark-ground, #171924)" stroke="#7aa8ff" stroke-width="3.2"/><circle cx="37" cy="29" r="3.6" fill="var(--mark-ground, #171924)" stroke="#7aa8ff" stroke-width="3.2"/><circle cx="56" cy="26" r="3.6" fill="var(--mark-ground, #171924)" stroke="#c3a6ff" stroke-width="3.2"/><circle cx="73" cy="36" r="3.6" fill="var(--mark-ground, #171924)" stroke="#c3a6ff" stroke-width="3.2"/><circle cx="75" cy="54" r="3.6" fill="var(--mark-ground, #171924)" stroke="#f5b75c" stroke-width="3.2"/><circle cx="58" cy="62" r="3.6" fill="var(--mark-ground, #171924)" stroke="#f5b75c" stroke-width="3.2"/><circle cx="47" cy="45" r="5.6" fill="#f5b75c"/><circle cx="60" cy="75" r="3.6" fill="var(--mark-ground, #171924)" stroke="#f5b75c" stroke-width="3.2"/></svg>';

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
// It shows projects, not threads. A dot marks a project that has open threads; paused
// projects and areas without a project are grey and at the bottom. Click one to see its
// threads and what can be done there. Drop a thread on one to file it.

function outlineRow({ name, project, about, touched, open, grey, isArea, hereName }) {
  return h('div', { class: `out${grey ? ' is-grey' : ''}${hereName === project ? ' is-here' : ''}`, dataset: { drop: 'folder', project } },
    h('button', {
      class: 'out-row', type: 'button',
      title: `${name}${about ? `\n${about}` : ''}${open ? `\n${open} open ${open === 1 ? 'thread' : 'threads'}` : ''}\nClick to read its note`,
      onclick: () => openPanel({ kind: 'note', link: project }),
    },
    h('span', { class: 'out-name' }, name, open ? h('span', { class: 'out-mark', 'aria-label': 'has open threads' }) : null),
    touched ? h('span', { class: 'out-when' }, ago(touched).replace(' ago', '')) : null),
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
  return [
    h('div', { class: 'tree-head' }, h('span', { class: 'tree-label' }, 'Projects'),
      bulkButton('active', '+ active', active.length, `Start a check-in thread on every active project. ${each}.`),
      bulkButton('paused', '+ paused', paused.length, `Start a thread on every paused project: has what it waits for happened? ${each}.`)),
    h('div', { class: 'out-list' }, ...active.map((p) => row(p, false)), ...paused.map((p) => row(p, true))),
    !projects.length ? h('p', { class: 'tree-note' }, 'No projects in the vault.') : null,
    h('div', { class: 'tree-head' }, h('span', { class: 'tree-label' }, 'Areas'),
      bulkButton('areas', '+ project ideas', areas.length, `Start a thread per area about which new project to start there. ${each}.`)),
    h('div', { class: 'out-list' }, ...areas.filter((a) => !a.empty).sort(byRecent).map((a) => row(a, false)), ...areas.filter((a) => a.empty).sort(byRecent).map((a) => row(a, true))),
  ].filter(Boolean);
}

function renderTree(force = false) {
  if (drag?.active && !force) { drag.stale = true; return; }
  if (wide.matches) els.tree.replaceChildren(...treeNodes());
  else if (S.tab === 'projects') renderRail();
}

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
  const folders = S.tab === 'projects' && !wide.matches;
  const before = new Map([...els.lists.querySelectorAll('.item')].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
  els.lists.replaceChildren(...(folders ? [h('div', { class: 'tree' }, ...treeNodes())] : queueLists()));
  els.tabQueue.classList.toggle('is-on', !folders);
  els.tabProjects.classList.toggle('is-on', folders);
  if (!reducedMotion.matches && before.size) {
    for (const el of els.lists.querySelectorAll('.item')) {
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
wide.addEventListener('change', () => { if (wide.matches) S.tab = 'queue'; renderRail(); renderTree(); });

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
  if (kind === 'queue') {
    if (t.state === 'working') return null;
    const others = [...zone.querySelectorAll('.item[data-id]')].filter((el) => el.dataset.id !== drag.id);
    let index = others.findIndex((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (index < 0) index = others.length;
    return { kind, zone, index, others };
  }
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
  clearDropMarks();
  const target = dropAt(x, y);
  drag.target = target;
  if (!target) return;
  if (target.kind === 'queue') {
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
      if (target.kind === 'queue') {
        if (t.state === 'done') S.threads.set(t.id, (await api('POST', `/api/threads/${t.id}/state`, { state: 'ready' })).thread);
        // Shown at once; the server's order follows a moment later.
        const ids = inbox().map((x) => x.id).filter((id) => id !== d.id);
        ids.splice(target.index, 0, d.id);
        S.queue = { ...S.queue, order: ids };
        S.queue = await api('POST', '/api/queue/move', { id: d.id, index: target.index });
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
    S.projects = await api('GET', '/api/projects');
    renderTree();
    if (S.current && !S.pad) renderHead();
  } catch { /* the next change brings it */ }
}, 400);

function setTab(tab) {
  S.tab = tab;
  renderRail();
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
      h('button', { class: 'btn', type: 'button', disabled: !b.mail, title: b.mail ? 'Takes in the mail that arrived and went out since the last time, and nothing else' : 'Connect Gmail in the settings first', onclick: () => updateBrain('mail') }, 'Update Gmail'),
    ));
    if (b.mail) rows.push(h('p', { class: 'brain-sub' }, b.mailLevel ? `Mail is taken in up to ${stamp(b.mailLevel)}` : 'No mail taken in yet; the first time looks back one day'));
    if (b.brain.error) rows.push(h('p', { class: 'brain-sub is-error' }, b.brain.error));
  }
  if (b.last && !b.running) {
    const last = b.last;
    const what = last.mailOnly ? 'Gmail update' : 'update';
    let text;
    if (last.status === 'failed') text = `Last ${what} failed, ${stamp(last.finishedAt)}`;
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
    if (last.status === 'failed') toast(`The ${what} failed: ${last.error}`);
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
  const status = h('span', { class: 'mail-status' });
  const actions = h('div', { class: 'mail-actions' });
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

  const act = async (path, okText) => {
    await save();
    await saving;
    try {
      await api('POST', `/api/threads/${threadId}/mail/${path}`, { name, reason: reason ? reason() : '' });
      toast(okText);
      document.activeElement?.blur();
      if (onDecided) onDecided();
      else { await onArtifacts({ threadId }); }
    } catch (err) { toast(err.message); }
  };

  function drawActions(confirming = false) {
    if (sent) {
      actions.replaceChildren(h('span', { class: 'mail-sent' }, `Sent ${stamp(sent)}`));
      return;
    }
    if (confirming) {
      actions.replaceChildren(
        h('span', { class: 'mail-confirm' }, `Send to ${mail.to || '(no recipient)'} with the subject “${mail.subject}”?`),
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
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: async () => { await navigator.clipboard.writeText(mail.body); toast('Copied.'); } }, 'Copy text'),
      info && info.versions.length > 1 ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openPanel({ kind: 'artifact', threadId, name, diff: true }) }, `${info.versions.length} versions`) : null,
      status,
    ].filter(Boolean));
  }
  drawActions();
  const el = h('div', { class: `mail${sent ? ' is-sent' : ''}`, dataset: { name } },
    field('To', 'to'), field('Subject', 'subject'), body, actions);
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

function partsInto(container, threadId, parts, { live = false } = {}) {
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
  container.replaceChildren(...out);
}

function messageEl(threadId, m) {
  if (m.role === 'user' && m.event) {
    return h('p', { class: 'msg msg-event' }, m.text.replace(/^\[|\]$/g, ''));
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
  if (m.stopped) el.append(h('p', { class: 'msg-note' }, 'You stopped Claude here.'));
  if (m.error) el.append(h('p', { class: 'msg-note is-error' }, m.error));
  return el;
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
    status = h('span', { class: 'status status-working' }, h('span', { class: 'pulse' }), 'Claude is working');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/stop`, {}).catch((e) => toast(e.message)) }, 'Stop'));
  } else if (t.state === 'ready' && t.kind === 'event' && t.event) {
    status = h('span', { class: 'status status-ready' }, `${eventPhase(t.event)} · ${eventWhen(t.event)}${t.event.where ? ` · ${t.event.where}` : ''}`);
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', title: 'Close this event: prepared and debriefed', onclick: markDone }, 'Done ', kbd('Alt X')));
  } else if (t.state === 'ready') {
    status = h('span', { class: 'status status-ready' }, 'Waiting for you');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', title: 'Not now: put it back and show me the next', onclick: requeue }, 'Requeue ', kbd('Alt S')));
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: markDone }, 'Done ', kbd('Alt X')));
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
  if (t.state !== 'working') actions.push(deleteButton(t));
  els.head.replaceChildren(...[title, status, h('div', { class: 'head-actions' }, actions), t.kind === 'card' ? null : pathEl(t.project)].filter(Boolean));
}

function renderComposer() {
  const t = S.current ? S.threads.get(S.current) : null;
  els.composer.hidden = Boolean(S.pad) || t?.kind === 'card';
  // A spin-off needs a thread to start from.
  els.spin.hidden = !t;
  els.spin.textContent = phone.matches ? 'Spin off' : 'Send into spin-off';
  let verb = 'Send';
  if (!t) {
    els.input.placeholder = 'What should Claude work on?';
    verb = 'Start';
  } else if (t.state === 'working') {
    els.input.placeholder = 'Add to this thread. Claude gets it when this turn ends.';
    verb = 'Add';
  } else {
    els.input.placeholder = t.state === 'done' ? 'Reply to reopen this thread.'
      : t.kind === 'event' && t.event && Date.now() > t.event.end ? 'How did it go?' : 'Reply.';
  }
  els.send.textContent = verb;
  els.sendDone.textContent = `${verb} and done`;
  renderAttached();
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

function saveDraft() {
  if (!S.pad) S.drafts.set(S.current || 'new', els.input.value);
}

function restoreDraft() {
  els.input.value = S.drafts.get(S.current || 'new') || '';
  autosize();
}

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
        await navigator.clipboard.writeText(area.value).catch(() => {});
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
    placeholder: 'Optional: your reason, or what is outdated here',
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
    flush = async () => {
      if (!dirty) return;
      dirty = false;
      await api('POST', `/api/threads/${t.id}/artifact/save`, { name: 'Message.md', content: `${area.value.trim()}\n` });
    };
    const soon = debounce(() => flush().catch((e) => toast(e.message)), 700);
    area.addEventListener('input', () => { dirty = true; grow(area); soon(); });
    bodyEl = area;
    requestAnimationFrame(() => grow(area));
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
  els.openScratch.classList.remove('is-on');
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
  if (phone.matches) setRail(false);
  openToken += 1;
  S.pad = null;
  S.current = null;
  S.newProject = project;
  S.view = null;
  S.live = null;
  S.cardDecide = null;
  liveEl = null;
  els.openScratch.classList.remove('is-on');
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
  els.openScratch.classList.add('is-on');
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
async function send(done = false) {
  const text = els.input.value.trim();
  if (S.pad) return;
  const files = filesToSend();
  if (!files || (!text && !files.length)) return;
  const from = S.current;
  els.send.disabled = true;
  els.sendDone.disabled = true;
  try {
    if (from) {
      const out = await api('POST', `/api/threads/${from}/messages`, { text, files, done });
      S.threads.set(from, out.thread);
    } else {
      const out = await api('POST', '/api/threads', { text, files, done, project: S.newProject });
      S.threads.set(out.thread.id, out.thread);
      S.newProject = '';
    }
    els.input.value = '';
    S.drafts.delete(from || 'new');
    S.attach.delete(from || 'new');
    if (done) toast(from && S.threads.get(from)?.state === 'working' ? 'Kept. The thread closes when this turn ends; Claude does not answer it.' : 'Kept for the brain update. Done, with no answer.');
    // An event's thread is a session: it stays open while Claude answers.
    if (!done && from && S.threads.get(from)?.kind === 'event') { renderEvents(); return; }
    advance(from);
  } catch (err) {
    toast(err.message);
  } finally {
    els.send.disabled = false;
    els.sendDone.disabled = false;
  }
}

// "Send into spin-off": the message starts a new thread that begins as a copy of this
// one. Nothing is sent here; this thread goes to the back of the queue.
async function spinOff() {
  const text = els.input.value.trim();
  const from = S.current;
  if (!from || S.pad) return;
  const files = filesToSend();
  if (!files) return;
  if (!text && !files.length) { toast('Write what the spin-off should do first.'); return; }
  els.spin.disabled = true;
  try {
    const out = await api('POST', `/api/threads/${from}/spinoff`, { text, files });
    S.threads.set(out.thread.id, out.thread);
    S.threads.set(out.from.id, out.from);
    els.input.value = '';
    S.drafts.delete(from);
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
  const order = [...inbox(), ...working(), ...(S.showDone ? done() : [])];
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

  if (st.holder) body.append(h('p', { class: 'panel-note repo-busy' }, `“${st.holder}” is working in this repo right now. This thread waits for it before Claude touches the repo.`));
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
        e.currentTarget.disabled = true;
        try { const out = await api('POST', `/api/threads/${threadId}/repo/push`, {}); toast('Pushed.'); window.open(out.compare, '_blank', 'noopener'); showRepo(panel); } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      } }, st.pushed ? 'Open pull request' : 'Push and open pull request'),
      armedButton(`Merge into ${st.main}`, `Merge into ${st.main} and push`, async () => {
        await api('POST', `/api/threads/${threadId}/repo/merge`, {});
        toast(`Merged into ${st.main}.`);
        showRepo(panel);
      }),
    );
    if (!st.pushed && st.ahead) actions.append(h('button', { class: 'btn btn-quiet', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await api('POST', `/api/threads/${threadId}/repo/push`, {}); toast('Pushed the branch.'); showRepo(panel); } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
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
    tools.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: async () => { await navigator.clipboard.writeText(text ?? ''); toast('Copied.'); } }, 'Copy'));
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
  if (run.status === 'failed') {
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
  return fillConnections(els.settingsBody, token);
}

for (const b of els.settings.querySelectorAll('.window-tab')) b.addEventListener('click', () => openSettings(b.dataset.tab));
els.settingsClose.addEventListener('click', () => els.settings.close());
els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
els.openSettings.addEventListener('click', () => openSettings());

async function fillConnections(body, token) {
  body.append(h('h3', { class: 'window-head' }, 'Connections'));
  let c;
  try {
    c = await api('GET', '/api/connections');
  } catch (err) {
    body.append(h('p', { class: 'panel-note is-error' }, err.message));
    return;
  }
  if (token !== settingsToken) return;
  S.connections = c;
  const block = (title, state, ...rest) => h('section', { class: 'conn' },
    h('h3', { class: 'conn-title' }, title, h('span', { class: `conn-state${state.on ? ' is-on' : ''}${state.bad ? ' is-error' : ''}` }, state.text)), ...rest);
  const note = (text) => h('p', { class: 'panel-note' }, text);

  const g = c.google;
  if (g.connected) {
    body.append(block('Gmail and Calendar', { on: true, text: 'connected' },
      note(`Signed in${g.email ? ` as ${g.email}` : ''}. Threads can search and read your mail, read your calendar and add entries. Only the buttons on a mail put it into Gmail or send it, and only when you press them.`),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await api('POST', '/api/google/disconnect', {}); toast('Disconnected.'); openSettings('connections'); } }, 'Disconnect')));
  } else if (g.configured) {
    body.append(block('Gmail and Calendar', { text: 'not connected' },
      note('Sign in with Google once. Threads can then read your mail and calendar, "Update Gmail" takes in new mail, and the buttons on a mail work.'),
      h('a', { class: 'btn btn-brain', href: '/auth/google' }, 'Connect Google')));
  } else {
    body.append(block('Gmail and Calendar', { text: 'not set up' },
      note('This needs a Google client id and secret in config.json first. The steps are in docs/google.md in the app’s folder; they take about ten minutes, once.')));
  }

  const d = c.data;
  body.append(block('Saving the app’s state', d.error ? { bad: true, text: 'not saving' } : d.enabled ? { on: true, text: d.lastPush ? `saved ${stamp(d.lastPush)}` : 'on' } : { text: 'off' },
    note(d.error || (d.enabled
      ? `Threads, water levels, the scratchpad, the mood line and what the queue has learned are committed and pushed to ${d.repo} every few minutes. Secrets and the brain clone are left out.`
      : 'The state stays on this computer only. Set dataRepo in config.json to save it to GitHub.'))));

  if (c.app?.commit) {
    body.append(block('App version', { text: c.app.commit },
      note(`${c.app.subject}${c.app.date ? ` (${stamp(Date.parse(c.app.date))})` : ''}.${c.app.update?.enabled ? ` Updates itself from GitHub${c.app.update.waiting ? `; a new version is waiting until Claude has finished` : ''}.` : ''}`)));
  }

  const v = c.voice;
  body.append(block('Calling by phone', v.ready ? { on: true, text: 'ready' } : { text: v.enabled ? 'incomplete' : 'off' },
    note(v.ready ? 'Call your Twilio number from one of your allowed phones.'
      : v.enabled ? `Switched on, but config.json still lacks: ${v.missing.join(', ')}. See docs/calling.md.`
        : 'Off. The Talk page does the same from your phone’s browser, for free. A real phone number needs Twilio: docs/calling.md.')));

  const r = c.remote;
  body.append(block('Where the app runs', { on: true, text: r.local ? 'this computer' : 'another computer' },
    note(r.local
      ? (r.allowedHosts.length ? `Also reachable as ${r.allowedHosts.join(', ')}.` : 'Only this computer can reach it. To reach it from your phone or run it on a Raspberry Pi, see docs/pi.md.')
      : `You are reaching it at ${location.host}.`)));
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

function fillKeys(body) {
  const rows = [
    ['Enter', 'Send, then open what the queue puts next'],
    ['Ctrl Enter', 'Send and done: the message is kept for the brain update and the thread closes, with no answer from Claude'],
    ['Alt Enter', 'Send into a spin-off: a new thread that starts as a copy of this one'],
    ['Shift Enter', 'New line'],
    ['Alt N', 'New thread'],
    ['Alt L', 'Show or hide the inbox (or move the pointer to the left edge)'],
    ['Alt S', 'Requeue: not now, show me the next'],
    ['Alt X', 'Done: close this thread'],
    ['Y / N', 'On a card: accept / decline (Alt Y, Alt N or Ctrl Enter while typing)'],
    ['Alt J / Alt K', 'Next / previous thread in the inbox'],
    ['Alt A', 'Show or hide the files Claude made in this thread'],
    ['Alt U', 'Update the brain'],
    ['Alt M', 'Jump to the mood line'],
    ['Alt P', 'Scratchpad, and back'],
    ['Esc', 'Close the side panel or this window'],
  ];
  body.append(h('h3', { class: 'window-head' }, 'Keys'),
    h('dl', { class: 'keys' }, rows.map(([k, text]) => [h('dt', {}, kbd(k)), h('dd', {}, text)])),
    h('p', { class: 'panel-note' }, 'Select any text in a reply, a file or a vault note to quote it in your reply. Drag a thread to reorder the inbox, onto Done to close it, or onto a folder to file it.'));
}

// ---------- sleep time ----------
//
// Between the sleep hours the app covers itself with a go-to-sleep screen. Getting past it
// lasts only as long as this window stays open: opening the app again, or coming back to it
// after a while away, brings the screen back.

const minutesOf = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
let sleepPassed = 0; // until when the screen was waved away
let hiddenSince = 0;

function sleepWindow(now = new Date()) {
  const sl = S.settings?.sleep;
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

function checkSleep() {
  const w = sleepWindow();
  const show = Boolean(w) && Date.now() >= sleepPassed;
  if (!show) {
    if (!sleepScreen.hidden) { sleepScreen.hidden = true; document.body.classList.remove('is-asleep'); }
    return;
  }
  const now = new Date();
  sleepScreen.replaceChildren(h('div', { class: 'sleep-inner' },
    h('div', { class: 'sleep-moon', 'aria-hidden': 'true' }),
    h('h1', { class: 'sleep-title' }, 'Time to sleep.'),
    h('p', { class: 'sleep-text' }, `It is ${clock(now.getTime())}. Everything here is still here at ${w.until}, and the queue keeps until then.`),
    h('button', { class: 'btn btn-quiet sleep-pass', type: 'button', onclick: () => { sleepPassed = w.end; checkSleep(); } }, 'Let me in anyway'),
  ));
  if (sleepScreen.hidden) {
    sleepScreen.hidden = false;
    document.body.classList.add('is-asleep');
    closePickers();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }
}

setInterval(checkSleep, 30 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenSince = Date.now(); return; }
  // Away for a while counts as opening the app again.
  if (hiddenSince && Date.now() - hiddenSince > 10 * 60 * 1000) sleepPassed = 0;
  hiddenSince = 0;
  checkSleep();
});

// ---------- the status line: which computer, and whether the laptop can sleep ----------
//
// On the laptop the page always comes from the laptop, and the laptop does the work. The
// status line under the top bar says what is still running or not saved yet, when it is
// safe to suspend the laptop, and offers to hand everything over to the Pi (and back).

let statusNow = null;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const quoted = (list, n = 2) => list.slice(0, n).map((t) => `“${clip(t.title, 30)}”`).join(', ') + (list.length > n ? ` and ${list.length - n} more` : '');

function renderStatus() {
  const bar = document.getElementById('statusbar');
  const st = statusNow;
  if (!st?.show) { bar.hidden = true; document.getElementById('talk-link').href = '/walk'; return; }
  bar.hidden = false;
  const l = st.link;
  const pi = l.remoteName || 'Pi';
  const lap = l.localName || 'Laptop';
  const onPi = l.enabled && l.active === 'remote';
  // What still keeps the laptop from sleeping, or from handing over.
  const running = [];
  if (st.busy.threads.length) running.push(`Claude is working on ${quoted(st.busy.threads)}`);
  if (st.busy.extracting) running.push('the brain update is running');
  if (st.busy.cards) running.push('the app is looking for new cards');
  const unsaved = st.saved.enabled && (st.saved.files || st.saved.ahead);
  let tone = 'ok';
  let text;
  const buttons = [];
  const act = (label, choice, opts = {}) => h('button', { class: `btn ${opts.quiet ? 'btn-quiet' : ''} status-btn`, type: 'button', disabled: Boolean(opts.off), title: opts.title || '', onclick: async () => {
    try { statusNow = { ...st, link: await api('POST', '/api/link', { choice }) }; renderStatus(); setTimeout(checkStatus, 400); } catch (err) { toast(err.message); }
  } }, label);

  if (l.enabled && l.step && l.choice === 'remote' && !onPi) {
    tone = 'busy';
    const finished = [
      ...(st.busy.threads.length ? [`Claude has finished ${quoted(st.busy.threads)}`] : []),
      ...(st.busy.extracting ? ['the brain update is through'] : []),
      ...(st.busy.cards ? ['the card run is through'] : []),
    ];
    text = l.step === 'Waiting for Claude to finish here'
      ? `Handing over to the ${pi} as soon as ${finished.join(' and ') || 'Claude has finished here'}. Keep the ${lap} awake until then.`
      : `Handing over to the ${pi}: ${l.step.toLowerCase()}… Keep the ${lap} awake.`;
    buttons.push(act('Cancel', 'local', { quiet: true }));
  } else if (l.enabled && l.step && onPi) {
    tone = 'busy';
    text = `Taking everything back from the ${pi}: ${l.step.toLowerCase()}…`;
  } else if (onPi) {
    tone = 'ok';
    text = `Handed over: the ${pi} has everything and does the work. Safe to suspend the ${lap}; it takes everything back when it wakes.`;
    buttons.push(act(`Take back to the ${lap}`, 'local', { quiet: true }));
  } else {
    if (running.length) { tone = 'busy'; text = `${running.join(', ').replace(/^./, (c) => c.toUpperCase())}. Keep the ${lap} awake.`; }
    else if (unsaved) { tone = 'busy'; text = st.saved.error ? `Not saved to GitHub: ${st.saved.error}` : 'Saving the latest changes to GitHub…'; }
    else { tone = 'ok'; text = `Everything is saved. Safe to suspend the ${lap}.`; }
    if (l.note) text = `${text} ${l.note}`;
    if (l.enabled) {
      const missing = [...running, ...(unsaved ? [plural(st.saved.files + st.saved.ahead, 'change', 'changes') + ' not on GitHub yet'] : [])];
      const title = !l.online ? `The ${pi} is not reachable.`
        : missing.length ? `Still to transfer: ${missing.join('; ')}. The handover waits for that.` : `Ready: everything is saved, the ${pi} can take over now.`;
      buttons.push(h('span', { class: `status-ready ${l.online ? (missing.length ? 'is-wait' : 'is-go') : 'is-off'}`, title },
        !l.online ? `${pi} is off` : missing.length ? `${pi}: waits for ${missing.length === 1 ? 'one thing' : `${missing.length} things`}` : `${pi} is ready`));
      buttons.push(act(`Hand over to the ${pi}`, 'remote', { off: !l.online, title: l.online ? `The ${lap} saves everything to GitHub, the ${pi} takes it in, and the ${pi} does the work until the ${lap} takes it back. The line here says when it is safe to suspend.` : `The ${pi} is not reachable.` }));
    }
  }
  const warn = st.unpushed.length
    ? h('span', { class: 'status-warn', title: `${st.unpushed.map((u) => `“${u.title}”: ${plural(u.commits, 'commit', 'commits')} in ${u.repo}`).join('\n')}\n\nThis repo work is only on the ${lap}. Push it in the thread's repo panel to have it on the ${pi}.` },
      `${plural(st.unpushed.length, 'repo branch', 'repo branches')} only on the ${lap}`)
    : null;
  bar.className = `statusbar is-${tone}`;
  bar.replaceChildren(...[
    h('span', { class: 'status-side' }, h('span', { class: `status-dot ${onPi ? 'is-remote' : 'is-local'}`, 'aria-hidden': 'true' }), onPi ? pi : lap),
    h('span', { class: 'status-text', role: 'status' }, text),
    warn,
    h('span', { class: 'status-actions' }, buttons),
  ].filter(Boolean));
  // Talking goes to wherever the threads are.
  document.getElementById('talk-link').href = onPi ? `${l.remote}/walk` : '/walk';
}

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

// ---------- events: what is coming up in the calendar ----------
//
// Not in the inbox. Each entry worth preparing has a thread of its own that opens a day
// before (important) or on the morning of the day, and stays until it is marked done:
// for preparing before and debriefing after.

const eventThreads = () => [...S.threads.values()].filter((t) => t.kind === 'event' && t.event);
const openEvents = () => eventThreads().filter((t) => !t.hidden && t.state !== 'done').sort((a, b) => a.event.start - b.event.start);
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

function renderEvents() {
  const box = document.getElementById('events');
  if (box.classList.contains('is-open')) return;
  const open = openEvents();
  const waiting = open.filter((t) => t.state === 'ready').length;
  const next = open[0];
  const button = h('button', { class: `top-btn events-btn${open.length ? '' : ' is-empty'}`, type: 'button', 'aria-haspopup': 'menu', title: open.length ? 'Events: preparing before, debriefing after' : 'Events: nothing coming up' },
    svg('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>'),
    h('span', { class: 'top-label' }, next ? clip(next.title, 22) : 'Events'),
    next ? h('span', { class: 'events-when' }, eventPhase(next.event) === 'Debrief' ? 'debrief' : eventWhen(next.event).replace(/^Today /, '')) : null,
    waiting ? h('span', { class: 'top-count' }, String(waiting)) : null);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (box.classList.contains('is-open')) { closePickers(); return; }
    closePickers();
    box.classList.add('is-open');
    const item = (t, coming) => h('button', { class: `pick-opt event-opt${t.id === S.current ? ' is-on' : ''}${coming ? ' is-coming' : ''}`, type: 'button', disabled: coming, onclick: () => { closePickers(); openThread(t.id); } },
      h('span', { class: 'event-main' },
        h('span', { class: 'event-title' }, t.title),
        h('span', { class: 'event-sub' }, coming ? `${eventWhen(t.event)} · opens ${eventWhen({ start: t.event.showAt }).toLowerCase()}` : `${eventWhen(t.event)}${t.event.where ? ` · ${t.event.where}` : ''}${t.event.important ? '' : ' · small'}`)),
      coming ? null : h('span', { class: `event-phase is-${eventPhase(t.event).toLowerCase()}` }, t.state === 'working' ? 'Claude…' : t.state === 'ready' ? `${eventPhase(t.event)} · yours` : eventPhase(t.event)));
    const open = openEvents();
    const coming = comingEvents();
    box.append(h('div', { class: 'pick-menu events-menu', role: 'menu' },
      open.length ? open.map((t) => item(t, false)) : h('p', { class: 'link-status' }, 'Nothing to prepare or debrief right now.'),
      coming.length ? [h('p', { class: 'events-head' }, 'Coming'), ...coming.map((t) => item(t, true))] : null,
      h('p', { class: 'link-status' }, 'From your calendar. Important entries open a day before, smaller ones on the day. Each stays until you mark it done.')));
  });
  box.replaceChildren(button);
}
setInterval(() => { if (!document.hidden) renderEvents(); }, 60_000);

// ---------- pickers: model and effort ----------

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const closePickers = () => { for (const el of document.querySelectorAll('.pick.is-open')) { el.classList.remove('is-open'); el.querySelector('.pick-menu')?.remove(); } renderEvents(); };

function picker(host, { options, value, onPick }) {
  const name = (m) => m.charAt(0).toUpperCase() + m.slice(1);
  const label = host.dataset.label;
  const button = h('button', { class: 'pick-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-label': `${label}: ${name(value)}` },
    h('span', { class: 'pick-label' }, label), h('span', {}, name(value)), svg(CHEVRON));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = host.classList.contains('is-open');
    closePickers();
    if (wasOpen) return;
    const menu = h('div', { class: 'pick-menu', role: 'listbox' }, options.map((o) => h('button', {
      class: `pick-opt${o === value ? ' is-on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(o === value),
      onclick: () => { closePickers(); if (o !== value) onPick(o); button.focus(); },
    }, name(o))));
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

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (e.altKey) spinOff(); else send(e.ctrlKey);
  }
});
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
els.spin.addEventListener('click', spinOff);
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
els.openScratch.addEventListener('click', () => openPad());
$('new-thread').addEventListener('click', () => openNew());
els.tabQueue.addEventListener('click', () => setTab('queue'));
els.tabProjects.addEventListener('click', () => setTab('projects'));
els.quote.addEventListener('mousedown', (e) => e.preventDefault());
els.quote.addEventListener('click', insertQuote);
document.addEventListener('mouseup', () => setTimeout(maybeShowQuote, 0));
document.addEventListener('keyup', (e) => { if (e.shiftKey) maybeShowQuote(); });
els.scroller.addEventListener('scroll', hideQuote, { passive: true });

// The mood line saves as you type. Enter just puts you back in the reply box.
const saveMood = debounce(() => api('PUT', '/api/settings', { mood: els.mood.value }).catch((e) => toast(e.message)), 500);
els.mood.addEventListener('input', saveMood);
els.mood.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); els.mood.blur(); if (!els.composer.hidden) focusInput(); } });
function renderSettings() {
  const s = S.settings;
  if (document.activeElement !== els.mood) els.mood.value = s.mood || '';
  const set = (key) => (value) => { S.settings = { ...S.settings, [key]: value }; renderSettings(); api('PUT', '/api/settings', { [key]: value }).catch((e) => toast(e.message)); };
  picker(els.model, { options: s.models || [], value: s.model, onPick: set('model') });
  picker(els.effort, { options: s.efforts || [], value: s.effort, onPick: set('effort') });
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
    navigator.clipboard.writeText(copy.parentElement.querySelector('code').textContent).then(() => {
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
    KeyM: () => { els.mood.focus(); els.mood.select(); },
    KeyL: () => setRail(!els.app.classList.contains('rail-open')),
    KeyP: () => openPad(),
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
  if (t.kind === 'event') queueMicrotask(renderEvents);
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
  if (arrived && S.current === null && !S.pad && !els.input.value.trim() && !S.newProject) openThread(inbox()[0].id, { byQueue: true });
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
  on('state', (s) => { S.settings = { ...S.settings, ...s }; renderSettings(); checkSleep(); });
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
  checkSleep();
  navigator.clearAppBadge?.().catch(() => {}); // the old count, from before it was taken off
  S.queue = state.queue;
  S.cards = state.cards;
  S.brain = state.brain;
  renderSettings();
  renderRail();
  renderEvents();
  renderTree();
  renderBrain();
}

function boot() {
  els.messages.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'empty-sub' }, 'Connecting to the app…')));
  connect();
  // If the app is not running, say so instead of waiting silently.
  setTimeout(() => {
    if (!S.brain) els.messages.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'empty-lead' }, 'The app is not running.'), h('p', { class: 'empty-sub' }, 'Start it with “npm start” in the app’s folder. This page connects by itself.')));
  }, 4000);
}

boot();
