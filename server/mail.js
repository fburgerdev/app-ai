// A mail Claude writes is a Markdown file that starts with a few header lines:
//
//   ---
//   type: mail
//   to: someone@example.org
//   subject: Nächste Schritte
//   reply-to-thread: 18c2f…        (only when it answers a mail in Gmail)
//   attach: Konzept.pdf            (one line per file that goes along; see below)
//   ---
//   Hallo …
//
// The app shows such a file as a mail card with Put in Gmail and Send.
//
// An `attach:` line names one file of the thread: a file Claude made in it (its name as
// shown), a file Florian attached to a message (its name), or a document in the vault's
// `Files/` folder (`Files/2026-11-17 Konzept.pdf`). A name may hold commas, so there is one
// line per file.

const KEYS = ['to', 'cc', 'bcc', 'subject', 'from', 'reply-to-thread'];

export function parseMail(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const head = {};
  const attach = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^"(.*)"$/, '$1');
    if (kv[1].toLowerCase() === 'attach') { if (value && !attach.includes(value)) attach.push(value); } else head[kv[1].toLowerCase()] = value;
  }
  if (head.type !== 'mail') return null;
  return {
    to: head.to || '',
    cc: head.cc || '',
    bcc: head.bcc || '',
    subject: head.subject || '',
    from: head.from || '',
    replyToThreadId: head['reply-to-thread'] || '',
    attach,
    body: m[2].replace(/^\s*\n/, '').replace(/\s+$/, ''),
  };
}

// The thread a sent mail closes, or null. A reply finishes the thread it was written in:
// a thread the app opened for a mail to answer, or any other thread when the mail answers
// a conversation in Gmail. Cards close themselves; a thread Claude is still working in or
// already closed is left as it is.
export function closesOnSend(thread, mail) {
  if (!thread || thread.kind === 'card' || thread.state !== 'ready') return null;
  return thread.kind === 'mail-reply' || mail?.replyToThreadId ? thread : null;
}

export function serializeMail(mail) {
  const head = { ...mail, 'reply-to-thread': mail.replyToThreadId };
  const lines = ['---', 'type: mail'];
  for (const key of KEYS) {
    const value = String(head[key] || '').replace(/[\r\n]+/g, ' ').trim();
    if (value || key === 'to' || key === 'subject') lines.push(`${key}: ${value}`);
  }
  for (const name of mail.attach || []) {
    const value = String(name || '').replace(/[\r\n]+/g, ' ').trim();
    if (value) lines.push(`attach: ${value}`);
  }
  lines.push('---', '', String(mail.body || '').trim(), '');
  return lines.join('\n');
}
