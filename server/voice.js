// Calling the inbox from a phone.
//
// Twilio answers the call, turns your speech into text and the app's text into speech
// (its ConversationRelay). The app does on the phone what it does on the screen: it reads
// you the thread that has waited longest, takes your reply, and moves to the next one.
//
// A call never waits for Claude. What you hear is a spoken digest prepared when the
// thread became ready, and your reply starts Claude's work in the background while the
// call goes on to the next thread.
//
// Walk mode (the app's own page on the phone) uses the same conversation without Twilio.
// Who you talk to in both is the host, in host.js.
//
// Nothing here is reachable unless voice is switched on in config.json. Then two checks
// guard it: the request that starts a call must carry Twilio's signature and come from
// one of your numbers, and the audio connection must present the one-time token that
// request was given.

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { log } from './config.js';
import * as store from './store.js';
import * as runner from './runner.js';
import { queueOrder, recordDecision } from './queue.js';
import { runAgent } from './agent.js';
import { DATA_DIR } from './config.js';
import { getState, setState, readPad, writePad } from './state.js';
import { projectTree } from './projects.js';
import { messageText, readPrompt, voiceActivity } from './util.js';
import { HostSession, interpret } from './host.js';

export { HostSession, interpret };
export const CallSession = HostSession;

let config = null;

// ---------- the app, as the host sees it ----------

function plainSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, x, y) => y || x)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Names the phone is likely to mishear: the projects, and the words Florian listed.
function words() {
  let names = [];
  try {
    names = projectTree().groups.flatMap((g) => [g.name, ...g.projects.map((p) => p.name)]).filter((n) => n && n !== 'No area');
  } catch { /* the vault is not there yet */ }
  const own = (readPad('words') || '').split(/[\n,]+/).map((w) => w.trim()).filter(Boolean);
  return [...new Set([...own, ...names])].join(', ');
}

async function model({ system, prompt, model: name, mode = 'plain' }) {
  const result = await runAgent({ prompt, cwd: DATA_DIR, systemAppend: system, model: name, mode, fake: config.fake });
  if (result.error) throw new Error(result.error);
  return (result.finalText || result.text || '').trim();
}

// A call or a walk goes through the conversations in the queue's order. Cards are left
// to the screen: they are for reading and editing, not for listening.
const app = {
  inbox: () => queueOrder().map((id) => store.getThread(id)).filter((t) => t && t.kind !== 'card'),
  workingCount: () => store.listThreads().filter((t) => t.state === 'working').length,
  workingTitles: () => store.listThreads().filter((t) => t.state === 'working').map((t) => t.title),
  thread: (id) => store.getThread(id),
  digest: (id, lang) => runner.spokenDigest(id, lang),
  cachedDigest: (id, lang) => { const t = store.getThread(id); return t?.spoken && t.spoken.at === t.messageCount && (t.spoken.lang || 'en') === lang ? t.spoken.text : ''; },
  full: (id) => {
    const last = store.readMessages(id).filter((m) => m.role === 'assistant').at(-1);
    return last ? plainSpeech(messageText(last)).slice(0, 6000) : '';
  },
  lastUser: (id) => store.readMessages(id).filter((m) => m.role === 'user' && !m.auto).at(-1)?.text || '',
  reply: (id, text) => { recordDecision('replied', store.getThread(id), { by: 'voice' }); runner.sendMessage(id, text); },
  create: (text) => {
    const thread = store.createThread({ title: runner.titleFrom(text) });
    runner.sendMessage(thread.id, text);
    return thread.title;
  },
  later: (id) => { recordDecision('requeued', store.getThread(id), { by: 'voice' }); store.updateThread(id, { requeuedAt: Date.now() }); },
  done: (id) => { recordDecision('done', store.getThread(id), { by: 'voice' }); store.updateThread(id, { state: 'done', doneAt: Date.now(), error: '' }); },
  mood: () => getState().mood || '',
  setMood: (text) => setState({ mood: String(text) }),
  words,
  // The quick model that decides where speech goes.
  ask: ({ system, prompt }) => model({ system, prompt, model: config.voice.hostModel }),
  // The stronger one for questions the host hands on. It may search the web; if that
  // way of running is unavailable, it answers from what it knows.
  think: async (prompt, lang) => {
    const system = readPrompt('host-think.md');
    try {
      return plainSpeech(await model({ system, prompt, model: config.voice.thinkModel, mode: 'lookup' }));
    } catch (err) {
      log(`host: lookup failed (${err.message}); answering without the web`);
      try { return plainSpeech(await model({ system, prompt, model: config.voice.thinkModel })); } catch { return ''; }
    }
  },
};

// ---------- Twilio ----------

const tokens = new Map(); // one-time token -> expiry
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Twilio signs each request: HMAC-SHA1 over the full address plus the sorted form fields.
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const normalNumber = (n) => String(n || '').replace(/[^\d+]/g, '');

export function voiceStatus(config) {
  const v = config.voice;
  const missing = [];
  if (!v.publicUrl) missing.push('publicUrl');
  if (!v.authToken) missing.push('authToken');
  if (!v.allowedCallers.length) missing.push('allowedCallers');
  // The public address must not double as a private one: everything served under an
  // allowed host is the whole app, and this address is open to the internet.
  let publicHost = '';
  try { publicHost = new URL(v.publicUrl).host.toLowerCase(); } catch { /* reported above */ }
  if (publicHost && (config.allowedHosts || []).map((h) => String(h).toLowerCase()).includes(publicHost)) {
    missing.push('a publicUrl whose host is not also listed in allowedHosts');
  }
  return { enabled: Boolean(v.enabled), ready: Boolean(v.enabled) && !missing.length, missing };
}

// The answer to Twilio's "a call is coming in": connect it to this app, or turn it away.
export function answerCall(config, { path, params, signature }) {
  const v = config.voice;
  if (!voiceStatus(config).ready) return { status: 404, body: 'Not found' };
  const url = v.publicUrl.replace(/\/+$/, '') + path;
  if (!safeEqual(signature || '', twilioSignature(v.authToken, url, params))) return { status: 403, body: 'Forbidden' };
  const allowed = v.allowedCallers.map(normalNumber);
  if (!allowed.includes(normalNumber(params.From))) {
    log(`voice: turned away a call from ${params.From}`);
    return { status: 200, type: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>' };
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + 60_000);
  const ws = `${url.replace(/^http/, 'ws').replace(/\/voice\/twiml.*$/, '')}/voice/ws`;
  const body = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>'
    + `<ConversationRelay url="${xml(ws)}" language="${xml(v.language)}" dtmfDetection="true" interruptible="true" speechTimeout="${Number(v.speechTimeoutMs) || 2500}">`
    + `<Parameter name="token" value="${token}"/>`
    + '</ConversationRelay></Connect></Response>';
  return { status: 200, type: 'text/xml', body };
}

function redeem(token) {
  const expires = tokens.get(token);
  tokens.delete(token);
  for (const [t, e] of tokens) if (e < Date.now()) tokens.delete(t);
  return Boolean(expires && expires > Date.now());
}

// Accepts the audio connection Twilio opens for a call, and the connection the app's own
// walk mode opens from the phone's browser. Both speak the same few messages; they
// differ in who is let in. A call must present Twilio's one-time token. Walk mode must
// come from one of the app's own pages, under an address the app answers to.
//
// A walk loses its connection now and then (a tunnel, a dead spot). Its conversation is
// kept for a while, so the page can pick it up where it was, and anything said to it in
// the meantime is delivered then.
const WALK_KEEP_MS = 30 * 60_000;
let walk = null; // { session, outbox: [{seq, token}], seq, send, lostAt }

export function attachVoice(server, cfg, allowedHosts) {
  config = cfg;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/voice/ws' && voiceStatus(config).ready) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, false));
      return;
    }
    const host = String(req.headers.host || '').toLowerCase();
    const origin = String(req.headers.origin || '').replace(/^https?:\/\//, '').toLowerCase();
    if (pathname === '/walk/ws' && allowedHosts.has(host) && origin === host) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, true));
      return;
    }
    socket.destroy();
  });

  // A thread that becomes ready is told to whoever is talking to the host.
  const sessions = new Set();
  store.events.on('thread', (thread) => { if (thread.state === 'ready') for (const s of sessions) s.threadReady(thread); });

  wss.on('connection', (ws, trusted) => {
    let session = null;
    const send = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    // A connection that does not identify itself at once is not Twilio.
    const deadline = setTimeout(() => { if (!session) ws.close(1008, 'no setup'); }, 5000);

    const startWalk = (msg) => {
      const lang = String(msg.lang || 'en-US');
      voiceActivity.at = Date.now();
      voiceActivity.lang = lang.toLowerCase().startsWith('de') ? 'de' : 'en';
      const kept = walk && !walk.session.ended && (!walk.lostAt || Date.now() - walk.lostAt < WALK_KEEP_MS);
      if (msg.resume && kept) {
        // The page is back: same conversation, and whatever it has not heard yet.
        walk.send = send;
        walk.lostAt = 0;
        walk.session.setLanguage(lang);
        // A page that knows this conversation gets what it missed, to be read out. A page
        // that does not (opened anew) gets the last thing said, to show where things are.
        const seen = msg.sid === walk.sid && Number.isFinite(msg.seen) ? msg.seen : null;
        if (seen === null) {
          const lastSaid = walk.outbox.at(-1);
          if (lastSaid) send({ type: 'text', token: lastSaid.token, last: true, seq: lastSaid.seq, sid: walk.sid, replay: true });
        } else {
          for (const item of walk.outbox) if (item.seq > seen) send({ type: 'text', token: item.token, last: true, seq: item.seq, sid: walk.sid });
        }
        walk.session.status();
        return walk.session;
      }
      if (walk) { walk.session.ended = true; sessions.delete(walk.session); }
      const mine = { session: null, outbox: [], seq: 0, send, lostAt: 0, sid: crypto.randomBytes(6).toString('hex') };
      mine.session = new HostSession({
        say: (text) => {
          mine.seq += 1;
          mine.outbox.push({ seq: mine.seq, token: text });
          if (mine.outbox.length > 30) mine.outbox.shift();
          mine.send({ type: 'text', token: text, last: true, seq: mine.seq, sid: mine.sid });
        },
        hangUp: () => setTimeout(() => mine.send({ type: 'end' }), 400),
        notify: (message) => mine.send(message),
        app,
        lang,
      });
      walk = mine;
      sessions.add(mine.session);
      mine.session.start();
      return mine.session;
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!session) {
        if (msg.type !== 'setup' || !(trusted || redeem(msg.customParameters?.token))) { ws.close(1008, 'not allowed'); return; }
        clearTimeout(deadline);
        log(trusted ? `voice: walk mode ${msg.resume ? 'reconnected' : 'connected'}` : `voice: call from ${msg.from} connected`);
        if (trusted) { session = startWalk(msg); return; }
        session = new HostSession({
          say: (text) => send({ type: 'text', token: text, last: true }),
          hangUp: () => setTimeout(() => send({ type: 'end' }), 2500),
          app,
          lang: config.voice.language,
        });
        sessions.add(session);
        session.start();
        return;
      }
      if (trusted) voiceActivity.at = Date.now();
      if (msg.type === 'prompt' && msg.last !== false) {
        if (trusted && msg.lang) session.setLanguage(msg.lang);
        session.heard(msg.voicePrompt, trusted && Array.isArray(msg.alternatives) ? msg.alternatives.slice(0, 5).map(String) : [], { typed: trusted && msg.typed === true });
      } else if (msg.type === 'dtmf') session.key(String(msg.digit));
      else if (msg.type === 'error') log(`voice: Twilio reported: ${msg.description}`);
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (!session) return;
      if (trusted) {
        // Kept for a reconnect; speech meant for the page waits in the outbox.
        if (walk?.session === session && walk.send === send) { walk.send = () => {}; walk.lostAt = Date.now(); }
        log('voice: walk mode disconnected');
      } else {
        session.ended = true;
        sessions.delete(session);
        log('voice: call ended');
      }
    });
  });
  return wss;
}
