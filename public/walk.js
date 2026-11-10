// Walk mode: the inbox by voice, from the phone's browser.
//
// The phone turns your speech into text and reads replies aloud with its own voice, so
// it costs nothing per minute. The app on the other end runs the same conversation it
// would run on a phone call: it reads you what is waiting, collects what you say until
// you say "send", and moves on.
//
// Chrome on Android stops listening when the screen turns off. So this page keeps the
// screen on, and "Lock for the pocket" covers it with a dark shield that ignores touches.

const $ = (id) => document.getElementById(id);
const els = { state: $('state'), said: $('said'), heard: $('heard'), talk: $('talk'), lang: $('lang'), note: $('note'), shield: $('shield'), unlock: $('unlock'), lock: $('lock') };

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let ws = null;
let recognition = null;
let on = false;
let speaking = false;
let wakeLock = null;

els.lang.value = localStorage.getItem('walk-lang') || 'en-US';
els.lang.addEventListener('change', () => { localStorage.setItem('walk-lang', els.lang.value); if (recognition) { recognition.lang = els.lang.value; } });

function setState(text, kind = '') {
  els.state.textContent = text;
  els.state.className = `state${kind ? ` is-${kind}` : ''}`;
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* the page still works; the screen may dim */ }
}
document.addEventListener('visibilitychange', () => { if (on && document.visibilityState === 'visible') keepAwake(); });

function listen() {
  if (!on || speaking || !recognition) return;
  try { recognition.start(); setState('Listening', 'listening'); } catch { /* already listening */ }
}

function speak(text) {
  els.said.textContent = text;
  speaking = true;
  try { recognition?.abort(); } catch { /* not running */ }
  setState('Speaking', 'speaking');
  speechSynthesis.cancel();
  // Long texts are spoken sentence by sentence; some phones cut off one long utterance.
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    u.lang = els.lang.value;
    if (i === parts.length - 1) {
      const doneSpeaking = () => { speaking = false; listen(); };
      u.onend = doneSpeaking;
      u.onerror = doneSpeaking;
    }
    speechSynthesis.speak(u);
  });
}

function say(command) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'prompt', voicePrompt: command, last: true }));
}

function start() {
  if (!Recognition) {
    setState('This browser cannot listen', 'error');
    els.note.textContent = 'Walk mode needs Chrome on Android (or another browser with speech recognition).';
    return;
  }
  on = true;
  els.talk.textContent = 'Stop';
  els.talk.classList.add('is-on');
  keepAwake();
  // Speaking once inside the tap lets the phone read aloud later without another tap.
  speechSynthesis.speak(new SpeechSynthesisUtterance(' '));

  recognition = new Recognition();
  recognition.lang = els.lang.value;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    const text = result[0].transcript.trim();
    els.heard.textContent = text;
    if (result.isFinal && text) say(text);
  };
  recognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setState('The microphone is not allowed', 'error');
      els.note.textContent = 'Allow the microphone for this page in the browser’s site settings, then start again.';
      stop();
    }
  };
  // Recognition ends after every sentence and every silence; start it again.
  recognition.onend = () => { if (on && !speaking) setTimeout(listen, 250); };

  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/walk/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'setup', from: 'walk mode' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'text') speak(msg.token);
    else if (msg.type === 'end') stop('Goodbye');
  };
  ws.onclose = () => { if (on) stop('The connection to the app was lost'); };
  setState('Connecting');
}

function stop(text = 'Tap to start') {
  on = false;
  speaking = false;
  try { recognition?.abort(); } catch { /* not running */ }
  recognition = null;
  speechSynthesis.cancel();
  ws?.close();
  ws = null;
  wakeLock?.release?.().catch(() => {});
  els.talk.textContent = 'Start';
  els.talk.classList.remove('is-on');
  els.shield.hidden = true;
  setState(text);
}

els.talk.addEventListener('click', () => (on ? stop() : start()));
for (const button of document.querySelectorAll('[data-say]')) {
  button.addEventListener('click', () => { speechSynthesis.cancel(); speaking = false; say(button.dataset.say); });
}

// The pocket lock: a dark cover that swallows touches. Hold the button to lift it.
els.lock.addEventListener('click', () => { if (on) els.shield.hidden = false; });
let holdTimer = 0;
const hold = () => { holdTimer = setTimeout(() => { els.shield.hidden = true; }, 1200); };
const release = () => clearTimeout(holdTimer);
els.unlock.addEventListener('pointerdown', hold);
els.unlock.addEventListener('pointerup', release);
els.unlock.addEventListener('pointerleave', release);

if (!window.isSecureContext) {
  els.note.textContent = 'The microphone only works over https or on the computer itself. Open the app through its Tailscale address (docs/pi.md).';
}
