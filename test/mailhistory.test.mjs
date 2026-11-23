// The mails that led to a calendar entry, shown word for word in its event thread.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-mailhistory-'));
process.env.APP_AI_DATA = data;
const { historyFileName, historyMarkdown, mailThreadIds, withoutQuote, writeMailHistory } = await import('../server/mailhistory.js');
const store = await import('../server/store.js');
const { mailNote } = await import('../server/events.js');
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test('only real Gmail thread ids are kept, three at most', () => {
  assert.deepEqual(mailThreadIds(['18c2f0a1b2c3d4e5', 'nonsense!', '18c2f0a1b2c3d4e5', 'abcdef1', 'abcdef2', 'abcdef3']), ['18c2f0a1b2c3d4e5', 'abcdef1', 'abcdef2']);
  assert.deepEqual(mailThreadIds('18c2f0a1b2c3d4e5, 19d'), ['18c2f0a1b2c3d4e5']);
  assert.deepEqual(mailThreadIds(undefined), []);
  assert.equal(historyFileName('Call: KStW / Jörg'), 'Mailverlauf — Call KStW Jörg.md');
});

test('a reply loses the earlier mails quoted below it, and nothing else', () => {
  const gmail = 'Passt, Donnerstag 14 Uhr.\n\nViele Grüße\nJörg\n\nAm Mo., 17. Nov. 2026 um 10:12 Uhr schrieb Florian Burger <\nflorian@example.org>:\n\n> Hallo Jörg,\n> hätten Sie Donnerstag Zeit?\n';
  assert.deepEqual(withoutQuote(gmail), { text: 'Passt, Donnerstag 14 Uhr.\n\nViele Grüße\nJörg', cut: true });
  const english = 'Sounds good.\n\nOn Mon, 17 Nov 2026 at 10:12, Florian <f@example.org> wrote:\n> Shall we talk?';
  assert.equal(withoutQuote(english).text, 'Sounds good.');
  const outlook = 'Gern.\r\n\r\nVon: Florian Burger <f@example.org>\r\nGesendet: Montag, 17. November 2026 10:12\r\nAn: Jörg\r\nBetreff: Termin\r\n\r\nHallo Jörg';
  assert.equal(withoutQuote(outlook).text, 'Gern.');
  const plain = 'Hallo,\n\n> ein Zitat mitten im Text\n\nund dann geht es weiter.';
  assert.deepEqual(withoutQuote(plain), { text: plain, cut: false }, 'a quote in the middle stays');
});

const thread = [
  { messageId: 'm1', date: 'Mon, 17 Nov 2026 10:12:00 +0100', from: 'Florian Burger <f@example.org>', to: 'Jörg <j@example.org>', subject: 'Termin zur Mensa', labels: ['SENT'], text: 'Hallo Jörg,\n\nhätten Sie Donnerstag Zeit?\n# kein Titel\n\nViele Grüße\nFlorian' },
  { messageId: 'm2', date: 'Tue, 18 Nov 2026 09:00:00 +0100', from: 'Jörg <j@example.org>', to: 'f@example.org', cc: 'office@example.org', subject: 'Re: Termin zur Mensa', labels: ['INBOX'], text: 'Passt.\n\nOn Mon, Florian wrote:\n> hätten Sie Donnerstag Zeit?', attachments: [{ part: '1', name: 'Agenda.pdf', type: 'application/pdf', size: 10 }, { part: '2', name: 'logo.png', inline: true }] },
  { messageId: 'm3', date: 'Tue, 18 Nov 2026 11:00:00 +0100', from: 'Florian Burger <f@example.org>', to: 'j@example.org', subject: 'Re: Termin zur Mensa', labels: ['DRAFT'], text: 'never sent' },
];

test('the file holds every mail as written, oldest first, without drafts', () => {
  const md = historyMarkdown('Call with Jörg', [{ threadId: '19abc0def1', messages: thread }]);
  assert.match(md, /^# Mailverlauf — Call with Jörg\n/);
  assert.match(md, /\[Open in Gmail\]\(https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/19abc0def1\)/);
  assert.match(md, /## Termin zur Mensa/);
  assert.match(md, /### 17-11-2026 \d\d:12 · Florian Burger \(you\)/);
  assert.match(md, /\*\*From:\*\* Florian Burger \\<f@example\.org>/, 'an address is no tag');
  assert.match(md, /hätten Sie Donnerstag Zeit\?\n\\# kein Titel\n/, 'his own words, a # line no heading');
  assert.match(md, /\*\*Cc:\*\* office@example\.org/);
  assert.match(md, /Attached: Agenda\.pdf\n/);
  assert.doesNotMatch(md, /logo\.png/);
  assert.doesNotMatch(md, /never sent/);
  assert.equal(md.match(/hätten Sie Donnerstag Zeit/g).length, 1, 'the quote in the reply is left off');
  assert.ok(md.indexOf('17-11-2026') < md.indexOf('18-11-2026'));
});

test('the app writes the file into the event thread and shows it', async () => {
  const t = store.createThread({ title: 'Call with Jörg', kind: 'event' });
  const asked = [];
  const file = await writeMailHistory(t.id, t.title, ['19abc0def1', 'abcdef9'], async ({ threadId }) => {
    asked.push(threadId);
    return threadId === '19abc0def1' ? thread : [thread[2]];
  });
  assert.deepEqual(asked, ['19abc0def1', 'abcdef9']);
  assert.equal(file.name, 'Mailverlauf — Call with Jörg.md');
  const shown = store.listArtifacts(t.id);
  assert.deepEqual(shown.map((a) => a.name), [file.name]);
  assert.equal(shown[0].versions.at(-1).by, 'app');
  assert.match(store.readArtifactText(t.id, file.name), /Passt\./);
  assert.doesNotMatch(store.readArtifactText(t.id, file.name), /never sent/, 'a conversation with only a draft is left out');
  assert.equal(await writeMailHistory(t.id, t.title, ['abcdef9'], async () => [thread[2]]), null);
});

test('the briefing is told where the mails are, or to look for them', () => {
  const t = { title: 'Call with Jörg', event: { mailThreads: ['19abc0def1'] } };
  assert.match(mailNote(t, { file: { name: 'Mailverlauf — Call with Jörg.md', path: '/x/y.md' } }), /word for word, as the file "Mailverlauf — Call with Jörg\.md"/);
  assert.match(mailNote(t, { mail: true }), /^Search his mail .*"Mailverlauf — Call with Jörg\.md"/s);
  assert.match(mailNote(t, { failed: 'timeout', mail: true }), /could not fetch it: timeout/);
  assert.equal(mailNote(t, { mail: false }), '', 'without Gmail, nothing about mail');
});
