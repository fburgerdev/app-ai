import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pad = (n) => String(n).padStart(2, '0');

// The vault writes dates as DD-MM-YYYY, so the app does too.
export function dateDMY(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export function dateTimeDMY(ts = Date.now()) {
  const d = new Date(ts);
  return `${dateDMY(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayLine() {
  const weekday = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
  return `${weekday}, ${dateDMY()}`;
}

export function readPrompt(name, values = {}) {
  let text = fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8');
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  return text;
}

// A file name that is safe on Windows, macOS and Linux.
export function safeFileName(name, max = 80) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'untitled').slice(0, max).trim();
}

// The text of an assistant message, without tool lines.
export function messageText(message) {
  if (message.role === 'user') return message.text || '';
  return (message.parts || [])
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'artifact') return `[made the file "${p.name}", version ${p.v}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// When the host was last talked to, and in which language. A thread that becomes ready
// soon after gets its spoken version prepared at once, so a walk does not wait for it.
export const voiceActivity = { at: 0, lang: 'en' };
