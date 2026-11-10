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

const DICTATED = '[Dictated on a phone call; may contain transcription errors.]';

const COMMANDS = [
  ['send', /^(send|send it|send that|send this|senden|abschicken|schick es ab|schicken)$/],
  ['repeat', /^(repeat|repeat that|again|say that again|say again|nochmal|noch mal|wiederholen|wiederhole)$/],
  ['later', /^(later|skip|skip it|skip this|next|next one|next thread|später|weiter|überspringen)$/],
  ['done', /^(done|mark (it |that |this )?(as )?done|close it|close this|finished|erledigt|fertig)$/],
  ['cancel', /^(cancel|scratch that|start over|delete that|abbrechen|verwerfen|lösch das)$/],
  ['new', /^((start |create |open |make )?(a )?new (thread|chat|conversation)|neuer (thread|chat)|neuen (thread|chat)( starten| anfangen)?)$/],
  ['bye', /^(goodbye|good bye|bye|bye bye|hang up|that's all|thats all|end call|stop|tschüss|tschüs|auf wiedersehen|ende)$/],
  ['help', /^(help|what can i say|hilfe)$/],
];
// Said around a command without changing it: "okay new thread please".
const FILLER = /^(?:(?:ok|okay|okey|please|bitte|hey|claude|um|uh|ähm|äh|so|also|and|und|now|jetzt)\s+)+|(?:\s+(?:please|bitte|now|jetzt|then|dann))+$/g;
// Spoken forms of each command, to catch near misses ("new threat", "nu thread", "sent it").
const SPOKEN = {
  send: ['send', 'send it', 'senden'],
  repeat: ['repeat', 'repeat that', 'say that again', 'wiederholen', 'nochmal'],
  later: ['later', 'skip it', 'next one', 'später', 'weiter'],
  done: ['done', 'mark as done', 'erledigt'],
  cancel: ['cancel', 'scratch that', 'abbrechen', 'verwerfen'],
  new: ['new thread', 'start a new thread', 'neuer thread', 'new chat'],
  bye: ['goodbye', 'hang up', 'tschüss'],
  help: ['help', 'hilfe'],
};

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[.,!?¿¡"“”„]/g, '').replace(/\s+/g, ' ').trim();
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

// The command a short utterance is, exactly or nearly; null if none.
function commandOf(norm) {
  const bare = norm.replace(FILLER, '').trim();
  for (const candidate of [norm, bare]) {
    for (const [command, pattern] of COMMANDS) if (pattern.test(candidate)) return command;
  }
  // Near misses only for short utterances, so ordinary dictation is never taken for a command.
  if (!bare || bare.split(' ').length > 5) return null;
  let best = null;
  for (const [command, forms] of Object.entries(SPOKEN)) {
    for (const form of forms) {
      if (form.length < 5 && bare.length < 5) continue; // "done" vs "dan": too short to guess
      const similarity = 1 - distance(bare, form) / Math.max(bare.length, form.length);
      if (similarity >= 0.7 && (!best || similarity > best.similarity)) best = { command, similarity };
    }
  }
  return best?.command || null;
}

const KEYS = { 1: 'send', 2: 'repeat', 3: 'later', 4: 'done', 5: 'new', 0: 'cancel', 9: 'bye' };
const HELP = 'Speak your reply, then say send, or press 1. Say repeat, or press 2, to hear it again. Later, or 3, puts the thread at the back. Done, or 4, closes it. New thread, or 5, starts one. Cancel, or 0, drops what you said. Goodbye, or 9, ends the call.';

// What was said, as a command or as dictation. "…and send it" at the end of a sentence
// counts as dictation followed by send.
export function interpret(utterance, alternatives = []) {
  const text = String(utterance || '').trim();
  const norm = normalize(text);
  if (!norm) return { command: null, text: '' };
  // The phone's best guess first, then its other guesses: a command heard in any of them counts.
  for (const guess of [norm, ...alternatives.map(normalize).filter(Boolean)]) {
    const command = commandOf(guess);
    if (command) return { command, text: '' };
  }
  const tail = /^(.*?)[\s,.]+(?:and\s+)?(?:then\s+)?(?:send|senden|abschicken)(?: it| that)?[.!]?$/i.exec(text);
  const said = tail ? tail[1].replace(/[\s,]+$/, '') : '';
  if (said.split(/\s+/).length >= 3) return { command: 'send', text: said };
  return { command: null, text };
}

// One call. `say` speaks, `hangUp` ends the call; `app` is what the session may do.
export class CallSession {
  constructor({ say, hangUp, app }) {
    this.say = say;
    this.hangUp = hangUp;
    this.app = app;
    this.current = null; // thread being discussed
    this.buffer = []; // what has been dictated and not sent
    this.composing = false; // dictating a new thread
    this.setAside = new Set(); // threads put off during this call
    this.idle = false; // nothing left to present
    this.ended = false;
    this.queue = Promise.resolve(); // one thing at a time
  }

  run(fn) {
    this.queue = this.queue.then(fn).catch((err) => {
      log(`voice: ${err.stack || err.message}`);
      this.say('Something went wrong on my side. Try that again.');
    });
    return this.queue;
  }

  next() {
    return this.app.inbox().find((t) => !this.setAside.has(t.id)) || null;
  }

  start() {
    return this.run(async () => {
      const n = this.app.inbox().length;
      const busy = this.app.workingCount();
      if (n) await this.present(`${n === 1 ? 'One thread is' : `${n} threads are`} waiting. `);
      else {
        this.idle = true;
        this.say(`Nothing is waiting.${busy ? ` Claude is working on ${busy === 1 ? 'one thread' : `${busy} threads`}; I will tell you when one is ready.` : ''} Say new thread to start one.`);
      }
    });
  }

  async present(lead = '') {
    const thread = this.next();
    this.buffer = [];
    this.composing = false;
    if (!thread) {
      this.current = null;
      this.idle = true;
      const busy = this.app.workingCount();
      this.say(`${lead}That is everything for now.${busy ? ' I will tell you when Claude finishes another one.' : ''} Say new thread, or goodbye.`);
      return;
    }
    this.current = thread.id;
    this.idle = false;
    const digest = await this.app.digest(thread.id);
    if (this.ended) return;
    this.say(`${lead}${thread.title}. ${digest}`);
  }

  // A thread became ready while the call had nothing to present.
  threadReady(thread) {
    if (!this.idle || this.ended || this.composing || this.buffer.length) return;
    this.run(() => this.present('Claude has finished one. '));
  }

  heard(utterance, alternatives = []) {
    return this.run(() => this.handle(interpret(utterance, alternatives)));
  }

  key(digit) {
    const command = KEYS[digit];
    if (command) return this.run(() => this.handle({ command, text: '' }));
    return Promise.resolve();
  }

  async handle({ command, text }) {
    if (this.ended) return;
    if (text) {
      if (!this.current && !this.composing) {
        // Speaking with nothing open starts a new thread.
        this.composing = true;
        this.idle = false;
      }
      this.buffer.push(text);
    }
    if (!command) return;

    if (command === 'help') { this.say(HELP); return; }
    if (command === 'bye') {
      this.ended = true;
      this.say(this.buffer.length ? 'Goodbye. What you had not sent is dropped.' : 'Goodbye.');
      this.hangUp();
      return;
    }
    if (command === 'cancel') {
      this.buffer = [];
      if (this.composing) { this.composing = false; await this.present('Dropped. '); } else this.say('Dropped. Go ahead.');
      return;
    }
    if (command === 'new') {
      if (this.buffer.length) { this.say('You have something unsent. Say send, or cancel.'); return; }
      this.composing = true;
      this.idle = false;
      this.current = null;
      this.say('New thread. What should Claude work on?');
      return;
    }
    if (command === 'send') {
      const message = this.buffer.join(' ').trim();
      if (!message) { this.say('There is nothing to send yet. Speak your reply first.'); return; }
      if (this.composing) this.app.create(`${message}\n\n${DICTATED}`);
      else this.app.reply(this.current, `${DICTATED}\n\n${message}`);
      await this.present(this.composing ? 'Started. ' : 'Sent. ');
      return;
    }
    if (!this.current) { this.say('No thread is open. Say new thread, or goodbye.'); return; }
    if (this.buffer.length) { this.say('You have something unsent. Say send, or cancel.'); return; }
    if (command === 'repeat') {
      const thread = this.app.thread(this.current);
      this.say(`${thread.title}. ${await this.app.digest(this.current)}`);
    } else if (command === 'later') {
      this.setAside.add(this.current);
      this.app.later(this.current);
      await this.present('Later. ');
    } else if (command === 'done') {
      this.app.done(this.current);
      await this.present('Closed. ');
    }
  }
}

// ---------- the app, as a call sees it ----------

// A call or a walk goes through the conversations in the queue's order. Cards are left
// to the screen: they are for reading and editing, not for listening.
const app = {
  inbox: () => queueOrder().map((id) => store.getThread(id)).filter((t) => t && t.kind !== 'card'),
  workingCount: () => store.listThreads().filter((t) => t.state === 'working').length,
  thread: (id) => store.getThread(id),
  digest: (id) => runner.spokenDigest(id),
  reply: (id, text) => { recordDecision('replied', store.getThread(id), { by: 'voice' }); runner.sendMessage(id, text); },
  create: (text) => {
    const thread = store.createThread({ title: runner.titleFrom(text) });
    runner.sendMessage(thread.id, text);
  },
  later: (id) => { recordDecision('requeued', store.getThread(id), { by: 'voice' }); store.updateThread(id, { requeuedAt: Date.now() }); },
  done: (id) => { recordDecision('done', store.getThread(id), { by: 'voice' }); store.updateThread(id, { state: 'done', doneAt: Date.now(), error: '' }); },
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
export function attachVoice(server, config, allowedHosts) {
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

  wss.on('connection', (ws, trusted) => {
    let session = null;
    const send = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    // A connection that does not identify itself at once is not Twilio.
    const deadline = setTimeout(() => { if (!session) ws.close(1008, 'no setup'); }, 5000);
    const onReady = (thread) => { if (thread.state === 'ready') session?.threadReady(thread); };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!session) {
        if (msg.type !== 'setup' || !(trusted || redeem(msg.customParameters?.token))) { ws.close(1008, 'not allowed'); return; }
        clearTimeout(deadline);
        log(trusted ? 'voice: walk mode connected' : `voice: call from ${msg.from} connected`);
        session = new CallSession({
          say: (text) => send({ type: 'text', token: text, last: true }),
          hangUp: () => setTimeout(() => send({ type: 'end' }), 2500),
          app,
        });
        store.events.on('thread', onReady);
        session.start();
        return;
      }
      if (msg.type === 'prompt' && msg.last !== false) session.heard(msg.voicePrompt, trusted && Array.isArray(msg.alternatives) ? msg.alternatives.slice(0, 5).map(String) : []);
      else if (msg.type === 'dtmf') session.key(String(msg.digit));
      else if (msg.type === 'error') log(`voice: Twilio reported: ${msg.description}`);
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      store.events.off('thread', onReady);
      if (session) { session.ended = true; log('voice: call ended'); }
    });
  });
  return wss;
}
