// Events from the calendar, threads finding their project by themselves, and the lease
// that keeps background work to one computer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showAtFor } from '../server/events.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('when an event thread opens', () => {
  const start = new Date(2026, 10, 20, 15, 0).getTime();
  assert.equal(showAtFor(start, true), start - 24 * 3600_000, 'important: a day before');
  assert.equal(showAtFor(start, false), new Date(2026, 10, 20, 7, 0).getTime(), 'smaller: 07:00 on the day');
  const early = new Date(2026, 10, 20, 7, 30).getTime();
  assert.equal(showAtFor(early, false), early - 3600_000, 'but at least an hour before');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-events-'));
const vault = path.join(dir, 'vault.git');
const data = path.join(dir, 'data');
const port = 6900 + Math.floor(Math.random() * 300);
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
git(dir, 'init', '--bare', '-b', 'main', vault);
const seed = path.join(dir, 'seed');
git(dir, 'clone', vault, seed);
for (const d of ['Brain/Projects', 'Brain/Areas', 'Brain/People', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Areas', 'Campaign.md'), '# Campaign\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Mensa Tracker.md'), '# Mensa Tracker\n\nStatus: active\nrepo: `fburgerdev/website-stuwerke`\n');
fs.writeFileSync(path.join(seed, 'Brain', 'People', 'Anna Karle (PUYK).md'), 'Last contacted: by 18-10-2026 (message)\n\nrole: runs [[PUYK]]\n\nOpen threads: turn her offer into something concrete.\n');
fs.writeFileSync(path.join(seed, 'Brain', 'People', 'Kirk Junker (Prorektor).md'), 'Last contacted: 01-07-2026\n\nOpen threads: none; he no longer holds the office\n');
fs.writeFileSync(path.join(seed, 'Brain', 'People', 'People Index.md'), '# People Index\n');
fs.writeFileSync(path.join(seed, 'Brain', 'People', 'Kristine (Veganuary).md'), 'Last contacted: 10-07-2026\nStatus: waiting: KStW news\n\nOpen threads: owes her an update once there is more to say\n');
fs.writeFileSync(path.join(seed, 'Brain', 'People', 'Jürgen (Kitchen).md'), 'Last contacted: 08-10-2026\nStatus: keep warm\n\nOpen threads: keep him warm\n');
fs.mkdirSync(path.join(seed, 'Brain', 'Horizons'), { recursive: true });
fs.writeFileSync(path.join(seed, 'Brain', 'Horizons', '30,000 ft Goals.md'), '# 30,000 ft\n\n1. [[Campaign]] — every Mensa plant-based\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Next Actions.md'), '# Next Actions\n\nRules.\n\n## [[Mensa Tracker]]\n\n- [ ] Call the [[Campaign]] office, 0221 1234\n\n## [[Campaign]]\n\n- [ ] Decide on the stall date\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Someday.md'), '# Someday\n\nIntro.\n\n- Try to get the Kitas in Köln to go plant-based. Noted after the meeting.\n- Look into investing.\n\n## Parked 21-09-2026\n\n- Reschedule the outreach stall.\n');
fs.writeFileSync(path.join(seed, 'Brain', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## [[Campaign]]\n\n- [[Mensa Tracker]] — the website\n');
git(seed, 'checkout', '-B', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', cards: { auto: false } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data }, stdio: ['ignore', fs.openSync(path.join(dir, 'log'), 'w'), 'inherit'] });
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'log'), 'utf8')); });
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); }
  throw new Error(`timed out: ${what}`);
}
const state = async () => (await call('GET', '/api/state')).data;
const thread = async (id) => (await call('GET', `/api/threads/${id}`)).data;
const ready = (id) => until(async () => { const t = await thread(id); return t.thread.state === 'ready' && t.messages.some((m) => m.role === 'assistant') ? t : null; }, `thread ${id} answered`);

test('the app is up', async () => {
  await until(async () => (await state()).brain.brain.ready, 'brain cloned', 40000);
});

test('people and Someday come with the outline', async () => {
  const tree = (await call('GET', '/api/projects')).data;
  assert.deepEqual(tree.people.map((p) => [p.name, p.group]).sort(), [['Anna Karle (PUYK)', 'move'], ['Jürgen (Kitchen)', 'warm'], ['Kirk Junker (Prorektor)', 'none'], ['Kristine (Veganuary)', 'waiting']]);
  assert.equal(tree.people.find((p) => p.group === 'waiting').waitsFor, 'KStW news');
  const area = tree.groups.find((g) => g.name === 'Campaign');
  assert.equal(area.rank, 1);
  assert.equal(area.goal, 'every Mensa plant-based');
  const anna = tree.people.find((p) => p.name.startsWith('Anna'));
  assert.equal(new Date(anna.contacted).getMonth(), 9);
  assert.match(anna.about, /^Open: turn her offer/);
  assert.deepEqual(tree.someday.map((x) => [x.short, x.parked]), [['Try to get the Kitas in Köln to go plant-based.', false], ['Look into investing.', false], ['Reschedule the outreach stall.', true]]);
  assert.ok(tree.someday[0].touched > 0, 'when the line last changed, from git');
  // Threads can be on a person, or on Someday.
  const t = (await call('POST', '/api/threads', { text: 'Draft a note to Anna', project: 'Anna Karle (PUYK)' })).data.thread;
  assert.equal(t.project, 'Anna Karle (PUYK)');
  const sd = (await call('POST', '/api/threads', { text: 'From Someday: investing', project: 'Someday' })).data.thread;
  assert.equal(sd.project, 'Someday');
});

test('a thread finds its project by itself, after its first answer, and takes the project\'s repo', async () => {
  const t = (await call('POST', '/api/threads', { text: 'Let us add the Bavarian Studierendenwerke to the mensa tracker' })).data.thread;
  assert.equal(t.project, '', 'not chosen when it was started');
  const done = await until(async () => { const x = (await thread(t.id)).thread; return x.projectGuessed ? x : null; }, 'guessed');
  assert.equal(done.project, 'Mensa Tracker');
  assert.equal(done.repo, 'fburgerdev/website-stuwerke');
  // None fits: it stays without, and is not asked again.
  const loose = (await call('POST', '/api/threads', { text: 'What is a good book on game theory?' })).data.thread;
  const x = await until(async () => { const y = (await thread(loose.id)).thread; return y.projectGuessed ? y : null; }, 'guessed none');
  assert.equal(x.project, '');
  // What Florian sets stands.
  const mine = (await call('POST', '/api/threads', { text: 'Campaign or the tracker?' })).data.thread;
  await call('POST', `/api/threads/${mine.id}/project`, { project: 'Campaign' });
  await ready(mine.id);
  await sleep(300);
  assert.equal((await thread(mine.id)).thread.project, 'Campaign');
});

test('an event close enough opens with its briefing, outside the inbox, and stays until done', async () => {
  // The stand-in's calendar has the fair two hours from now when a thread says EVENT-SOON.
  await call('POST', '/api/threads', { text: 'EVENT-SOON marker for the stand-in calendar' });
  await call('POST', '/api/cards/make', {});
  const fair = await until(async () => (await state()).threads.find((t) => t.kind === 'event' && t.title === 'Example fair' && t.messageCount > 1), 'fair opened');
  assert.equal(fair.hidden, false);
  assert.equal(fair.event.started, true);
  const t = await ready(fair.id);
  assert.match(t.messages[0].text, /^This is the thread for an entry in Florian's calendar: Example fair/);
  assert.match(t.messages[0].text, /prepare before the entry and to debrief after it/);
  assert.ok(!(await state()).queue.order.includes(fair.id), 'not in the inbox');
  // The smaller call two hours from now opens too: its morning has passed, an hour before at the latest.
  const small = (await state()).threads.find((t2) => t2.kind === 'event' && t2.title === 'Call with the example office');
  assert.equal(small.event.important, false);
  // Prepare, debrief, done.
  await call('POST', `/api/threads/${fair.id}/messages`, { text: 'What should I bring?' });
  await until(async () => (await thread(fair.id)).messages.filter((m) => m.role === 'assistant').length >= 2, 'second answer');
  assert.ok(!(await state()).queue.order.includes(fair.id));
  await call('POST', `/api/threads/${fair.id}/state`, { state: 'done' });
  assert.equal((await thread(fair.id)).thread.state, 'done');
});

test('on the Pi, background work waits while the laptop holds the lease', async () => {
  const link = await import('../server/link.js');
  assert.equal(link.mayRunBackground(), true);
  link.takeLease(true);
  assert.equal(link.mayRunBackground(), false);
  assert.equal(link.leaseHeld(), true);
  link.takeLease(false);
  assert.equal(link.mayRunBackground(), true);
});

test('next actions sleep, wake into the inbox, and threads can be deferred back', async () => {
  const sleeping = (await call('GET', '/api/next-actions')).data;
  assert.deepEqual(sleeping.actions.map((a) => [a.project, a.show]), [['Mensa Tracker', 'Call the Campaign office, 0221 1234'], ['Campaign', 'Decide on the stall date']]);
  // Wake one: a thread in the inbox, opening with a brief; the line leaves the list.
  const woke = (await call('POST', '/api/next-actions/wake', { project: 'Mensa Tracker', text: sleeping.actions[0].text })).data.thread;
  assert.equal(woke.kind, 'next-action');
  assert.equal(woke.project, 'Mensa Tracker');
  const t = await ready(woke.id);
  assert.match(t.messages[0].text, /^Florian woke this line from his Next Actions, under Mensa Tracker/);
  assert.ok((await state()).queue.order.includes(woke.id), 'in the inbox like any thread');
  assert.deepEqual((await call('GET', '/api/next-actions')).data.actions.map((a) => a.show), ['Decide on the stall date']);
  assert.equal((await call('POST', '/api/next-actions/wake', { project: 'Mensa Tracker', text: sleeping.actions[0].text })).status, 409, 'not twice');
  // Defer it again, with a note on where he left off.
  const d = (await call('POST', `/api/threads/${woke.id}/defer`, { text: 'They are only in on Tuesdays' })).data.thread;
  assert.equal(d.state, 'done');
  assert.equal(d.deferred, true);
  assert.ok(!(await state()).queue.order.includes(woke.id));
  assert.deepEqual((await call('GET', '/api/next-actions')).data.deferred.map((x) => x.id), [woke.id]);
  const last = (await thread(woke.id)).messages.at(-1);
  assert.equal(last.text, 'They are only in on Tuesdays');
  assert.equal(last.unanswered, true);
  // The brain update sees it (told to write the line), then the thread is gone.
  assert.ok((await state()).brain.waiting >= 1);
  await call('POST', '/api/brain/extract', {});
  await until(async () => { const b = (await state()).brain; return !b.running && !(await state()).threads.some((x) => x.id === woke.id); }, 'deferred thread deleted after the update', 30000);
  const run = fs.readdirSync(path.join(data, 'extractions')).sort().at(-1);
  const files = fs.readdirSync(path.join(data, 'extractions', run, 'transcripts'));
  const file = files.find((f) => f.includes('Call the Campaign office'));
  const text = fs.readFileSync(path.join(data, 'extractions', run, 'transcripts', file), 'utf8');
  assert.match(text, /Woken from Next Actions: Florian started this thread from the line "Call the \[\[Campaign\]\] office, 0221 1234" under "Mensa Tracker"/);
  assert.match(text, /Deferred by Florian/);
  // A reply into a deferred thread wakes it instead.
  const other = (await call('POST', '/api/threads', { text: 'Something to park' })).data.thread;
  await ready(other.id);
  await call('POST', `/api/threads/${other.id}/defer`, {});
  await call('POST', `/api/threads/${other.id}/messages`, { text: 'Actually, now' });
  assert.equal((await thread(other.id)).thread.deferred, false);
});

test('usage is counted per run', async () => {
  const u = (await call('GET', '/api/usage')).data;
  assert.ok(u.today.runs >= 3);
  assert.ok(u.today.cost > 0);
  assert.equal(u.days.length, 7);
  assert.ok(u.byKind.some((k) => k.kind === 'Threads'));
  assert.ok(u.byKind.some((k) => k.kind === 'Brain update'));
});

test('the tier is picked per message, can be pinned, and runs again one higher', async () => {
  // Auto: the stand-in picks "high" for strategy, "cheap" for something quick.
  const hard = (await call('POST', '/api/threads', { text: 'Work out the negotiation strategy for the next meeting' })).data.thread;
  await ready(hard.id);
  assert.equal((await thread(hard.id)).thread.lastTier, 'high');
  const quick = (await call('POST', '/api/threads', { text: 'Quick: what is the date of the next meeting?' })).data.thread;
  await ready(quick.id);
  assert.equal((await thread(quick.id)).thread.lastTier, 'cheap');
  // Pinned on the thread, the picker is not asked again.
  assert.equal((await call('POST', `/api/threads/${quick.id}/tier`, { tier: 'extra' })).data.thread.tier, 'extra');
  await call('POST', `/api/threads/${quick.id}/messages`, { text: 'And the one after that?' });
  await until(async () => (await thread(quick.id)).messages.filter((m) => m.role === 'assistant').length >= 2, 'second answer');
  assert.equal((await thread(quick.id)).thread.lastTier, 'extra');
  assert.equal((await call('POST', `/api/threads/${quick.id}/tier`, { tier: 'enormous' })).status, 400);
  // Again, higher: the last message runs once more, one tier up.
  await call('POST', `/api/threads/${hard.id}/tier`, { tier: '' });
  const again = (await call('POST', `/api/threads/${hard.id}/again`, {})).data;
  assert.equal(again.tier, 'extra');
  const after = await ready(hard.id);
  assert.equal(after.thread.lastTier, 'extra');
  assert.equal(after.messages.filter((m) => m.role === 'user').length, 1, 'the message is not sent twice');
  assert.equal(after.messages.filter((m) => m.role === 'assistant').length, 2);
  // A fixed tier for everything, set in the settings.
  await call('PUT', '/api/settings', { tier: 'low' });
  const plain = (await call('POST', '/api/threads', { text: 'Work out the negotiation strategy, again' })).data.thread;
  await ready(plain.id);
  assert.equal((await thread(plain.id)).thread.lastTier, 'low', 'no picking when a tier is set');
  await call('PUT', '/api/settings', { tier: 'auto' });
});

test('getting ready to suspend holds back background work and says when it is safe', async () => {
  const before = (await call('GET', '/api/status')).data;
  assert.equal(before.link.finalizing, undefined === before.link.finalizing ? undefined : false);
  await call('POST', '/api/status/finalize', { on: true });
  const on = (await call('GET', '/api/status')).data;
  assert.equal(on.link.finalizing, true);
  assert.equal(on.safe, true, 'nothing is running');
  // A message from Florian means he is working again.
  const t = (await call('POST', '/api/threads', { text: 'One more thing' })).data.thread;
  assert.equal((await call('GET', '/api/status')).data.link.finalizing, false);
  await ready(t.id);
});
