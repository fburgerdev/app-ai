// Listening and speaking for the Talk page, without the phone's own speech engines.
//
//   hearing   the page records what Florian says and sends the audio here; Groq's
//             Whisper turns it into text. Needs voice.groqKey.
//   speaking  the page asks for a sentence as audio. "piper" makes it on this machine
//             (free, works on the Pi); "openai" asks OpenAI's voice (needs
//             voice.openaiKey). Without either, the phone's own voice is used.
//
// Keys live in config.json, which is never committed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, log } from './config.js';

let config;
export function initSpeech(cfg) { config = cfg; }

const two = (lang) => (String(lang || 'en').toLowerCase().startsWith('de') ? 'de' : 'en');

function piperVoice(lang) {
  const p = config.voice.piper || {};
  const dir = p.dir || path.join(DATA_DIR, 'piper');
  const name = (p.voices || {})[two(lang)];
  if (!name) return null;
  const file = path.isAbsolute(name) ? name : path.join(dir, name.endsWith('.onnx') ? name : `${name}.onnx`);
  return fs.existsSync(file) ? file : null;
}

export function speechStatus() {
  const v = config.voice;
  const voices = [];
  if (config.fake || piperVoice('en') || piperVoice('de')) voices.push('piper');
  if (v.openaiKey) voices.push('openai');
  return {
    hear: config.fake || v.groqKey ? 'groq' : 'device',
    voices, // server voices on offer; the phone's own is always there too
    speak: voices.includes(v.speak) ? v.speak : voices[0] || 'device',
    piperLanguages: ['en', 'de'].filter((l) => config.fake || piperVoice(l)),
  };
}

// Things Whisper writes when it is given noise or silence.
const PHANTOMS = /^(thank you\.?|thanks for watching\.?!?|you\.?|bye\.?|\.+|untertitel(ung)? (der|von|im auftrag).*|vielen dank( fürs zuschauen)?\.?|copyright.*|www\..*)$/i;

export async function hear({ audio, mime, lang, words }) {
  if (config.fake) return { text: audio.length > 2000 ? 'what is waiting?' : '' };
  const v = config.voice;
  if (!v.groqKey) throw new Error('Listening through Groq is not set up (voice.groqKey).');
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `speech.${ext}`);
  form.append('model', v.hearModel || 'whisper-large-v3-turbo');
  form.append('language', two(lang));
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // Names he uses, so they are spelled the way he spells them.
  if (words) form.append('prompt', String(words).slice(0, 800));
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${v.groqKey}` }, body: form, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(res.status === 401 ? 'Groq refused the key (voice.groqKey).' : res.status === 429 ? 'Groq says: too many requests right now.' : `Groq answered ${res.status}. ${detail}`);
  }
  const text = String((await res.json()).text || '').trim();
  return { text: PHANTOMS.test(text) ? '' : text };
}

// A second of silence as a WAV, for the stand-in.
function silentWav() {
  const samples = 8000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}

function piper(text, lang) {
  const model = piperVoice(lang) || piperVoice(two(lang) === 'de' ? 'en' : 'de');
  if (!model) throw new Error('No Piper voice is installed (see docs/voice.md).');
  const out = path.join(os.tmpdir(), `app-ai-say-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const command = (config.voice.piper || {}).command || 'piper';
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-m', model, '-f', out], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `Piper is not installed ("${command}" not found). See docs/voice.md.` : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`Piper stopped with an error. ${err.trim().split('\n').pop() || ''}`);
        resolve({ audio: fs.readFileSync(out), type: 'audio/wav' });
      } catch (e) { reject(e); } finally { fs.rm(out, { force: true }, () => {}); }
    });
    child.stdin.end(text.replace(/\s+/g, ' ').trim());
  });
}

async function openai(text, lang) {
  const v = config.voice;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${v.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: v.openaiModel || 'gpt-4o-mini-tts', voice: v.openaiVoice || 'sage', input: text, response_format: 'mp3',
      instructions: `Speak ${two(lang) === 'de' ? 'German' : 'English'}, calmly and clearly, like a colleague briefing someone on a walk.`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenAI refused the key (voice.openaiKey).' : `OpenAI answered ${res.status}.`);
  return { audio: Buffer.from(await res.arrayBuffer()), type: 'audio/mpeg' };
}

export async function say({ text, lang, engine }) {
  const clean = String(text || '').trim().slice(0, 1200);
  if (!clean) throw new Error('Nothing to say.');
  if (config.fake) return { audio: silentWav(), type: 'audio/wav' };
  const status = speechStatus();
  const use = status.voices.includes(engine) ? engine : status.speak;
  try {
    if (use === 'openai') return await openai(clean, lang);
    if (use === 'piper') return await piper(clean, lang);
  } catch (err) {
    log(`speech: ${use} failed: ${err.message}`);
    throw err;
  }
  throw new Error('No voice is set up on the server.');
}
