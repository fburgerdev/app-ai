// Gmail and Google Calendar for threads.
//
// The app talks to Google directly, signed in as you through your own Google Cloud
// project (docs/google.md). Claude gets a small set of tools: search and read mail, read
// the calendar, add a calendar entry. There is no tool that sends mail or deletes
// anything, so a thread cannot do those whatever it is told. A calendar entry can carry
// guests, who get Google's invitation (Florian's yes, 17-11-2026); the thread then gets a
// note saying who was invited.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { GOOGLE_TOKEN_FILE, log } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose', // needed for drafts
  'https://www.googleapis.com/auth/gmail.modify', // archiving a conversation once its reply is sent
  'https://www.googleapis.com/auth/calendar.events',
];
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';

let config;
let http = (...args) => fetch(...args);
const pendingStates = new Map(); // state -> { redirectUri, expires }

export function initGoogle(cfg) {
  config = cfg;
}

// For tests: replace the network.
export function setHttp(fn) {
  http = fn;
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(GOOGLE_TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeToken(token) {
  fs.writeFileSync(GOOGLE_TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function googleStatus() {
  const configured = Boolean(config.google.clientId && config.google.clientSecret);
  const token = readToken();
  const connected = Boolean(configured && token?.refresh_token);
  // A sign-in from before archiving existed holds no record of its permissions; it has
  // to be made again before Send can archive.
  const canArchive = connected && String(token.scope || '').split(' ').includes(MODIFY);
  return { configured, connected, canArchive, email: token?.email || '' };
}

export const googleConnected = () => googleStatus().connected;

// ---------- signing in ----------

export function authUrl(redirectUri) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { redirectUri, expires: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(fields) {
  const res = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google refused the sign-in: ${data.error_description || data.error || res.status}`);
  return data;
}

export async function finishAuth({ code, state }) {
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending || pending.expires < Date.now()) throw new Error('This sign-in link has expired. Start again from Connections.');
  const data = await tokenRequest({ code, redirect_uri: pending.redirectUri, grant_type: 'authorization_code' });
  if (!data.refresh_token) throw new Error('Google sent no long-lived token. Remove the app under myaccount.google.com/permissions and connect again.');
  const token = {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope || '', // what he actually allowed; he can untick a permission
    email: '',
  };
  writeToken(token);
  try {
    token.email = (await api(`${GMAIL}/profile`)).emailAddress || '';
    writeToken(token);
  } catch (err) {
    log(`google: connected, but the address could not be read: ${err.message}`);
  }
  return token.email;
}

export function disconnect() {
  try { fs.unlinkSync(GOOGLE_TOKEN_FILE); } catch { /* already gone */ }
}

async function accessToken() {
  const token = readToken();
  if (!token?.refresh_token) throw new Error('Gmail and Calendar are not connected. Florian connects them in the app under Connections.');
  if (token.access_token && token.expires > Date.now() + 60_000) return token.access_token;
  let data;
  try {
    data = await tokenRequest({ refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  } catch (err) {
    throw new Error(`${err.message}. Florian has to connect Google again in the app under Connections.`);
  }
  token.access_token = data.access_token;
  token.expires = Date.now() + (data.expires_in || 3600) * 1000;
  writeToken(token);
  return token.access_token;
}

async function api(url, { method = 'GET', body } = {}) {
  const res = await http(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google answered ${res.status}: ${data.error?.message || 'no detail'}`);
  return data;
}

// ---------- mail ----------

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const encodeWord = (s) => (isAscii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

// "Jörg Beispiel <j@example.org>, other@example.org" with names made safe for a header.
function encodeAddresses(list) {
  return String(list || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.*)<([^>]+)>$/.exec(part);
      if (!m) return part;
      const name = m[1].trim().replace(/^"|"$/g, '');
      if (!name) return `<${m[2].trim()}>`;
      return `${isAscii(name) ? `"${name.replace(/"/g, '')}"` : encodeWord(name)} <${m[2].trim()}>`;
    })
    .join(', ');
}

// Builds the message in the form Gmail's API takes it.
export function buildRawMessage({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const headers = [];
  if (from) headers.push(`From: ${encodeAddresses(clean(from))}`);
  if (to) headers.push(`To: ${encodeAddresses(clean(to))}`);
  if (cc) headers.push(`Cc: ${encodeAddresses(clean(cc))}`);
  if (bcc) headers.push(`Bcc: ${encodeAddresses(clean(bcc))}`);
  headers.push(`Subject: ${encodeWord(clean(subject))}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${clean(inReplyTo)}`);
  if (references) headers.push(`References: ${clean(references)}`);
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  const encoded = Buffer.from(String(body || '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return b64url(`${headers.join('\r\n')}\r\n\r\n${encoded}`);
}

const header = (message, name) => (message.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function bodyText(payload) {
  if (!payload) return '';
  const find = (part, type) => {
    if (part.mimeType === type && part.body?.data) return fromB64url(part.body.data);
    for (const child of part.parts || []) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return '';
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain;
  const html = find(payload, 'text/html');
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function gmailSearch({ query, max = 10 }) {
  const n = Math.min(Math.max(Number(max) || 10, 1), 25);
  const list = await api(`${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(n) })}`);
  const out = [];
  for (const { id } of list.messages || []) {
    const m = await api(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push({
      threadId: m.threadId,
      date: header(m, 'Date'),
      from: header(m, 'From'),
      to: header(m, 'To'),
      subject: header(m, 'Subject'),
      snippet: m.snippet || '',
      labels: (m.labelIds || []).filter((l) => ['SENT', 'INBOX', 'DRAFT', 'UNREAD'].includes(l)),
    });
  }
  return out;
}

export async function gmailReadThread({ threadId }) {
  const thread = await api(`${GMAIL}/threads/${encodeURIComponent(threadId)}?format=full`);
  return (thread.messages || []).map((m) => {
    let text = bodyText(m.payload);
    if (text.length > 20_000) text = `${text.slice(0, 20_000)}\n[cut: the message is longer]`;
    return {
      date: header(m, 'Date'),
      from: header(m, 'From'),
      to: header(m, 'To'),
      cc: header(m, 'Cc') || undefined,
      subject: header(m, 'Subject'),
      labels: (m.labelIds || []).filter((l) => ['SENT', 'INBOX', 'DRAFT'].includes(l)),
      text,
    };
  });
}

// Creates a draft, or replaces one saved earlier (so a revised mail stays one draft).
export async function gmailSaveDraft({ draftId, replyToThreadId, from, to, cc, bcc, subject, body }) {
  let inReplyTo = '';
  let references = '';
  if (replyToThreadId) {
    // A conversation that is not there (a wrong id from a card run, a deleted mail) must
    // not keep the mail from going out: it then goes as a mail of its own.
    const thread = await api(`${GMAIL}/threads/${encodeURIComponent(replyToThreadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`)
      .catch((err) => { if (/answered 40[04]\b/.test(err.message)) return null; throw err; });
    if (!thread) replyToThreadId = '';
    const last = (thread?.messages || []).filter((m) => !(m.labelIds || []).includes('DRAFT')).at(-1);
    if (last) {
      inReplyTo = header(last, 'Message-ID');
      references = `${header(last, 'References')} ${inReplyTo}`.trim();
    }
  }
  const message = { raw: buildRawMessage({ from, to, cc, bcc, subject, body, inReplyTo, references }) };
  if (replyToThreadId) message.threadId = replyToThreadId;
  const draft = draftId
    ? await api(`${GMAIL}/drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body: { message } })
    : await api(`${GMAIL}/drafts`, { method: 'POST', body: { message } });
  return { draftId: draft.id, replaced: Boolean(draftId) };
}

// Sends a mail. Only ever called from the Send button in the app, after Florian confirms;
// no tool Claude has leads here.
export async function gmailSend({ draftId, replyToThreadId, from, to, cc, bcc, subject, body }) {
  if (!String(to || '').trim()) throw new Error('The mail has no recipient.');
  const saved = await gmailSaveDraft({ draftId, replyToThreadId, from, to, cc, bcc, subject, body });
  const sent = await api(`${GMAIL}/drafts/send`, { method: 'POST', body: { id: saved.draftId } });
  return { messageId: sent.id, threadId: sent.threadId };
}

// Archives a conversation: it leaves the Gmail inbox and stays in All Mail. A later
// answer brings it back to the inbox, as in Gmail itself. Only ever called after the
// Send button sent a reply in it; no tool Claude has leads here.
export async function gmailArchiveThread({ threadId }) {
  if (!googleStatus().canArchive) throw new Error('Gmail has not allowed archiving yet. Connect Google again under Connections.');
  await api(`${GMAIL}/threads/${encodeURIComponent(threadId)}/modify`, { method: 'POST', body: { removeLabelIds: ['INBOX'] } });
}

// Automated mail: no person wrote it and nobody answers it. Mail Florian sent is never
// automated. Judged from the headers alone, so its text is never fetched.
const AUTOMATED_FROM = /(^|[<\s"])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?)[^@\s]*@/i;
export function isAutomated(headers, labels = []) {
  if (labels.includes('SENT')) return false;
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  if (AUTOMATED_FROM.test(get('From'))) return true;
  const auto = get('Auto-Submitted');
  if (auto && !/^no$/i.test(auto.trim())) return true;
  // Newsletters and mailing lists: sent in bulk, with a way to unsubscribe.
  if (/^(bulk|list|junk)$/i.test(get('Precedence').trim())) return true;
  if (get('List-Unsubscribe') && (get('List-Id') || /^(bulk|list)$/i.test(get('Precedence').trim()) || get('Feedback-ID'))) return true;
  return false;
}

// Mail that arrived or went out after a moment, newest last, grouped by conversation.
// This is what the brain update reads. All of it, however much there is: the list is
// read page by page, because whatever is left out here is never read later (the update
// counts everything up to its start as read). Left out on purpose: drafts, spam, trash,
// Gmail's Promotions and Social tabs, and automated mail (judged from the headers, so
// skipping it costs one small request each). Returns the threads and what was skipped.
export async function gmailSince(sinceMs) {
  const q = `after:${Math.floor(sinceMs / 1000)} -in:drafts -in:spam -in:trash -category:promotions -category:social`;
  const ids = [];
  let pageToken = '';
  do {
    const list = await api(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: '500', ...(pageToken ? { pageToken } : {}) })}`);
    for (const m of list.messages || []) ids.push(m.id);
    pageToken = list.nextPageToken || '';
  } while (pageToken && ids.length < 5000);
  const threads = new Map();
  let skipped = 0;
  const kept = [];
  for (const id of ids.reverse()) {
    const meta = await api(`${GMAIL}/messages/${id}?${new URLSearchParams([['format', 'metadata'], ...['From', 'Auto-Submitted', 'Precedence', 'List-Unsubscribe', 'List-Id', 'Feedback-ID'].map((h) => ['metadataHeaders', h])])}`);
    if (Number(meta.internalDate) <= sinceMs) continue;
    if (isAutomated(meta.payload?.headers || [], meta.labelIds || [])) { skipped += 1; continue; }
    kept.push(id);
  }
  // Long texts are cut; shorter still when there is a lot, so a long absence stays readable.
  const limit = kept.length > 150 ? 2500 : 8000;
  for (const id of kept) {
    const m = await api(`${GMAIL}/messages/${id}?format=full`);
    let text = bodyText(m.payload);
    if (text.length > limit) text = `${text.slice(0, limit)}\n[cut: the message is longer]`;
    const entry = threads.get(m.threadId) || { threadId: m.threadId, subject: header(m, 'Subject'), messages: [] };
    entry.messages.push({
      sent: (m.labelIds || []).includes('SENT'),
      date: header(m, 'Date'),
      from: header(m, 'From'),
      to: header(m, 'To'),
      cc: header(m, 'Cc') || '',
      text,
    });
    threads.set(m.threadId, entry);
  }
  return Object.assign([...threads.values()], { read: kept.length, skipped });
}

// ---------- calendar ----------

const meetLink = (e) => e.hangoutLink || (e.conferenceData?.entryPoints || []).find((p) => p.entryPointType === 'video')?.uri || '';

const eventLine = (e) => ({
  id: e.id,
  title: e.summary || '(no title)',
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  location: e.location || undefined,
  description: e.description ? e.description.slice(0, 500) : undefined,
  with: (e.attendees || []).map((a) => a.email).slice(0, 12),
  meet: meetLink(e) || undefined,
});

export async function calendarList({ from, to, query, max = 50 }) {
  const params = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.min(Math.max(Number(max) || 50, 1), 100)),
  });
  if (query) params.set('q', query);
  const data = await api(`${CALENDAR}/calendars/primary/events?${params}`);
  return (data.items || []).map(eventLine);
}

// Entries Claude makes are Pumpkin (orange) in Google Calendar, so Florian can tell them
// from his own.
const CLAUDE_COLOR = '6';

// Adds an entry to your own calendar. With meet, Google makes a Meet link for it. With
// guests (plain mail addresses), Google sends each of them an invitation at once; without,
// nobody hears of the entry and Florian passes the link on himself.
const ADDRESS = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
export async function calendarCreate({ title, start, end, allDay, location, description, meet, guests }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (v) => (allDay ? { date: String(v).slice(0, 10) } : { dateTime: new Date(v).toISOString(), timeZone: zone });
  const invited = [...new Set((Array.isArray(guests) ? guests : []).map((g) => String(g).trim().toLowerCase()).filter(Boolean))];
  const wrong = invited.filter((g) => !ADDRESS.test(g));
  if (wrong.length) throw new Error(`Not a mail address: ${wrong.join(', ')}. Give each guest as a plain address (name@example.org). Nothing was added to the calendar.`);
  if (invited.length > 20) throw new Error('At most 20 guests. Nothing was added to the calendar.');
  const body = { summary: title, start: when(start), end: when(end), location, description, colorId: CLAUDE_COLOR };
  if (meet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  if (invited.length) body.attendees = invited.map((email) => ({ email }));
  const query = new URLSearchParams({ ...(meet ? { conferenceDataVersion: '1' } : {}), ...(invited.length ? { sendUpdates: 'all' } : {}) }).toString();
  const event = await api(`${CALENDAR}/calendars/primary/events${query ? `?${query}` : ''}`, { method: 'POST', body });
  const out = { id: event.id, link: event.htmlLink };
  if (invited.length) out.invited = invited;
  if (meet) {
    const url = meetLink(event);
    if (url) out.meet = url;
    else out.note = 'The entry was made, but Google gave no Meet link for it. Florian can add one in the entry himself.';
  }
  return out;
}

// ---------- the tools a thread gets ----------

// `onInvite({ title, start, invited })` is told when an entry went out with guests.
export async function buildGoogleServer({ onInvite } = {}) {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  const reply = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
  const guarded = (fn) => async (args) => {
    try {
      return reply(await fn(args));
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
  };
  return createSdkMcpServer({
    name: 'google',
    version: '1.0.0',
    instructions: 'Florian\'s Gmail and Google Calendar. Mail can be searched and read here. A mail to send is written as a file; Florian puts it into Gmail or sends it himself with the buttons on that file.',
    tools: [
      tool('gmail_search', 'Search Florian\'s mail with Gmail search syntax (from:, to:, subject:, newer_than:7d, in:sent, is:unread …). Returns the newest matching messages with their thread ids.',
        { query: z.string(), max: z.number().int().min(1).max(25).optional() }, guarded(gmailSearch)),
      tool('gmail_read_thread', 'Read every message of one mail thread, oldest first.',
        { threadId: z.string() }, guarded(gmailReadThread)),
      tool('calendar_list', 'List the entries in Florian\'s calendar between two moments (ISO 8601).',
        { from: z.string(), to: z.string(), query: z.string().optional(), max: z.number().int().min(1).max(100).optional() }, guarded(calendarList)),
      tool('calendar_create', 'Add an entry to Florian\'s own calendar. For allDay give dates (YYYY-MM-DD) with the end date being the day after the last day. With `guests`, Google sends each of them an invitation by mail at once.',
        {
          title: z.string(),
          start: z.string().describe('ISO 8601 with offset, or YYYY-MM-DD for all-day'),
          end: z.string(),
          allDay: z.boolean().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          meet: z.boolean().optional().describe('true to attach a Google Meet link'),
          guests: z.array(z.string()).max(20).optional().describe('Mail addresses to invite. Google mails each an invitation at once and it cannot be taken back: only people Florian named, or agreed to, as guests of this entry in this thread. Leave out otherwise.'),
        }, guarded(async (args) => {
          const out = await calendarCreate(args);
          if (out.invited?.length) { try { onInvite?.({ title: args.title, start: args.start, invited: out.invited }); } catch { /* the entry is made either way */ } }
          return out;
        })),
    ],
  });
}
