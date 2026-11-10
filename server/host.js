// The host: who Florian talks to in walk mode and on a call.
//
// A small model sits between his speech and the threads. For everything he says it
// decides where it goes: to the thread that is open, to a new thread, to the app as a
// command, or it answers him itself (and hands harder questions to a stronger model).
// Nothing has to be closed with a keyword any more: he speaks, pauses, and it is dealt
// with.
//
// A few short commands are recognised here without a model, so "next" and "repeat"
// answer at once and work even when the model is unavailable.

import { log } from './config.js';
import { readPrompt } from './util.js';

const DICTATED = '[Dictated by voice; may contain transcription errors.]';

// ---------- commands that need no model ----------

const COMMANDS = [
  ['send', /^(send|send it|send that|send this|senden|abschicken|schick es ab|schicken)$/],
  ['repeat', /^(repeat|repeat that|again|say that again|say again|nochmal|noch mal|wiederholen|wiederhole)$/],
  ['later', /^(later|skip|skip it|skip this|next|next one|next thread|später|weiter|überspringen|nächster|nächstes)$/],
  ['done', /^(done|mark (it |that |this )?(as )?done|close it|close this|erledigt)$/],
  ['cancel', /^(cancel|scratch that|start over|delete that|abbrechen|verwerfen|lösch das)$/],
  ['new', /^((start |create |open |make )?(a )?new (thread|chat|conversation)|neuer (thread|chat)|neuen (thread|chat)( starten| anfangen)?)$/],
  ['bye', /^(goodbye|good bye|bye|bye bye|hang up|that's all|thats all|end call|tschüss|tschüs|auf wiedersehen)$/],
  ['help', /^(help|what can i say|hilfe)$/],
];
// Said around a command without changing it: "okay new thread please".
const FILLER = /^(?:(?:ok|okay|okey|please|bitte|hey|claude|um|uh|ähm|äh|so|also|and|und|now|jetzt)\s+)+|(?:\s+(?:please|bitte|now|jetzt|then|dann))+$/g;
// Spoken forms of each command, to catch near misses ("new threat", "nu thread", "sent it").
const SPOKEN = {
  send: ['send it', 'senden'],
  repeat: ['repeat', 'repeat that', 'say that again', 'wiederholen', 'nochmal'],
  later: ['skip it', 'next one', 'next thread', 'später', 'weiter'],
  done: ['mark as done', 'erledigt'],
  cancel: ['cancel', 'scratch that', 'abbrechen', 'verwerfen'],
  new: ['new thread', 'start a new thread', 'neuer thread', 'new chat'],
  bye: ['goodbye', 'hang up', 'tschüss'],
  help: ['hilfe'],
};
const KEYS = { 1: 'send', 2: 'repeat', 3: 'later', 4: 'done', 5: 'new', 0: 'cancel', 9: 'bye' };

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
  // Near misses only for short utterances, so ordinary speech is never taken for a command.
  if (!bare || bare.split(' ').length > 5) return null;
  let best = null;
  for (const [command, forms] of Object.entries(SPOKEN)) {
    for (const form of forms) {
      if (bare.length < 5) continue; // "dan" for "done": too short to guess
      const similarity = 1 - distance(bare, form) / Math.max(bare.length, form.length);
      if (similarity >= 0.7 && (!best || similarity > best.similarity)) best = { command, similarity };
    }
  }
  return best?.command || null;
}

// What was said, as a command or as speech for the host. "…and send it" at the end of a
// sentence is speech that goes straight to the open thread.
export function interpret(utterance, alternatives = []) {
  const text = String(utterance || '').trim();
  const norm = normalize(text);
  if (!norm) return { command: null, text: '' };
  // The phone's best guess first, then its other guesses: a command heard in any of them counts.
  for (const guess of [norm, ...alternatives.map(normalize).filter(Boolean)]) {
    const command = commandOf(guess);
    if (command) return { command, text: '' };
  }
  const tail = /^(.*?)[\s,.]+(?:and\s+|und\s+)?(?:then\s+)?(?:send|senden|abschicken)(?: it| that)?[.!]?$/i.exec(text);
  const said = tail ? tail[1].replace(/[\s,]+$/, '') : '';
  if (said.split(/\s+/).length >= 3) return { command: 'send', text: said };
  return { command: null, text };
}

// ---------- what the host says without a model, in English and German ----------

const PHRASES = {
  en: {
    waiting: (n) => `${n === 1 ? 'One thread is' : `${n} threads are`} waiting. `,
    nothing: 'Nothing is waiting.',
    working: (n) => ` Claude is working on ${n === 1 ? 'one thread' : `${n} threads`}; I will tell you when one is ready.`,
    idleHint: ' Ask me anything, or tell me what Claude should work on.',
    everything: 'That is everything for now.',
    tellYou: ' I will tell you when Claude finishes another one.',
    finishedOne: 'Claude has finished one. ',
    finished: (title) => `Claude has finished "${title}". Say next to hear it.`,
    sent: 'Sent. ',
    started: (title) => `Started a thread: ${title}.`,
    later: 'Later. ',
    closed: 'Closed. ',
    dropped: 'Dropped.',
    nothingToDrop: 'There is nothing to drop.',
    newThread: 'New thread. What should Claude work on?',
    nothingToSend: 'There is nothing to send. Just say what you want; I work out where it goes.',
    noThread: 'No thread is open.',
    bye: 'Goodbye.',
    moment: 'One moment.',
    moodSet: 'Mood line set.',
    noted: 'Noted for the next brain update.',
    unsorted: 'I could not work out where that goes. Say send to give it to the open thread as it is, or say it again.',
    unsortedNew: 'I could not work out where that goes. Say send to start a thread with it, or say it again.',
    noAnswer: 'I could not get an answer to that right now. Say new thread and the question, and Claude will find out.',
    noSuchThread: 'I do not see that thread among the ones waiting.',
    wrong: 'Something went wrong on my side. Try that again.',
    help: 'Just talk. What you say after hearing a thread goes to that thread, and I move on to the next. Ask me something and I answer it myself. Say next to put a thread off, done to close it, repeat to hear it again, new thread to start one, and goodbye to stop.',
  },
  de: {
    waiting: (n) => `${n === 1 ? 'Ein Thread wartet' : `${n} Threads warten`}. `,
    nothing: 'Es wartet nichts.',
    working: (n) => ` Claude arbeitet an ${n === 1 ? 'einem Thread' : `${n} Threads`}; ich sage Bescheid, wenn einer fertig ist.`,
    idleHint: ' Frag mich etwas, oder sag mir, woran Claude arbeiten soll.',
    everything: 'Das ist alles für den Moment.',
    tellYou: ' Ich sage Bescheid, wenn Claude den nächsten fertig hat.',
    finishedOne: 'Claude ist mit einem fertig. ',
    finished: (title) => `Claude ist fertig mit „${title}“. Sag weiter, um es zu hören.`,
    sent: 'Gesendet. ',
    started: (title) => `Thread gestartet: ${title}.`,
    later: 'Später. ',
    closed: 'Erledigt. ',
    dropped: 'Verworfen.',
    nothingToDrop: 'Es gibt nichts zu verwerfen.',
    newThread: 'Neuer Thread. Woran soll Claude arbeiten?',
    nothingToSend: 'Es gibt nichts zu senden. Sag einfach, was du willst; ich sortiere es ein.',
    noThread: 'Es ist kein Thread offen.',
    bye: 'Tschüss.',
    moment: 'Einen Moment.',
    moodSet: 'Stimmung gesetzt.',
    noted: 'Notiert für das nächste Brain-Update.',
    unsorted: 'Ich konnte das nicht einordnen. Sag senden, um es so an den offenen Thread zu geben, oder sag es noch einmal.',
    unsortedNew: 'Ich konnte das nicht einordnen. Sag senden, um damit einen Thread zu starten, oder sag es noch einmal.',
    noAnswer: 'Darauf bekomme ich gerade keine Antwort. Sag neuer Thread und die Frage, dann findet Claude es heraus.',
    noSuchThread: 'Diesen Thread sehe ich nicht unter den wartenden.',
    wrong: 'Bei mir ist etwas schiefgegangen. Versuch es noch einmal.',
    help: 'Sprich einfach. Was du nach einem Thread sagst, geht an diesen Thread, und ich gehe zum nächsten. Frag mich etwas, und ich antworte selbst. Sag weiter, um einen Thread zu verschieben, erledigt, um ihn zu schließen, wiederholen, um ihn noch einmal zu hören, neuer Thread, um einen zu starten, und tschüss zum Beenden.',
  },
};

const LANGUAGE_NAMES = { en: 'English', de: 'German' };
const short = (text, max) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

// The first JSON object in a model's answer, or null.
export function parseDecision(text) {
  const raw = String(text || '');
  const from = raw.indexOf('{');
  const to = raw.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  try {
    const decision = JSON.parse(raw.slice(from, to + 1));
    return decision && typeof decision.do === 'string' ? decision : null;
  } catch {
    return null;
  }
}

// Repairs misheard words the host pointed out, leaving everything else as spoken.
function applyFixes(text, fix) {
  let out = text;
  if (fix && typeof fix === 'object') {
    for (const [heard, meant] of Object.entries(fix).slice(0, 12)) {
      if (!heard || typeof meant !== 'string' || heard.length > 80 || meant.length > 80) continue;
      const pattern = new RegExp(heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(pattern, meant);
    }
  }
  return out;
}

// One conversation with the host. `say` speaks, `hangUp` ends it, `app` is what the host
// may do, `notify` tells a screen what happened (walk mode only).
export class HostSession {
  constructor({ say, hangUp, app, notify, lang }) {
    this.say = say;
    this.hangUp = hangUp;
    this.app = app;
    this.notify = notify || (() => {});
    this.setLanguage(lang);
    this.current = null; // thread being discussed
    this.held = []; // what he said and the host is still holding
    this.unsorted = false; // the held text is something the host could not place
    this.composing = false; // the next thing he says starts a new thread
    this.setAside = new Set(); // threads put off in this conversation
    this.idle = false; // no thread is open
    this.ended = false;
    this.history = []; // { who, text }: the conversation, for the host's memory
    this.lastHeardAt = 0;
    this.queue = Promise.resolve(); // one thing at a time
  }

  setLanguage(lang) {
    this.lang = String(lang || 'en').toLowerCase().startsWith('de') ? 'de' : 'en';
    this.t = PHRASES[this.lang];
  }

  run(fn) {
    this.queue = this.queue.then(fn).catch((err) => {
      log(`host: ${err.stack || err.message}`);
      this.speak(this.t.wrong);
    }).finally(() => this.status());
    return this.queue;
  }

  remember(who, text) {
    this.history.push({ who, text: short(text, 400) });
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24);
  }

  speak(text, { remember = true } = {}) {
    if (!text) return;
    if (remember) this.remember('Host', text);
    this.say(text);
  }

  status(thinking = false) {
    const thread = this.current ? this.app.thread(this.current) : null;
    this.notify({
      type: 'status',
      thinking,
      thread: thread ? { id: thread.id, title: thread.title } : null,
      waiting: this.app.inbox().length,
      working: this.app.workingCount(),
      holding: this.held.join(' '),
      composing: this.composing,
    });
  }

  next() {
    return this.app.inbox().find((t) => !this.setAside.has(t.id)) || null;
  }

  start() {
    return this.run(async () => {
      const n = this.app.inbox().length;
      const busy = this.app.workingCount();
      if (n) await this.present(this.t.waiting(n));
      else {
        this.idle = true;
        this.speak(`${this.t.nothing}${busy ? this.t.working(busy) : ''}${this.t.idleHint}`);
      }
    });
  }

  async present(lead = '', thread = this.next()) {
    this.held = [];
    this.unsorted = false;
    this.composing = false;
    if (!thread) {
      this.current = null;
      this.idle = true;
      const busy = this.app.workingCount();
      this.speak(`${lead}${this.t.everything}${busy ? this.t.tellYou : ''}`);
      return;
    }
    this.current = thread.id;
    this.idle = false;
    this.status(true);
    const digest = await this.app.digest(thread.id, this.lang);
    if (this.ended) return;
    this.remember('Host', `[read out the thread "${thread.title}"] ${digest}`);
    this.speak(`${lead}${thread.title}. ${digest}`, { remember: false });
  }

  // A thread became ready while nothing was open. If he is in the middle of talking with
  // the host, it is announced; otherwise it is read out.
  threadReady(thread) {
    if (!this.idle || this.ended || this.composing || this.held.length) return;
    this.run(async () => {
      if (!this.idle || this.ended) return;
      if (Date.now() - this.lastHeardAt < 45_000) this.speak(this.t.finished(thread.title));
      else await this.present(this.t.finishedOne);
    });
  }

  // Something he said or typed.
  heard(utterance, alternatives = [], { typed = false } = {}) {
    return this.run(() => this.take(String(utterance || '').trim(), alternatives, typed));
  }

  key(digit) {
    const command = KEYS[digit];
    if (command) return this.run(() => this.command(command, ''));
    return Promise.resolve();
  }

  async take(said, alternatives, typed) {
    if (this.ended || !said) return;
    this.lastHeardAt = Date.now();
    const { command, text } = interpret(said, alternatives);
    if (command) {
      this.notify({ type: 'heard', text: said, kind: 'command', note: command });
      await this.command(command, text, typed);
      return;
    }
    if (this.composing) {
      this.notify({ type: 'heard', text: said, kind: 'new' });
      await this.create([...this.held, said].join(' '), typed);
      return;
    }
    await this.route(said, alternatives, typed);
  }

  async command(command, text = '', typed = false) {
    const t = this.t;
    if (command === 'help') { this.speak(t.help); return; }
    if (command === 'bye') {
      this.ended = true;
      this.speak(t.bye);
      this.hangUp();
      return;
    }
    if (command === 'cancel') {
      const had = this.held.length || this.composing;
      this.held = [];
      this.unsorted = false;
      this.composing = false;
      this.speak(had ? t.dropped : t.nothingToDrop);
      return;
    }
    if (command === 'new') {
      this.held = [];
      this.unsorted = false;
      this.composing = true;
      this.speak(t.newThread);
      return;
    }
    if (command === 'send') {
      // "…and send it": straight to the open thread, no model in between.
      const message = [...this.held, text].join(' ').trim();
      if (!message) { this.speak(t.nothingToSend); return; }
      if (this.composing || !this.current) await this.create(message, typed);
      else await this.reply(message, typed);
      return;
    }
    if (!this.current) {
      // "next" with nothing open looks for something that became ready meanwhile.
      if (command === 'later' && this.next()) { await this.present(); return; }
      this.speak(`${t.noThread}${t.idleHint}`);
      return;
    }
    if (command === 'repeat') {
      const thread = this.app.thread(this.current);
      this.speak(`${thread.title}. ${await this.app.digest(this.current, this.lang)}`, { remember: false });
    } else if (command === 'more') {
      this.speak(this.app.full(this.current) || await this.app.digest(this.current, this.lang), { remember: false });
    } else if (command === 'later') {
      this.setAside.add(this.current);
      this.app.later(this.current);
      await this.present(t.later);
    } else if (command === 'done') {
      this.app.done(this.current);
      await this.present(t.closed);
    }
  }

  async reply(message, typed) {
    this.app.reply(this.current, typed ? message : `${DICTATED}\n\n${message}`);
    this.remember('Host', `[sent that to the thread "${this.app.thread(this.current)?.title || ''}"]`);
    await this.present(this.t.sent);
  }

  async create(message, typed) {
    const title = this.app.create(typed ? message : `${message}\n\n${DICTATED}`) || short(message, 60);
    this.held = [];
    this.unsorted = false;
    this.composing = false;
    this.speak(this.t.started(title));
  }

  // Asks the small model where this goes, and does it.
  async route(said, alternatives, typed) {
    // What the host could not place last time is dropped once he says something new.
    if (this.unsorted) { this.held = []; this.unsorted = false; }
    const whole = [...this.held, said].join(' ').trim();
    this.remember('Florian', whole);
    this.status(true);
    const decision = await this.decide(whole, alternatives, typed);
    if (this.ended) return;
    const t = this.t;
    const kind = decision?.do;
    const fixed = applyFixes(whole, decision?.fix);

    if (kind === 'wait') {
      this.history.pop(); // it comes back whole with what he says next
      this.held = [whole];
      this.notify({ type: 'heard', text: said, kind: 'wait' });
      return;
    }
    this.held = [];

    if (kind === 'reply') {
      const message = short(typeof decision.text === 'string' && decision.text.trim() ? decision.text : fixed, 20_000);
      if (!this.current) {
        this.notify({ type: 'heard', text: said, kind: 'new' });
        await this.create(message, typed);
        return;
      }
      this.notify({ type: 'heard', text: said, kind: 'reply', note: this.app.thread(this.current)?.title || '' });
      await this.reply(message, typed);
      return;
    }
    if (kind === 'new') {
      this.notify({ type: 'heard', text: said, kind: 'new' });
      await this.create(short(typeof decision.text === 'string' && decision.text.trim() ? decision.text : fixed, 20_000), typed);
      return;
    }
    if (kind === 'answer' && typeof decision.say === 'string' && decision.say.trim()) {
      this.notify({ type: 'heard', text: said, kind: 'host' });
      this.speak(decision.say.trim());
      return;
    }
    if (kind === 'ask' && typeof decision.say === 'string' && decision.say.trim()) {
      this.notify({ type: 'heard', text: said, kind: 'host' });
      this.speak(decision.say.trim());
      return;
    }
    if (kind === 'think') {
      this.notify({ type: 'heard', text: said, kind: 'host', note: 'thinking it through' });
      this.speak(t.moment, { remember: false });
      this.status(true);
      const answer = await this.app.think(this.thinkPrompt(typeof decision.question === 'string' && decision.question.trim() ? decision.question : fixed), this.lang);
      if (this.ended) return;
      this.speak(answer || t.noAnswer);
      return;
    }
    if (kind === 'command' && ['next', 'done', 'repeat', 'more', 'cancel', 'bye'].includes(decision.name)) {
      this.notify({ type: 'heard', text: said, kind: 'command', note: decision.name });
      await this.command(decision.name === 'next' ? 'later' : decision.name);
      return;
    }
    if (kind === 'open') {
      const thread = this.app.inbox()[Number(decision.thread) - 1];
      this.notify({ type: 'heard', text: said, kind: 'command', note: 'open' });
      if (!thread) { this.speak(t.noSuchThread); return; }
      this.setAside.delete(thread.id);
      await this.present('', thread);
      return;
    }
    if (kind === 'mood' && typeof decision.text === 'string') {
      this.notify({ type: 'heard', text: said, kind: 'command', note: 'mood' });
      this.app.setMood(decision.text);
      this.speak(t.moodSet);
      return;
    }
    if (kind === 'note' && typeof decision.text === 'string') {
      this.notify({ type: 'heard', text: said, kind: 'command', note: 'note' });
      this.app.addNote(decision.text);
      this.speak(t.noted);
      return;
    }

    // The model was unavailable or answered with something unusable. Nothing is lost:
    // he can send it as it is.
    this.held = [whole];
    this.unsorted = true;
    this.notify({ type: 'heard', text: said, kind: 'unsorted' });
    this.speak(this.current ? t.unsorted : t.unsortedNew, { remember: false });
  }

  context() {
    const thread = this.current ? this.app.thread(this.current) : null;
    const inbox = this.app.inbox();
    const lines = [
      `Now: ${new Date().toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      `He speaks: ${LANGUAGE_NAMES[this.lang]}`,
    ];
    const mood = this.app.mood();
    if (mood) lines.push(`Mood line: ${mood}`);
    if (thread) {
      lines.push(`Open thread: "${thread.title}"${thread.project ? ` (project ${thread.project})` : ''}`);
      const digest = this.app.cachedDigest(thread.id, this.lang);
      if (digest) lines.push(`What he heard from it: ${short(digest, 900)}`);
      const last = this.app.lastUser(thread.id);
      if (last) lines.push(`His last message in it: ${short(last, 300)}`);
    } else {
      lines.push('Open thread: none');
    }
    lines.push(inbox.length ? 'Waiting, in order:' : 'Waiting: nothing');
    inbox.slice(0, 15).forEach((t, i) => lines.push(`${i + 1}. ${t.title}${t.gist ? `: ${short(t.gist, 110)}` : ''}`));
    const working = this.app.workingTitles();
    if (working.length) lines.push(`Claude is working on: ${working.slice(0, 8).join('; ')}`);
    const words = this.app.words();
    if (words) lines.push(`Names and words he uses: ${short(words, 700)}`);
    return lines;
  }

  talk() {
    return this.history.slice(-14).map((h) => `${h.who}: ${h.text}`);
  }

  async decide(said, alternatives, typed) {
    const others = [...new Set(alternatives.map((a) => String(a).trim()).filter((a) => a && a !== said))].slice(0, 3);
    const prompt = [
      ...this.context(),
      'Conversation so far:',
      ...(this.history.length > 1 ? this.talk().slice(0, -1) : ['(none yet)']),
      '---',
      `Florian said: ${said}`,
      ...(others.length ? [`The phone's other guesses: ${others.join(' | ')}`] : []),
      ...(typed ? ['(He typed this; it has no speech mistakes.)'] : []),
    ].join('\n');
    try {
      return parseDecision(await this.app.ask({ system: readPrompt('host.md'), prompt }));
    } catch (err) {
      log(`host: could not decide: ${err.message}`);
      return null;
    }
  }

  thinkPrompt(question) {
    return [
      `He speaks: ${LANGUAGE_NAMES[this.lang]}`,
      'The conversation so far:',
      ...this.talk(),
      '---',
      `The question to answer: ${question}`,
    ].join('\n');
  }
}
