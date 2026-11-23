// The mails that led to a calendar entry, word for word, as a file in its event thread.
//
// Florian's wish, 23-11-2026: with the briefing for a call he wants the mail thread that
// led to it, so he can read what he asked himself and not only Claude's summary of it.
// So the app fetches the conversation from Gmail and writes it out itself: nothing in
// between retells it.

import fs from 'node:fs';
import path from 'node:path';
import * as google from './google.js';
import * as store from './store.js';

export const gmailLink = (threadId) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

// Gmail thread ids: hex, as the mail tools return them.
export function mailThreadIds(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return [...new Set(list.map((x) => String(x || '').trim()).filter((x) => /^[0-9a-f]{6,32}$/i.test(x)))].slice(0, 3);
}

export function historyFileName(title) {
  const safe = String(title || 'Termin').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Termin';
  return `Mailverlauf — ${safe}.md`;
}

// A reply carries the earlier mails quoted below it. They are in the file once already,
// as mails of their own, so the quote is left off: "Am … schrieb …:" or "On … wrote:"
// with the ">" lines after it, or an Outlook-style block ("-----Original Message-----",
// "Von: … Gesendet: …").
export function withoutQuote(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.length;
  // Outlook: the old mail starts with a marker line or a header block.
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-{2,}\s*(Original Message|Ursprüngliche Nachricht|Forwarded message|Weitergeleitete Nachricht)\s*-{2,}\s*$/i.test(lines[i])) { cut = i; break; }
    if (/^\s*(Von|From):\s+\S/.test(lines[i]) && lines.slice(i + 1, i + 5).some((l) => /^\s*(Gesendet|Sent|Datum|Date):\s+\S/.test(l))) { cut = i; break; }
  }
  // Gmail and most others: a block of ">" lines at the end, with the line that names it.
  let end = cut;
  while (end > 0 && (!lines[end - 1].trim() || lines[end - 1].startsWith('>'))) end -= 1;
  if (end < cut && lines.slice(end, cut).some((l) => l.startsWith('>'))) {
    let start = end;
    const said = /(wrote|schrieb|geschrieben)\b.*:\s*$/i;
    if (start > 0 && said.test(lines[start - 1])) start -= 1;
    else if (start > 1 && said.test(`${lines[start - 2]} ${lines[start - 1]}`)) start -= 2;
    cut = start;
  }
  const kept = lines.slice(0, cut).join('\n').trim();
  return { text: kept || String(text || '').trim(), cut: Boolean(kept) && cut < lines.length };
}

const p2 = (n) => String(n).padStart(2, '0');
function when(dateHeader) {
  const d = new Date(dateHeader);
  if (Number.isNaN(d.getTime())) return String(dateHeader || '').trim() || 'undated';
  return `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// Mail text shown as written: a line starting with "#" is not a heading, "<" starts no tag.
const asWritten = (s) => String(s || '').replace(/</g, '\\<').replace(/^(\s*)#/gm, '$1\\#');
const shortName = (from) => String(from || '').replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || String(from || '').trim();

// threads: [{ threadId, messages }] with messages as google.gmailReadThread returns them.
export function historyMarkdown(title, threads) {
  const out = [`# Mailverlauf — ${title}`, ''];
  out.push('The mails that led to this entry, oldest first, as they were written. Earlier mails quoted at the bottom of a reply are left off; they are here as mails of their own.', '');
  for (const { threadId, messages } of threads) {
    const sent = messages.filter((m) => !(m.labels || []).includes('DRAFT'));
    if (threads.length > 1 || sent[0]?.subject) out.push(`## ${asWritten(sent[0]?.subject || '(no subject)')}`, '');
    out.push(`[Open in Gmail](${gmailLink(threadId)})`, '');
    for (const m of sent) {
      const mine = (m.labels || []).includes('SENT');
      out.push(`### ${when(m.date)} · ${asWritten(shortName(m.from))}${mine ? ' (you)' : ''}`, '');
      out.push(`**From:** ${asWritten(m.from)}  `);
      out.push(`**To:** ${asWritten(m.to)}${m.cc ? '  ' : ''}`);
      if (m.cc) out.push(`**Cc:** ${asWritten(m.cc)}`);
      out.push('');
      const { text } = withoutQuote(m.text);
      out.push(asWritten(text) || '(no text)', '');
      const files = (m.attachments || []).filter((a) => !a.inline);
      if (files.length) out.push(`Attached: ${files.map((a) => asWritten(a.name)).join(', ')}`, '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// Fetches the conversations and writes the file into the thread's artifacts folder, shown.
// Returns { name, v, path }, or null when none of them had a mail in it.
export async function writeMailHistory(threadId, title, ids, read = google.gmailReadThread) {
  const threads = [];
  for (const id of ids) {
    const messages = await read({ threadId: id });
    if (messages.some((m) => !(m.labels || []).includes('DRAFT'))) threads.push({ threadId: id, messages });
  }
  if (!threads.length) return null;
  // Oldest conversation first, like the mails inside each.
  const first = (t) => Date.parse(t.messages[0]?.date) || 0;
  threads.sort((a, b) => first(a) - first(b));
  const name = historyFileName(title);
  const file = path.join(store.artifactsDir(threadId), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, historyMarkdown(title, threads));
  const shown = store.scanArtifacts(threadId, 'app', { serve: [name] }).find((c) => c.name === name);
  const v = shown?.v || store.listArtifacts(threadId).find((a) => a.name === name)?.versions.at(-1)?.v || 1;
  return { name, v, path: file };
}
