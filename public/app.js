// The interface. One loop: the app shows what the queue puts first, you reply or decide,
// and it brings up the next thing.

import { renderMarkdown, highlightPlain } from '/markdown.js';
import { renderDiff } from '/diff.js';
import { parseMail, serializeMail } from '/mail.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), lists: $('rail-lists'), brain: $('brain'), head: $('thread-head'),
  scroller: $('scroller'), messages: $('messages'), composer: $('composer'), input: $('input'),
  send: $('send'), panel: $('panel'), quote: $('quote-btn'), toast: $('toast'),
  mood: $('mood'), model: $('model'), effort: $('effort'), tabQueue: $('tab-queue'), tabProjects: $('tab-projects'),
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
  openProject: '',
  panel: null,
  drafts: new Map(),
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

const all = () => [...S.threads.values()];
// What is waiting, in the queue's order; anything the queue has not placed yet follows, oldest first.
function inbox() {
  const ready = all().filter((t) => t.state === 'ready').sort((a, b) => a.queuedAt - b.queuedAt);
  const pos = new Map(S.queue.order.map((id, i) => [id, i]));
  return ready.sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6));
}
const working = () => all().filter((t) => t.state === 'working').sort((a, b) => a.updatedAt - b.updatedAt);
const done = () => all().filter((t) => t.state === 'done' && t.kind !== 'card').sort((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt));
const nextReady = (exceptId) => inbox().find((t) => t.id !== exceptId) || null;
const isUnfiled = (t) => t.kind !== 'card' && (t.lastUserAt || 0) > (t.extractedCount || 0);

function advance(fromId) {
  const next = nextReady(fromId);
  if (next) openThread(next.id, { byQueue: true });
  else openNew();
}

const KIND = { 'brain-update': 'Questions', 'mail-reply': 'Mail to answer' };
function kindLabel(t) {
  if (t.kind === 'card') return t.card?.type === 'chase' ? 'Chase' : 'Opportunity';
  return KIND[t.kind] || '';
}

// ---------- the rail ----------

function railItem(t) {
  let sub = '';
  if (t.state === 'working') sub = t.activity || 'Working';
  else if (t.state === 'ready') sub = t.error ? 'Stopped with an error' : `waiting ${ago(t.queuedAt)}`;
  else sub = t.archived ? 'in the brain' : isUnfiled(t) ? 'not in the brain yet' : 'closed';
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
      h('span', { class: 'item-sub' }, label ? h('span', { class: 'tag' }, label) : null, t.project && S.tab === 'queue' ? `${t.project}, ` : '', sub),
    ),
  );
}

const section = (label, count, items, extra) => h('section', { class: 'group' },
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
  ]));
  if (busy.length) parts.push(section('Claude is working', busy.length, busy.map(railItem)));
  if (closed.length) {
    const toggle = h('button', { class: 'link', type: 'button', onclick: () => { S.showDone = !S.showDone; renderRail(); } }, S.showDone ? 'Hide' : 'Show');
    parts.push(section('Done', closed.length, S.showDone ? closed.map(railItem) : [], toggle));
  }
  return parts;
}

function projectLists() {
  const tree = S.projects;
  if (!tree) return [h('p', { class: 'group-empty' }, 'Reading the vault…')];
  if (tree.missing) return [h('p', { class: 'group-empty' }, 'The vault has no Projects Index yet.')];
  const row = (node, isArea) => {
    const open = S.openProject === node.name;
    const mine = all().filter((t) => t.project === node.name && t.kind !== 'card' && t.state !== 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const touched = node.touched ? ago(node.touched) : 'no thread yet';
    return h('div', { class: `proj${isArea ? ' is-area' : ''}${open ? ' is-open' : ''}` },
      h('button', { class: 'proj-row', type: 'button', title: node.about || node.name, onclick: () => { S.openProject = open ? '' : node.name; renderRail(); } },
        h('span', { class: 'proj-name' }, node.name),
        h('span', { class: `proj-meta${node.open ? ' has-open' : ''}` }, node.open ? `${node.open} open, ${touched}` : touched),
      ),
      open ? h('div', { class: 'proj-body' },
        node.about ? h('p', { class: 'proj-about' }, node.about) : null,
        ...mine.map(railItem),
        h('div', { class: 'proj-actions' },
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openNew(node.name) }, 'New thread here'),
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openPanel({ kind: 'note', link: node.name }) }, 'Read the note'),
        ),
      ) : null,
    );
  };
  return tree.groups.map((g) => h('section', { class: 'group' },
    g.isArea ? row(g, true) : h('h2', { class: 'group-head' }, g.name),
    ...g.projects.map((p) => row(p, false)),
  ));
}

function renderRail() {
  const before = new Map([...els.lists.querySelectorAll('.item')].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
  els.lists.replaceChildren(...(S.tab === 'queue' ? queueLists() : projectLists()));
  els.tabQueue.classList.toggle('is-on', S.tab === 'queue');
  els.tabProjects.classList.toggle('is-on', S.tab === 'projects');
  if (!reducedMotion.matches && before.size) {
    for (const el of els.lists.querySelectorAll('.item')) {
      const was = before.get(el.dataset.id);
      const now = el.getBoundingClientRect().top;
      if (was == null) el.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
      else if (Math.abs(was - now) > 1) el.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  const n = inbox().length;
  document.title = n ? `(${n}) Inbox` : 'Inbox';
  if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

const loadProjects = debounce(async () => {
  try {
    S.projects = await api('GET', '/api/projects');
    if (S.tab === 'projects') renderRail();
    if (S.current) renderHead();
  } catch { /* the next change brings it */ }
}, 400);

function setTab(tab) {
  S.tab = tab;
  if (tab === 'projects') loadProjects();
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
    rows.push(h('p', { class: 'brain-line is-running' }, h('span', { class: 'pulse' }), 'Updating the brain'));
    rows.push(h('p', { class: 'brain-sub' }, b.step || 'Starting'));
  } else {
    const bits = [];
    if (b.waiting) bits.push(`${b.waiting} ${b.waiting === 1 ? 'thread' : 'threads'}`);
    if (b.notes) bits.push('your notes');
    if (b.cards) bits.push(`${b.cards} ${b.cards === 1 ? 'card' : 'cards'}`);
    if (b.mail) bits.push('new mail');
    rows.push(h('p', { class: 'brain-line' }, bits.length ? `Not in the brain yet: ${bits.join(', ')}` : 'Nothing new to file in the brain'));
    rows.push(h('button', { class: 'btn btn-brain', type: 'button', disabled: !bits.length, onclick: updateBrain }, 'Update brain ', kbd('Alt U')));
    if (b.brain.error) rows.push(h('p', { class: 'brain-sub is-error' }, b.brain.error));
  }
  if (b.last && !b.running) {
    const last = b.last;
    let text;
    if (last.status === 'failed') text = `Last update failed, ${stamp(last.finishedAt)}`;
    else if (last.status === 'nothing') text = `Last update ${stamp(last.finishedAt)}: nothing to file`;
    else text = `Last update ${stamp(last.finishedAt)}: ${last.changes.length} ${last.changes.length === 1 ? 'file' : 'files'}${last.pushed ? '' : ', not pushed yet'}`;
    rows.push(h('button', { class: `link brain-last${last.status === 'failed' || !last.pushed ? ' is-error' : ''}`, type: 'button', onclick: () => openPanel({ kind: 'run', run: last }) }, text));
  }
  const link = (label, fn) => h('button', { class: 'link keys-link', type: 'button', onclick: fn }, label);
  rows.push(h('div', { class: 'foot-links' },
    link('Scratchpad', () => openPad('scratchpad')),
    link('Notes for Claude', () => openPad('notes')),
    h('a', { class: 'link keys-link', href: '/walk' }, 'Walk mode'),
    link('Connections', () => openPanel({ kind: 'connections' })),
    link('Keys', () => openPanel({ kind: 'keys' })),
  ));
  els.brain.replaceChildren(...rows);
}

function setBrain(status) {
  const wasRunning = S.brain?.running;
  S.brain = status;
  renderBrain();
  if (wasRunning && !status.running && status.last) {
    const last = status.last;
    if (last.status === 'failed') toast(`The brain update failed: ${last.error}`);
    else if (last.status === 'nothing') toast('Brain update finished. Nothing needed filing.');
    else toast(`Brain updated: ${last.changes.length} ${last.changes.length === 1 ? 'file' : 'files'}${last.hasQuestions ? ', and Claude has questions for you' : ''}.`);
    if (S.panel?.kind === 'run') openPanel({ kind: 'run', run: last });
    if (S.pad === 'notes') openPad('notes');
  }
}

async function updateBrain() {
  try {
    const out = await api('POST', '/api/brain/extract', {});
    if (!out.started) toast(out.reason);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- a mail, as a card you can edit and send ----------

const googleOn = () => S.config.fake || S.connections?.google?.connected;

// `onDecided` is set for opportunity and chase cards, where putting the mail in Gmail or
// sending it is the same as accepting the card.
function mailCard(threadId, name, text, info, { onDecided } = {}) {
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
      await api('POST', `/api/threads/${threadId}/mail/${path}`, { name });
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
    const hint = off ? 'Connect Gmail under Connections first' : null;
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
      h('div', { class: 'msg-body' }, renderMarkdown(m.text)),
      h('time', { class: 'msg-time' }, stamp(m.ts)),
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

function projectPicker(t) {
  const tree = S.projects;
  const select = h('select', { class: 'select project-pick', 'aria-label': 'Project', title: 'The project or area this thread belongs to',
    onchange: (e) => api('POST', `/api/threads/${t.id}/project`, { project: e.target.value }).then(() => loadProjects()).catch((err) => toast(err.message)) },
    h('option', { value: '' }, 'No project'));
  for (const g of tree?.groups || []) {
    const group = h('optgroup', { label: g.name });
    if (g.isArea) group.append(h('option', { value: g.name, selected: t.project === g.name }, `${g.name} (the area)`));
    for (const p of g.projects) group.append(h('option', { value: p.name, selected: t.project === p.name }, p.name));
    if (group.children.length) select.append(group);
  }
  if (t.project && !select.querySelector('option[selected]')) select.append(h('option', { value: t.project, selected: true }, t.project));
  return select;
}

function renderHead() {
  if (S.pad) return;
  const t = S.current ? S.threads.get(S.current) : null;
  if (!t) {
    els.head.replaceChildren(h('h1', { class: 'thread-title is-static' }, S.newProject ? `New thread in ${S.newProject}` : 'New thread'),
      S.newProject ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openNew() }, 'Without a project') : null);
    return;
  }
  const title = h('input', {
    class: 'thread-title', 'aria-label': 'Thread name', spellcheck: 'false',
    onchange: (e) => api('POST', `/api/threads/${t.id}/title`, { title: e.target.value }).catch((err) => toast(err.message)),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); els.input.focus(); } },
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
  } else if (t.state === 'ready') {
    status = h('span', { class: 'status status-ready' }, 'Waiting for you');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', title: 'Not now: put it back and show me the next', onclick: requeue }, 'Requeue ', kbd('Alt S')));
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: markDone }, 'Done ', kbd('Alt X')));
  } else {
    status = h('span', { class: 'status status-done' }, t.archived ? 'Done, and in the brain' : 'Done');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/state`, { state: 'ready' }).catch((e) => toast(e.message)) }, 'Reopen'));
  }
  const files = t.kind === 'card' ? [] : S.view?.artifacts || [];
  if (files.length) {
    actions.unshift(h('button', { class: 'btn btn-quiet', type: 'button', onclick: toggleFiles }, `${files.length} ${files.length === 1 ? 'file' : 'files'} `, kbd('Alt A')));
  }
  els.head.replaceChildren(title, status, h('div', { class: 'head-actions' }, t.kind === 'card' ? null : projectPicker(t), actions));
}

function renderComposer() {
  const t = S.current ? S.threads.get(S.current) : null;
  els.composer.hidden = Boolean(S.pad) || t?.kind === 'card';
  const next = nextReady(S.current);
  if (!t) {
    els.input.placeholder = 'What should Claude work on?';
    els.send.textContent = next ? `Start, then open “${clip(next.title)}”` : 'Start thread';
  } else if (t.state === 'working') {
    els.input.placeholder = 'Add to this thread. Claude gets it when this turn ends.';
    els.send.textContent = next ? `Add, then open “${clip(next.title)}”` : 'Add to thread';
  } else {
    els.input.placeholder = t.state === 'done' ? 'Reply to reopen this thread.' : 'Reply.';
    els.send.textContent = next ? `Send, then open “${clip(next.title)}”` : 'Send';
  }
}

function renderEmpty() {
  const ready = inbox().length;
  const busy = working().length;
  let line = 'Nothing is waiting for you.';
  if (busy) line += ` Claude is working on ${busy} ${busy === 1 ? 'thread' : 'threads'}; the first one to finish opens here.`;
  els.messages.replaceChildren(h('div', { class: 'empty' },
    h('p', { class: 'empty-lead' }, S.newProject ? `Start a thread on ${S.newProject}. Claude begins with the project’s notes loaded.` : ready ? 'Start something new, or pick a thread on the left.' : line),
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

async function renderCard(t) {
  const info = S.view.artifacts.find((a) => a.name === 'Message.md');
  const raw = await (await fetch(`/api/threads/${t.id}/artifact?name=Message.md`)).text();
  if (t.id !== S.current) return;
  const card = t.card || {};
  const decided = t.state !== 'ready';
  const head = h('div', { class: 'card-head' },
    h('p', { class: 'card-why' }, card.why || ''),
    h('p', { class: 'card-to' }, card.channel === 'linkedin' ? 'LinkedIn note to ' : card.channel === 'mail' ? 'Mail to ' : 'Message to ', h('strong', {}, card.to || 'someone'),
      card.link ? [' (', h('a', { href: card.link, target: '_blank', rel: 'noopener noreferrer' }, 'open their page'), ')'] : null),
  );
  const decide = async (outcome) => {
    try {
      await flush();
      if (outcome === 'accepted') {
        await navigator.clipboard.writeText(area.value).catch(() => {});
        if (card.link) window.open(card.link, '_blank', 'noopener');
      }
      const out = await api('POST', `/api/threads/${t.id}/card`, { outcome });
      S.threads.set(t.id, out.thread);
      toast(outcome === 'accepted' ? 'Accepted. The text is copied.' : 'Declined.');
      advance(t.id);
    } catch (err) { toast(err.message); }
  };

  let area = null;
  let flush = async () => {};
  let bodyEl;
  if (parseMail(raw)) {
    bodyEl = mailCard(t.id, 'Message.md', raw, info, { onDecided: () => advance(t.id) });
  } else {
    area = h('textarea', { class: 'card-text', spellcheck: 'true', disabled: decided, 'aria-label': 'The message. Edit it here.' });
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
  }
  const buttons = decided ? h('p', { class: 'card-done' }, `You ${card.outcome || 'decided'} this${card.how ? ` (${card.how})` : ''}.`)
    : h('div', { class: 'card-actions' },
      parseMail(raw) ? null : h('button', { class: 'btn btn-send', type: 'button', onclick: () => decide('accepted') }, 'Accept and copy ', kbd('Y')),
      h('button', { class: 'btn', type: 'button', onclick: () => decide('declined') }, 'Decline ', kbd('N')),
      h('span', { class: 'card-hint' }, parseMail(raw) ? 'Putting it in Gmail or sending it accepts the card.' : 'Edit the text first if you like. While typing: Ctrl+Enter accepts.'),
    );
  S.cardDecide = decided ? null : decide;
  S.cardIsMail = Boolean(parseMail(raw));
  els.messages.replaceChildren(h('div', { class: 'card' }, head, bodyEl, buttons));
  enter(els.messages);
}

// ---------- opening things ----------

let openToken = 0;

async function openThread(id, { keepPanel = false, byQueue = false } = {}) {
  const meta = S.threads.get(id);
  if (!meta) return;
  saveDraft();
  if (!byQueue && meta.state === 'ready' && inbox()[0]?.id !== id) api('POST', '/api/queue/opened', { id }).catch(() => {});
  const token = ++openToken;
  S.pad = null;
  S.current = id;
  S.view = null;
  S.live = null;
  S.cardDecide = null;
  liveEl = null;
  if (!keepPanel && S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderHead();
  renderComposer();
  restoreDraft();
  els.messages.replaceChildren();
  els.messages.className = 'messages quotable';
  if (meta.kind !== 'card') els.input.focus();
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
  renderHead();
  renderComposer();
  restoreDraft();
  els.messages.className = 'messages quotable';
  renderEmpty();
  enter(els.messages);
  els.input.focus();
}

// A pad: a plain page to write in. It saves as you type.
const PADS = {
  scratchpad: { title: 'Scratchpad', about: 'Yours alone. It saves as you type. Claude never reads it, in any thread or run.' },
  notes: { title: 'Notes for Claude', about: 'Half-sentences, updated facts, nudges about how Claude works. The next brain update files them and empties this page, so an empty page means they went in.' },
  profile: { title: 'What the queue has learned', about: 'The queue reads this every time it orders what is waiting. It is rewritten from your choices now and then; correct it or add your own lines, and they are kept.' },
};

async function openPad(name) {
  saveDraft();
  const token = ++openToken;
  S.pad = name;
  S.current = null;
  S.view = null;
  S.live = null;
  S.cardDecide = null;
  if (S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderComposer();
  const pad = PADS[name];
  const state = h('span', { class: 'status' });
  els.head.replaceChildren(h('h1', { class: 'thread-title is-static' }, pad.title), state,
    h('div', { class: 'head-actions' }, name === 'scratchpad' ? null : h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openPad(name === 'notes' ? 'profile' : 'notes') }, name === 'notes' ? 'What the queue has learned' : 'Notes for Claude')));
  els.messages.className = 'messages is-pad';
  els.messages.replaceChildren(h('p', { class: 'pad-about' }, 'Loading…'));
  let text = '';
  try {
    text = (await api('GET', `/api/pads/${name}`)).text;
  } catch (err) { toast(err.message); }
  if (token !== openToken) return;
  const area = h('textarea', { class: 'pad', spellcheck: 'true', 'aria-label': pad.title, placeholder: name === 'notes' ? 'e.g. the room for the meetup is booked. stop suggesting LinkedIn notes to people I already met.' : '' });
  area.value = text;
  const save = debounce(async () => {
    try {
      await api('PUT', `/api/pads/${name}`, { text: area.value });
      state.textContent = `Saved ${clock(Date.now())}`;
    } catch (err) { state.textContent = 'Not saved'; toast(err.message); }
  }, 500);
  area.addEventListener('input', () => { state.textContent = ''; save(); });
  els.messages.replaceChildren(h('p', { class: 'pad-about' }, pad.about), area);
  enter(els.messages);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

async function send() {
  const text = els.input.value.trim();
  if (!text || S.pad) return;
  const from = S.current;
  els.send.disabled = true;
  try {
    if (from) await api('POST', `/api/threads/${from}/messages`, { text });
    else {
      const out = await api('POST', '/api/threads', { text, project: S.newProject });
      S.threads.set(out.thread.id, out.thread);
      S.newProject = '';
    }
    els.input.value = '';
    S.drafts.delete(from || 'new');
    advance(from);
  } catch (err) {
    toast(err.message);
  } finally {
    els.send.disabled = false;
  }
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
  S.panel = panel;
  if (panel.kind === 'artifact') return showArtifact(panel);
  if (panel.kind === 'note') return showNote(panel);
  if (panel.kind === 'run') return showRun(panel.run);
  if (panel.kind === 'files') return showFiles();
  if (panel.kind === 'connections') return showConnections();
  return showKeys();
}

function toggleFiles() {
  if (S.panel && (S.panel.kind === 'artifact' || S.panel.kind === 'files')) { closePanel(); return; }
  const files = S.view?.artifacts || [];
  if (!files.length) { toast('Claude has not made a file in this thread.'); return; }
  if (files.length === 1) openPanel({ kind: 'artifact', threadId: S.current, name: files[0].name });
  else openPanel({ kind: 'files' });
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

async function showConnections() {
  const panel = S.panel;
  const body = h('div', { class: 'panel-body' });
  panelFrame('Connections', [], body);
  let c;
  try {
    c = await api('GET', '/api/connections');
  } catch (err) {
    body.append(h('p', { class: 'panel-note is-error' }, err.message));
    return;
  }
  if (S.panel !== panel) return;
  S.connections = c;
  const block = (title, state, ...rest) => h('section', { class: 'conn' },
    h('h3', { class: 'conn-title' }, title, h('span', { class: `conn-state${state.on ? ' is-on' : ''}${state.bad ? ' is-error' : ''}` }, state.text)), ...rest);
  const note = (text) => h('p', { class: 'panel-note' }, text);

  const g = c.google;
  if (g.connected) {
    body.append(block('Gmail and Calendar', { on: true, text: 'connected' },
      note(`Signed in${g.email ? ` as ${g.email}` : ''}. Threads can search and read your mail, read your calendar and add entries. Only the buttons on a mail put it into Gmail or send it, and only when you press them.`),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await api('POST', '/api/google/disconnect', {}); toast('Disconnected.'); openPanel({ kind: 'connections' }); } }, 'Disconnect')));
  } else if (g.configured) {
    body.append(block('Gmail and Calendar', { text: 'not connected' },
      note('Sign in with Google once. Threads can then read your mail and calendar, the brain update reads new mail, and the buttons on a mail work.'),
      h('a', { class: 'btn btn-brain', href: '/auth/google' }, 'Connect Google')));
  } else {
    body.append(block('Gmail and Calendar', { text: 'not set up' },
      note('This needs a Google client id and secret in config.json first. The steps are in docs/google.md in the app’s folder; they take about ten minutes, once.')));
  }

  const d = c.data;
  body.append(block('Saving the app’s state', d.error ? { bad: true, text: 'not saving' } : d.enabled ? { on: true, text: d.lastPush ? `saved ${stamp(d.lastPush)}` : 'on' } : { text: 'off' },
    note(d.error || (d.enabled
      ? `Threads, water levels, pads, the mood line and what the queue has learned are committed and pushed to ${d.repo} every few minutes. Secrets and the brain clone are left out.`
      : 'The state stays on this computer only. Set dataRepo in config.json to save it to GitHub.'))));

  const v = c.voice;
  body.append(block('Calling the inbox', v.ready ? { on: true, text: 'ready' } : { text: v.enabled ? 'incomplete' : 'off' },
    note(v.ready ? 'Call your Twilio number from one of your allowed phones.'
      : v.enabled ? `Switched on, but config.json still lacks: ${v.missing.join(', ')}. See docs/calling.md.`
        : 'Off. Walk mode does the same from your phone’s browser, for free. A real phone number needs Twilio: docs/calling.md.')));

  const r = c.remote;
  body.append(block('Where the app runs', { on: true, text: r.local ? 'this computer' : 'another computer' },
    note(r.local
      ? (r.allowedHosts.length ? `Also reachable as ${r.allowedHosts.join(', ')}.` : 'Only this computer can reach it. To reach it from your phone (for walk mode) or run it on a Raspberry Pi, see docs/pi.md.')
      : `You are reaching it at ${location.host}.`)));
}

function showKeys() {
  const rows = [
    ['Enter', 'Send, then open what the queue puts next'],
    ['Shift Enter', 'New line'],
    ['Alt N', 'New thread'],
    ['Alt S', 'Requeue: not now, show me the next'],
    ['Alt X', 'Done: close this thread'],
    ['Y / N', 'On a card: accept / decline (Alt Y, Alt N or Ctrl Enter while typing)'],
    ['Alt J / Alt K', 'Next / previous thread in the list'],
    ['Alt A', 'Show or hide the files Claude made in this thread'],
    ['Alt U', 'Update the brain'],
    ['Alt M', 'Jump to the mood line'],
    ['Alt P', 'Scratchpad'],
    ['Esc', 'Close the side panel'],
  ];
  panelFrame('Keyboard shortcuts', [], h('div', { class: 'panel-body' },
    h('dl', { class: 'keys' }, rows.map(([k, text]) => [h('dt', {}, kbd(k)), h('dd', {}, text)])),
    h('p', { class: 'panel-note' }, 'Select any text in a reply, a file or a vault note to quote it in your reply.'),
  ));
}

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
  els.input.focus();
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
    send();
  }
});
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
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
els.mood.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); els.mood.blur(); if (!els.composer.hidden) els.input.focus(); } });
els.model.addEventListener('change', () => api('PUT', '/api/settings', { model: els.model.value }).catch((e) => toast(e.message)));
els.effort.addEventListener('change', () => api('PUT', '/api/settings', { effort: els.effort.value }).catch((e) => toast(e.message)));

function renderSettings() {
  const s = S.settings;
  if (document.activeElement !== els.mood) els.mood.value = s.mood || '';
  const name = (m) => m.charAt(0).toUpperCase() + m.slice(1);
  els.model.replaceChildren(...(s.models || []).map((m) => h('option', { value: m, selected: m === s.model }, name(m))));
  els.effort.replaceChildren(...(s.efforts || []).map((m) => h('option', { value: m, selected: m === s.effort }, name(m))));
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
  if (e.key === 'Escape') {
    if (!els.quote.hidden) { hideQuote(); return; }
    if (S.panel) { closePanel(); if (!els.composer.hidden) els.input.focus(); return; }
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
    KeyU: updateBrain,
    KeyA: toggleFiles,
    KeyM: () => { els.mood.focus(); els.mood.select(); },
    KeyP: () => openPad('scratchpad'),
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

// ---------- events from the server ----------

function onThread(t) {
  const before = S.threads.get(t.id);
  S.threads.set(t.id, t);
  renderRail();
  renderComposer();
  if (t.id === S.current && !S.pad) {
    if (!before || before.state !== t.state || before.title !== t.title || before.archived !== t.archived || before.project !== t.project) {
      const editing = document.activeElement?.classList.contains('thread-title');
      if (!editing) renderHead();
    }
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
  if (S.tab === 'projects' && (!before || before.project !== t.project || before.state !== t.state)) loadProjects();
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
  on('message', onMessage);
  on('live', onLive);
  on('artifacts', onArtifacts);
  on('brain', setBrain);
  on('state', (s) => { S.settings = { ...S.settings, ...s }; renderSettings(); });
  on('queue', (q) => { S.queue = q; renderRail(); renderComposer(); });
  on('cards', (c) => { S.cards = c; renderRail(); if (c.lastError) toast(`Looking for opportunities failed: ${c.lastError}`); });
  on('connections', () => { if (S.panel?.kind === 'connections') openPanel({ kind: 'connections' }); });
  // The page listens first and reads the state second, so nothing that happens in
  // between is missed. After a lost connection it reads the state again.
  let started = false;
  source.onerror = () => { els.app.classList.add('is-offline'); };
  source.onopen = async () => {
    els.app.classList.remove('is-offline');
    try {
      await load();
    } catch { return; }
    if (!started) {
      started = true;
      if (S.config.fake) document.body.classList.add('is-fake');
      loadProjects();
      const first = inbox()[0];
      if (first) openThread(first.id, { byQueue: true });
      else openNew();
      setInterval(renderRail, 30_000);
    } else if (S.current && S.threads.has(S.current)) {
      openThread(S.current, { keepPanel: true, byQueue: true });
    }
  };
}

async function load() {
  const state = await api('GET', '/api/state');
  S.threads = new Map(state.threads.map((t) => [t.id, t]));
  S.config = state.config;
  S.connections = state.connections;
  S.settings = state.settings;
  S.queue = state.queue;
  S.cards = state.cards;
  S.brain = state.brain;
  renderSettings();
  renderRail();
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
