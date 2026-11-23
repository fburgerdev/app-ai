// Mail attachments: listed when a thread is read, downloaded onto a thread's workbench,
// and handed to the brain update (fetched again from Gmail where the file is not here).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup } from './helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-mailfiles-'));
process.env.APP_AI_DATA = path.join(root, 'data');
fs.mkdirSync(process.env.APP_AI_DATA, { recursive: true });

const { loadConfig } = await import('../server/config.js');
loadConfig();
const store = await import('../server/store.js');
const google = await import('../server/google.js');
const { mailFileLines } = await import('../server/extract.js');

test.after(() => cleanup(root));

const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80, ...Array.from({ length: 200 }, (_, i) => i % 256)]);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
let attachmentCalls = 0;

// One mail with a text, a PDF fetched by attachment id (a fresh one each time, as Gmail
// does), a small file carried inline, and a logo inside the text.
function message() {
  return {
    id: 'M1',
    threadId: 'T1',
    labelIds: ['INBOX'],
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [{ name: 'Subject', value: 'Antrag' }, { name: 'From', value: 'Anna <anna@example.org>' }, { name: 'Date', value: 'Mon, 23 Nov 2026 10:00:00 +0100' }],
      parts: [
        { partId: '0', mimeType: 'multipart/related', parts: [
          { partId: '0.0', mimeType: 'text/plain', body: { data: b64url('Hallo, anbei der Antrag.') } },
          { partId: '0.1', mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }], body: { attachmentId: `L${Math.random()}`, size: 900 } },
        ] },
        { partId: '1', mimeType: 'application/pdf', filename: 'Antrag Förderung.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: `A${Math.random()}`, size: pdf.length } },
        { partId: '2', mimeType: 'text/plain', filename: 'notiz.txt', body: { data: b64url('kurz'), size: 4 } },
      ],
    },
  };
}

function connect() {
  google.initGoogle({ google: { clientId: 'id', clientSecret: 'secret' } });
  fs.writeFileSync(path.join(process.env.APP_AI_DATA, 'google-token.json'), JSON.stringify({ refresh_token: 'r', access_token: 'a', expires: Date.now() + 3_600_000 }));
  let current = message();
  google.setHttp(async (url) => {
    const u = new URL(String(url));
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (u.pathname.endsWith('/threads/T1')) return json({ messages: [message()] });
    if (u.pathname.endsWith('/messages/M1')) { current = message(); return json(current); }
    const m = /\/messages\/M1\/attachments\/(.+)$/.exec(u.pathname);
    if (m) {
      attachmentCalls += 1;
      // Only the id from the latest fetch of the message is good.
      const id = decodeURIComponent(m[1]);
      if (id !== current.payload.parts[1].body.attachmentId) return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid attachment token' } }) };
      return json({ data: b64url(pdf), size: pdf.length });
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
  });
}

test('reading a thread lists its attachments by part, logos marked inline', async () => {
  connect();
  const [m] = await google.gmailReadThread({ threadId: 'T1' });
  assert.equal(m.messageId, 'M1');
  assert.equal(m.text, 'Hallo, anbei der Antrag.');
  assert.deepEqual(m.attachments.map((a) => [a.part, a.name, Boolean(a.inline)]), [['0.1', 'logo.png', true], ['1', 'Antrag Förderung.pdf', false], ['2', 'notiz.txt', false]]);
  assert.equal(m.attachments[1].type, 'application/pdf');
  assert.equal(m.attachments[1].size, pdf.length);
});

test('an attachment is downloaded whole, by message and part', async () => {
  connect();
  const file = await google.gmailAttachment({ messageId: 'M1', part: '1' });
  assert.equal(file.name, 'Antrag Förderung.pdf');
  assert.ok(file.data.equals(pdf), 'byte for byte');
  assert.equal(file.mail.subject, 'Antrag');
  const inline = await google.gmailAttachment({ messageId: 'M1', part: '2' });
  assert.equal(inline.data.toString('utf8'), 'kurz', 'a small file carried in the message itself');
  await assert.rejects(google.gmailAttachment({ messageId: 'M1', part: '9' }), /no attachment in part "9"/);
});

test('a thread keeps a download on its workbench, once, and the update gets it even from another computer', async () => {
  connect();
  const t = store.createThread({ title: 'Antrag' });
  const file = await google.gmailAttachment({ messageId: 'M1', part: '1' });
  const first = store.saveMailFile(t.id, file, { messageId: 'M1', part: '1' });
  assert.equal(path.dirname(first.file), store.mailDir(t.id));
  assert.ok(first.file.startsWith(store.workDir(t.id)), 'on the workbench, not among the shown files');
  assert.ok(fs.readFileSync(first.file).equals(pdf));
  const again = store.saveMailFile(t.id, file, { messageId: 'M1', part: '1' });
  assert.equal(again.again, true);
  assert.equal(again.file, first.file);
  assert.equal(store.getThread(t.id).mailFiles.length, 1, 'remembered once');
  // A different file with the same name does not overwrite the first.
  const other = store.saveMailFile(t.id, { ...file, data: Buffer.from('x') }, { messageId: 'M2', part: '1' });
  assert.equal(path.basename(other.file), 'Antrag Förderung (2).pdf');
  assert.equal(fs.readdirSync(store.artifactsDir(t.id)).length, 0, 'nothing is shown by itself');

  // The brain update copies what is here, and fetches again what is not.
  const out = path.join(root, 'update');
  fs.rmSync(store.mailDir(t.id), { recursive: true, force: true });
  store.saveMailFile(t.id, file, { messageId: 'M1', part: '1' });
  fs.rmSync(path.join(store.mailDir(t.id), 'Antrag Förderung.pdf'));
  const calls = attachmentCalls;
  const lines = await mailFileLines(store.getThread(t.id), out);
  assert.equal(lines.length, 2);
  const fetched = lines.find((l) => l.startsWith('- "Antrag Förderung.pdf"'));
  assert.match(fetched, /attached to the mail "Antrag" from Anna <anna@example\.org>.*: `.*mail - Antrag Förderung\.pdf`$/);
  assert.ok(fs.readFileSync(path.join(out, 'mail - Antrag Förderung.pdf')).equals(pdf), 'fetched again from Gmail');
  assert.ok(attachmentCalls > calls);
  assert.match(lines.find((l) => l.startsWith('- "Antrag Förderung (2).pdf"')), /could not be fetched/, 'one Gmail no longer has is said, not hidden');
});

test('the download tool is offered only where there is a workbench to save to', async () => {
  const names = async (opts) => {
    const server = await google.buildGoogleServer(opts);
    return Object.keys(server.instance._registeredTools);
  };
  const withSave = await names({ saveAttachment: async () => ({}) });
  const without = await names();
  assert.ok(withSave.includes('gmail_read_thread'));
  assert.ok(withSave.includes('gmail_download_attachment'));
  assert.ok(without.includes('gmail_read_thread'));
  assert.ok(!without.includes('gmail_download_attachment'), 'a card has no workbench, so no download');
});
