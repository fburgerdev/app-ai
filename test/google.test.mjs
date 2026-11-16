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

test('a reply to a conversation that is not there goes out as a mail of its own', async () => {
  let posted;
  google.setHttp(async (url, init = {}) => {
    if (String(url).includes('/threads/GONE')) return { ok: false, status: 404, json: async () => ({ error: { message: 'Requested entity was not found.' } }) };
    if (String(url).endsWith('/drafts')) posted = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ id: 'D2', access_token: 'fresh', expires_in: 3600 }) };
  });
  const out = await google.gmailSaveDraft({ replyToThreadId: 'GONE', to: 'a@example.org', subject: 'Re: Termin', body: 'Passt.' });
  assert.equal(out.draftId, 'D2');
  assert.equal(posted.message.threadId, undefined);
  assert.doesNotMatch(decode(posted.message.raw), /^In-Reply-To:/m);
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

test('the update reads all mail since the last one, page by page, and skips automated mail', async () => {
  const since = Date.UTC(2026, 10, 14, 0, 0);
  // 700 messages: more than one page. Every tenth is a no-reply notification, every
  // seventh a newsletter; Florian's own mail from a list address still counts.
  const all = Array.from({ length: 700 }, (_, i) => {
    const headers = [{ name: 'From', value: i % 10 === 0 ? 'EAGxBerlin <noreply@swapcard.com>' : `Person ${i} <p${i}@example.org>` }];
    if (i % 7 === 0) headers.push({ name: 'List-Unsubscribe', value: '<mailto:x@example.org>' }, { name: 'List-Id', value: 'news.example.org' });
    return { id: `m${i}`, threadId: `t${i % 50}`, internalDate: String(since + (700 - i) * 60_000), labelIds: i === 70 ? ['SENT'] : ['INBOX'], payload: { headers: [...headers, { name: 'Subject', value: `S${i}` }], mimeType: 'text/plain', body: { data: Buffer.from(`text ${i}`).toString('base64url') } } };
  });
  const byId = new Map(all.map((m) => [m.id, m]));
  let fullFetches = 0;
  google.setHttp(async (url) => {
    const u = new URL(String(url));
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fresh', expires_in: 3600 });
    if (u.pathname.endsWith('/messages')) {
      assert.match(u.searchParams.get('q'), /after:\d+ -in:drafts -in:spam -in:trash/);
      const start = Number(u.searchParams.get('pageToken') || 0);
      const n = Number(u.searchParams.get('maxResults'));
      const page = all.slice(start, start + n).map((m) => ({ id: m.id }));
      return json({ messages: page, ...(start + n < all.length ? { nextPageToken: String(start + n) } : {}) });
    }
    const m = byId.get(u.pathname.split('/').pop());
    if (u.searchParams.get('format') === 'full') fullFetches += 1;
    return json(m);
  });
  const threads = await google.gmailSince(since);
  const automated = all.filter((m, i) => i !== 70 && (i % 10 === 0 || i % 7 === 0)).length;
  assert.equal(threads.skipped, automated);
  assert.equal(threads.read, all.length - automated, 'nothing beyond the first page is lost');
  assert.equal(fullFetches, threads.read, 'automated mail is judged from its headers only');
  assert.ok(threads.flatMap((t) => t.messages).some((m) => m.sent && m.text === 'text 70'), 'his own mail is kept even from a list');
});

test('automated mail is told from the headers', () => {
  const h = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
  assert.equal(google.isAutomated(h({ From: 'PayPal <service@paypal.de>' })), false, 'a sender name alone is not enough');
  assert.equal(google.isAutomated(h({ From: 'no-reply@mailing.bahn.de' })), true);
  assert.equal(google.isAutomated(h({ From: 'Jörg <j@kstw.de>', 'Auto-Submitted': 'auto-replied' })), true, 'an out-of-office reply');
  assert.equal(google.isAutomated(h({ From: 'Jörg <j@kstw.de>', 'Auto-Submitted': 'no' })), false);
  assert.equal(google.isAutomated(h({ From: 'Green Office <green-office@uni-koeln.de>', 'List-Unsubscribe': '<x>', 'List-Id': 'go.uni-koeln.de' })), true);
  assert.equal(google.isAutomated(h({ From: 'Anja <anja@uk-koeln.de>' })), false);
  assert.equal(google.isAutomated(h({ From: 'noreply@x.org' }), ['SENT']), false);
});
