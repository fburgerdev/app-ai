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
import { CallSession, interpret, twilioSignature } from '../server/voice.js';

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

function fakeApp() {
  const threads = [
    { id: 'a', title: 'Mail to the office', state: 'ready', queuedAt: 1 },
    { id: 'b', title: 'Grant deadline', state: 'ready', queuedAt: 2 },
  ];
  const log = [];
  return {
    log,
    threads,
    inbox: () => threads.filter((t) => t.state === 'ready').sort((x, y) => x.queuedAt - y.queuedAt),
    workingCount: () => threads.filter((t) => t.state === 'working').length,
    thread: (id) => threads.find((t) => t.id === id),
    digest: async (id) => `Digest of ${id}.`,
    reply: (id, text) => { log.push(['reply', id, text]); threads.find((t) => t.id === id).state = 'working'; },
    create: (text) => { log.push(['create', text]); },
    later: (id) => { log.push(['later', id]); threads.find((t) => t.id === id).queuedAt = Date.now(); },
    done: (id) => { log.push(['done', id]); threads.find((t) => t.id === id).state = 'done'; },
  };
}

test('a call walks the inbox: hear, dictate, send, next', async () => {
  const app = fakeApp();
  const said = [];
  let hungUp = false;
  const call = new CallSession({ say: (t) => said.push(t), hangUp: () => { hungUp = true; }, app });
  await call.start();
  assert.match(said.at(-1), /^2 threads are waiting\. Mail to the office\. Digest of a\.$/);

  await call.heard('Make it shorter.');
  await call.heard('And propose Thursday.');
  assert.equal(said.length, 1, 'dictation is taken in silently');
  await call.heard('later');
  assert.match(said.at(-1), /unsent/, 'an unsent reply is never dropped by accident');
  await call.key('1');
  assert.equal(app.log[0][0], 'reply');
  assert.equal(app.log[0][1], 'a');
  assert.match(app.log[0][2], /^\[Dictated on a phone call.*\n\nMake it shorter\. And propose Thursday\.$/s);
  assert.match(said.at(-1), /^Sent\. Grant deadline\. Digest of b\.$/);

  await call.heard('repeat');
  assert.match(said.at(-1), /^Grant deadline\. Digest of b\.$/);
  await call.heard('skip');
  assert.deepEqual(app.log.at(-1), ['later', 'b']);
  assert.match(said.at(-1), /That is everything for now/, 'a thread set aside does not come round again in the same call');

  app.threads.find((t) => t.id === 'a').state = 'ready';
  call.threadReady(app.threads[0]);
  await call.queue;
  assert.match(said.at(-1), /^Claude has finished one\. Mail to the office\./);
  await call.heard('done');
  assert.deepEqual(app.log.at(-1), ['done', 'a']);

  await call.heard('new thread');
  await call.heard('Find out when the board meets and send it');
  assert.equal(app.log.at(-1)[0], 'create');
  assert.match(app.log.at(-1)[1], /^Find out when the board meets\n\n\[Dictated/);
  await call.heard('goodbye');
  assert.equal(hungUp, true);
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

  say('Where does the plan stand');
  say('send');
  await spoken(/^Started\./, 'new thread started');
  const finished = await spoken(/^Claude has finished one\. Where does the plan stand\./, 'the call announces the finished thread');
  assert.ok(finished.token.length > 60, 'with a digest of the reply');

  say('Work out the second option, and send it.');
  await spoken(/^Sent\./, 'reply sent');
  const state = await (await fetch(`${base}/api/state`)).json();
  const thread = state.threads.find((t) => t.title === 'Where does the plan stand');
  const messages = (await (await fetch(`${base}/api/threads/${thread.id}`)).json()).messages;
  assert.match(messages.filter((m) => m.role === 'user').at(-1).text, /^\[Dictated on a phone call.*\n\nWork out the second option$/s);

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
