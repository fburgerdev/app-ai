// The second iteration, end to end against the stand-in Claude: the water level, notes
// for Claude, mail buttons, cards, the queue with mood line and requeue, pads, projects,
// walk mode, and the app's state saved to its own repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { parseMail, serializeMail } from '../server/mail.js';
import { parseIndex } from '../server/projects.js';
import { parseReport } from '../server/extract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a mail file round-trips through its header', () => {
  const mail = parseMail('---\ntype: mail\nto: Jörg <j@example.org>\nsubject: Nächste Schritte\nreply-to-thread: T1\n---\n\nHallo,\n\nviele Grüße\n');
  assert.deepEqual(mail, { to: 'Jörg <j@example.org>', cc: '', bcc: '', subject: 'Nächste Schritte', from: '', replyToThreadId: 'T1', body: 'Hallo,\n\nviele Grüße' });
  assert.deepEqual(parseMail(serializeMail(mail)), mail);
  assert.equal(parseMail('# Just a note\n'), null);
  assert.equal(parseMail('---\ntitle: something else\n---\nbody'), null);
});

test('the project index is read the way the vault writes it', () => {
  const groups = parseIndex('# Projects Index\n\nIntro with [[Next Actions]].\n\n## [[Big Area]]\n\n- [[Motion One]] — motions in three parliaments\n- [[Owned Elsewhere]] **[delegated]** — someone else runs it\n\n## [[Empty Area]]\n\n—\n\n## No area\n\n- [[Loose Project]] — on its own\n');
  assert.deepEqual(groups.map((g) => [g.name, g.isArea, g.projects.map((p) => p.name)]), [
    ['Big Area', true, ['Motion One', 'Owned Elsewhere']],
    ['Empty Area', true, []],
    ['No area', false, ['Loose Project']],
  ]);
  assert.equal(groups[0].projects[0].about, 'motions in three parliaments');
  assert.equal(groups[0].projects[1].delegated, true);
});

test('the brain update report yields questions and mail to answer', () => {
  const r = parseReport('STATUS: questions\nCOMMIT: thinking: board date, room\n\n## Written\n- Brain/Projects/X.md — the date\n\n## Questions\n**X**\n1. Add the call?\n\n## Mail to answer\n- 18c2f | Terminvorschlag | wants a date\n- 99aa | Re: Angebot\n');
  assert.equal(r.subject, 'thinking: board date, room');
  assert.match(r.questions, /Add the call/);
  assert.deepEqual(r.mail, [{ threadId: '18c2f', subject: 'Terminvorschlag', why: 'wants a date' }, { threadId: '99aa', subject: 'Re: Angebot', why: '' }]);
});

// ---------- against the running app ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-two-'));
const remote = path.join(dir, 'vault.git');
const dataRemote = path.join(dir, 'app-data.git');
const seed = path.join(dir, 'seed');
const data = path.join(dir, 'data');
const port = 5300 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
git(dir, 'init', '--bare', '-b', 'main', remote);
git(dir, 'init', '--bare', '-b', 'main', dataRemote);
git(dir, 'clone', remote, seed);
for (const d of ['Brain/Projects', 'Brain/Areas', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Scratchpad.md'), 'the old scratchpad\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Areas', 'Campaign.md'), '# Campaign\n\nThe area note.\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Motion.md'), '# Motion\n\nThe project note.\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## [[Campaign]]\n\n- [[Motion]] — a motion\n\n## No area\n\n- [[Grant]] — a grant\n');
git(seed, 'checkout', '-B', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-m', 'seed');
git(seed, 'push', 'origin', 'main');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: remote, dataRepo: dataRemote, cards: { auto: false }, queue: { learnEvery: 4 }, google: { clientSecret: 'never-commit-me' } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data },
  stdio: 'ignore',
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const until = async (fn, label) => {
  for (let i = 0; i < 240; i += 1) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
};
const state = async () => (await call('GET', '/api/state')).data;
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' ? t : null; }, `thread ${id} ready`);
const lastRun = (n) => until(async () => { const r = (await call('GET', '/api/brain/runs')).data.runs; return r.length === n && r[0].finishedAt ? r[0] : null; }, `brain update ${n}`);
const artifactText = async (id, name, v) => (await fetch(`${base}/api/threads/${id}/artifact?name=${encodeURIComponent(name)}${v ? `&v=${v}` : ''}`)).text();

let mailThread;
let planThread;

test('the app starts with Opus on high effort', async () => {
  const s = await until(async () => { const x = await state(); return x?.brain.brain.ready ? x : null; }, 'brain ready');
  assert.equal(s.settings.model, 'opus');
  assert.equal(s.settings.effort, 'high');
  assert.deepEqual(s.settings.models, ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepEqual(s.settings.efforts, ['medium', 'high']);
  const changed = (await call('PUT', '/api/settings', { model: 'fable', effort: 'medium' })).data;
  assert.equal(changed.model, 'fable');
  assert.equal((await call('PUT', '/api/settings', { model: 'gpt', effort: 'low' })).data.model, 'fable', 'unknown values are ignored');
  await call('PUT', '/api/settings', { model: 'opus', effort: 'high' });
});

test('a thread started from a project carries it; the tree shows it', async () => {
  planThread = (await call('POST', '/api/threads', { text: 'Where does the motion stand?', project: 'Motion' })).data.thread.id;
  mailThread = (await call('POST', '/api/threads', { text: 'Please draft a mail to the office' })).data.thread.id;
  assert.equal((await ready(planThread)).thread.project, 'Motion');
  await ready(mailThread);
  const tree = (await call('GET', '/api/projects')).data;
  const area = tree.groups.find((g) => g.name === 'Campaign');
  assert.equal(area.projects[0].name, 'Motion');
  assert.equal(area.projects[0].open, 1);
  assert.ok(area.projects[0].touched > 0);
  assert.equal(tree.groups.find((g) => g.name === 'No area').projects[0].open, 0);
  assert.equal((await call('POST', `/api/threads/${mailThread}/project`, { project: 'Not In The Vault' })).status, 400);
  assert.equal((await call('POST', `/api/threads/${mailThread}/project`, { project: 'Campaign' })).data.thread.project, 'Campaign');
});

test('the mood line reorders the queue; requeue puts a thread behind the others', async () => {
  const first = await until(async () => { const s = await state(); return s.queue.order.length === 2 && !s.queue.ranking ? s : null; }, 'queue ordered');
  const [top, second] = first.queue.order;
  const byWait = first.threads.filter((t) => t.state === 'ready').sort((a, b) => a.queuedAt - b.queuedAt).map((t) => t.id);
  assert.deepEqual(first.queue.order, byWait, 'without a mood line: longest waiting first');
  // A mood line that names the second one brings it to the front.
  const word = second === mailThread ? 'mail' : 'motion';
  await call('PUT', '/api/settings', { mood: `feeling like ${word} today` });
  const moody = await until(async () => { const s = await state(); return s.queue.order[0] === second && !s.queue.ranking ? s : null; }, 'mood applied');
  assert.match(moody.queue.why, /mood/);
  await call('POST', `/api/threads/${second}/skip`, {});
  assert.deepEqual((await state()).queue.order, [top, second], 'requeued: behind the other, whatever the mood says');

  // Dragged by hand: it stays where it was put, whatever the mood line or the model says.
  const moved = await call('POST', '/api/queue/move', { id: second, index: 0 });
  assert.deepEqual(moved.data.order, [second, top]);
  await call('PUT', '/api/settings', { mood: `feeling like ${word === 'mail' ? 'motion' : 'mail'} today` });
  await sleep(1800);
  const held = await until(async () => { const s = await state(); return !s.queue.ranking ? s : null; }, 'ranked again');
  assert.deepEqual(held.queue.order, [second, top], 'the model orders around what was dragged');
  const lines = fs.readFileSync(path.join(data, 'queue', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.action === 'moved').to, 1, 'the drag is a choice the queue learns from');
  assert.equal((await call('POST', '/api/queue/move', { id: 'nope', index: 0 })).status, 409);
  // Putting it off lets go of the place.
  await call('POST', `/api/threads/${second}/skip`, {});
  assert.deepEqual((await state()).queue.order, [top, second]);
  await call('PUT', '/api/settings', { mood: '' });
});

test('editing a mail makes a version of yours; the buttons put it in Gmail and send it once', async () => {
  const t = await thread(mailThread);
  const name = t.artifacts[0].name;
  const mail = parseMail(await artifactText(mailThread, name));
  assert.equal(mail.to, 'office@example.org');
  mail.body = mail.body.replace('vielen Dank', 'danke');
  const saved = (await call('POST', `/api/threads/${mailThread}/artifact/save`, { name, content: serializeMail(mail) })).data.artifact;
  assert.equal(saved.versions.length, 2);
  assert.equal(saved.versions[1].by, 'you');
  assert.equal(saved.versions[0].by, 'claude');

  assert.equal((await call('POST', `/api/threads/${mailThread}/mail/draft`, { name })).status, 200);
  let info = (await thread(mailThread)).artifacts[0].mail;
  assert.equal(info.draftVersion, 2);
  assert.ok(info.draftId);

  assert.equal((await call('POST', `/api/threads/${mailThread}/mail/send`, { name })).status, 200);
  const after = await thread(mailThread);
  info = after.artifacts[0].mail;
  assert.equal(info.sentVersion, 2);
  const note = after.messages.at(-1);
  assert.equal(note.event, true);
  assert.match(note.text, /^\[Florian sent the mail ".*" \(version 2\) from the app on .*To: office@example\.org\. Subject: /);
  assert.equal((await call('POST', `/api/threads/${mailThread}/mail/send`, { name })).status, 409, 'a mail is sent once');
  assert.equal((await call('POST', `/api/threads/${mailThread}/artifact/save`, { name, content: 'x' })).status, 409, 'a sent mail cannot be changed');
  assert.equal((await call('POST', `/api/threads/${planThread}/mail/send`, { name: 'nothing.md' })).status, 404);
});

test('pads save; the scratchpad never reaches a run', async () => {
  await call('PUT', '/api/pads/scratchpad', { text: 'private thoughts' });
  await call('PUT', '/api/pads/notes', { text: 'the room for the meetup is booked\nMAIL-TEST please\n' });
  assert.equal((await call('GET', '/api/pads/scratchpad')).data.text, 'private thoughts');
  assert.equal((await call('GET', '/api/pads/nonsense')).status, 404);
  assert.equal((await state()).brain.notes, true);
});

test('update brain raises the water level to the press, files the notes and empties them', async () => {
  const before = await thread(mailThread);
  assert.equal(before.thread.extractedCount, 0);
  assert.equal((await call('POST', '/api/brain/extract', {})).data.started, true);
  // A message sent during the update stays below the line.
  await call('POST', `/api/threads/${planThread}/messages`, { text: 'one more thing, after the press' });
  const run = await lastRun(1);
  assert.equal(run.status, 'updated');
  assert.equal(run.notes, true);

  const mailNow = await thread(mailThread);
  assert.equal(mailNow.thread.extractedCount, before.messages.length, 'the level is where the thread stood at the press');
  assert.ok(mailNow.thread.extractedAt > 0);
  await until(async () => ((await thread(planThread)).messages.length >= 4 ? true : null), 'reply to the later message');
  const planNow = await ready(planThread);
  assert.equal(planNow.thread.extractedCount, 2, 'what came after the press waits for the next update');
  assert.equal((await state()).brain.waiting, 1);

  assert.equal((await call('GET', '/api/pads/notes')).data.text, '', 'filed notes are gone from the pad');
  const dirT = path.join(data, 'extractions', run.id, 'transcripts');
  const files = fs.readdirSync(dirT);
  assert.ok(files.includes('Notes for Claude.md'));
  const everything = files.filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dirT, f), 'utf8')).join('\n');
  assert.doesNotMatch(everything, /private thoughts/, 'the scratchpad is never handed to Claude');
  assert.match(everything, /edited by Florian/);
  assert.match(everything, /SENT by Florian/);
  assert.match(everything, /Project or area: Motion/);
  assert.doesNotMatch(everything, /after the press/);

  // The stand-in reported one mail to answer: it becomes a thread with a draft in it.
  assert.equal(run.replyThreads.length, 1);
  const reply = await ready(run.replyThreads[0]);
  assert.equal(reply.thread.kind, 'mail-reply');
  assert.equal(reply.messages[0].auto, true);
  assert.equal(reply.thread.lastUserAt, 0, 'the app\'s own opening message is not something Florian said');
  assert.equal(reply.artifacts.length, 1);
});

test('cards: made in the background, edited in place, accepted or declined, never made twice', async () => {
  await call('POST', '/api/cards/make', {});
  const s = await until(async () => { const x = await state(); return x.threads.filter((t) => t.kind === 'card' && t.state === 'ready').length === 3 ? x : null; }, 'three cards');
  const opp = s.threads.find((t) => t.card?.type === 'opportunity');
  const chase = s.threads.find((t) => t.card?.type === 'chase');
  assert.equal(opp.card.channel, 'linkedin');
  assert.equal(s.brain.waiting, 1, 'cards do not count as threads to file');

  assert.equal((await call('POST', `/api/threads/${opp.id}/messages`, { text: 'hi' })).status, 409, 'a card takes no reply');
  const text = await artifactText(opp.id, 'Message.md');
  const cut = text.replace('Dieser zweite Absatz ist vielleicht zu viel.\n\n', '');
  await call('POST', `/api/threads/${opp.id}/artifact/save`, { name: 'Message.md', content: cut });
  const accepted = (await call('POST', `/api/threads/${opp.id}/card`, { outcome: 'accepted', reason: '  we already met at the summit,\n so I shortened it ' })).data.thread;
  assert.equal(accepted.card.reason, 'we already met at the summit, so I shortened it');
  assert.equal(accepted.state, 'done');
  assert.equal(accepted.card.outcome, 'accepted');
  assert.equal((await call('POST', `/api/threads/${opp.id}/card`, { outcome: 'declined' })).status, 409);

  // The chase card is a mail: sending it accepts it.
  const chaseMail = parseMail(await artifactText(chase.id, 'Message.md'));
  assert.equal(chaseMail.to, 'office@example.org');
  await call('POST', `/api/threads/${chase.id}/mail/send`, { name: 'Message.md' });
  assert.equal((await thread(chase.id)).thread.card.how, 'sent');

  // A proposal is work Claude offers to do: accepting it starts the thread, with his edits.
  const proposal = s.threads.find((t) => t.card?.type === 'proposal');
  assert.equal(proposal.card.channel, 'thread');
  assert.equal(proposal.project, 'Motion');
  const brief = await artifactText(proposal.id, 'Message.md');
  await call('POST', `/api/threads/${proposal.id}/artifact/save`, { name: 'Message.md', content: `${brief.trim()} Keep it to one page.\n` });
  const took = (await call('POST', `/api/threads/${proposal.id}/card`, { outcome: 'accepted' })).data;
  assert.equal(took.thread.card.how, 'started as a thread');
  assert.equal(took.started.project, 'Motion');
  assert.equal(took.started.title, proposal.title);
  const work = await ready(took.started.id);
  assert.equal(work.messages[0].auto, true, 'the brief is the app\'s message, not something Florian said');
  assert.match(work.messages[0].text, /^Florian accepted this proposal of yours, after editing it\. Do the work:\n\nWork out a timeline.*Keep it to one page\.$/s);

  // Something in the calendar for tomorrow: no card to decide, a thread that prepares him.
  const prep = (await state()).threads.find((t) => t.kind === 'prep');
  assert.equal(prep.title, 'Prepare: example fair tomorrow');
  assert.equal(prep.project, 'Campaign');
  const prepared = await ready(prep.id);
  assert.match(prepared.messages[0].text, /^The app looked at Florian's calendar/);
  assert.equal(prepared.thread.lastUserAt, 0);

  const log = fs.readFileSync(path.join(data, 'cards', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type !== 'prep' && l.type !== 'proposal');
  assert.equal(log.length, 2);
  assert.equal(log[0].edited, true);
  assert.match(log[0].proposed, /zweite Absatz/);
  assert.doesNotMatch(log[0].final, /zweite Absatz/);
  assert.equal(log[0].reason, 'we already met at the summit, so I shortened it', 'what he wrote about a card is kept with its outcome');
  assert.equal((await state()).brain.cards, 3, 'the outcomes wait for the next brain update; the preparation is a thread, not a card');
  // A second run makes none of them again: the calendar entry is not prepared twice.
  const threadsBefore = (await state()).threads.length;
  await call('POST', '/api/cards/make', {});
  await until(async () => ((await state()).cards.running ? null : true), 'second run done');
  assert.equal((await state()).threads.filter((t) => t.kind === 'prep').length, 1);
  assert.ok((await state()).threads.length >= threadsBefore);
});

test('send and done closes the thread once Claude has answered; files can be attached; Claude spins off on request', async () => {
  // Attach a file to a new thread.
  const up = await call('POST', '/api/uploads', { name: '../../notes on the meeting.txt', data: Buffer.from('The board meets on the 14th.').toString('base64') });
  assert.equal(up.status, 200);
  assert.equal(up.data.name, 'notes on the meeting.txt', 'a path in the name is dropped');
  assert.equal((await call('POST', '/api/uploads', { name: 'empty.txt', data: '' })).status, 400);
  const made = (await call('POST', '/api/threads', { text: 'Summarise the attached notes', files: [up.data.id, 'no-such-upload'] })).data.thread;
  const first = await ready(made.id);
  assert.deepEqual(first.messages[0].files, [{ name: 'notes on the meeting.txt', size: 28 }]);
  assert.ok(fs.existsSync(path.join(data, 'threads', made.id, 'uploads', 'notes on the meeting.txt')));
  assert.ok(!fs.existsSync(path.join(data, 'uploads-pending', up.data.id)), 'the upload moved into the thread');
  const got = await fetch(`${base}/api/threads/${made.id}/upload?name=${encodeURIComponent('notes on the meeting.txt')}`);
  assert.equal(await got.text(), 'The board meets on the 14th.');
  assert.equal((await fetch(`${base}/api/threads/${made.id}/upload?name=..%2Fthread.json`)).status, 404);

  // A message with only a file, and a second file of the same name.
  const again = await call('POST', '/api/uploads', { name: 'notes on the meeting.txt', data: Buffer.from('v2').toString('base64') });
  await call('POST', `/api/threads/${made.id}/messages`, { text: '', files: [again.data.id] });
  const second = await ready(made.id);
  assert.equal(second.messages.at(-2).files[0].name, 'notes on the meeting (2).txt');

  // Send and done: no stop in the inbox on the way.
  const sent = await call('POST', `/api/threads/${made.id}/messages`, { text: 'Thanks, file that and we are finished here', done: true });
  assert.equal(sent.data.thread.state, 'working');
  const closed = await until(async () => { const t = await thread(made.id); return t.thread.state === 'done' ? t : null; }, 'closed by itself');
  assert.equal(closed.messages.at(-1).role, 'assistant', 'with Claude\'s answer in it');
  assert.equal(closed.thread.doneAfter, false);

  // Asked in the message, Claude spins off a thread of its own and carries on here.
  const before = (await state()).threads.length;
  await call('POST', `/api/threads/${planThread}/messages`, { text: 'Go with option two. Also spin off a new task only about the mail draft.' });
  const spun = await until(async () => (await state()).threads.find((t) => t.spunFrom === planThread && /mail draft/.test(t.title)) || null, 'spun off');
  assert.equal((await state()).threads.length, before + 1);
  const spunDone = await ready(spun.id);
  assert.equal(spunDone.messages.at(-2).auto, true);
  assert.match(spunDone.messages.at(-2).text, /^Florian asked in the thread ".*" for this to be spun off.*\n\nWork only on the mail draft\.$/s);
  assert.equal(spunDone.messages.at(-3).text, 'Go with option two. Also spin off a new task only about the mail draft.', 'it starts from the conversation as it stood');
  assert.equal(spunDone.thread.lastUserAt, 0, 'nothing in the spin-off is Florian\'s own yet');
  const original = await ready(planThread);
  assert.equal(original.messages.at(-1).role, 'assistant', 'the original thread got its answer too');
  assert.ok(!(await state()).threads.some((t) => t.spunFrom === spun.id), 'and the spin-off does not spin off again');
});

test('a spin-off starts as a copy; the original goes to the back untouched; a thread can be deleted', async () => {
  const source = await thread(planThread);
  const out = await call('POST', `/api/threads/${planThread}/spinoff`, { text: 'Separately: draft the invitation for the kick-off' });
  assert.equal(out.status, 200);
  const spin = out.data.thread;
  assert.notEqual(spin.id, planThread);
  assert.equal(spin.spunFrom, planThread);
  assert.equal(spin.project, source.thread.project);
  assert.equal(spin.title, 'Separately: draft the invitation for the kick-off');
  const after = await thread(planThread);
  assert.equal(after.messages.length, source.messages.length, 'nothing was sent to the original');
  assert.ok(after.thread.requeuedAt > 0, 'the original goes to the back of the queue');
  const done = await ready(spin.id);
  assert.equal(done.messages.length, source.messages.length + 2, 'the copy, his message, and Claude\'s reply');
  assert.equal(done.messages[0].text, source.messages[0].text);
  assert.equal(done.thread.extractedCount, source.messages.length, 'the copied part is not filed a second time');
  assert.ok(done.thread.lastUserAt > done.thread.extractedCount, 'what he said in the spin-off is');
  assert.ok(done.artifacts.length >= source.artifacts.length, 'the files come along');
  assert.equal((await call('POST', '/api/brain/extract', { only: 'mail' })).data.reason, 'Gmail is not connected. Connect it in the settings.');

  assert.equal((await call('DELETE', `/api/threads/${spin.id}`, {})).data.deleted, true);
  assert.equal((await call('GET', `/api/threads/${spin.id}`)).status, 404);
  assert.ok(!(await state()).threads.some((t) => t.id === spin.id));
  assert.ok(!fs.existsSync(path.join(data, 'threads', spin.id)), 'its conversation and files are gone from disk');
});

test('the queue records choices and rewrites its profile from them', async () => {
  const lines = fs.readFileSync(path.join(data, 'queue', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const actions = lines.map((l) => l.action);
  for (const a of ['requeued', 'replied', 'accepted']) assert.ok(actions.includes(a), `${a} is recorded`);
  const requeued = lines.find((l) => l.action === 'requeued');
  assert.match(requeued.mood, /^feeling like (mail|motion) today$/);
  assert.equal(lines.find((l) => l.kind === 'opportunity:linkedin').edited, 'shortened it');
  const profile = await until(async () => (await call('GET', '/api/pads/profile')).data.text || null, 'profile written');
  assert.match(profile, /Stand-in profile/);
});

test('walk mode: the host on the page, with a screen to tell and a connection that may drop', async () => {
  const refused = new WebSocket(`ws://localhost:${port}/walk/ws`, { headers: { Origin: 'https://evil.example' } });
  await new Promise((resolve) => refused.on('error', resolve));

  const connect = async (setup) => {
    const ws = new WebSocket(`ws://localhost:${port}/walk/ws`, { headers: { Origin: base } });
    const heard = [];
    ws.on('message', (raw) => heard.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'setup', from: 'walk mode', lang: 'en-US', ...setup }));
    return { ws, heard };
  };
  const one = await connect({});
  const first = await until(async () => one.heard.find((m) => m.type === 'text'), 'first thing read out');
  assert.match(first.token, /waiting/);
  assert.equal(first.seq, 1);
  assert.doesNotMatch(first.token, /Connect with an example person/, 'cards are left to the screen');
  const status = await until(async () => one.heard.findLast((m) => m.type === 'status' && m.thread), 'the screen knows which thread is open');
  assert.ok(status.waiting >= 1);

  one.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'my mood is short things on the walk', alternatives: ['my mood is short thinks'], lang: 'en-US', last: true }));
  await until(async () => one.heard.find((m) => m.type === 'text' && /Mood line set/.test(m.token)), 'mood confirmed');
  assert.equal((await call('GET', '/api/state')).data.settings.mood, 'short things on the walk');
  one.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'what is waiting?', typed: true, last: true }));
  await until(async () => one.heard.find((m) => m.type === 'text' && /Stand-in answer/.test(m.token)), 'the host answers itself');

  // The connection drops; the host answers into the gap; the page comes back and hears it.
  const seen = one.heard.findLast((m) => m.type === 'text').seq;
  one.ws.close();
  await sleep(100);
  const two = await connect({ resume: true, sid: first.sid, seen: seen - 1 });
  const again = await until(async () => two.heard.find((m) => m.type === 'text'), 'what was missed is said again');
  assert.equal(again.seq, seen);
  assert.match(again.token, /Stand-in answer/);
  assert.ok(!two.heard.some((m) => m.type === 'text' && /threads? (is|are) waiting\./.test(m.token)), 'no second greeting');

  // A page opened anew is shown the last thing said, marked as not to be read out.
  const three = await connect({ resume: true });
  const shown = await until(async () => three.heard.find((m) => m.type === 'text'), 'last line shown');
  assert.equal(shown.replay, true);
  assert.equal(shown.seq, seen);
  three.ws.close();
  await sleep(100);
  const four = await connect({ resume: true, sid: first.sid, seen });
  two.ws.close();
  two.ws = four.ws;
  two.heard = four.heard;

  two.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'goodbye', last: true }));
  await until(async () => two.heard.find((m) => m.type === 'end'), 'conversation ended');
  two.ws.close();
  const words = await call('PUT', '/api/pads/words', { text: 'KStW\nLutz' });
  assert.equal(words.status, 200);
});

test('the app\'s state is pushed to its own repo, without secrets', async () => {
  await call('POST', '/api/brain/extract', {});
  await lastRun(2);
  const files = await until(async () => {
    const list = git(dataRemote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    return list.includes('cards/log.jsonl') && list.some((f) => f.startsWith('extractions/')) ? list : null;
  }, 'data pushed');
  assert.ok(files.includes('state.json'));
  assert.ok(files.includes('scratchpad.md'));
  assert.ok(files.includes('queue/decisions.jsonl'));
  assert.ok(files.includes('cards/log.jsonl'));
  assert.ok(files.some((f) => /^threads\/[^/]+\/messages\.jsonl$/.test(f)));
  assert.ok(!files.includes('config.json'), 'config.json holds secrets and stays local');
  assert.ok(!files.some((f) => f.startsWith('brain/')), 'the brain clone has its own repo');
  assert.ok(!files.some((f) => f.includes('transcripts/')));
  let leaked = '';
  try { leaked = git(dataRemote, 'grep', '-l', 'never-commit-me', 'main'); } catch { /* git grep exits with 1 when nothing matches */ }
  assert.equal(leaked, '', 'no secret in the pushed state');
});
