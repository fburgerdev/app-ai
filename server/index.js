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
import * as checkins from './checkins.js';
import * as repos from './repos.js';
import * as speech from './speech.js';
import * as datasync from './datasync.js';
import * as link from './link.js';
import * as events from './events.js';
import { initRepair, report } from './repair.js';
import { createPruner } from './prune.js';
import { buildPolicy, runAgent } from './agent.js';
import { git as runGit } from './git.js';
import { initShip } from './ship.js';
import { initPi } from './pi.js';
import { stats } from './stats.js';
import { initLabels, reloadLabels } from './labels.js';
import * as nextActions from './nextactions.js';
import { overview as usageOverview } from './usage.js';
import { startSelfUpdate, updateStatus, checkNow } from './selfupdate.js';
import { parseMail, closesOnSend } from './mail.js';
import { getState, setState, reloadState, readPad, writePad, MODELS, EFFORTS, TIERS, TIER_NAMES } from './state.js';
import * as drafts from './drafts.js';
import { dateDMY, dateTimeDMY, readPrompt, todayLine } from './util.js';
import { answerCall, attachVoice, voiceStatus, words as voiceWords } from './voice.js';
import { ROOT } from './util.js';

const config = loadConfig();
const wantsOpen = process.argv.includes('--open');
const url = `http://localhost:${config.port}`;

brain.initBrain(config);
repos.initRepos(config);
runner.initRunner(config);
extraction.initExtraction(config);
google.initGoogle(config);
initReads(config);
speech.initSpeech(config);
queue.initQueue(config);
cards.initCards(config);
await datasync.initDataSync(config);
// Threads are loaded after the data repo had its chance to restore them.
store.loadThreads();
// When the other computer's state comes in later, everything kept in memory is read again.
datasync.onReload(() => { store.reloadThreads(); reloadState(); queue.reloadQueue(); reloadLabels(); });

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
// ---------- the laptop and the Pi ----------
// On the laptop, while the Pi is reachable, the page's requests are passed on to it.
// These few are always this computer's own.
// The night prune (server/prune.js). Florian, 16-11-2026: scheduled, on the Pi, saved part
// by part. Its progress is a file on this computer only, never in the data repo.
const pruner = createPruner({
  stateFile: path.join(DATA_DIR, 'prune-run.json'),
  vaultDir: config.brainDir,
  protectedPaths: config.protectedPaths,
  runAgent: (params) => runAgent({ ...params, fake: config.fake, usageKind: 'prune' }),
  withWriter: brain.withWriter,
  pullForWriting: brain.pullForWriting,
  commitAndPush: brain.commitAndPush,
  discardChanges: brain.discardChanges,
  checkPush: () => runGit(config.brainDir, ['push', '--dry-run', '--quiet', 'origin', `HEAD:${config.brainBranch}`]),
  checkPolicy: async () => {
    const policy = buildPolicy({ mode: 'extract', cwd: config.brainDir, artifactsDir: null, protectedPaths: config.protectedPaths });
    const probes = [
      ['Write', { file_path: path.join(config.brainDir, brain.coreName(), 'People', 'x.md'), content: 'x' }],
      ['Edit', { file_path: path.join(config.brainDir, brain.coreName(), 'Projects Index.md'), old_string: 'a', new_string: 'b' }],
      ['Bash', { command: `rm "${brain.coreName()}/People/x.md"` }],
      ['Bash', { command: `git mv "${brain.coreName()}/Projects/a.md" "Archive/Projects/a.md"` }],
    ];
    for (const [tool, input] of probes) {
      const r = await policy(tool, input);
      if (r.behavior !== 'allow') return `${tool} is refused (${r.message})`;
    }
    return '';
  },
  createReport: ({ title, text }) => {
    const thread = store.createThread({ title, kind: 'brain-update' });
    store.appendMessage(thread.id, { role: 'assistant', parts: [{ type: 'text', text }] });
    store.updateThread(thread.id, { extractedCount: 1, queuedAt: Date.now(), gist: 'The night prune: what went in, and its questions' });
    datasync.saveNow('prune report').catch(() => {});
    return thread.id;
  },
  log,
  readPrompt,
  today: todayLine,
  dateDMY,
  model: () => getState().model,
  effort: () => getState().effort,
});
// A turn held by the usage limit is not work in progress: it must not keep the laptop
// from handing over, or the app from updating itself.
const isBusy = () => store.listThreads().some((t) => t.state === 'working' && !t.held) || extraction.extractionStatus().running || cards.cardsStatus().running || pruner.status().partRunning;
await link.initLink(config, { busy: () => Boolean(isBusy()) });
app.get('/api/link', (req, res) => res.json(link.status()));
app.post('/api/link', express.json(), async (req, res) => res.json(await link.choose(req.body?.choice)));
// The other computer hands over: take in what it saved, or save what is here.
app.post('/api/sync/pull', async (req, res) => {
  try { res.json({ ok: true, changed: await datasync.pullNow() }); } catch (err) { res.status(502).json({ error: err.message }); }
});
// The laptop says every few seconds that it is doing the work, so the Pi leaves the
// background work (cards, events) to it; ?release=1 when it hands over.
app.post('/api/sync/lease', (req, res) => {
  link.takeLease(req.query.release !== '1');
  res.json({ ok: true });
});
// The status line on the laptop: which side does the work, what is still running or
// not saved, and whether the laptop can sleep.
let lastStatusSave = 0;
const laptopHere = Boolean(config.remote) || ['win32', 'darwin'].includes(process.platform) || process.env.APP_AI_STATUS_BAR === '1';
app.get('/api/status', async (req, res) => {
  const l = link.status();
  const threads = store.listThreads().filter((t) => t.state === 'working' && !t.held).map((t) => ({ id: t.id, title: t.title }));
  const extracting = extraction.extractionStatus().running;
  const carding = cards.cardsStatus().running;
  const [saved, unpushed] = await Promise.all([datasync.unsaved(), repos.unpushed().catch(() => [])]);
  const busy = threads.length > 0 || extracting || carding;
  // While getting ready: save as soon as the last turn ends, so "safe" is true when it is.
  if (l.finalizing && !busy && saved.enabled && (saved.files || saved.ahead) && !saved.error) datasync.saveNow('getting ready to suspend').catch(() => {});
  const savedAll = !saved.enabled || (saved.files === 0 && saved.ahead === 0);
  // Changes waiting for the next timed save: saved now, so "saving" means saving.
  if (!savedAll && !saved.error && Date.now() - lastStatusSave > 15_000) { lastStatusSave = Date.now(); datasync.saveNow('state').catch(() => {}); }
  // Four stages, Florian's words (13-11-2026): locked means the app starts nothing by
  // itself, and anything he sends unlocks it again.
  const locked = Boolean(l.finalizing) || l.active === 'remote';
  const doing = busy || !savedAll || l.switching;
  res.json({
    show: laptopHere,
    link: l,
    busy: { threads, extracting, cards: carding },
    saved,
    unpushed,
    locked,
    stage: locked ? (doing ? 'getting-ready' : 'safe') : (doing ? 'busy' : 'idle'),
    safe: locked && !doing,
  });
});
app.post('/api/status/save', async (req, res) => res.json(await datasync.saveNow('state')));
// Getting ready to suspend: nothing new starts and everything is saved; the status line
// says when it is safe. Works whether or not the Pi is there.
app.post('/api/status/finalize', express.json(), (req, res) => {
  res.json({ finalizing: link.setFinalize(req.body?.on !== false) });
});
app.post('/api/sync/push', async (req, res) => {
  const out = await datasync.saveNow('handover');
  if (out.error) return res.status(502).json({ error: out.error });
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => (link.isRemote() ? link.passOn(req, res) : next()));

// Uploads carry a whole file and get a larger limit; everything else stays small.
const smallJson = express.json({ limit: '5mb' });
const BIG = new Set(['/api/uploads', '/api/speech/hear']);
const uploadJson = express.json({ limit: '36mb' });
app.use((req, res, next) => (BIG.has(req.path) ? uploadJson : smallJson)(req, res, next));

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
app.get('/mail.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('text/javascript').sendFile(path.join(ROOT, 'server', 'mail.js')); });
// The page and its modules are always checked against the server (a 304 when unchanged),
// never taken from the browser's cache on trust: after the app updates itself, a cached
// old module next to a new one stops the whole page (17-11-2026).
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

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
    app: { ...version, update: updateStatus() },
  };
}

// Which version runs and whether Claude is in the middle of something. The Pi's update
// script asks this before it restarts the app.
const version = (() => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h|%cI|%s'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim().split('|');
    return { commit: out[0], date: out[1], subject: out.slice(2).join('|'), startedAt: Date.now() };
  } catch {
    return { commit: '', date: '', subject: '' };
  }
})();
app.get('/api/health', (req, res) => res.json({ ok: true, busy: Boolean(isBusy()), pruning: pruner.status().partRunning, version: version.commit }));

app.get('/api/state', (req, res) => {
  cards.maybeMakeCards();
  res.json({
    threads: store.listThreads(),
    brain: extraction.extractionStatus(),
    config: publicConfig(req),
    connections: connections(req),
    settings: { ...getState(), models: MODELS, efforts: EFFORTS, tiers: TIERS, tierNames: TIER_NAMES },
    queue: queue.queueStatus(),
    cards: cards.cardsStatus(),
  });
});

// The mood line, the model, the effort and the sleep time. Saved as you change them; nothing is sent.
app.put('/api/settings', (req, res) => {
  const { mood, model, effort, tier, sleep, focus } = req.body || {};
  res.json(setState({ mood, model, effort, tier, sleep, focus }));
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

// ---------- listening and speaking for the Talk page ----------
app.get('/api/speech', (req, res) => res.json(speech.speechStatus()));

app.post('/api/speech/hear', async (req, res) => {
  try {
    const audio = Buffer.from(String(req.body.audio || ''), 'base64');
    if (audio.length < 200) return res.json({ text: '' });
    res.json(await speech.hear({ audio, mime: String(req.body.mime || ''), lang: req.body.lang, words: voiceWords() }));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/speech/say', async (req, res) => {
  try {
    const out = await speech.say({ text: req.body.text, lang: req.body.lang, engine: req.body.engine });
    res.setHeader('Content-Type', out.type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(out.audio);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/projects', (req, res) => res.json(projects.projectTree()));

// Threads on every active project, every paused one, or on areas (one, or all).
app.post('/api/projects/start', (req, res) => {
  try {
    res.json(checkins.startCheckins(String(req.body.which || ''), String(req.body.name || '')));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/connections', (req, res) => res.json(connections(req)));

// ---------- signing in to Google ----------
const ownOrigin = (req) => `${isLocal(req) ? 'http' : 'https'}://${req.headers.host}`;

app.get('/auth/google', (req, res) => {
  if (!google.googleStatus().configured) return res.status(400).send('Add your Google client id and secret to config.json first. See docs/google.md.');
  res.redirect(google.authUrl(`${ownOrigin(req)}/auth/google/callback`));
});

app.get('/auth/google/callback', async (req, res) => {
  const page = (text) => `<!doctype html><meta charset="utf-8"><title>Brain</title><body style="background:#1b1d2a;color:#dfe1ee;font:16px system-ui;padding:3rem"><p>${text}</p><p><a style="color:#8cc4ff" href="/">Back to the app</a></p>`;
  if (req.query.error) return res.status(400).send(page('Google sign-in was cancelled.'));
  try {
    const email = await google.finishAuth({ code: String(req.query.code || ''), state: String(req.query.state || '') });
    store.events.emit('connections', connections(req));
    log(`google: connected${email ? ` as ${email}` : ''}`);
    res.redirect('/?google=connected');
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
    projects: send('projects'),
    connections: send('connections'),
  };
  for (const [name, fn] of Object.entries(handlers)) store.events.on(name, fn);
  // The page moved to the other computer, or the data was read again from disk: end
  // this stream, so the page connects again and reads the whole state.
  handlers['link-switched'] = () => res.end();
  handlers.reloaded = () => res.end();
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

// ---------- files Florian attaches ----------
//
// A file is uploaded as soon as he picks it and waits in a folder of its own until the
// message it belongs to is sent; then it moves into that thread.

const PENDING = path.join(DATA_DIR, 'uploads-pending');
const MAX_UPLOAD = 25 * 1024 * 1024;
fs.rmSync(PENDING, { recursive: true, force: true }); // what was never sent is not kept

app.post('/api/uploads', (req, res) => {
  // Only the file's own name, whatever path came with it, and nothing a file system minds.
  const name = String(req.body.name || '').split(/[\\/]/).pop().replace(/[:*?"<>|\u0000-\u001f]/g, ' ').replace(/^\.+/, '').trim().slice(0, 140) || 'file';
  let data;
  try { data = Buffer.from(String(req.body.data || ''), 'base64'); } catch { data = null; }
  if (!data?.length) return res.status(400).json({ error: 'That file is empty.' });
  if (data.length > MAX_UPLOAD) return res.status(413).json({ error: 'That file is larger than 25 MB.' });
  const id = store.newId();
  fs.mkdirSync(path.join(PENDING, id), { recursive: true });
  fs.writeFileSync(path.join(PENDING, id, name), data);
  res.json({ id, name, size: data.length });
});

// The upload ids a message names, as the folders they wait in.
const pendingFiles = (ids) => (Array.isArray(ids) ? ids : []).slice(0, 20)
  .map((id) => path.join(PENDING, path.basename(String(id))))
  .filter((dir) => fs.existsSync(dir));

app.get('/api/threads/:id/upload', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const file = store.uploadPath(thread.id, req.query.name);
  if (!file) return res.status(404).send('No such file');
  const ext = path.extname(file).toLowerCase();
  const inline = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md'].includes(ext);
  res.setHeader('Content-Type', TYPES[ext] && inline ? TYPES[ext] : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  fs.createReadStream(file).pipe(res);
});

app.post('/api/threads', (req, res) => {
  link.setFinalize(false); // he is working again
  const text = cleanText(req.body.text);
  const waitingFiles = pendingFiles(req.body.files);
  if (!text && !waitingFiles.length) return res.status(400).json({ error: 'Write a message first.' });
  const project = String(req.body.project || '');
  const known = projects.isKnownProject(project) ? project : '';
  const thread = store.createThread({ title: runner.titleFrom(text || 'Attached files'), project: known });
  // The name is only the first line for now; a project he chose himself stands.
  store.updateThread(thread.id, { titleAuto: true, ...(known ? { projectSet: true } : {}) });
  const pick = req.body.repo !== undefined ? repos.repoName(req.body.repo) : repos.repoName(projects.repoOf(known));
  if (pick || req.body.repo !== undefined) store.updateThread(thread.id, { repo: pick || '', repoSet: true });
  runner.sendMessage(thread.id, text, { files: store.attachFiles(thread.id, waitingFiles), doneAfter: req.body.done === true, tier: String(req.body.tier || '') });
  drafts.clearDraft('new');
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
  link.setFinalize(false); // he is working again
  const thread = need(req, res);
  if (!thread) return;
  const text = cleanText(req.body.text);
  const waitingFiles = pendingFiles(req.body.files);
  if (!text && !waitingFiles.length) return res.status(400).json({ error: 'Write a message first.' });
  if (thread.kind === 'card') return res.status(409).json({ error: 'A card takes no reply. Edit its text, then accept or decline.' });
  if (thread.state === 'done') store.updateThread(thread.id, { state: 'ready' });
  // "Send and done": the message is kept and the thread closes, with no answer.
  const done = req.body.done === true;
  queue.recordDecision(done ? 'replied and closed' : 'replied', thread);
  const message = runner.sendMessage(thread.id, text, { files: store.attachFiles(thread.id, waitingFiles), doneAfter: done, tier: String(req.body.tier || '') });
  drafts.clearDraft(thread.id);
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
  const waitingFiles = pendingFiles(req.body.files);
  if (!text && !waitingFiles.length) return res.status(400).json({ error: 'Write a message first.' });
  if (thread.kind === 'card') return res.status(409).json({ error: 'A card cannot be spun off.' });
  queue.recordDecision('spun off', thread);
  const copy = store.copyThread(thread.id, { title: runner.titleFrom(text || 'Attached files') });
  store.updateThread(copy.id, { titleAuto: true });
  if (thread.state === 'ready') store.updateThread(thread.id, { requeuedAt: Date.now() });
  runner.sendMessage(copy.id, text, { files: store.attachFiles(copy.id, waitingFiles), tier: String(req.body.tier || '') });
  drafts.clearDraft(thread.id);
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
    runner.sign(thread.id, { again: true }).catch(() => {});
    cards.maybeMakeCards();
  }
  else if (state === 'ready') store.updateThread(thread.id, { state: 'ready', queuedAt: Date.now(), archived: false, deferred: false });
  else return res.status(400).json({ error: 'Unknown state' });
  res.json({ thread: store.getThread(thread.id) });
});

// What he has typed and not sent, per thread: kept on the device and here, so it
// survives closing the page or the app and reaches his other devices.
app.get('/api/drafts', (req, res) => res.json({ drafts: drafts.listDrafts() }));
app.put('/api/drafts/:key', (req, res) => {
  try { res.json(drafts.putDraft(req.params.key, req.body?.text, req.body?.at)); } catch (err) { res.status(400).json({ error: err.message }); }
});
store.events.on('thread-deleted', ({ id }) => { try { drafts.dropDraft(id); } catch { /* nothing to drop */ } });

// Defer: not now, but it is his. The thread sleeps; the next brain update turns it into
// a line in Next Actions.md and deletes it. Text sent along is kept as where he left off.
app.post('/api/threads/:id/defer', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  try {
    queue.recordDecision('requeued', thread);
    res.json({ thread: nextActions.defer(thread.id, String(req.body?.text || '')) });
    drafts.clearDraft(thread.id); // what was in the box went along as where he left off
    runner.sign(thread.id, { again: true }).catch(() => {});
  } catch (err) { res.status(409).json({ error: err.message }); }
});

// Pin a thread to the top of the inbox, or take it off. Pinned threads are not part of
// the queue. Events are pinned from the start and can be unpinned like any other.
app.post('/api/threads/:id/pin', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.kind === 'card') return res.status(409).json({ error: 'A card cannot be pinned.' });
  const pinned = req.body?.pinned !== false;
  // A newly pinned thread goes below the ones already there.
  const last = Math.max(0, ...store.listThreads().filter((t) => t.id !== thread.id && store.isPinned(t)).map(store.pinPlace));
  res.json({ thread: store.updateThread(thread.id, pinned ? { pinned: true, pinAt: last + 1, ...(thread.state === 'done' ? { state: 'ready', queuedAt: Date.now(), archived: false, deferred: false } : {}) } : { pinned: false, queuedAt: Date.now() }) });
});

// The order he dragged the pinned threads into.
app.post('/api/pins/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const out = [];
  ids.forEach((id, i) => {
    const t = store.getThread(id);
    if (t && store.isPinned(t)) out.push(store.updateThread(id, { pinAt: i }));
  });
  // Whatever was not in the list keeps its order, below the ones he placed.
  const rest = store.listThreads().filter((t) => store.isPinned(t) && !ids.includes(t.id)).sort((a, b) => store.pinPlace(a) - store.pinPlace(b));
  rest.forEach((t, i) => out.push(store.updateThread(t.id, { pinAt: ids.length + i })));
  res.json({ threads: out });
});
// The same message again, one tier higher, pinned on the thread from now on.
app.post('/api/threads/:id/again', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  try { res.json(runner.againHigher(thread.id)); } catch (err) { res.status(409).json({ error: err.message }); }
});
// Next Actions, as sleeping threads; waking one makes it a thread in the inbox.
app.get('/api/next-actions', (req, res) => res.json(nextActions.list()));
// An event that has not opened yet, opened now because he wants to prepare already.
app.post('/api/events/:id/open', (req, res) => {
  try { res.json({ thread: events.openNow(req.params.id) }); } catch (err) { res.status(404).json({ error: err.message }); }
});
app.post('/api/next-actions/wake', (req, res) => {
  try { res.json({ thread: nextActions.wake({ project: String(req.body?.project || ''), text: String(req.body?.text || '') }) }); } catch (err) { res.status(409).json({ error: err.message }); }
});
app.get('/api/usage', (req, res) => res.json(usageOverview()));
// What happened, counted by week (server/stats.js).
app.get('/api/stats', (req, res) => { try { res.json(stats()); } catch (err) { res.status(500).json({ error: err.message }); } });
// Check for a new version now; `force` updates even while Claude is working.
app.post('/api/update/check', async (req, res) => res.json(await checkNow({ force: req.body?.force === true })));
// For the tests: report a failure the way the app's own parts do.
if (config.fake) app.post('/api/repair/test', (req, res) => res.json({ thread: report(String(req.body.source), String(req.body.message)) }));

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

// The tier this thread keeps ("Again, higher" sets it), or '' to decide per message again.
app.post('/api/threads/:id/tier', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const tier = String(req.body?.tier || '');
  if (tier && !TIER_NAMES.includes(tier)) return res.status(400).json({ error: 'Unknown tier' });
  res.json({ thread: store.updateThread(thread.id, { keepTier: tier }) });
});
app.post('/api/threads/:id/project', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const project = String(req.body.project || '');
  if (project && !projects.isKnownProject(project)) return res.status(400).json({ error: 'That project is not in the vault\'s Projects Index.' });
  // Filed under a project with a repo, a thread without one takes the project's.
  const repo = !thread.repo ? repos.repoName(projects.repoOf(project)) : null;
  res.json({ thread: store.updateThread(thread.id, { project, projectGuessed: true, projectSet: true, projectAuto: false, ...(repo ? { repo, repoSet: true } : {}) }) });
});

app.post('/api/threads/:id/title', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const title = cleanText(req.body.title).slice(0, 120);
  if (!title) return res.status(400).json({ error: 'A thread needs a name.' });
  // A name he gave stands: the app does not rename the thread again.
  res.json({ thread: store.updateThread(thread.id, { title, titleAuto: false }) });
});

// ---------- code: the repo a thread works in ----------

app.get('/api/repos', async (req, res) => {
  try { res.json({ repos: await repos.list() }); } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/threads/:id/repo', async (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  try { res.json({ status: await repos.status(thread.id) }); } catch (err) { res.status(502).json({ error: err.message }); }
});

// Florian picks the repo for a thread (or none). Claude opens it when the work needs it.
app.post('/api/threads/:id/repo', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const raw = String(req.body.repo || '').trim();
  const full = raw ? repos.repoName(raw) : '';
  if (raw && !full) return res.status(400).json({ error: `"${raw}" is not a repo name. Use owner/name or just the name.` });
  if (thread.state === 'working') return res.status(409).json({ error: 'Claude is working in this thread. Change the repo when it is done.' });
  const same = full && thread.repo && full.toLowerCase() === thread.repo.toLowerCase();
  res.json({ thread: store.updateThread(thread.id, { repo: full, repoSet: true, ...(same ? {} : { repoBranch: '', repoMain: '' }) }) });
});

app.get('/api/threads/:id/repo/diff', async (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  res.type('text/plain').send(await repos.fileDiff(thread.id, String(req.query.file || '')).catch((err) => `Could not read the change: ${err.message}`));
});

const repoEvent = (thread, text) => store.appendMessage(thread.id, { role: 'user', event: true, text: `[${text}]` });

app.post('/api/threads/:id/repo/push', async (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  try {
    const compare = await repos.push(thread.id);
    repoEvent(thread, `Florian pushed the branch ${thread.repoBranch} of ${thread.repo} to GitHub on ${dateTimeDMY(Date.now())}.`);
    res.json({ compare, status: await repos.status(thread.id) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/threads/:id/repo/merge', async (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  const branch = thread.repoBranch;
  try {
    const { base } = await repos.merge(thread.id);
    repoEvent(thread, `Florian merged the branch ${branch} into ${base} of ${thread.repo} and pushed it, on ${dateTimeDMY(Date.now())}. The next change in this repo starts on a new branch.`);
    res.json({ status: await repos.status(thread.id) });
  } catch (err) { res.status(409).json({ error: err.message }); }
});

// Deletes a thread for good. For chats that were a test, random, or nothing for the brain.
app.delete('/api/threads/:id', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.state === 'working') runner.stopTurn(thread.id);
  log(`thread deleted: "${thread.title}"`);
  repos.releaseAll(thread.id);
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
//
// A mail counts as sent only once Gmail has answered, which takes a second or two. So a
// second request in that time (a double click, Enter on the focused button) is refused
// here; without this both would get through and the mail would go out twice.
const mailBusy = new Set();
const fakeGmail = () => new Promise((resolve) => { setTimeout(resolve, 25); });

function mailFor(req, res) {
  const thread = need(req, res);
  if (!thread) return null;
  const name = String(req.body.name || '');
  const key = `${thread.id}\n${name}`;
  if (mailBusy.has(key)) { res.status(409).json({ error: 'This mail is already on its way to Gmail.' }); return null; }
  const info = store.listArtifacts(thread.id).find((a) => a.name === name);
  const mail = info ? parseMail(store.readArtifactText(thread.id, name)) : null;
  if (!mail) { res.status(404).json({ error: 'That file is not a mail.' }); return null; }
  if (info.mail?.sentAt) { res.status(409).json({ error: 'This mail has already been sent.' }); return null; }
  if (!config.fake && !google.googleConnected()) { res.status(409).json({ error: 'Gmail is not connected. Connect it under Connections.' }); return null; }
  mailBusy.add(key);
  return { thread, name, info, mail, version: info.versions.at(-1).v, release: () => mailBusy.delete(key) };
}

app.post('/api/threads/:id/mail/draft', async (req, res) => {
  const m = mailFor(req, res);
  if (!m) return;
  try {
    if (config.fake) await fakeGmail();
    const out = config.fake ? { draftId: m.info.mail?.draftId || 'stand-in-draft' } : await google.gmailSaveDraft({ draftId: m.info.mail?.draftId, ...m.mail });
    store.setMailInfo(m.thread.id, m.name, { draftId: out.draftId, draftVersion: m.version, draftAt: Date.now() });
    if (m.thread.kind === 'card' && m.thread.state === 'ready') cards.decideCard(m.thread, 'accepted', 'put in Gmail as a draft', req.body.reason);
    res.json({ ok: true, thread: store.getThread(m.thread.id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    m.release();
  }
});

app.post('/api/threads/:id/mail/send', async (req, res) => {
  const m = mailFor(req, res);
  if (!m) return;
  if (!m.mail.to.trim()) { m.release(); return res.status(400).json({ error: 'The mail has no recipient.' }); }
  try {
    if (config.fake) await fakeGmail();
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
    // A reply sent from a mail thread finishes that thread: it leaves the inbox, as if he
    // had marked it done (Florian, 17-11-2026). The next brain update files and archives it.
    const closed = closesOnSend(store.getThread(m.thread.id), m.mail);
    if (closed) {
      queue.recordDecision('done', closed);
      store.updateThread(closed.id, { state: 'done', doneAt: Date.now(), error: '' });
      runner.sign(closed.id, { again: true }).catch(() => {});
      cards.maybeMakeCards();
    }
    // A reply also takes its conversation out of the Gmail inbox. The mail is out either
    // way, so a refusal here only shows as a note on the toast.
    let archived = false;
    let archiveError = '';
    if (m.mail.replyToThreadId && !config.fake) {
      try {
        await google.gmailArchiveThread({ threadId: out.threadId || m.mail.replyToThreadId });
        archived = true;
      } catch (err) {
        archiveError = err.message;
        log(`mail: sent, but the conversation was not archived in Gmail: ${err.message}`);
      }
    } else if (m.mail.replyToThreadId) archived = true;
    res.json({ ok: true, closed: Boolean(closed), archived, archiveError, thread: store.getThread(m.thread.id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    m.release();
  }
});

// ---------- cards ----------
app.post('/api/threads/:id/card', (req, res) => {
  const thread = need(req, res);
  if (!thread) return;
  if (thread.kind !== 'card' || thread.state !== 'ready') return res.status(409).json({ error: 'This card has already been decided.' });
  const outcome = req.body.outcome === 'accepted' ? 'accepted' : req.body.outcome === 'declined' ? 'declined' : null;
  if (!outcome) return res.status(400).json({ error: 'Accept or decline.' });
  const entry = cards.decideCard(thread, outcome, outcome === 'accepted' ? 'copied' : '', req.body.reason);
  res.json({ thread: store.getThread(thread.id), started: entry.started ? store.getThread(entry.started.id) : null });
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

// The night prune. The Pi's timer starts it with a POST from the Pi itself.
app.post('/api/prune/start', (req, res) => {
  if (!brain.brainStatus().ready) return res.json({ started: false, reason: brain.brainStatus().error || 'The brain is not cloned yet.' });
  res.json(pruner.start({ deadline: req.body?.deadline }));
});
app.get('/api/prune', (req, res) => res.json(pruner.status()));

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
startSelfUpdate(config, { busy: () => Boolean(isBusy()) });
initRepair(config, { send: runner.sendMessage, mayRun: link.mayRunBackground });
initShip(config);
initPi(config);
initLabels(config);
brain.onBrainRetried(() => store.events.emit('brain', extraction.extractionStatus()));
process.on('unhandledRejection', (err) => { log(`unhandled: ${err?.stack || err}`); report('the app itself', String(err?.stack || err)); });
cards.setMayRun(link.mayRunBackground);
// Turns and brain updates held by the usage limit start again when it lifts, on the
// computer that does the work then.
runner.watchHolds(link.mayRunBackground);
extraction.watchHold(link.mayRunBackground);
events.initEvents({ mayRunHere: link.mayRunBackground });
// Threads from before the app named and sorted them by itself get their name, project and
// type now, in the background.
setTimeout(() => { if (link.mayRunBackground() && brain.brainStatus().ready) runner.backfillSignatures().catch(() => {}); }, 20_000).unref?.();
// Turns that will never finish go back to the inbox, but only by the computer that knows:
// its own, at once; the other computer's only when that one is gone and this one works.
const settle = () => {
  const l = link.status();
  const otherGone = link.mayRunBackground() && (!l.enabled || !l.online);
  const n = store.settleOrphans({ isRunning: runner.isRunning, otherGone });
  if (n) log(`threads: ${n} turn(s) that will not finish went back to the inbox`);
};
setTimeout(() => {
  settle();
  if (link.mayRunBackground()) { const n = store.clearFalseErrors(); if (n) log(`threads: cleared a false "ended on an error" from ${n} finished thread(s)`); }
}, 5000).unref?.();
setInterval(settle, 60_000).unref?.();
// Threads from before the workbench: what a script left among the shown files leaves
// the list, once per thread (store.pruneArtifacts). A thread Claude works on now waits.
setTimeout(() => {
  if (!link.mayRunBackground()) return;
  for (const t of store.listThreads()) {
    if (t.artifactsPruned || t.state === 'working') continue;
    try { store.pruneArtifacts(t.id); } catch (err) { log(`could not tidy the files of thread ${t.id}: ${err.message}`); }
  }
}, 8_000).unref?.();
// What that cleanup took out is also taken out of the data repo's saved history, once,
// at a quiet moment: the other computer saves first, and adopts the result by itself.
const PURGE_LIST = path.join(DATA_DIR, 'purge-history.json');
async function purgeWhenQuiet() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PURGE_LIST, 'utf8')); } catch { return; }
  if (!list.length) { fs.rmSync(PURGE_LIST, { force: true }); return; }
  if (!link.mayRunBackground() || store.listThreads().some((t) => t.state === 'working' && !t.held) || extraction.extractionStatus().running) { setTimeout(purgeWhenQuiet, 15 * 60_000).unref?.(); return; }
  await link.remoteSave();
  const r = await datasync.purgeHistory(list).catch((err) => ({ done: false, reason: err.message }));
  if (r.done) fs.rmSync(PURGE_LIST, { force: true });
  else { log(`app data: cleaning the saved history waits: ${r.reason}`); setTimeout(purgeWhenQuiet, 60 * 60_000).unref?.(); }
}
setTimeout(() => purgeWhenQuiet().catch((err) => log(`app data: cleaning the saved history failed: ${err.message}`)), 90_000).unref?.();
// A night prune cut off by a restart (an update, a crash) carries on once the vault is ready.
setTimeout(() => { if (brain.brainStatus().ready) pruner.resume(); }, 45_000).unref?.();
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
