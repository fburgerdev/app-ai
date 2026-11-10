// The talk page: the host, by voice or by typing.
//
// The phone turns speech into text and reads answers aloud with its own voice, so this
// costs nothing per minute. On the other end is the host (server/host.js): it decides
// whether what you said belongs to the open thread, is a command, or is a question it
// answers itself.
//
// How listening works here, and why:
// - The phone's recognition stops after every sentence and every silence. This page
//   starts it again and joins the pieces, and only hands them on once you have paused
//   for a moment. A thought with a breath in the middle stays one message.
// - A piece of speech is taken when the phone's listening session ends, not when it
//   flags a result as final: Android's flags are unreliable, the end of a session is not.
// - Reading aloud is watched from outside. Android often never reports that it finished
//   speaking; without the watchdog the page would wait for ever and stop listening.
// - Chrome on Android stops listening when the screen turns off. So the page keeps the
//   screen on, and "Lock for the pocket" covers it with a dark shield that ignores touches.

const $ = (id) => document.getElementById(id);
const els = {
  state: $('state'), nowTitle: $('now-title'), nowCounts: $('now-counts'), log: $('log'), live: $('live'),
  mic: $('mic'), micLabel: $('mic-label'), lock: $('lock'), note: $('note'), type: $('type'), typed: $('typed'),
  settings: $('settings'), openSettings: $('open-settings'), lang: $('lang'), pause: $('pause'), aloud: $('aloud'),
  voice: $('voice'), rate: $('rate'), sounds: $('sounds'), headphones: $('headphones'), words: $('words'),
  fresh: $('fresh'), events: $('events'), copyEvents: $('copy-events'), shield: $('shield'), shieldState: $('shield-state'), unlock: $('unlock'),
};

const saved = {
  get(key, fallback) { try { return localStorage.getItem(`walk-${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`walk-${key}`, String(value)); } catch { /* private mode */ } },
};
const settings = {
  lang: saved.get('lang', 'en-US'),
  pause: Number(saved.get('pause', 2500)),
  aloud: saved.get('aloud', 'true') === 'true',
  rate: Number(saved.get('rate', 1.05)),
  sounds: saved.get('sounds', 'true') === 'true',
  headphones: saved.get('headphones', 'false') === 'true',
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canSpeak = 'speechSynthesis' in window;

// ---------- what happened, for finding problems ----------

const events = [];
function note(what) {
  const t = new Date();
  events.push(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}  ${what}`);
  if (events.length > 120) events.shift();
  if (els.settings.open) els.events.textContent = events.join('\n');
}

// ---------- state shown on the page ----------

let on = false; // hands-free: listening and reading aloud
let online = false;
let ended = false; // the host said goodbye
let thinking = false;
let speaking = false;
let listening = false;
let problem = '';

function paint() {
  let text = 'Tap Talk to speak';
  let kind = '';
  if (problem) { text = problem; kind = 'error'; }
  else if (!online) { text = 'Reconnecting'; kind = 'error'; }
  else if (ended) { text = 'Ended'; }
  else if (speaking) { text = 'Speaking'; kind = 'speaking'; }
  else if (thinking) { text = 'Thinking'; kind = 'thinking'; }
  else if (on && listening) { text = 'Listening'; kind = 'listening'; }
  else if (on) { text = 'Getting ready'; }
  els.state.textContent = text;
  els.state.className = `chip${kind ? ` is-${kind}` : ''}`;
  els.shieldState.textContent = `Locked. ${text}.`;
  els.mic.classList.toggle('is-on', on);
  els.mic.classList.toggle('is-speaking', on && speaking);
  els.mic.setAttribute('aria-pressed', String(on));
  els.micLabel.textContent = !on ? 'Talk' : speaking ? 'Tap to interrupt' : 'Tap to stop';
}

function addLine(who, text) {
  const line = document.createElement('p');
  line.className = `line is-${who}`;
  line.textContent = text;
  els.log.append(line);
  while (els.log.children.length > 80) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
  return line;
}

const WHERE = {
  reply: (n) => `Sent to ${n || 'the open thread'}`,
  new: () => 'Started a new thread',
  host: (n) => (n ? `The host is ${n}` : 'Answered by the host'),
  command: (n) => `Command: ${n === 'later' ? 'next' : n}`,
  wait: () => 'Holding it. Go on.',
  unsorted: () => 'Not placed. Say "send" or say it again.',
};

function annotate(kind, name) {
  const mine = [...els.log.querySelectorAll('.line.is-you:not([data-placed])')].at(-1);
  if (!mine) return;
  mine.dataset.placed = kind;
  const where = document.createElement('span');
  where.className = `where is-${kind}`;
  where.textContent = (WHERE[kind] || (() => kind))(name);
  mine.append(where);
  els.log.scrollTop = els.log.scrollHeight;
}

// ---------- sounds: a short tone tells you something was taken, without looking ----------

let audio = null;
function tone(steps) {
  if (!settings.sounds || !audio) return;
  let at = audio.currentTime;
  for (const [freq, ms] of steps) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + ms / 1000 + 0.02);
    at += ms / 1000 + 0.03;
  }
}
const SOUNDS = { taken: [[880, 70]], reply: [[660, 70], [990, 90]], wait: [[440, 60], [440, 60]], unsorted: [[220, 220]], host: [[740, 60]] };

// ---------- the connection, which may drop on a walk ----------

let ws = null;
let sid = '';
let lastSeq = 0;
let wantFresh = false;
let retry = 0;
const unsent = []; // said while offline; delivered when the connection is back

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/walk/ws`);
  ws.onopen = () => {
    online = true;
    retry = 0;
    ws.send(JSON.stringify({ type: 'setup', from: 'walk mode', lang: settings.lang, resume: !wantFresh, sid, seen: sid ? lastSeq : null }));
    wantFresh = false;
    for (const message of unsent.splice(0)) ws.send(JSON.stringify(message));
    note('connected');
    paint();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'text') hostSaid(msg);
    else if (msg.type === 'status') showStatus(msg);
    else if (msg.type === 'heard') {
      annotate(msg.kind, msg.note);
      tone(SOUNDS[msg.kind] || SOUNDS.taken);
      note(`host placed it: ${msg.kind}${msg.note ? ` (${msg.note})` : ''}`);
    } else if (msg.type === 'end') {
      ended = true;
      note('the host ended the conversation');
      setOn(false);
    }
  };
  ws.onclose = () => {
    online = false;
    thinking = false;
    paint();
    if (ended) return;
    retry += 1;
    note('connection lost');
    setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(retry, 4)));
  };
}

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else { unsent.push(message); note('offline: kept for when the connection is back'); }
}

// After a goodbye, the next thing said or tapped begins a new conversation.
function beginAgain() {
  ended = false;
  wantFresh = true;
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(); // its onclose connects again
  else connect();
}

function prompt(text, alternatives = [], typed = false) {
  if (ended) beginAgain();
  send({ type: 'prompt', voicePrompt: text, alternatives, lang: settings.lang, typed, last: true });
}

function hostSaid(msg) {
  if (msg.sid && msg.sid !== sid) { sid = msg.sid; lastSeq = 0; }
  if (msg.seq && msg.seq <= lastSeq) return;
  if (msg.seq) lastSeq = msg.seq;
  thinking = false;
  const line = addLine('host', msg.token);
  note(`host: ${msg.token.slice(0, 60)}`);
  if (!msg.replay) speak(msg.token, line);
  paint();
}

function showStatus(msg) {
  thinking = Boolean(msg.thinking);
  els.nowTitle.textContent = msg.thread ? msg.thread.title : msg.composing ? 'New thread: say what Claude should work on' : 'None';
  els.nowTitle.classList.toggle('is-none', !msg.thread && !msg.composing);
  const parts = [];
  if (msg.waiting) parts.push(`${msg.waiting} waiting`);
  if (msg.working) parts.push(`${msg.working} working`);
  els.nowCounts.textContent = parts.join(' · ');
  paint();
}

// ---------- reading aloud ----------

let voices = [];
function loadVoices() {
  voices = canSpeak ? speechSynthesis.getVoices() : [];
  const lang2 = settings.lang.slice(0, 2).toLowerCase();
  const fitting = voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang2));
  const wanted = saved.get(`voice-${lang2}`, '');
  els.voice.replaceChildren(new Option('Automatic', ''), ...fitting.map((v) => new Option(`${v.name}${v.localService ? '' : ' (online)'}`, v.name)));
  els.voice.value = fitting.some((v) => v.name === wanted) ? wanted : '';
}
function pickVoice() {
  const lang = settings.lang.toLowerCase();
  const fitting = voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang.slice(0, 2)));
  const wanted = saved.get(`voice-${lang.slice(0, 2)}`, '');
  return fitting.find((v) => v.name === wanted)
    || fitting.find((v) => v.lang.replace('_', '-').toLowerCase() === lang && /natural|neural|enhanced|google/i.test(v.name))
    || fitting.find((v) => v.lang.replace('_', '-').toLowerCase() === lang)
    || fitting[0] || null;
}

const toSpeak = []; // { text, line }
let current = null;

// Long texts go sentence by sentence: some phones cut off one long utterance, and a
// sentence is also where an interruption should land.
function chunks(text) {
  const out = [];
  for (const sentence of text.match(/[^.!?…]+[.!?…]*["”’)]*\s*/g) || [text]) {
    if (out.length && (out.at(-1) + sentence).length < 180) out[out.length - 1] += sentence;
    else out.push(sentence);
  }
  return out.map((c) => c.trim()).filter(Boolean);
}

function speak(text, line) {
  if (!on || !settings.aloud || !canSpeak) return;
  for (const part of chunks(text)) toSpeak.push({ text: part, line });
  pump();
}

function pump() {
  if (current) return;
  const next = toSpeak.shift();
  if (!next) {
    if (speaking) { speaking = false; note('finished speaking'); paint(); listen(); }
    return;
  }
  if (!speaking) {
    speaking = true;
    // Without headphones the phone would hear itself: stop listening while it talks.
    if (!settings.headphones) stopListening();
    paint();
  }
  current = next;
  next.line?.classList.add('is-speaking');
  const u = new SpeechSynthesisUtterance(next.text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.lang = voice?.lang?.replace('_', '-') || settings.lang;
  u.rate = settings.rate;
  const started = Date.now();
  let finished = false;
  const finish = (why) => {
    if (finished) return;
    finished = true;
    clearInterval(watch);
    next.line?.classList.remove('is-speaking');
    if (why !== 'end') note(`speaking ended by ${why}`);
    current = null;
    pump();
  };
  u.onend = () => finish('end');
  u.onerror = (e) => finish(`error ${e.error || ''}`);
  // The watchdog: the phone went quiet without saying so, or never stops.
  const limit = 6000 + next.text.length * 130;
  const watch = setInterval(() => {
    const age = Date.now() - started;
    if (age > 1500 && !speechSynthesis.speaking && !speechSynthesis.pending) finish('watchdog (silent)');
    else if (age > limit) { try { speechSynthesis.cancel(); } catch { /* nothing to cancel */ } finish('watchdog (too long)'); }
  }, 300);
  try { speechSynthesis.speak(u); } catch (err) { finish(`speak failed: ${err.message}`); }
}

function shutUp() {
  toSpeak.length = 0;
  if (canSpeak) { try { speechSynthesis.cancel(); } catch { /* nothing to cancel */ } }
  // cancel() normally ends the current utterance through its error handler; make sure.
  setTimeout(() => { if (current) { current = null; pump(); } }, 250);
}

// ---------- listening ----------

let rec = null;
let sessionText = ''; // what the running listening session has heard so far
let sessionAlts = [];
let segments = []; // finished pieces waiting for the pause to run out
let pauseTimer = 0;
let quickEnds = 0;

function showLive() {
  const text = [...segments.map((s) => s.text), sessionText].filter(Boolean).join(' ');
  els.live.hidden = !text;
  els.live.textContent = text;
}

function schedule() {
  clearTimeout(pauseTimer);
  const text = segments.map((s) => s.text).join(' ');
  // A word or two is probably a command: do not make "next" wait out the whole pause.
  const wait = text.split(/\s+/).length <= 3 ? Math.min(700, settings.pause) : settings.pause;
  els.live.style.setProperty('--pause', `${wait}ms`);
  els.live.classList.remove('is-counting');
  void els.live.offsetWidth;
  els.live.classList.add('is-counting');
  pauseTimer = setTimeout(flush, wait);
}

function holdOff() {
  clearTimeout(pauseTimer);
  pauseTimer = 0;
  els.live.classList.remove('is-counting');
}

function flush() {
  pauseTimer = 0;
  if (!segments.length) return;
  const text = segments.map((s) => s.text).join(' ').trim();
  const alternatives = segments.length === 1 ? segments[0].alts : [];
  segments = [];
  showLive();
  els.live.classList.remove('is-counting');
  if (!text) return;
  addLine('you', text);
  note(`you: ${text.slice(0, 60)}`);
  tone(SOUNDS.taken);
  thinking = true;
  paint();
  prompt(text, alternatives, false);
}

function listen() {
  if (!on || rec || ended || !Recognition) return;
  if (speaking && !settings.headphones) return;
  const mine = new Recognition();
  rec = mine;
  mine.lang = settings.lang;
  mine.continuous = false;
  mine.interimResults = true;
  mine.maxAlternatives = 4;
  const startedAt = Date.now();
  mine.onstart = () => { listening = true; paint(); };
  mine.onspeechstart = () => holdOff();
  mine.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i += 1) text += `${e.results[i][0].transcript} `;
    sessionText = text.trim();
    const last = e.results[e.results.length - 1];
    sessionAlts = e.results.length === 1 ? Array.from(last, (r) => r.transcript.trim()).slice(1).filter(Boolean) : [];
    if (sessionText) holdOff();
    showLive();
    // With headphones on, talking over the host stops it.
    if (speaking && settings.headphones && sessionText.split(/\s+/).length >= 2) { note('interrupted by speech'); shutUp(); }
  };
  mine.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    note(`listening error: ${e.error}`);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      problem = 'Microphone not allowed';
      els.note.hidden = false;
      els.note.textContent = 'Allow the microphone for this page in the browser’s site settings, then tap Talk again.';
      setOn(false);
    } else if (e.error === 'audio-capture') {
      els.note.hidden = false;
      els.note.textContent = 'The phone gives this page no microphone. Close other apps that use it, then tap Talk again.';
    }
  };
  mine.onend = () => {
    if (rec === mine) rec = null;
    listening = false;
    if (sessionText) {
      segments.push({ text: sessionText, alts: sessionAlts });
      note(`heard: ${sessionText.slice(0, 60)}`);
      sessionText = '';
      sessionAlts = [];
      schedule();
    } else if (segments.length && !pauseTimer) {
      schedule(); // speech started, nothing came of it: the pause runs again
    }
    showLive();
    paint();
    // Listening ends after every sentence and every silence; start it again. If it
    // keeps ending at once, something is wrong: slow down instead of spinning.
    quickEnds = Date.now() - startedAt < 400 ? quickEnds + 1 : 0;
    if (quickEnds === 6) note('listening keeps ending at once; slowing down');
    if (on) setTimeout(listen, quickEnds >= 6 ? 2000 : 200);
  };
  try {
    mine.start();
  } catch (err) {
    note(`could not start listening: ${err.message}`);
    rec = null;
    setTimeout(listen, 1000);
  }
}

function stopListening() {
  const mine = rec;
  if (!mine) return;
  try { mine.abort(); } catch { /* not running */ }
}

// ---------- hands-free on and off ----------

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* the page still works; the screen may dim */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (on) { keepAwake(); listen(); }
});

function setOn(value) {
  if (value === on) { paint(); return; }
  on = value;
  if (on) {
    problem = '';
    els.note.hidden = true;
    if (!Recognition) {
      on = false;
      els.note.hidden = false;
      els.note.textContent = 'This browser cannot listen. Use Chrome on Android or on the computer. Typing works everywhere.';
      paint();
      return;
    }
    if (ended) beginAgain();
    // Sound has to begin inside a tap; after that the page may speak by itself.
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { audio = null; }
    if (canSpeak) { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch { /* no voice */ } }
    keepAwake();
    note('hands-free on');
    listen();
  } else {
    shutUp();
    speaking = false;
    stopListening();
    flush();
    wakeLock?.release?.().catch(() => {});
    els.shield.hidden = true;
    note('hands-free off');
  }
  paint();
}

els.mic.addEventListener('click', () => {
  if (on && speaking) { note('interrupted by tap'); shutUp(); return; }
  setOn(!on);
});

for (const button of document.querySelectorAll('[data-say]')) {
  button.addEventListener('click', () => {
    shutUp();
    addLine('you', button.textContent);
    prompt(button.dataset.say, [], true);
  });
}

els.type.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.typed.value.trim();
  if (!text) return;
  els.typed.value = '';
  shutUp();
  addLine('you', text);
  thinking = true;
  paint();
  prompt(text, [], true);
});

// ---------- settings ----------

els.lang.value = settings.lang;
els.pause.value = String(settings.pause);
els.aloud.checked = settings.aloud;
els.rate.value = String(settings.rate);
els.sounds.checked = settings.sounds;
els.headphones.checked = settings.headphones;

els.lang.addEventListener('change', () => { settings.lang = els.lang.value; saved.set('lang', settings.lang); loadVoices(); stopListening(); });
els.pause.addEventListener('change', () => { settings.pause = Number(els.pause.value); saved.set('pause', settings.pause); });
els.aloud.addEventListener('change', () => { settings.aloud = els.aloud.checked; saved.set('aloud', settings.aloud); if (!settings.aloud) shutUp(); });
els.rate.addEventListener('change', () => { settings.rate = Number(els.rate.value); saved.set('rate', settings.rate); });
els.sounds.addEventListener('change', () => { settings.sounds = els.sounds.checked; saved.set('sounds', settings.sounds); });
els.headphones.addEventListener('change', () => { settings.headphones = els.headphones.checked; saved.set('headphones', settings.headphones); });
els.voice.addEventListener('change', () => saved.set(`voice-${settings.lang.slice(0, 2).toLowerCase()}`, els.voice.value));

let wordsTimer = 0;
els.words.addEventListener('input', () => {
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(() => {
    fetch('/api/pads/words', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: els.words.value }) }).catch(() => {});
  }, 600);
});

els.openSettings.addEventListener('click', async () => {
  els.events.textContent = events.join('\n');
  els.settings.showModal();
  try { els.words.value = (await (await fetch('/api/pads/words')).json()).text || ''; } catch { /* offline */ }
});
els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
els.fresh.addEventListener('click', () => {
  els.settings.close();
  shutUp();
  els.log.replaceChildren();
  beginAgain();
});
els.copyEvents.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(events.join('\n')); els.copyEvents.textContent = 'Copied'; } catch { els.copyEvents.textContent = 'Could not copy'; }
  setTimeout(() => { els.copyEvents.textContent = 'Copy'; }, 1500);
});

// ---------- the pocket lock: a dark cover that swallows touches ----------

els.lock.addEventListener('click', () => { els.shield.hidden = false; });
let holdTimer = 0;
els.unlock.addEventListener('pointerdown', () => { holdTimer = setTimeout(() => { els.shield.hidden = true; }, 1200); });
els.unlock.addEventListener('pointerup', () => clearTimeout(holdTimer));
els.unlock.addEventListener('pointerleave', () => clearTimeout(holdTimer));

// ---------- start ----------

if (canSpeak) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}
if (!window.isSecureContext) {
  els.note.hidden = false;
  els.note.textContent = 'The microphone only works over https or on the computer itself. Open the app through its Tailscale address (docs/pi.md).';
}
note(`page opened; listening ${Recognition ? 'available' : 'not available'}; voice ${canSpeak ? 'available' : 'not available'}`);
paint();
connect();
