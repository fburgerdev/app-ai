// Secrets from the brain, encrypted with age: placeholders filled in only at the last
// step, values kept out of Threads/, the data repo and the brain update's commit, and a
// key inside the data folder refused. Every value here is made up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { cleanup, freePort, until } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-secrets-'));
const data = path.join(dir, 'data');
process.env.APP_AI_DATA = data;
const vault = path.join(dir, 'vault');
const keyFile = path.join(dir, 'keys', 'test.agekey');

// Made-up values only.
const IBAN = 'DE00123456780000000000';
const IBAN_SPACED = 'DE00 1234 5678 0000 0000 00';
const KEY = 'test-key_Zq8w"x\\y';
const SECRETS = `# Secrets\n\n- iban: ${IBAN_SPACED}\n- \`pixabay_key\`: \`${KEY}\`\n- steuer_id: 99 999 999 999\n- pin: 12\n`;

const identity = await generateX25519Identity();
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
fs.writeFileSync(keyFile, `# created: made up for a test\n# public key: ${await identityToRecipient(identity)}\n${identity}\n`);
const encrypt = async (text) => {
  const e = new Encrypter();
  e.addRecipient(await identityToRecipient(identity));
  return Buffer.from(await e.encrypt(text));
};
fs.mkdirSync(path.join(vault, 'Core'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Files'), { recursive: true });
fs.writeFileSync(path.join(vault, 'Core', 'Secrets.md.age'), await encrypt(SECRETS));
fs.writeFileSync(path.join(vault, 'Files', '2026-01-01 Vertrag.pdf.age'), await encrypt('%PDF made up'));

const { loadConfig, DATA_DIR, THREADS_DIR } = await import('../server/config.js');
const config = loadConfig();
const secrets = await import('../server/secrets.js');
const store = await import('../server/store.js');
const { renderThread } = await import('../server/threadexport.js');
const { redactMessages } = await import('../server/datasync.js');
store.loadThreads();

const servers = [];
test.after(() => cleanup(dir, servers));

test('a key inside the data folder is refused', () => {
  const inside = path.join(DATA_DIR, 'secret.agekey');
  fs.copyFileSync(keyFile, inside);
  const out = secrets.initSecrets({ ...config, brainDir: vault, secretsKey: inside });
  assert.equal(out.enabled, false);
  assert.match(out.reason, /data folder/);
  assert.equal(secrets.secretsEnabled(), false);
  fs.rmSync(inside);
  // And the data repo never takes a key file, wherever it sits in there.
  assert.equal(secrets.initSecrets({ ...config, brainDir: vault, secretsKey: '' }).enabled, false, 'empty: off');
});

test('the secrets are decrypted from the brain and placeholders filled', async () => {
  assert.equal(secrets.initSecrets({ ...config, brainDir: vault, secretsKey: keyFile }).enabled, true);
  await secrets.refreshSecrets();
  assert.deepEqual(secrets.secretNames().sort(), ['iban', 'pin', 'pixabay_key', 'steuer_id']);
  assert.equal(secrets.fill('IBAN: {{secret:iban}}, key {{ secret:PIXABAY_KEY }}, {{secret:unknown}}'), `IBAN: ${IBAN_SPACED}, key ${KEY}, {{secret:unknown}}`);
  assert.equal(secrets.secretEnv().APP_SECRET_IBAN, IBAN_SPACED);
  const doc = await secrets.decryptDocument('Files/2026-01-01 Vertrag.pdf');
  assert.equal(doc.name, '2026-01-01 Vertrag.pdf');
  assert.equal(doc.data.toString(), '%PDF made up');
  assert.equal(await secrets.decryptDocument('Files/../Core/Secrets.md'), null, 'only inside Files/');
});

test('redact catches a value with or without spaces, and in JSON', () => {
  assert.equal(secrets.redact(`Meine IBAN ist ${IBAN} bzw. ${IBAN_SPACED}.`), 'Meine IBAN ist {{secret:iban}} bzw. {{secret:iban}}.');
  assert.equal(secrets.redact('Steuer-ID 99999999999'), 'Steuer-ID {{secret:steuer_id}}');
  assert.equal(secrets.redact(JSON.stringify({ text: `key ${KEY}` })), JSON.stringify({ text: 'key {{secret:pixabay_key}}' }));
  assert.equal(secrets.redact('Seite 12 von 30'), 'Seite 12 von 30', 'values that short are left alone');
  assert.equal(secrets.redact(`X${IBAN}`), `X${IBAN}`, 'only whole tokens');
});

test('a shell command gets the values through a file, not in its text', () => {
  const command = secrets.withEnv('cd "/w" && python fill.py', 'thread-1', 'Bash');
  assert.ok(!command.includes(IBAN_SPACED));
  const file = /^\. '([^']+)'; cd/.exec(command)[1];
  assert.match(fs.readFileSync(file, 'utf8'), /export APP_SECRET_IBAN='DE00 1234/);
  assert.match(secrets.withEnv('cd C:\\w; python x.py', 'thread-1', 'PowerShell'), /^\. '.+env\.ps1'; cd/);
  secrets.dropEnvFile('thread-1');
  assert.equal(fs.existsSync(file), false, 'gone when the turn ends');
});

test('only a workbench command of a thread gets the values', async () => {
  const { buildPolicy } = await import('../server/agent.js');
  const bench = path.join(dir, 'bench');
  const policy = (extra) => buildPolicy({ mode: 'thread', cwd: vault, artifactsDir: path.join(dir, 'art'), workDir: bench, artifactsShell: true, ...extra });
  const command = `cd "${bench}" && python fill.py`;
  const withKey = await policy({ secretsKey: 'thread-2' })('Bash', { command });
  assert.equal(withKey.behavior, 'allow');
  assert.match(withKey.updatedInput.command, /^\. '.+env\.sh'; cd "/);
  assert.ok(!withKey.updatedInput.command.includes(IBAN_SPACED));
  assert.equal((await policy({})('Bash', { command })).updatedInput.command, command, 'without the key: unchanged');
  secrets.dropEnvFile('thread-2');
});

test('the thread file in the vault holds the placeholder, not the value', () => {
  const t = store.createThread({ title: 'Antrag' });
  store.appendMessage(t.id, { role: 'user', text: `Meine IBAN ist ${IBAN_SPACED}` });
  store.appendMessage(t.id, { role: 'assistant', parts: [{ type: 'text', text: 'Eingetragen als {{secret:iban}}.' }] });
  const text = renderThread(store.getThread(t.id), store.readMessages(t.id));
  assert.ok(!text.includes(IBAN_SPACED));
  assert.match(text, /Meine IBAN ist \{\{secret:iban\}\}/);
});

test('the data sync redacts the conversation files before it commits', async () => {
  const t = store.createThread({ title: 'Formular' });
  store.appendMessage(t.id, { role: 'user', text: `Key: ${KEY}, IBAN ${IBAN}` });
  assert.ok(await redactMessages() >= 1);
  const raw = fs.readFileSync(path.join(THREADS_DIR, t.id, 'messages.jsonl'), 'utf8');
  assert.ok(!raw.includes(IBAN) && !raw.includes('Zq8w'));
  assert.equal(store.readMessages(t.id)[0].text, 'Key: {{secret:pixabay_key}}, IBAN {{secret:iban}}', 'still valid JSON');
  store.appendMessage(t.id, { role: 'user', text: 'danach' });
  assert.equal(store.readMessages(t.id).length, 2, 'nothing lost');
});

test('the brain update commit redacts a staged value as a last check', async () => {
  const brain = await import('../server/brain.js');
  const repo = path.join(dir, 'staged');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet');
  fs.writeFileSync(path.join(repo, 'Note.md'), `IBAN ${IBAN_SPACED}\n`);
  fs.writeFileSync(path.join(repo, 'Clean.md'), 'nothing\n');
  git('add', '-A');
  assert.deepEqual(await brain.redactStaged(repo), ['Note.md']);
  assert.equal(fs.readFileSync(path.join(repo, 'Note.md'), 'utf8'), 'IBAN {{secret:iban}}\n');
});

// ---------- against the running app ----------

test('placeholders are filled on copy and download, only for the app\'s own page', async () => {
  const sdir = path.join(dir, 'server');
  const remote = path.join(sdir, 'vault.git');
  const seed = path.join(sdir, 'seed');
  const sdata = path.join(sdir, 'data');
  fs.mkdirSync(sdir, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(sdir, 'init', '--bare', '-b', 'main', remote);
  git(sdir, 'clone', remote, seed);
  fs.cpSync(vault, seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
  git(seed, 'checkout', '-B', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'main');
  const port = await freePort();
  const base = `http://localhost:${port}`;
  fs.mkdirSync(sdata, { recursive: true });
  fs.writeFileSync(path.join(sdata, 'config.json'), JSON.stringify({ port, brainRepo: remote, dataRepo: '', cards: { auto: false }, secretsKey: keyFile }));
  const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: sdata }, stdio: 'ignore' });
  servers.push(server);
  const page = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  const post = (url, body, headers = page) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  await until(async () => (await (await fetch(`${base}/api/state`)).json())?.brain.brain.ready, 'brain ready');

  // Copy: the page asks the app to fill the text in; a script on this computer cannot.
  const filled = await until(async () => { const d = await (await post('/api/fill', { text: 'IBAN {{secret:iban}}' })).json(); return d.text !== 'IBAN {{secret:iban}}' ? d : null; }, 'secrets read');
  assert.equal(filled.text, `IBAN ${IBAN_SPACED}`);
  assert.equal((await post('/api/fill', { text: '{{secret:iban}}' }, { 'Content-Type': 'application/json' })).status, 403);

  // A mail card with a placeholder: the download is filled, the file and the view are not.
  const id = (await (await post('/api/threads', { text: 'Please draft a mail to the office' })).json()).thread.id;
  const t = await until(async () => { const x = await (await fetch(`${base}/api/threads/${id}`)).json(); return x.thread.state === 'ready' && x.artifacts.length ? x : null; }, 'mail drafted');
  const name = t.artifacts[0].name;
  assert.equal((await post(`/api/threads/${id}/artifact/save`, { name, content: '---\ntype: mail\nto: office@example.org\nsubject: Erstattung\n---\nBitte auf {{secret:iban}} überweisen.\n' })).status, 200);
  const url = `${base}/api/threads/${id}/artifact?name=${encodeURIComponent(name)}`;
  assert.match(await (await fetch(url)).text(), /\{\{secret:iban\}\}/, 'the view keeps the placeholder');
  assert.match(await (await fetch(`${url}&download=1`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).text(), new RegExp(`auf ${IBAN_SPACED} überweisen`));
  assert.match(await (await fetch(`${url}&download=1`)).text(), /\{\{secret:iban\}\}/, 'not for a script');

  // Sent: the note in the thread says what went out, without the value.
  assert.equal((await post(`/api/threads/${id}/mail/send`, { name })).status, 200);
  const after = await (await fetch(`${base}/api/threads/${id}`)).json();
  assert.ok(!JSON.stringify(after).includes(IBAN_SPACED));
});
