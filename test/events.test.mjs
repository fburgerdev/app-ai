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
import { cleanup, freePort } from './helpers.mjs';

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
const port = await freePort();
const base = `http://localhost:${port}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
git(dir, 'init', '--bare', '-b', 'main', vault);
const seed = path.join(dir, 'seed');
git(dir, 'clone', vault, seed);
for (const d of ['Core/Projects', 'Core/Areas', 'Core/People', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
fs.writeFileSync(path.join(seed, 'Core', 'Areas', 'Campaign.md'), '# Campaign\n');
fs.writeFileSync(path.join(seed, 'Core', 'Projects', 'Mensa Tracker.md'), '# Mensa Tracker\n\nStatus: active\nrepo: `fburgerdev/website-stuwerke`\n');
fs.writeFileSync(path.join(seed, 'Core', 'People', 'Anna Karle (PUYK).md'), 'Last contacted: by 18-10-2026 (message)\n\nrole: runs [[PUYK]]\n\nOpen threads: turn her offer into something concrete.\n');
fs.writeFileSync(path.join(seed, 'Core', 'People', 'Kirk Junker (Prorektor).md'), 'Last contacted: 01-07-2026\n\nOpen threads: none; he no longer holds the office\n');
fs.writeFileSync(path.join(seed, 'Core', 'People', 'People Index.md'), '# People Index\n');
fs.writeFileSync(path.join(seed, 'Core', 'People', 'Kristine (Veganuary).md'), 'Last contacted: 10-07-2026\nStatus: waiting: KStW news\n\nOpen threads: owes her an update once there is more to say\n');
fs.writeFileSync(path.join(seed, 'Core', 'People', 'Jürgen (Kitchen).md'), 'Last contacted: 08-10-2026\nStatus: keep warm\n\nOpen threads: keep him warm\n');
fs.mkdirSync(path.join(seed, 'Core', 'Horizons'), { recursive: true });
fs.writeFileSync(path.join(seed, 'Core', 'Horizons', '30,000 ft Goals.md'), '# 30,000 ft\n\n1. [[Campaign]] — every Mensa plant-based\n');
fs.writeFileSync(path.join(seed, 'Core', 'Next Actions.md'), '# Next Actions\n\nRules.\n\n## [[Mensa Tracker]]\n\n- [ ] Call the [[Campaign]] office, 0221 1234\n\n## [[Campaign]]\n\n- [ ] Decide on the stall date\n');
fs.writeFileSync(path.join(seed, 'Core', 'Someday.md'), '# Someday\n\nIntro.\n\n- Try to get the Kitas in Köln to go plant-based. Noted after the meeting.\n- Look into investing.\n\n## Parked 21-09-2026\n\n- Reschedule the outreach stall.\n');
fs.writeFileSync(path.join(seed, 'Core', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## [[Campaign]]\n\n- [[Mensa Tracker]] — the website\n');
git(seed, 'checkout', '-B', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', cards: { auto: false } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data }, stdio: ['ignore', fs.openSync(path.join(dir, 'log'), 'w'), 'inherit'] });
test.after(() => { if (process.env.KEEP) console.log(fs.readFileSync(path.join(dir, 'log'), 'utf8')); });
test.after(() => cleanup(dir, [server]));

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
  // Each line gets a short label, made once in the background and kept by the line's text.
  const labelled = await until(async () => { const s = (await call('GET', '/api/projects')).data.someday; return s.every((x) => x.label) ? s : null; }, 'labels made');
  assert.deepEqual(labelled.map((x) => x.label), ['get the Kitas in', 'investing', 'Reschedule the outreach stall'], 'the stand-in: the first words');
  assert.ok(fs.existsSync(path.join(data, 'someday-labels.json')));
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
  // Kept on the thread, the picker is not asked again.
  assert.equal((await call('POST', `/api/threads/${quick.id}/tier`, { tier: 'extra' })).data.thread.keepTier, 'extra');
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
  assert.equal(after.thread.keepTier, 'extra', 'and the thread keeps it');
  // A single tier is no setting any more: the picker still decides.
  await call('PUT', '/api/settings', { tier: 'low' });
  const plain = (await call('POST', '/api/threads', { text: 'Quick: one more date, please' })).data.thread;
  await ready(plain.id);
  assert.equal((await thread(plain.id)).thread.lastTier, 'cheap');
});

test('threads can be pinned, reordered and unpinned; events are pinned from the start', async () => {
  const fair = (await state()).threads.find((t) => t.kind === 'event' && t.title === 'Example fair');
  const a = (await call('POST', '/api/threads', { text: 'A long piece of work to keep on top' })).data.thread;
  await ready(a.id);
  assert.ok((await state()).queue.order.includes(a.id), 'in the queue before it is pinned');
  const pinned = (await call('POST', `/api/threads/${a.id}/pin`, { pinned: true })).data.thread;
  assert.equal(pinned.pinned, true);
  assert.ok(!(await state()).queue.order.includes(a.id), 'a pinned thread is not in the queue');
  // Reorder: his thread first, the event after it.
  const out = (await call('POST', '/api/pins/order', { ids: [a.id, fair.id] })).data.threads;
  assert.equal(out.find((t) => t.id === a.id).pinAt, 0);
  assert.equal(out.find((t) => t.id === fair.id).pinAt, 1);
  // An event can be unpinned like any other thread.
  assert.equal((await call('POST', `/api/threads/${fair.id}/pin`, { pinned: false })).data.thread.pinned, false);
  // Done takes the pin off.
  const closed = (await call('POST', `/api/threads/${a.id}/state`, { state: 'done' })).data.thread;
  assert.equal(closed.pinned, false);
});

test('a thread gets its type with its project, and a name he typed stands', async () => {
  const t = (await call('POST', '/api/threads', { text: 'Work out the strategy for the stall' })).data.thread;
  assert.equal(t.titleAuto, true);
  const signed = await until(async () => { const x = (await thread(t.id)).thread; return x.signedAt ? x : null; }, 'signed');
  assert.equal(signed.type, 'thinking');
  await call('POST', `/api/threads/${t.id}/title`, { title: 'Stall strategy' });
  assert.equal((await thread(t.id)).thread.titleAuto, false);
  await ready(t.id);
  await call('POST', `/api/threads/${t.id}/state`, { state: 'done' });
  await sleep(300);
  assert.equal((await thread(t.id)).thread.title, 'Stall strategy');
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

test('a tier chosen when sending counts for that message only', async () => {
  await call('PUT', '/api/settings', { tier: 'ask' });
  const t = (await call('POST', '/api/threads', { text: 'Work out the negotiation strategy', tier: 'cheap' })).data.thread;
  await ready(t.id);
  assert.equal((await thread(t.id)).thread.lastTier, 'cheap', 'his choice, not the picker\'s');
  await call('POST', `/api/threads/${t.id}/messages`, { text: 'And again, please', tier: 'extra' });
  await until(async () => (await thread(t.id)).messages.filter((m) => m.role === 'assistant').length >= 2, 'second answer');
  assert.equal((await thread(t.id)).thread.lastTier, 'extra');
  assert.equal((await thread(t.id)).thread.nextTier, '', 'forgotten afterwards');
  await call('PUT', '/api/settings', { tier: 'auto' });
});

test('the status has four stages', async () => {
  await call('POST', '/api/status/finalize', { on: false });
  const idle = (await call('GET', '/api/status')).data;
  assert.equal(idle.stage, 'idle');
  assert.equal(idle.locked, false);
  assert.equal(idle.safe, false, 'not locked: the app may start something');
  await call('POST', '/api/status/finalize', { on: true });
  const safe = (await call('GET', '/api/status')).data;
  assert.equal(safe.stage, 'safe');
  assert.equal(safe.safe, true);
  // Something running while locked is the getting-ready stage.
  const t = (await call('POST', '/api/threads', { text: 'Something slow SLOW-TEST' })).data.thread;
  await call('POST', '/api/status/finalize', { on: true });
  const during = await until(async () => { const x = (await call('GET', '/api/status')).data; return x.busy.threads.length ? x : null; }, 'busy', 6000);
  assert.equal(during.stage, 'getting-ready');
  assert.equal(during.safe, false);
  await ready(t.id);
  await call('POST', '/api/status/finalize', { on: false });
  const busy = (await call('POST', '/api/threads', { text: 'Another one SLOW-TEST' })).data.thread;
  const yellow = await until(async () => { const x = (await call('GET', '/api/status')).data; return x.busy.threads.length ? x : null; }, 'busy again', 6000);
  assert.equal(yellow.stage, 'busy');
  await ready(busy.id);
});

test('network trouble is retried quietly; a real failure opens a repair thread, once', async () => {
  const { isNetworkError } = await import('../server/repair.js');
  assert.ok(isNetworkError("fatal: unable to access 'https://github.com/x/': Failed to connect to github.com port 443 after 21133 ms: Could not connect to server"));
  assert.ok(isNetworkError('Could not resolve host: github.com'));
  assert.ok(!isNetworkError('TypeError: cannot read properties of undefined'));
  const before = (await state()).threads.filter((t) => t.kind === 'repair').length;
  const made = (await call('POST', '/api/repair/test', { source: 'the brain update', message: 'TypeError: x is not a function at extract.js:12' })).data;
  assert.ok(made.thread);
  const t = await ready(made.thread);
  assert.equal(t.thread.kind, 'repair');
  assert.equal(t.thread.repo, 'fburgerdev/app-ai');
  assert.match(t.messages[0].text, /TypeError: x is not a function/);
  assert.match(t.messages[0].text, /The end of the app's log/);
  assert.equal((await call('POST', '/api/repair/test', { source: 'the brain update', message: 'TypeError: x is not a function at extract.js:99' })).data.thread, null, 'the same error does not open a second thread');
  assert.equal((await call('POST', '/api/repair/test', { source: 'saving', message: 'Could not resolve host: github.com' })).data.thread, null, 'the network is not a bug');
  assert.equal((await state()).threads.filter((x) => x.kind === 'repair').length, before + 1);
});

test('checking for updates by hand answers at once', async () => {
  const r = (await call('POST', '/api/update/check', {})).data;
  assert.equal(r.outcome, 'off', 'the stand-in does not update itself');
});

test('a preparation made before events existed does not stop its event', async () => {
  // The old kind of entry in the card log, for the fair the stand-in calendar has.
  const day = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const all = (await state()).threads.filter((t) => t.kind === 'event');
  for (const t of all) await call('DELETE', `/api/threads/${t.id}`);
  fs.appendFileSync(path.join(data, 'cards', 'log.jsonl'), JSON.stringify({ ts: Date.now(), key: `prep:${day}:example-fair`, type: 'prep', channel: 'thread', title: 'Prepare: Example fair today', outcome: 'started', how: 'by itself, from the calendar' }) + '\n');
  await call('POST', '/api/threads', { text: 'EVENT-SOON again' });
  await call('POST', '/api/cards/make', {});
  await until(async () => (await state()).threads.some((t) => t.kind === 'event' && t.title === 'Example fair'), 'the event is made after all');
});

test('what is typed and not sent is kept, the newer copy wins, and sending empties it', async () => {
  const t = (await call('POST', '/api/threads', { text: 'A thread to write a reply in' })).data.thread;
  await ready(t.id);
  const at = Date.now();
  assert.equal((await call('PUT', `/api/drafts/${t.id}`, { text: 'half a sentence', at })).data.text, 'half a sentence');
  // Kept on disk, so it survives a restart and travels with the app's data.
  assert.ok(fs.existsSync(path.join(data, 'drafts', `${t.id}.json`)));
  assert.equal((await call('GET', '/api/drafts')).data.drafts[t.id].text, 'half a sentence');
  // An older copy from another device does not overwrite it.
  assert.equal((await call('PUT', `/api/drafts/${t.id}`, { text: 'stale', at: at - 60_000 })).data.text, 'half a sentence');
  assert.equal((await call('PUT', '/api/drafts/../config', { text: 'x' })).status, 404, 'only draft names');
  // Sent: emptied, and remembered as emptied, so an older copy cannot come back.
  await call('POST', `/api/threads/${t.id}/messages`, { text: 'half a sentence, finished' });
  const after = (await call('GET', '/api/drafts')).data.drafts[t.id];
  assert.equal(after.text, '');
  assert.equal((await call('PUT', `/api/drafts/${t.id}`, { text: 'half a sentence', at })).data.text, '');
  // The box of a thread not started yet, emptied when the thread starts.
  await call('PUT', '/api/drafts/new', { text: 'an idea for a new thread', at: Date.now() });
  await call('POST', '/api/threads', { text: 'an idea for a new thread' });
  assert.equal((await call('GET', '/api/drafts')).data.drafts.new.text, '');
  // A deleted thread takes its draft with it.
  await ready(t.id);
  await call('PUT', `/api/drafts/${t.id}`, { text: 'never sent', at: Date.now() + 1000 });
  await call('DELETE', `/api/threads/${t.id}`, {});
  await until(async () => !fs.existsSync(path.join(data, 'drafts', `${t.id}.json`)), 'draft dropped');
});

test('only files Claude chose to show are shown; what a script leaves behind goes to the workbench', async () => {
  const t = (await call('POST', '/api/threads', { text: 'SCRIPT-TEST fill the form' })).data.thread;
  const done = await ready(t.id);
  // One file shown: the result the script handed over. Not the 40 library files.
  assert.deepEqual(done.artifacts.map((a) => a.name), ['Formular ausgefüllt.pdf']);
  const parts = done.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts || []).filter((p) => p.type === 'artifact');
  assert.deepEqual(parts.map((p) => p.name), ['Formular ausgefüllt.pdf']);
  // The artifacts folder holds only that; the rest is on the workbench, which is not synced.
  const art = path.join(data, 'threads', t.id, 'artifacts');
  assert.deepEqual(fs.readdirSync(art), ['Formular ausgefüllt.pdf']);
  assert.ok(fs.existsSync(path.join(data, 'threads', t.id, 'work', 'unshown', 'pylib', 'yaml', '__pycache__', 'm0.cpython-312.pyc')));
  assert.ok(fs.existsSync(path.join(data, 'threads', t.id, 'work', 'fill.py')));
  // A mail written with the file tool is shown as before.
  const m = (await call('POST', '/api/threads', { text: 'Please draft a mail to the office' })).data.thread;
  assert.deepEqual((await ready(m.id)).artifacts.map((a) => a.name), ['Mail an das Büro.md']);
});

test('an event that is not open yet can be opened now, to prepare already', async () => {
  // Close the thread that makes the stand-in's fair start soon: now it is tomorrow.
  for (const t of (await state()).threads.filter((x) => /EVENT-SOON/.test(x.title) && x.state !== 'done')) {
    await until(async () => (await call('POST', `/api/threads/${t.id}/state`, { state: 'done' })).status === 200, 'closed');
  }
  await call('POST', '/api/cards/make', {});
  const coming = await until(async () => (await state()).threads.find((t) => t.kind === 'event' && t.title === 'Example fair' && t.hidden && !t.event.started), 'tomorrow\'s fair, not open yet');
  assert.ok(coming.event.showAt > Date.now(), 'it would open by itself later');
  const opened = (await call('POST', `/api/events/${coming.id}/open`, {})).data.thread;
  assert.equal(opened.hidden, false);
  assert.equal(opened.event.started, true);
  const t = await ready(opened.id);
  assert.match(t.messages[0].text, /^This is the thread for an entry in Florian's calendar: Example fair/, 'with its briefing, as if its time had come');
  assert.equal((await call('POST', '/api/events/nope/open', {})).status, 404);
});

test('when he says an entry was postponed, its event moves at once, from any thread', async () => {
  const fair = await until(async () => (await state()).threads.find((t) => t.kind === 'event' && t.title === 'Example fair' && t.state !== 'done'), 'the fair, open');
  const length = fair.event.end - fair.event.start;
  const later = new Date(Date.now() + 5 * 24 * 3600_000);
  later.setSeconds(0, 0);
  const said = (await call('POST', '/api/threads', { text: `The fair got postponed. MOVE-TEST example fair TO ${later.toISOString()}` })).data.thread;
  await ready(said.id);
  const moved = await thread(fair.id);
  assert.equal(moved.thread.event.start, later.getTime(), 'the new start');
  assert.equal(moved.thread.event.end - moved.thread.event.start, length, 'the same length');
  assert.equal(moved.thread.event.showAt, showAtFor(later.getTime(), moved.thread.event.important), 'opens by the new time');
  assert.equal(moved.thread.event.started, true, 'an open event stays open');
  assert.match(moved.messages.at(-1).text, /^\[The entry moved from .* to .*said in the thread/, 'its thread is told');
  // A name that fits none changes nothing.
  const wrong = (await call('POST', '/api/threads', { text: `MOVE-TEST no such meeting TO ${later.toISOString()}` })).data.thread;
  await ready(wrong.id);
  assert.equal((await thread(fair.id)).thread.event.start, later.getTime());
});

test('focus: only his own threads in the queue, no new cards, and it ends by itself', async () => {
  const mine = (await call('POST', '/api/threads', { text: 'Something of my own' })).data.thread;
  await ready(mine.id);
  await call('POST', '/api/cards/make', {});
  const card = await until(async () => (await state()).threads.find((t) => t.kind === 'card' && t.state === 'ready'), 'a card waiting');
  await until(async () => (await state()).queue.order.includes(card.id), 'the card in the queue');
  const on = (await call('PUT', '/api/settings', { focus: true })).data;
  assert.equal(on.focus.on, true);
  assert.ok(on.focus.until > Date.now() && on.focus.until <= Date.now() + 24 * 3600_000, 'until the next sleep time, within a day');
  const q = await until(async () => { const s = await state(); return !s.queue.order.includes(card.id) ? s.queue.order : null; }, 'the card out of the queue');
  assert.ok(q.includes(mine.id), 'his own thread stays');
  // (The card run started by itself makes no cards while he focuses; "Look for
  // opportunities", which he clicks himself, still does.)
  const off = (await call('PUT', '/api/settings', { focus: false })).data;
  assert.equal(off.focus.on, false);
  await until(async () => (await state()).queue.order.includes(card.id), 'back in the queue after focus');
});

test('focus ends at the next sleep time, or midnight without one', async () => {
  const { focusEnd } = await import('../server/state.js');
  const at = new Date(2026, 10, 15, 22, 30).getTime();
  assert.equal(focusEnd(at, { on: true, from: '23:00' }), new Date(2026, 10, 15, 23, 0).getTime());
  assert.equal(focusEnd(at, { on: true, from: '00:30' }), new Date(2026, 10, 16, 0, 30).getTime());
  assert.equal(focusEnd(at, { on: false, from: '23:00' }), new Date(2026, 10, 16, 0, 0).getTime());
});

test('deep work comes first in the queue; small things fill the time in between', async () => {
  await call('PUT', '/api/settings', { focus: false });
  await call('POST', '/api/cards/make', {});
  const card = await until(async () => (await state()).threads.find((t) => t.kind === 'card' && t.state === 'ready'), 'a card waiting');
  // A small question, then a build session that started later: the session goes first.
  const small = (await call('POST', '/api/threads', { text: 'Quick: what time is it in Berlin?' })).data.thread;
  await ready(small.id);
  const deep = (await call('POST', '/api/threads', { text: 'Build the tracker code for the new page' })).data.thread;
  await until(async () => (await thread(deep.id)).thread.type === 'build' && (await thread(deep.id)).thread.state === 'ready', 'the session typed as build');
  const s = await until(async () => { const x = (await state()).queue; return x.order.includes(deep.id) && x.order.includes(card.id) && !x.ranking ? x : null; }, 'all in the queue');
  const lastDeep = Math.max(...s.deep.map((id) => s.order.indexOf(id)));
  const firstSmall = Math.min(...s.order.filter((id) => !s.deep.includes(id)).map((id) => s.order.indexOf(id)));
  assert.ok(lastDeep < firstSmall, 'every deep thread before every small one');
  assert.ok(s.order.indexOf(deep.id) < s.order.indexOf(small.id), 'the new session before the older quick question');
  assert.ok(s.deep.includes(deep.id) && !s.deep.includes(card.id) && !s.deep.includes(small.id));
  assert.ok(s.order.indexOf(card.id) > s.order.indexOf(deep.id));
});
