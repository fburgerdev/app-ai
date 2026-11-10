// The local server: serves the interface and the API it talks to.
// Bound to this computer only (127.0.0.1); nothing here is reachable from outside.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import express from 'express';
import { loadConfig, log, DATA_DIR } from './config.js';
import * as brain from './brain.js';
import * as store from './store.js';
import * as runner from './runner.js';
import * as extraction from './extract.js';
import { ROOT } from './util.js';

const config = loadConfig();
const wantsOpen = process.argv.includes('--open');
const url = `http://localhost:${config.port}`;

brain.initBrain(config);
runner.initRunner(config);
extraction.initExtraction(config);
store.loadThreads();

const app = express();
app.disable('x-powered-by');

// ---------- only this computer's own browser may talk to the API ----------
//
// Any web page can make a browser send requests to localhost. Two checks stop that:
// the Host header must be this server (blocks DNS rebinding), and anything that changes
// state must come from this app's own pages and carry JSON (which other sites cannot
// send without asking permission first, and permission is never given).
const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`]);
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host || '')) return res.status(403).send('Forbidden');
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
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// ---------- state and live updates ----------
function publicConfig() {
  return { threadShell: config.threadShell, fake: config.fake, dataDir: DATA_DIR, brainRepo: config.brainRepo };
}

app.get('/api/state', (req, res) => {
  res.json({ threads: store.listThreads(), brain: extraction.extractionStatus(), config: publicConfig() });
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
    message: send('message'),
    live: send('live'),
    artifacts: send('artifacts'),
    brain: send('brain'),
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
  const thread = store.createThread({ title: runner.titleFrom(text) });
  runner.sendMessage(thread.id, text);
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
  if (thread.state === 'done') store.updateThread(thread.id, { state: 'ready' });
  const message = runner.sendMessage(thread.id, text);
  res.json({ message, thread: store.getThread(thread.id) });
});

app.post('/api/threads/:id/state', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.state === 'working') return res.status(409).json({ error: 'Claude is still working on this thread.' });
  const { state } = req.body;
  if (state === 'done') store.updateThread(thread.id, { state: 'done', doneAt: Date.now(), error: '' });
  else if (state === 'ready') store.updateThread(thread.id, { state: 'ready', queuedAt: Date.now(), archived: false });
  else return res.status(400).json({ error: 'Unknown state' });
  res.json({ thread: store.getThread(thread.id) });
});

// "Later": the thread stays in the inbox but goes to the back of it.
app.post('/api/threads/:id/skip', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  res.json({ thread: store.updateThread(thread.id, { queuedAt: Date.now() }) });
});

app.post('/api/threads/:id/title', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const title = cleanText(req.body.title).slice(0, 120);
  if (!title) return res.status(400).json({ error: 'A thread needs a name.' });
  res.json({ thread: store.updateThread(thread.id, { title }) });
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
  const file = store.artifactLivePath(thread.id, String(req.body.name || ''));
  if (!file) return res.status(404).json({ error: 'That file is no longer in the thread\'s folder.' });
  openWithSystem(file, Boolean(req.body.reveal));
  res.json({ ok: true });
});

// ---------- the brain ----------
app.post('/api/brain/extract', (req, res) => {
  res.json(extraction.startExtraction());
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`app-ai is already running at ${url}.`);
    if (wantsOpen) openBrowser();
    setTimeout(() => process.exit(0), 300);
  } else {
    throw err;
  }
});
