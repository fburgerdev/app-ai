// The threads as files in the vault (Threads/), and the vault's Core folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup } from './helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-threads-'));
process.env.APP_AI_DATA = path.join(root, 'data');
const vault = path.join(root, 'vault');
fs.mkdirSync(vault, { recursive: true });

const { loadConfig } = await import('../server/config.js');
loadConfig();
const store = await import('../server/store.js');
const brain = await import('../server/brain.js');
const { exportThreads, lastThreadOn, renderThread } = await import('../server/threadexport.js');

test.after(() => cleanup(root));

const files = () => fs.readdirSync(path.join(vault, 'Threads')).sort();
const read = (name) => fs.readFileSync(path.join(vault, 'Threads', name), 'utf8');

test('threads are written into the vault as labelled conversations, without tool output', () => {
  const t = store.createThread({ title: 'Timeline for the motion', project: 'Motion' });
  store.appendMessage(t.id, { role: 'user', text: 'The session is on 03-12-2026.' });
  store.appendMessage(t.id, { role: 'assistant', parts: [
    { type: 'tool', name: 'Read', summary: 'Read Core/Projects/Motion.md', output: 'SECRET-TOOL-OUTPUT' },
    { type: 'text', text: 'Then the motion has to be in by 19-11-2026.' },
    { type: 'artifact', name: 'Plan.md', v: 1 },
  ] });
  fs.writeFileSync(path.join(store.artifactsDir(t.id), 'Plan.md'), '# Plan\n\nHand in the motion.\n');
  store.scanArtifacts(t.id, 'claude', { serve: ['Plan.md'] });

  // Not conversations of his: a card, and a thread the app started that he never touched.
  const card = store.createThread({ title: 'A card', kind: 'card' });
  store.appendMessage(card.id, { role: 'user', text: 'x' });
  const app = store.createThread({ title: 'Check-in', kind: 'checkin-active' });
  store.appendMessage(app.id, { role: 'user', auto: true, text: 'The app asks Claude to look at the project.' });
  store.appendMessage(app.id, { role: 'assistant', parts: [{ type: 'text', text: 'Nothing is stuck.' }] });

  const done = exportThreads(vault);
  assert.deepEqual({ total: done.total, written: done.written }, { total: 1, written: 1 });
  assert.equal(files().length, 1);
  const name = files()[0];
  assert.match(name, /^\d{4}-\d{2}-\d{2} Timeline for the motion\.md$/);
  const text = read(name);
  assert.match(text, new RegExp(`^Thread: ${t.id}$`, 'm'));
  assert.match(text, /^Project: \[\[Motion\]\]$/m);
  assert.match(text, /^State: open$/m);
  assert.match(text, /^### Florian, \d{2}-\d{2}-\d{4} \d{2}:\d{2}\n\nThe session is on 03-12-2026\.$/m);
  assert.match(text, /^### Claude, .*\n\nThen the motion has to be in by 19-11-2026\./m);
  assert.ok(!text.includes('SECRET-TOOL-OUTPUT'), 'tool output stays out');
  assert.match(text, /### File "Plan\.md" \(1 version; the last written by Claude/);
  assert.ok(text.includes('Hand in the motion.'), 'the final text of a file Claude made is kept');

  // Nothing changed: nothing is written again.
  assert.equal(exportThreads(vault).written, 0);
});

test('a thread keeps one file: a new name moves it, a deleted thread keeps it', () => {
  const t = store.listThreads().find((x) => x.title === 'Timeline for the motion');
  store.appendMessage(t.id, { role: 'user', text: 'Call it the Mensa motion.' });
  store.updateThread(t.id, { title: 'Mensa motion: timeline', state: 'done' });
  const done = exportThreads(vault);
  assert.equal(done.renamed, 1);
  assert.equal(files().length, 1);
  assert.match(files()[0], / Mensa motion timeline\.md$/);
  assert.match(read(files()[0]), /^State: closed$/m);

  // A second thread of the same name on the same day gets a number, and keeps it.
  const twin = store.createThread({ title: 'Mensa motion: timeline', project: 'Motion' });
  store.appendMessage(twin.id, { role: 'user', text: 'Again.' });
  exportThreads(vault);
  assert.equal(files().length, 2);
  assert.ok(files().some((n) => / Mensa motion timeline 2\.md$/.test(n)));
  assert.equal(exportThreads(vault).written, 0, 'both files are stable');

  // The app deletes a deferred thread after the update: its file is the only copy then.
  store.deleteThread(twin.id);
  exportThreads(vault);
  assert.equal(files().length, 2);
});

test('a spin-off holds only what was said in it', () => {
  const source = store.listThreads().find((x) => x.title === 'Mensa motion: timeline');
  const spin = store.copyThread(source.id, { title: 'Only the mail' });
  store.appendMessage(spin.id, { role: 'user', text: 'Draft the mail to the office.' });
  const text = renderThread(store.getThread(spin.id), store.readMessages(spin.id));
  assert.match(text, /^Spun off from: "Mensa motion: timeline"/m);
  assert.ok(text.includes('Draft the mail to the office.'));
  assert.ok(!text.includes('The session is on 03-12-2026.'), 'the copied part is in the original\'s file');
});

test('a new thread on a project is pointed at the last thread on it', () => {
  const me = store.createThread({ title: 'Next step', project: 'Motion' });
  const last = lastThreadOn(vault, 'Motion', { exceptId: me.id });
  assert.ok(last);
  assert.match(last.path, /^Threads\/\d{4}-\d{2}-\d{2} Mensa motion timeline( 2)?\.md$/);
  assert.equal(last.project, 'Motion');
  assert.equal(lastThreadOn(vault, 'Another Project'), null);
  assert.equal(lastThreadOn(vault, ''), null);
  // Never itself.
  const only = store.listThreads().find((x) => x.title === 'Mensa motion: timeline');
  const others = lastThreadOn(vault, 'Motion', { exceptId: only.id });
  assert.notEqual(others?.id, only.id);
});

test('the notes folder is Core, and a vault that still has Brain keeps working', () => {
  const old = path.join(root, 'old-vault');
  fs.mkdirSync(path.join(old, 'Brain', 'Projects'), { recursive: true });
  brain.initBrain({ brainDir: old, hiddenPaths: [] });
  assert.equal(brain.coreName(), 'Brain');
  assert.equal(brain.corePath('Next Actions.md'), 'Brain/Next Actions.md');
  fs.renameSync(path.join(old, 'Brain'), path.join(old, 'Core'));
  assert.equal(brain.coreName(), 'Core');
  assert.equal(brain.corePath('Next Actions.md'), 'Core/Next Actions.md');
  const empty = path.join(root, 'empty-vault');
  fs.mkdirSync(empty, { recursive: true });
  brain.initBrain({ brainDir: empty, hiddenPaths: [] });
  assert.equal(brain.coreName(), 'Core');
});
