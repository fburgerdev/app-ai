// The phone call, end to end against the stand-in Claude: Twilio's request, the audio
// connection, dictation, commands, and what must be refused.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HostSession, interpret, twilioSignature } from '../server/voice.js';
import { parseDecision } from '../server/host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('speech is told apart from commands', () => {
  assert.deepEqual(interpret('Send it.'), { command: 'send', text: '' });
  assert.deepEqual(interpret('okay send'), { command: 'send', text: '' });
  assert.deepEqual(interpret('Later'), { command: 'later', text: '' });
  assert.deepEqual(interpret('Go with the second option and send it'), { command: 'send', text: 'Go with the second option' });
  assert.deepEqual(interpret('Please send the mail to the office tomorrow'), { command: null, text: 'Please send the mail to the office tomorrow' });
  assert.deepEqual(interpret('We are done with the first part'), { command: null, text: 'We are done with the first part' });
  // Near misses and filler words still count as commands.
  for (const [said, command] of [['New threat.', 'new'], ['nu thread', 'new'], ['okay new thread please', 'new'], ['Neuer Thread', 'new'], ['start new thread', 'new'], ['sent it', 'send'], ['Repeat that please', 'repeat'], ['Tschüss', 'bye'], ['mark it done', 'done'], ['Erledigt.', 'done']]) {
    assert.equal(interpret(said).command, command, said);
  }
  // A command found only among the phone's other guesses.
  assert.equal(interpret('New Fred', ['new thread', 'new friend']).command, 'new');
  // Dictation is left alone.
  for (const said of ['I think we should wait until Friday', 'Dan', 'next week', 'send the mail to Lisa tomorrow morning', 'that sounds good to me']) {
    assert.equal(interpret(said).command, null, said);
  }
});

// The app as the host sees it, with a scripted model: `decide` maps what was said to the
// decision the small model would return.
function fakeApp(decide = () => ({ do: 'reply' })) {
  const threads = [
    { id: 'a', title: 'Mail to the office', state: 'ready', queuedAt: 1 },
    { id: 'b', title: 'Grant deadline', state: 'ready', queuedAt: 2 },
  ];
  const log = [];
  const asked = [];
  return {
    log,
    asked,
    threads,
    inbox: () => threads.filter((t) => t.state === 'ready').sort((x, y) => x.queuedAt - y.queuedAt),
    workingCount: () => threads.filter((t) => t.state === 'working').length,
    workingTitles: () => threads.filter((t) => t.state === 'working').map((t) => t.title),
    thread: (id) => threads.find((t) => t.id === id),
    digest: async (id) => `Digest of ${id}.`,
    cachedDigest: (id) => `Digest of ${id}.`,
    full: (id) => `The whole reply of ${id}.`,
    lastUser: () => '',
    reply: (id, text) => { log.push(['reply', id, text]); threads.find((t) => t.id === id).state = 'working'; },
    create: (text) => { log.push(['create', text]); return 'A new one'; },
    later: (id) => { log.push(['later', id]); threads.find((t) => t.id === id).queuedAt = Date.now(); },
    done: (id) => { log.push(['done', id]); threads.find((t) => t.id === id).state = 'done'; },
    mood: () => '',
    setMood: (text) => log.push(['mood', text]),
    addNote: (text) => log.push(['note', text]),
    words: () => 'KStW, Plant-based Universities',
    ask: async ({ prompt }) => {
      asked.push(prompt);
      const said = /^Florian said: (.*)$/m.exec(prompt)[1];
      const decision = decide(said);
      return typeof decision === 'string' ? decision : JSON.stringify(decision);
    },
    think: async (prompt) => { log.push(['think', prompt]); return 'A careful answer.'; },
  };
}

function hostWith(decide) {
  const app = fakeApp(decide);
  const said = [];
  const seen = [];
  let hungUp = false;
  const host = new HostSession({ say: (t) => said.push(t), hangUp: () => { hungUp = true; }, notify: (m) => seen.push(m), app, lang: 'en-US' });
  return { app, said, seen, host, hungUp: () => hungUp };
}

test('the model\'s answer is read as a decision, or not at all', () => {
  assert.deepEqual(parseDecision('{"do":"reply"}'), { do: 'reply' });
  assert.deepEqual(parseDecision('Sure:\n```json\n{"do":"answer","say":"Two."}\n```'), { do: 'answer', say: 'Two.' });
  assert.equal(parseDecision('I think he wants the thread'), null);
  assert.equal(parseDecision('{"say":"no action"}'), null);
});

test('what he says after a thread goes to that thread, without a keyword', async () => {
  const { app, said, seen, host } = hostWith(() => ({ do: 'reply', fix: { 'case TW': 'KStW' } }));
  await host.start();
  assert.match(said.at(-1), /^2 threads are waiting\. Mail to the office\. Digest of a\.$/);

  await host.heard('Make it shorter and mention the case TW meeting.');
  assert.deepEqual(app.log[0].slice(0, 2), ['reply', 'a']);
  assert.match(app.log[0][2], /^\[Dictated by voice.*\n\nMake it shorter and mention the KStW meeting\.$/s, 'misheard words are repaired, the rest is his');
  assert.match(said.at(-1), /^Sent\. Grant deadline\. Digest of b\.$/, 'and the next thread is read out');
  assert.ok(seen.some((m) => m.type === 'heard' && m.kind === 'reply' && m.note === 'Mail to the office'), 'the screen is told where it went');
  assert.match(app.asked[0], /Open thread: "Mail to the office"/);
  assert.match(app.asked[0], /What he heard from it: Digest of a\./);
  assert.match(app.asked[0], /1\. Mail to the office/);
  assert.match(app.asked[0], /Names and words he uses: KStW/);

  await host.heard('Go with the second option and send it');
  assert.equal(app.asked.length, 1, '"…and send it" needs no model');
  assert.match(app.log.at(-1)[2], /\n\nGo with the second option$/);
  assert.match(said.at(-1), /^Sent\. That is everything for now/);
});

test('the host answers its own questions and hands on the hard ones', async () => {
  const decide = (said) => {
    if (/how many/.test(said)) return { do: 'answer', say: 'Two are waiting.' };
    if (/protein/.test(said)) return { do: 'think', question: 'How much protein is in tofu?' };
    if (/mood/.test(said)) return { do: 'mood', text: 'short things only' };
    if (/note/.test(said)) return { do: 'note', text: 'ask Lutz about Friday' };
    return { do: 'reply' };
  };
  const { app, said, host } = hostWith(decide);
  await host.start();
  await host.heard('how many are waiting?');
  assert.equal(said.at(-1), 'Two are waiting.');
  assert.equal(app.log.length, 0, 'nothing went to a thread');
  await host.heard('how much protein is in tofu');
  assert.deepEqual(said.slice(-2), ['One moment.', 'A careful answer.']);
  assert.match(app.log.at(-1)[1], /Florian: how many are waiting\?\nHost: Two are waiting\./, 'the stronger model gets the conversation');
  assert.match(app.log.at(-1)[1], /The question to answer: How much protein is in tofu\?/);
  await host.heard('my mood is short things only');
  assert.deepEqual(app.log.at(-1), ['mood', 'short things only']);
  await host.heard('note for Claude ask Lutz about Friday');
  assert.deepEqual(app.log.at(-1), ['note', 'ask Lutz about Friday']);
  assert.match(app.asked.at(-1), /Host: Mood line set\./, 'the host remembers the conversation');
  assert.equal(host.current, 'a', 'and the thread stays open through all of it');
});

test('commands, a held thought, a new thread and a thread by name', async () => {
  const decide = (said) => {
    if (/um$/.test(said)) return { do: 'wait' };
    if (/^open the grant/.test(said)) return { do: 'open', thread: 1 };
    if (/^ask Claude/.test(said)) return { do: 'new', text: 'Find out when the board meets' };
    if (/close this/.test(said)) return { do: 'command', name: 'done' };
    return { do: 'reply' };
  };
  const { app, said, seen, host, hungUp } = hostWith(decide);
  await host.start();

  await host.heard('I think we should um');
  assert.equal(said.length, 1, 'a broken-off thought is held, silently');
  assert.ok(seen.some((m) => m.type === 'heard' && m.kind === 'wait'));
  await host.heard('wait until Friday');
  assert.match(app.log.at(-1)[2], /\n\nI think we should um wait until Friday$/, 'and sent whole with what follows');

  await host.heard('repeat');
  assert.match(said.at(-1), /^Grant deadline\. Digest of b\.$/);
  await host.heard('ask Claude to find out when the board meets');
  assert.match(app.log.at(-1)[1], /^Find out when the board meets\n\n\[Dictated/);
  assert.equal(said.at(-1), 'Started a thread: A new one.');
  assert.equal(host.current, 'b', 'starting a thread does not leave the open one');
  await host.heard('skip');
  assert.deepEqual(app.log.at(-1), ['later', 'b']);
  assert.match(said.at(-1), /That is everything for now/, 'a thread set aside does not come round again');
  await host.heard('open the grant one');
  assert.match(said.at(-1), /^Grant deadline\. Digest of b\.$/);
  await host.heard('close this one');
  assert.deepEqual(app.log.at(-1), ['done', 'b']);

  // Nothing open: a finished thread is announced while he is talking, read out when he is not.
  app.threads.find((t) => t.id === 'a').state = 'ready';
  host.threadReady(app.threads[0]);
  await host.queue;
  assert.equal(said.at(-1), 'Claude has finished "Mail to the office". Say next to hear it.');
  await host.heard('next');
  assert.match(said.at(-1), /^Mail to the office\. Digest of a\.$/);
  await host.key('4');
  host.lastHeardAt = 0;
  app.threads.find((t) => t.id === 'b').state = 'ready';
  host.threadReady(app.threads[1]);
  await host.queue;
  assert.match(said.at(-1), /^Claude has finished one\. Grant deadline\./);

  await host.heard('new thread');
  await host.heard('Draft the agenda for Monday');
  assert.match(app.log.at(-1)[1], /^Draft the agenda for Monday\n\n\[Dictated/, 'after "new thread" the next thing said starts it, without a model');
  await host.heard('goodbye');
  assert.equal(hungUp(), true);
});

test('when the model fails nothing is lost, and German is spoken to in German', async () => {
  const { app, said, host } = hostWith(() => 'no json here');
  await host.start();
  await host.heard('Tell them Thursday works');
  assert.match(said.at(-1), /could not work out where that goes/);
  assert.equal(app.log.length, 0);
  await host.heard('send');
  assert.match(app.log.at(-1)[2], /\n\nTell them Thursday works$/, '"send" gives it to the open thread as it is');

  const german = hostWith(() => ({ do: 'reply' }));
  german.host.setLanguage('de-DE');
  await german.host.start();
  assert.match(german.said.at(-1), /^2 Threads warten\. /);
  await german.host.heard('Mach es kürzer', [], { typed: true });
  assert.equal(german.app.log.at(-1)[2], 'Mach es kürzer', 'typed text carries no dictation note');
  assert.match(german.said.at(-1), /^Gesendet\. /);
});

// ---------- against the running app ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-voice-'));
const remote = path.join(dir, 'vault.git');
const seed = path.join(dir, 'seed');
const data = path.join(dir, 'data');
const port = 4800 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'clone', remote, seed);
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'seed');
git(seed, 'push', 'origin', 'main');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  port,
  brainRepo: remote,
  allowedHosts: ['pi.example.ts.net'],
  readLog: true,
  cards: { auto: false },
  voice: { enabled: true, publicUrl: base, authToken: 'twilio-secret', allowedCallers: ['+49 170 1234567'] },
}));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data, APP_AI_DATA_REPO: '' },
  stdio: 'ignore',
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const until = async (fn, label) => {
  for (let i = 0; i < 200; i += 1) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
};
const twiml = (params, signature) => fetch(`${base}/voice/twiml`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
  body: new URLSearchParams(params),
});

test('only Twilio, and only your number, can start a call', async () => {
  await until(async () => (await fetch(`${base}/api/state`)).ok, 'server up');
  const mine = { CallSid: 'CA1', From: '+491701234567', To: '+4930000000' };
  const forged = await twiml(mine, 'bm90IGEgc2lnbmF0dXJl');
  assert.equal(forged.status, 403);
  const stranger = { ...mine, From: '+15550001111' };
  const turnedAway = await twiml(stranger, twilioSignature('twilio-secret', `${base}/voice/twiml`, stranger));
  assert.match(await turnedAway.text(), /<Reject\/>/);
  const ok = await twiml(mine, twilioSignature('twilio-secret', `${base}/voice/twiml`, mine));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<ConversationRelay url="ws:\/\/localhost:\d+\/voice\/ws"[^>]*dtmfDetection="true"[^>]*><Parameter name="token" value="[0-9a-f]{48}"\/>/);
});

test('the audio connection needs the one-time token', async () => {
  const ws = new WebSocket(`ws://localhost:${port}/voice/ws`);
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'setup', callSid: 'CA2', from: '+491701234567', customParameters: { token: 'made-up' } }));
  assert.equal(await closed, 1008);
});

test('a whole call against the app', async () => {
  const params = { CallSid: 'CA3', From: '+491701234567', To: '+4930000000' };
  const xml = await (await twiml(params, twilioSignature('twilio-secret', `${base}/voice/twiml`, params))).text();
  const token = /value="([0-9a-f]+)"/.exec(xml)[1];
  const ws = new WebSocket(`ws://localhost:${port}/voice/ws`);
  const heard = [];
  ws.on('message', (raw) => heard.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => ws.on('open', resolve));
  const say = (voicePrompt) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-US', last: true }));
  const spoken = (pattern, label) => until(async () => heard.find((m) => m.type === 'text' && pattern.test(m.token)), label);

  ws.send(JSON.stringify({ type: 'setup', callSid: 'CA3', from: '+491701234567', customParameters: { token } }));
  const hello = await spoken(/Nothing is waiting/, 'greeting');
  assert.equal(hello.last, true, 'every spoken message is closed, or Twilio swallows its end');

  say('Ask Claude to work out where the plan stands');
  await spoken(/^Started a thread: /, 'new thread started');
  const state = await until(async () => {
    const st = await (await fetch(`${base}/api/state`)).json();
    return st.threads.some((t) => t.state === 'ready' && /^Ask Claude to work out/.test(t.title)) ? st : null;
  }, 'the thread is ready');
  say('next');
  const read = await spoken(/^Ask Claude to work out where the plan stands\. /, 'the finished thread is read out');
  assert.ok(read.token.length > 60, 'with a digest of the reply');

  say('Work out the second option for the case TW meeting');
  await spoken(/^Sent\./, 'reply sent');
  const thread = state.threads.find((t) => /^Ask Claude to work out/.test(t.title));
  const messages = (await (await fetch(`${base}/api/threads/${thread.id}`)).json()).messages;
  assert.match(messages.filter((m) => m.role === 'user').at(-1).text, /^\[Dictated by voice.*\n\nWork out the second option for the KStW meeting$/s);

  say('what is waiting?');
  await spoken(/^Stand-in answer\./, 'the host answers itself');
  say('look up how tall the Cologne cathedral is');
  await spoken(/^One moment\.$/, 'the host says it is thinking');
  await spoken(/^Stand-in careful answer to: look up how tall/, 'the stronger model answers');

  ws.send(JSON.stringify({ type: 'dtmf', digit: '9' }));
  await spoken(/^Goodbye/, 'goodbye');
  await until(async () => heard.find((m) => m.type === 'end'), 'the app ends the call');
  ws.close();
});

test('the app answers under its allowed names and no others', async () => {
  const as = (host) => new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: '/api/state', headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal((await as('pi.example.ts.net')).status, 200);
  assert.equal((await as('evil.example')).status, 403);
  const remoteState = JSON.parse((await as('pi.example.ts.net')).body);
  assert.equal(remoteState.config.local, false);
  assert.equal(remoteState.connections.voice.ready, true);
});

test('what Claude reads from the vault is logged', async () => {
  const lines = fs.readFileSync(path.join(data, 'reads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const file = lines.find((l) => l.kind === 'file' && l.by === 'thread');
  assert.equal(file.path, 'Brain/Next Actions.md');
  assert.deepEqual(file.lines, [1, 40]);
  assert.ok(file.threadId);
  const search = lines.find((l) => l.kind === 'search');
  assert.equal(search.path, 'Brain');
  assert.equal(search.pattern, 'deadline');
});
