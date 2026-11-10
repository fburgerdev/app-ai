// The interface. One loop: the app shows the thread that has waited longest, you reply,
// Enter sends it and brings up the next one.

import { renderMarkdown, renderInto, highlightPlain } from '/markdown.js';
import { renderDiff } from '/diff.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), lists: $('rail-lists'), brain: $('brain'), head: $('thread-head'),
  scroller: $('scroller'), messages: $('messages'), composer: $('composer'), input: $('input'),
  hint: $('composer-hint'), send: $('send'), panel: $('panel'), quote: $('quote-btn'), toast: $('toast'),
};

const S = {
  threads: new Map(),
  current: null, // thread id, or null for the "new thread" view
  view: null, // { messages, artifacts } of the current thread
  live: null, // parts of the message Claude is writing in the current thread
  brain: null,
  config: {},
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

// ---------- which thread comes next ----------

const all = () => [...S.threads.values()];
const inbox = () => all().filter((t) => t.state === 'ready').sort((a, b) => a.queuedAt - b.queuedAt);
const working = () => all().filter((t) => t.state === 'working').sort((a, b) => a.updatedAt - b.updatedAt);
const done = () => all().filter((t) => t.state === 'done').sort((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt));
const nextReady = (exceptId) => inbox().find((t) => t.id !== exceptId) || null;
const isUnfiled = (t) => (t.lastUserAt || 0) > (t.extractedCount || 0);

function advance(fromId) {
  const next = nextReady(fromId);
  if (next) openThread(next.id);
  else openNew();
}

// ---------- the rail ----------

function railItem(t) {
  let sub = '';
  if (t.state === 'working') sub = t.activity || 'Working';
  else if (t.state === 'ready') sub = t.error ? 'Stopped with an error' : `waiting ${ago(t.queuedAt)}`;
  else sub = t.archived ? 'in the brain' : isUnfiled(t) ? 'not in the brain yet' : 'closed';
  return h('button', {
    class: `item item-${t.state}${t.id === S.current ? ' is-current' : ''}${t.error ? ' has-error' : ''}`,
    type: 'button',
    title: t.title,
    onclick: () => openThread(t.id),
  },
    h('span', { class: 'item-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'item-text' },
      h('span', { class: 'item-title' }, t.title),
      h('span', { class: 'item-sub' }, sub),
    ),
  );
}

function renderRail() {
  const ready = inbox();
  const busy = working();
  const closed = done();
  const section = (label, count, items, extra) => h('section', { class: 'group' },
    h('h2', { class: 'group-head' }, label, count ? h('span', { class: 'count' }, String(count)) : null, extra),
    ...items,
  );
  const parts = [];
  parts.push(section('Waiting for you', ready.length, ready.length
    ? ready.map(railItem)
    : [h('p', { class: 'group-empty' }, busy.length ? 'Nothing yet. Claude is still working.' : 'Nothing is waiting.')]));
  if (busy.length) parts.push(section('Claude is working', busy.length, busy.map(railItem)));
  if (closed.length) {
    const toggle = h('button', { class: 'link', type: 'button', onclick: () => { S.showDone = !S.showDone; renderRail(); } }, S.showDone ? 'Hide' : 'Show');
    parts.push(section('Done', closed.length, S.showDone ? closed.map(railItem) : [], toggle));
  }
  els.lists.replaceChildren(...parts);

  const n = ready.length;
  document.title = n ? `(${n}) Inbox` : 'Inbox';
  if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
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
    const n = b.waiting;
    rows.push(h('p', { class: 'brain-line' }, n ? `${n} ${n === 1 ? 'thread is' : 'threads are'} not in the brain yet` : 'Nothing new to file in the brain'));
    rows.push(h('button', { class: 'btn btn-brain', type: 'button', disabled: !n, onclick: updateBrain }, 'Update brain ', kbd('Alt U')));
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
  rows.push(h('button', { class: 'link keys-link', type: 'button', onclick: () => openPanel({ kind: 'keys' }) }, 'Keyboard shortcuts'));
  els.brain.replaceChildren(...rows);
}

function setBrain(status) {
  const wasRunning = S.brain?.running;
  S.brain = status;
  renderBrain();
  if (wasRunning && !status.running && status.last) {
    if (status.last.status === 'failed') toast(`The brain update failed: ${status.last.error}`);
    else if (status.last.status === 'nothing') toast('Brain update finished. Nothing needed filing.');
    else toast(`Brain updated: ${status.last.changes.length} ${status.last.changes.length === 1 ? 'file' : 'files'}${status.last.hasQuestions ? ', and Claude has questions for you' : ''}.`);
    if (S.panel?.kind === 'run') openPanel({ kind: 'run', run: status.last });
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
  return h('button', { class: 'artifact-card', type: 'button', onclick: () => openPanel({ kind: 'artifact', threadId, name: part.name, v: part.v }) },
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
  const parts = S.live.length ? S.live : [];
  partsInto(liveEl.firstChild, S.current, parts, { live: true });
  if (!parts.length) liveEl.firstChild.append(h('p', { class: 'starting' }, h('span', { class: 'pulse' }), S.threads.get(S.current)?.activity || 'Starting'));
  if (stick) els.scroller.scrollTop = els.scroller.scrollHeight;
}

function scheduleLive() {
  if (!liveTimer) liveTimer = setTimeout(renderLive, 80);
}

const nearBottom = () => els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight < 120;

function renderHead() {
  const t = S.current ? S.threads.get(S.current) : null;
  if (!t) {
    els.head.replaceChildren(h('h1', { class: 'thread-title is-static' }, 'New thread'));
    return;
  }
  const title = h('input', {
    class: 'thread-title', value: t.title, 'aria-label': 'Thread name', spellcheck: 'false',
    onchange: (e) => api('POST', `/api/threads/${t.id}/title`, { title: e.target.value }).catch((err) => toast(err.message)),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); els.input.focus(); } },
  });
  title.value = t.title;
  let status;
  const actions = [];
  if (t.state === 'working') {
    status = h('span', { class: 'status status-working' }, h('span', { class: 'pulse' }), 'Claude is working');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/stop`, {}).catch((e) => toast(e.message)) }, 'Stop'));
  } else if (t.state === 'ready') {
    status = h('span', { class: 'status status-ready' }, 'Waiting for you');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: later }, 'Later ', kbd('Alt S')));
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: markDone }, 'Done ', kbd('Alt X')));
  } else {
    status = h('span', { class: 'status status-done' }, t.archived ? 'Done, and in the brain' : 'Done');
    actions.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api('POST', `/api/threads/${t.id}/state`, { state: 'ready' }).catch((e) => toast(e.message)) }, 'Reopen'));
  }
  const files = S.view?.artifacts || [];
  if (files.length) {
    actions.unshift(h('button', { class: 'btn btn-quiet', type: 'button', onclick: toggleFiles }, `${files.length} ${files.length === 1 ? 'file' : 'files'} `, kbd('Alt A')));
  }
  els.head.replaceChildren(title, status, h('div', { class: 'head-actions' }, actions));
}

function renderComposer() {
  const t = S.current ? S.threads.get(S.current) : null;
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
  els.hint.textContent = 'Enter sends. Shift+Enter makes a new line.';
}

const clip = (s, n = 34) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

function renderEmpty() {
  const ready = inbox().length;
  const busy = working().length;
  let line = 'Nothing is waiting for you.';
  if (busy) line += ` Claude is working on ${busy} ${busy === 1 ? 'thread' : 'threads'}; the first one to finish opens here.`;
  els.messages.replaceChildren(h('div', { class: 'empty' },
    h('p', { class: 'empty-lead' }, ready ? 'Start something new, or pick a thread on the left.' : line),
    h('p', { class: 'empty-sub' }, 'Each thread is its own conversation. Claude reads your brain before answering, and nothing reaches the brain until you update it.'),
  ));
}

function saveDraft() {
  S.drafts.set(S.current || 'new', els.input.value);
}

function restoreDraft() {
  els.input.value = S.drafts.get(S.current || 'new') || '';
  autosize();
}

let openToken = 0;

async function openThread(id, { keepPanel = false } = {}) {
  if (!S.threads.has(id)) return;
  saveDraft();
  const token = ++openToken;
  S.current = id;
  S.view = null;
  S.live = null;
  liveEl = null;
  if (!keepPanel && S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderHead();
  renderComposer();
  restoreDraft();
  els.messages.replaceChildren();
  els.input.focus();
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
  S.live = data.thread.state === 'working' ? (data.live || []) : null;
  renderHead();
  els.messages.replaceChildren(...data.messages.map((m) => messageEl(id, m)));
  if (S.live) renderLive();
  // Start reading where Claude's latest message starts, not at its end.
  const claude = [...els.messages.querySelectorAll('.msg-claude')].at(-1);
  if (claude && !S.live) {
    els.scroller.scrollTop = Math.max(0, claude.offsetTop - 24);
  } else {
    els.scroller.scrollTop = els.scroller.scrollHeight;
  }
}

function openNew() {
  saveDraft();
  openToken += 1;
  S.current = null;
  S.view = null;
  S.live = null;
  liveEl = null;
  if (S.panel && S.panel.kind === 'artifact') closePanel();
  renderRail();
  renderHead();
  renderComposer();
  restoreDraft();
  renderEmpty();
  els.input.focus();
}

async function send() {
  const text = els.input.value.trim();
  if (!text) return;
  const from = S.current;
  els.send.disabled = true;
  try {
    if (from) await api('POST', `/api/threads/${from}/messages`, { text });
    else {
      const out = await api('POST', '/api/threads', { text });
      S.threads.set(out.thread.id, out.thread);
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

async function later() {
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
  if (!t || t.state !== 'ready') return;
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

function closePanel() {
  S.panel = null;
  els.panel.hidden = true;
  els.panel.replaceChildren();
  els.app.classList.remove('has-panel');
}

function panelFrame(title, tools, body) {
  els.panel.replaceChildren(
    h('header', { class: 'panel-head' },
      h('h2', { class: 'panel-title', title }, title),
      h('div', { class: 'panel-tools' }, tools, h('button', { class: 'btn btn-quiet', type: 'button', onclick: closePanel }, 'Close ', kbd('Esc'))),
    ),
    body,
  );
  els.panel.hidden = false;
  els.app.classList.add('has-panel');
}

const TEXT_TYPES = ['md', 'txt', 'csv', 'json', 'js', 'mjs', 'ts', 'py', 'css', 'sh', 'ps1', 'yml', 'yaml', 'xml', 'sql', 'tex'];
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

async function openPanel(panel) {
  S.panel = panel;
  if (panel.kind === 'artifact') return showArtifact(panel);
  if (panel.kind === 'note') return showNote(panel);
  if (panel.kind === 'run') return showRun(panel.run);
  if (panel.kind === 'files') return showFiles();
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

  const tools = [];
  if (versions.length > 1) {
    const select = h('select', { class: 'select', 'aria-label': 'Version', onchange: (e) => openPanel({ ...panel, v: Number(e.target.value), diff: panel.diff }) },
      versions.map((n) => h('option', { value: n, selected: n === v }, n === latest ? `Version ${n}, latest` : `Version ${n}`)));
    tools.push(select);
    if (isText && v > versions[0]) {
      tools.push(h('button', { class: `btn btn-quiet${panel.diff ? ' is-on' : ''}`, type: 'button', onclick: () => openPanel({ ...panel, diff: !panel.diff }) }, panel.diff ? 'Hide changes' : 'Show changes'));
    }
  }
  let text = null;
  if (isText) {
    tools.push(h('button', { class: 'btn btn-quiet', type: 'button', onclick: async () => { await navigator.clipboard.writeText(text ?? ''); toast('Copied.'); } }, 'Copy'));
  }
  tools.push(h('button', { class: 'btn btn-quiet', type: 'button', title: 'Open with the program your computer uses for this kind of file', onclick: () => api('POST', `/api/threads/${threadId}/artifact/open`, { name }).catch((e) => toast(e.message)) }, 'Open in app'));
  tools.push(h('a', { class: 'btn btn-quiet', href: `${url}&download=1` }, 'Download'));

  const body = h('div', { class: 'panel-body quotable', dataset: { quoteSource: source } });
  panelFrame(name, tools, body);

  try {
    if (isText) {
      text = await (await fetch(url)).text();
      if (S.panel !== panel) return;
      if (panel.diff && v > versions[0]) {
        const prev = versions[versions.indexOf(v) - 1];
        const before = await (await fetch(`/api/threads/${threadId}/artifact?name=${encodeURIComponent(name)}&v=${prev}`)).text();
        if (S.panel !== panel) return;
        body.append(h('p', { class: 'diff-legend' }, `Changes from version ${prev} to version ${v}: `, h('ins', {}, 'added'), ' ', h('del', {}, 'removed')), renderDiff(before, text));
      } else if (ext === 'md' || ext === 'txt') body.append(renderMarkdown(text));
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
      body.append(h('p', { class: 'panel-note' }, 'This kind of file cannot be shown here. Use “Open in app”.'));
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
    if (note.binary) body.append(h('p', { class: 'panel-note' }, 'This vault file is not text. Open it from the vault.'));
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
      h('p', { class: 'panel-note' }, 'Your threads still count as not filed. Update the brain again when the cause is fixed.'));
  } else {
    body.append(h('p', { class: 'panel-note' },
      `${run.threads.length} ${run.threads.length === 1 ? 'thread' : 'threads'} read: ${run.threads.join(', ')}.`));
    if (run.status === 'nothing') body.append(h('p', { class: 'panel-note' }, 'Nothing in them needed filing.'));
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
    if (run.restored?.length) body.append(h('p', { class: 'panel-note' }, `Left untouched on purpose: ${run.restored.join(', ')}.`));
  }
  panelFrame(`Brain update, ${stamp(run.finishedAt)}`, [], body);
}

function showKeys() {
  const rows = [
    ['Enter', 'Send, then open the next waiting thread'],
    ['Shift Enter', 'New line'],
    ['Alt N', 'New thread'],
    ['Alt S', 'Later: put this thread at the back of the inbox'],
    ['Alt X', 'Done: close this thread'],
    ['Alt J / Alt K', 'Next / previous thread in the list'],
    ['Alt A', 'Show or hide the files Claude made in this thread'],
    ['Alt U', 'Update the brain from all threads'],
    ['Esc', 'Close this panel'],
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
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hideQuote();
  const text = sel.toString().trim();
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  const zone = node?.closest('.quotable');
  if (!text || !zone) return hideQuote();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
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
$('new-thread').addEventListener('click', openNew);
els.quote.addEventListener('mousedown', (e) => e.preventDefault());
els.quote.addEventListener('click', insertQuote);
document.addEventListener('mouseup', () => setTimeout(maybeShowQuote, 0));
document.addEventListener('keyup', (e) => { if (e.shiftKey) maybeShowQuote(); });
els.scroller.addEventListener('scroll', hideQuote, { passive: true });

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

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.quote.hidden) { hideQuote(); return; }
    if (S.panel) { closePanel(); els.input.focus(); }
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const actions = {
    KeyN: openNew,
    KeyS: later,
    KeyX: markDone,
    KeyU: updateBrain,
    KeyA: toggleFiles,
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
  if (t.id === S.current) {
    if (!before || before.state !== t.state || before.title !== t.title || before.archived !== t.archived) {
      const editing = document.activeElement?.classList.contains('thread-title');
      if (!editing) renderHead();
    }
    if (t.state === 'working' && !S.live) { S.live = []; scheduleLive(); }
    if (t.state === 'working' && S.live && !S.live.length) scheduleLive();
    if (t.state !== 'working' && S.live) { S.live = null; liveEl?.remove(); liveEl = null; }
  }
  // On the empty screen with nothing typed, the first thread to finish opens by itself.
  const becameReady = t.state === 'ready' && before && before.state === 'working';
  if (becameReady && S.current === null && !els.input.value.trim()) openThread(inbox()[0].id);
  else if (S.current === null) renderEmpty();
  if (S.brain) {
    S.brain.waiting = all().filter((x) => x.state !== 'working' && isUnfiled(x)).length;
    renderBrain();
  }
}

function onMessage({ threadId, message }) {
  if (threadId !== S.current || !S.view) return;
  S.view.messages.push(message);
  const stick = nearBottom();
  if (message.role === 'assistant') {
    S.live = null;
    liveEl?.remove();
    liveEl = null;
  }
  const el = messageEl(threadId, message);
  if (liveEl?.isConnected) liveEl.before(el);
  else els.messages.append(el);
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
    renderHead();
    if (S.panel?.kind === 'artifact' && S.panel.threadId === threadId && S.panel.followLatest) {
      openPanel({ ...S.panel, v: undefined });
    }
  } catch { /* the next event brings it */ }
}

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('thread', (e) => onThread(JSON.parse(e.data)));
  source.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
  source.addEventListener('live', (e) => onLive(JSON.parse(e.data)));
  source.addEventListener('artifacts', (e) => onArtifacts(JSON.parse(e.data)));
  source.addEventListener('brain', (e) => setBrain(JSON.parse(e.data)));
  let lost = false;
  source.onerror = () => { lost = true; els.app.classList.add('is-offline'); };
  source.onopen = async () => {
    els.app.classList.remove('is-offline');
    if (!lost) return;
    lost = false;
    await load();
    if (S.current && S.threads.has(S.current)) openThread(S.current, { keepPanel: true });
  };
}

async function load() {
  const state = await api('GET', '/api/state');
  S.threads = new Map(state.threads.map((t) => [t.id, t]));
  S.config = state.config;
  S.brain = state.brain;
  renderRail();
  renderBrain();
}

async function boot() {
  try {
    await load();
  } catch (err) {
    els.messages.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'empty-lead' }, 'The app is not running.'), h('p', { class: 'empty-sub' }, 'Start it with “npm start” in the app’s folder, then reload this page.')));
    return;
  }
  if (S.config.fake) document.body.classList.add('is-fake');
  connect();
  const first = inbox()[0];
  if (first) openThread(first.id);
  else openNew();
  setInterval(renderRail, 30_000);
}

boot();
