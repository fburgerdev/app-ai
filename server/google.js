// Gmail and Google Calendar for threads.
//
// The app talks to Google directly, signed in as you through your own Google Cloud
// project (docs/google.md). Claude gets a small set of tools: search and read mail, save
// a draft, read the calendar, add a calendar entry. There is no tool that sends mail,
// deletes anything or invites people, so a thread cannot do those whatever it is told.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { GOOGLE_TOKEN_FILE, log } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose', // needed for drafts
  'https://www.googleapis.com/auth/calendar.events',
];
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
  return { configured, connected: Boolean(configured && token?.refresh_token), email: token?.email || '' };
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
    const thread = await api(`${GMAIL}/threads/${encodeURIComponent(replyToThreadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
    const last = (thread.messages || []).filter((m) => !(m.labelIds || []).includes('DRAFT')).at(-1);
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

// Mail that arrived or went out after a moment, newest last, grouped by conversation.
// This is what the brain update reads; drafts, spam and promotions are left out.
export async function gmailSince(sinceMs, { max = 60 } = {}) {
  const q = `after:${Math.floor(sinceMs / 1000)} -in:drafts -in:spam -in:trash -category:promotions -category:social`;
  const list = await api(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
  const threads = new Map();
  for (const { id } of (list.messages || []).reverse()) {
    const m = await api(`${GMAIL}/messages/${id}?format=full`);
    if (Number(m.internalDate) <= sinceMs) continue;
    let text = bodyText(m.payload);
    if (text.length > 8000) text = `${text.slice(0, 8000)}\n[cut: the message is longer]`;
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
  return [...threads.values()];
}

// ---------- calendar ----------

const eventLine = (e) => ({
  id: e.id,
  title: e.summary || '(no title)',
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  location: e.location || undefined,
  description: e.description ? e.description.slice(0, 500) : undefined,
  with: (e.attendees || []).map((a) => a.email).slice(0, 12),
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

// Adds an entry to your own calendar. It takes no guests, so nobody gets an invitation.
export async function calendarCreate({ title, start, end, allDay, location, description }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (v) => (allDay ? { date: String(v).slice(0, 10) } : { dateTime: new Date(v).toISOString(), timeZone: zone });
  const event = await api(`${CALENDAR}/calendars/primary/events`, {
    method: 'POST',
    body: { summary: title, start: when(start), end: when(end), location, description },
  });
  return { id: event.id, link: event.htmlLink };
}

// ---------- the tools a thread gets ----------

export async function buildGoogleServer() {
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
      tool('calendar_create', 'Add an entry to Florian\'s own calendar. It cannot invite anyone. For allDay give dates (YYYY-MM-DD) with the end date being the day after the last day.',
        {
          title: z.string(),
          start: z.string().describe('ISO 8601 with offset, or YYYY-MM-DD for all-day'),
          end: z.string(),
          allDay: z.boolean().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
        }, guarded(calendarCreate)),
    ],
  });
}
