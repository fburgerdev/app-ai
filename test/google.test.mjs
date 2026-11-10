import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-google-'));
process.env.APP_AI_DATA = data;
const google = await import('../server/google.js');
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('a draft with umlauts survives as a mail', () => {
  const mail = decode(google.buildRawMessage({
    to: 'Jörg Beispiel <j@example.org>, plain@example.org',
    subject: 'Nächste Schritte',
    body: 'Hallo,\n\nviele Grüße\nFlorian',
  }));
  const [head, body] = mail.split('\r\n\r\n');
  assert.match(head, /^To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <j@example\.org>, plain@example\.org$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.match(head, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hallo,\r\n\r\nviele Grüße\r\nFlorian');
});

test('a header cannot be smuggled in through the subject', () => {
  const mail = decode(google.buildRawMessage({ to: 'a@example.org', subject: 'Hi\r\nBcc: someone@evil.example', body: 'x' }));
  assert.doesNotMatch(mail.split('\r\n\r\n')[0], /^Bcc:/m);
});

test('saving a reply draft refreshes the token and threads the mail', async () => {
  google.initGoogle({ google: { clientId: 'id', clientSecret: 'secret' } });
  fs.writeFileSync(path.join(data, 'google-token.json'), JSON.stringify({ refresh_token: 'r', access_token: 'old', expires: 0, email: 'me@example.org' }));
  const calls = [];
  google.setHttp(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body });
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (String(url).includes('oauth2.googleapis.com/token')) return json({ access_token: 'fresh', expires_in: 3600 });
    if (String(url).includes('/threads/T1')) {
      return json({ messages: [
        { labelIds: ['INBOX'], payload: { headers: [{ name: 'Message-ID', value: '<one@mail>' }] } },
        { labelIds: ['DRAFT'], payload: { headers: [{ name: 'Message-ID', value: '<draft@mail>' }] } },
      ] });
    }
    if (String(url).endsWith('/drafts/D1')) return json({ id: 'D1' });
    return json({});
  });
  assert.equal(google.googleStatus().connected, true);
  const out = await google.gmailSaveDraft({ draftId: 'D1', replyToThreadId: 'T1', to: 'a@example.org', subject: 'Re: Termin', body: 'Passt.' });
  assert.deepEqual(out, { draftId: 'D1', replaced: true });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const put = calls.at(-1);
  assert.equal(put.method, 'PUT');
  assert.equal(put.auth, 'Bearer fresh');
  const sent = JSON.parse(put.body);
  assert.equal(sent.message.threadId, 'T1');
  assert.match(decode(sent.message.raw), /^In-Reply-To: <one@mail>$/m, 'it answers the last real message, not an older draft');
  assert.ok(!calls.some((c) => /\/send\b/.test(c.url)), 'nothing is ever sent');
});

test('a calendar entry goes into the own calendar without guests', async () => {
  let body;
  google.setHttp(async (url, init = {}) => {
    if (init.body && String(url).includes('/calendars/primary/events')) body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ id: 'E1', htmlLink: 'https://calendar.example/E1' }) };
  });
  const out = await google.calendarCreate({ title: 'Treffen', start: '2026-12-03', end: '2026-12-04', allDay: true });
  assert.equal(out.id, 'E1');
  assert.deepEqual(body.start, { date: '2026-12-03' });
  assert.equal(body.attendees, undefined);
});

test('the tools can be built for a thread', async () => {
  const server = await google.buildGoogleServer();
  assert.equal(server.name, 'google');
});
