// A mail Claude writes is a Markdown file that starts with a few header lines:
//
//   ---
//   type: mail
//   to: someone@example.org
//   subject: Nächste Schritte
//   reply-to-thread: 18c2f…        (only when it answers a mail in Gmail)
//   ---
//   Hallo …
//
// The app shows such a file as a mail card with Put in Gmail and Send.

const KEYS = ['to', 'cc', 'bcc', 'subject', 'from', 'reply-to-thread'];

export function parseMail(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const head = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) head[kv[1].toLowerCase()] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  if (head.type !== 'mail') return null;
  return {
    to: head.to || '',
    cc: head.cc || '',
    bcc: head.bcc || '',
    subject: head.subject || '',
    from: head.from || '',
    replyToThreadId: head['reply-to-thread'] || '',
    body: m[2].replace(/^\s*\n/, '').replace(/\s+$/, ''),
  };
}

export function serializeMail(mail) {
  const head = { ...mail, 'reply-to-thread': mail.replyToThreadId };
  const lines = ['---', 'type: mail'];
  for (const key of KEYS) {
    const value = String(head[key] || '').replace(/[\r\n]+/g, ' ').trim();
    if (value || key === 'to' || key === 'subject') lines.push(`${key}: ${value}`);
  }
  lines.push('---', '', String(mail.body || '').trim(), '');
  return lines.join('\n');
}
