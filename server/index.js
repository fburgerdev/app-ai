// The local server: serves the interface and the API it talks to.
// Bound to this computer only (127.0.0.1); nothing here is reachable from outside.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import express from 'express';
import { loadConfig, log, DATA_DIR } from './config.js';
import * as brain from './brain.js';
import * as store from './store.js';
import * as runner from './runner.js';
import * as extraction from './extract.js';
import * as google from './google.js';
import { initReads, logRead } from './reads.js';
import * as queue from './queue.js';
import * as cards from './cards.js';
import * as projects from './projects.js';
import * as datasync from './datasync.js';
import { parseMail } from './mail.js';
import { getState, setState, readPad, writePad, MODELS, EFFORTS } from './state.js';
import { dateTimeDMY } from './util.js';
import { answerCall, attachVoice, voiceStatus } from './voice.js';
import { ROOT } from './util.js';

const config = loadConfig();
const wantsOpen = process.argv.includes('--open');
const url = `http://localhost:${config.port}`;

brain.initBrain(config);
runner.initRunner(config);
extraction.initExtraction(config);
google.initGoogle(config);
initReads(config);
queue.initQueue(config);
cards.initCards(config);
await datasync.initDataSync(config);
// Threads are loaded after the data repo had its chance to restore them.
store.loadThreads();

const app = express();
app.disable('x-powered-by');

// ---------- only this computer's own browser may talk to the API ----------
//
// Any web page can make a browser send requests to localhost. Two checks stop that:
// the Host header must be this server (blocks DNS rebinding), and anything that changes
// state must come from this app's own pages and carry JSON (which other sites cannot
// send without asking permission first, and permission is never given).
const localHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`]);
const allowedHosts = new Set([...localHosts, ...(config.allowedHosts || []).map((h) => String(h).toLowerCase())]);
const isLocal = (req) => localHosts.has(req.headers.host || '');

// Twilio's "a call is coming in". It arrives from the internet, so it is checked on its
// own terms (Twilio's signature and your phone number) instead of by address.
app.post('/voice/twiml', express.urlencoded({ extended: false }), (req, res) => {
  const out = answerCall(config, { path: req.originalUrl, params: req.body || {}, signature: req.headers['x-twilio-signature'] });
  if (out.type) res.type(out.type);
  res.status(out.status).send(out.body);
});

app.use((req, res, next) => {
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return res.status(403).send('Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return res.status(403).send('Forbidden');
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).send('JSON only');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '5mb' }));

// ---------- the interface and its libraries ----------
const vendor = (route, dir) => app.use(route, express.static(path.join(ROOT, 'node_modules', dir), { maxAge: '1d' }));
vendor('/vendor/marked', 'marked/lib');
vendor('/vendor/dompurify', 'dompurify/dist');
vendor('/vendor/katex', 'katex/dist');
vendor('/vendor/highlight', '@highlightjs/cdn-assets');
vendor('/vendor/fonts/literata', '@fontsource-variable/literata');
vendor('/vendor/fonts/instrument-sans', '@fontsource-variable/instrument-sans');
vendor('/vendor/fonts/jetbrains-mono', '@fontsource-variable/jetbrains-mono');
// The mail file format is the same code on both sides.
app.get('/mail.js', (req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'server', 'mail.js')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// ---------- state and live updates ----------
// `local` says whether the browser runs on the same computer as the app. Opening a file
// in another program only makes sense there.
function publicConfig(req) {
  return { threadShell: config.threadShell, fake: config.fake, dataDir: DATA_DIR, brainRepo: config.brainRepo, local: isLocal(req) };
}

function connections(req) {
  return {
    google: google.googleStatus(),
    voice: voiceStatus(config),
    remote: { local: isLocal(req), allowedHosts: config.allowedHosts || [] },
    data: datasync.dataSyncStatus(),
    app: version,
  };
}

// Which version runs and whether Claude is in the middle of something. The Pi's update
// script asks this before it restarts the app.
const version = (() => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h|%cI|%s'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim().split('|');
    return { commit: out[0], date: out[1], subject: out.slice(2).join('|') };
  } catch {
    return { commit: '', date: '', subject: '' };
  }
})();
const isBusy = () => store.listThreads().some((t) => t.state === 'working') || extraction.extractionStatus().running || cards.cardsStatus().running;
app.get('/api/health', (req, res) => res.json({ ok: true, busy: Boolean(isBusy()), version: version.commit }));

app.get('/api/state', (req, res) => {
  cards.maybeMakeCards();
  res.json({
    threads: store.listThreads(),
    brain: extraction.extractionStatus(),
    config: publicConfig(req),
    connections: connections(req),
    settings: { ...getState(), models: MODELS, efforts: EFFORTS },
    queue: queue.queueStatus(),
    cards: cards.cardsStatus(),
  });
});

// The mood line, the model and the effort. Saved as you change them; nothing is sent.
app.put('/api/settings', (req, res) => {
  const { mood, model, effort } = req.body || {};
  res.json(setState({ mood, model, effort }));
});

// Pads: the scratchpad, notes for Claude, and the queue's learned profile.
app.get('/api/pads/:name', (req, res) => {
  const text = readPad(req.params.name);
  if (text === null) return res.status(404).json({ error: 'No such pad' });
  res.json({ text });
});

app.put('/api/pads/:name', (req, res) => {
  if (!writePad(req.params.name, String(req.body.text ?? ''))) return res.status(404).json({ error: 'No such pad' });
  if (req.params.name === 'notes') store.events.emit('brain', extraction.extractionStatus());
  res.json({ ok: true });
});

app.get('/api/projects', (req, res) => res.json(projects.projectTree()));

app.get('/api/connections', (req, res) => res.json(connections(req)));

// ---------- signing in to Google ----------
const ownOrigin = (req) => `${isLocal(req) ? 'http' : 'https'}://${req.headers.host}`;

app.get('/auth/google', (req, res) => {
  if (!google.googleStatus().configured) return res.status(400).send('Add your Google client id and secret to config.json first. See docs/google.md.');
  res.redirect(google.authUrl(`${ownOrigin(req)}/auth/google/callback`));
});

app.get('/auth/google/callback', async (req, res) => {
  const page = (text) => `<!doctype html><meta charset="utf-8"><title>Inbox</title><body style="background:#1b1d2a;color:#dfe1ee;font:16px system-ui;padding:3rem"><p>${text}</p><p><a style="color:#8cc4ff" href="/">Back to the inbox</a></p>`;
  if (req.query.error) return res.status(400).send(page('Google sign-in was cancelled.'));
  try {
    const email = await google.finishAuth({ code: String(req.query.code || ''), state: String(req.query.state || '') });
    store.events.emit('connections', connections(req));
    res.send(page(`Gmail and Calendar are connected${email ? ` as ${email.replace(/[<>&]/g, '')}` : ''}. New turns in every thread can use them.`));
  } catch (err) {
    res.status(400).send(page(String(err.message).replace(/[<>&]/g, '')));
  }
});

app.post('/api/google/disconnect', (req, res) => {
  google.disconnect();
  res.json(connections(req));
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 1500\n\n');
  const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const handlers = {
    thread: send('thread'),
    'thread-deleted': send('thread-deleted'),
    message: send('message'),
    live: send('live'),
    state: send('state'),
    queue: send('queue'),
    cards: send('cards'),
    artifacts: send('artifacts'),
    brain: send('brain'),
    connections: send('connections'),
  };
  for (const [name, fn] of Object.entries(handlers)) store.events.on(name, fn);
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(beat);
    for (const [name, fn] of Object.entries(handlers)) store.events.off(name, fn);
  });
});

// ---------- threads ----------
const need = (req, res) => {
  const thread = store.getThread(req.params.id);
  if (!thread) res.status(404).json({ error: 'No such thread' });
  return thread;
};

const cleanText = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();

app.post('/api/threads', (req, res) => {
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Write a message first.' });
  const project = String(req.body.project || '');
  const thread = store.createThread({ title: runner.titleFrom(text), project: projects.isKnownProject(project) ? project : '' });
  runner.sendMessage(thread.id, text);
  cards.maybeMakeCards();
  res.json({ thread: store.getThread(thread.id) });
});

app.get('/api/threads/:id', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  res.json({
    thread,
    messages: store.readMessages(thread.id),
    live: runner.liveParts(thread.id),
    artifacts: store.listArtifacts(thread.id),
  });
});

app.post('/api/threads/:id/messages', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Write a message first.' });
  if (thread.kind === 'card') return res.status(409).json({ error: 'A card takes no reply. Edit its text, then accept or decline.' });
  if (thread.state === 'done') store.updateThread(thread.id, { state: 'ready' });
  queue.recordDecision('replied', thread);
  const message = runner.sendMessage(thread.id, text);
  cards.maybeMakeCards();
  res.json({ message, thread: store.getThread(thread.id) });
});

// "Send into a spin-off": the message starts a new thread that begins as a copy of this
// one. Nothing is sent here; this thread goes to the back of the queue, since he has
// just dealt with it.
app.post('/api/threads/:id/spinoff', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Write a message first.' });
  if (thread.kind === 'card') return res.status(409).json({ error: 'A card cannot be spun off.' });
  queue.recordDecision('spun off', thread);
  const copy = store.copyThread(thread.id, { title: runner.titleFrom(text) });
  if (thread.state === 'ready') store.updateThread(thread.id, { requeuedAt: Date.now() });
  runner.sendMessage(copy.id, text);
  res.json({ thread: store.getThread(copy.id), from: store.getThread(thread.id) });
});

app.post('/api/threads/:id/state', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.state === 'working') return res.status(409).json({ error: 'Claude is still working on this thread.' });
  const { state } = req.body;
  if (state === 'done') {
    queue.recordDecision('done', thread);
    store.updateThread(thread.id, { state: 'done', doneAt: Date.now(), error: '' });
    cards.maybeMakeCards();
  }
  else if (state === 'ready') store.updateThread(thread.id, { state: 'ready', queuedAt: Date.now(), archived: false });
  else return res.status(400).json({ error: 'Unknown state' });
  res.json({ thread: store.getThread(thread.id) });
});

// Requeue: not now. The thread stays waiting but goes to the back for a while, and the
// queue learns from it.
app.post('/api/threads/:id/skip', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  queue.recordDecision('requeued', thread);
  cards.maybeMakeCards();
  res.json({ thread: store.updateThread(thread.id, { requeuedAt: Date.now() }) });
});

// Florian dragged a waiting thread to another place in the queue.
app.post('/api/queue/move', (req, res) => {
  const thread = store.getThread(String(req.body.id || ''));
  if (!thread || thread.state !== 'ready') return res.status(409).json({ error: 'Only a waiting thread can be moved.' });
  res.json(queue.moveTo(thread, req.body.index));
});

// Florian opened a waiting thread by hand instead of the one the queue offered.
app.post('/api/queue/opened', (req, res) => {
  const thread = store.getThread(String(req.body.id || ''));
  if (thread && thread.state === 'ready' && queue.queueOrder()[0] !== thread.id) queue.recordDecision('opened', thread);
  res.json({ ok: true });
});

app.post('/api/threads/:id/project', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const project = String(req.body.project || '');
  if (project && !projects.isKnownProject(project)) return res.status(400).json({ error: 'That project is not in the vault\'s Projects Index.' });
  res.json({ thread: store.updateThread(thread.id, { project }) });
});

app.post('/api/threads/:id/title', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const title = cleanText(req.body.title).slice(0, 120);
  if (!title) return res.status(400).json({ error: 'A thread needs a name.' });
  res.json({ thread: store.updateThread(thread.id, { title }) });
});

// Deletes a thread for good. For chats that were a test, random, or nothing for the brain.
app.delete('/api/threads/:id', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.state === 'working') runner.stopTurn(thread.id);
  log(`thread deleted: "${thread.title}"`);
  store.deleteThread(thread.id);
  datasync.saveNow('thread deleted').catch(() => {});
  res.json({ deleted: true });
});

app.post('/api/threads/:id/stop', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  res.json({ stopped: runner.stopTurn(thread.id) });
});

// ---------- artifacts ----------
const TYPES = {
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
};

app.get('/api/threads/:id/artifact', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const name = String(req.query.name || '');
  const file = store.artifactPath(thread.id, name, req.query.v);
  if (!file) return res.status(404).send('No such file');
  const ext = path.extname(name).toLowerCase();
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  // A page Claude wrote is shown, but boxed in: it cannot reach this app's API.
  if (ext !== '.pdf') res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`);
  fs.createReadStream(file).pipe(res);
});

function openWithSystem(file, reveal) {
  if (process.platform === 'win32') {
    execFile('explorer.exe', reveal ? [`/select,${file}`] : [file], { windowsHide: false }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', reveal ? ['-R', file] : [file], () => {});
  } else {
    execFile('xdg-open', [reveal ? path.dirname(file) : file], () => {});
  }
}

app.post('/api/threads/:id/artifact/open', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (!isLocal(req)) return res.status(409).json({ error: 'The app runs on another computer, so it cannot open a program on this one. Use Download.' });
  const file = store.artifactLivePath(thread.id, String(req.body.name || ''));
  if (!file) return res.status(404).json({ error: 'That file is no longer in the thread\'s folder.' });
  openWithSystem(file, Boolean(req.body.reveal));
  res.json({ ok: true });
});

// Florian's own edit of a file or of a card's text.
app.post('/api/threads/:id/artifact/save', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const name = String(req.body.name || '');
  const info = store.listArtifacts(thread.id).find((a) => a.name === name);
  if (!info) return res.status(404).json({ error: 'No such file' });
  if (info.mail?.sentAt) return res.status(409).json({ error: 'This mail has been sent and can no longer be changed.' });
  res.json({ artifact: store.saveArtifact(thread.id, name, String(req.body.content ?? '')) });
});

// ---------- mail: the two buttons ----------
//
// These are the only places in the app that put anything into Gmail, and both run only
// on Florian's click. Claude has no tool that reaches them.
function mailFor(req, res) {
  const thread = need(req, res);
  if (!thread) return null;
  const name = String(req.body.name || '');
  const info = store.listArtifacts(thread.id).find((a) => a.name === name);
  const mail = info ? parseMail(store.readArtifactText(thread.id, name)) : null;
  if (!mail) { res.status(404).json({ error: 'That file is not a mail.' }); return null; }
  if (info.mail?.sentAt) { res.status(409).json({ error: 'This mail has already been sent.' }); return null; }
  if (!config.fake && !google.googleConnected()) { res.status(409).json({ error: 'Gmail is not connected. Connect it under Connections.' }); return null; }
  return { thread, name, info, mail, version: info.versions.at(-1).v };
}

app.post('/api/threads/:id/mail/draft', async (req, res) => {
  const m = mailFor(req, res);
  if (!m) return;
  try {
    const out = config.fake ? { draftId: m.info.mail?.draftId || 'stand-in-draft' } : await google.gmailSaveDraft({ draftId: m.info.mail?.draftId, ...m.mail });
    store.setMailInfo(m.thread.id, m.name, { draftId: out.draftId, draftVersion: m.version, draftAt: Date.now() });
    if (m.thread.kind === 'card' && m.thread.state === 'ready') cards.decideCard(m.thread, 'accepted', 'put in Gmail as a draft', req.body.reason);
    res.json({ ok: true, thread: store.getThread(m.thread.id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/threads/:id/mail/send', async (req, res) => {
  const m = mailFor(req, res);
  if (!m) return;
  if (!m.mail.to.trim()) return res.status(400).json({ error: 'The mail has no recipient.' });
  try {
    const out = config.fake ? { messageId: 'stand-in-message' } : await google.gmailSend({ draftId: m.info.mail?.draftId, ...m.mail });
    const sentAt = Date.now();
    store.setMailInfo(m.thread.id, m.name, { sentAt, sentVersion: m.version, messageId: out.messageId, draftId: null });
    if (m.thread.kind === 'card') {
      if (m.thread.state === 'ready') cards.decideCard(m.thread, 'accepted', 'sent', req.body.reason);
    } else {
      // A note in the thread, so Claude and the next brain update know it went out.
      store.appendMessage(m.thread.id, {
        role: 'user',
        event: true,
        text: `[Florian sent the mail "${m.name}" (version ${m.version}) from the app on ${dateTimeDMY(sentAt)}. To: ${m.mail.to}. Subject: ${m.mail.subject}.]`,
      });
    }
    res.json({ ok: true, thread: store.getThread(m.thread.id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------- cards ----------
app.post('/api/threads/:id/card', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.kind !== 'card' || thread.state !== 'ready') return res.status(409).json({ error: 'This card has already been decided.' });
  const outcome = req.body.outcome === 'accepted' ? 'accepted' : req.body.outcome === 'declined' ? 'declined' : null;
  if (!outcome) return res.status(400).json({ error: 'Accept or decline.' });
  cards.decideCard(thread, outcome, outcome === 'accepted' ? 'copied' : '', req.body.reason);
  res.json({ thread: store.getThread(thread.id) });
});

app.post('/api/cards/make', (req, res) => {
  if (!brain.brainStatus().ready) return res.status(409).json({ error: 'The brain is not cloned yet.' });
  cards.makeCards().catch(() => {});
  res.json(cards.cardsStatus());
});

// ---------- the brain ----------
app.post('/api/brain/extract', (req, res) => {
  res.json(extraction.startExtraction({ only: req.body.only === 'mail' ? 'mail' : '' }));
});

app.get('/api/brain/runs', (req, res) => {
  res.json({ runs: extraction.lastRuns(15) });
});

app.post('/api/brain/refresh', async (req, res) => {
  if (!brain.brainStatus().ready) await brain.ensureClone();
  await brain.refresh({ force: true });
  res.json(extraction.extractionStatus());
});

// A note from the vault, for reading beside the chat.
app.get('/api/vault', (req, res) => {
  const link = String(req.query.link || '');
  const found = brain.resolveWikilink(link);
  if (!found) return res.status(404).json({ error: `No note called "${link}" in the vault.` });
  logRead({ by: 'you', path: found.path });
  const ext = path.extname(found.path).toLowerCase();
  if (!['.md', '.txt', '.json', '.csv', '.ps1'].includes(ext)) return res.json({ path: found.path, binary: true });
  res.json({ path: found.path, text: fs.readFileSync(found.full, 'utf8') });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  log(`request failed: ${err.stack || err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

// ---------- start ----------
function openBrowser() {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  else if (process.platform === 'darwin') execFile('open', [url], () => {});
  else execFile('xdg-open', [url], () => {});
}

const server = app.listen(config.port, '127.0.0.1', () => {
  log(`app-ai is running at ${url}  (data: ${DATA_DIR}${config.fake ? ', stand-in Claude' : ''})`);
  if (wantsOpen) openBrowser();
  brain.ensureClone().then(() => brain.refresh({ force: true })).then(() => store.events.emit('brain', extraction.extractionStatus()));
});

attachVoice(server, config, allowedHosts);
datasync.startDataSync();
store.events.on('connections-changed', () => store.events.emit('connections', {}));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`app-ai is already running at ${url}.`);
    if (wantsOpen) openBrowser();
    setTimeout(() => process.exit(0), 300);
  } else {
    throw err;
  }
});
