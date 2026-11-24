// The daily report: which day a moment belongs to, when a report is due, what counts as
// Florian's doing, which lines survive, and the report over the app's API.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkItems, dayOf, dayWindow, dueDay, eveningOf, isDay, ofThread, parseAnswer, shiftDay } from '../server/days.js';
import { cleanup, freePort, until } from './helpers.mjs';

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('a day runs from 04:00 to 04:00', () => {
  assert.equal(dayOf(at(24, 3, 59)), '2026-11-23');
  assert.equal(dayOf(at(24, 4)), '2026-11-24');
  assert.deepEqual(dayWindow('2026-11-23'), { from: at(23, 4), to: at(24, 4) });
  assert.equal(shiftDay('2026-12-01', -1), '2026-11-30');
  assert.equal(isDay('2026-11-23'), true);
  for (const no of ['2026-13-01', '2026-02-30', '../x', '', undefined]) assert.equal(isDay(no), false);
  assert.equal(eveningOf('2026-11-23', '21:00'), at(23, 21));
  assert.equal(eveningOf('2026-11-23', '00:30'), at(24, 0, 30), 'past midnight still belongs to the day');
  assert.equal(eveningOf('2026-11-23', 'never'), 0);
});

test('when a report is due', () => {
  const due = (now, made = {}, active = () => true) => dueDay({ now, at: '21:00', madeAt: (d) => made[d] || 0, active });
  const y = { '2026-11-22': at(23, 5) }; // yesterday is through
  assert.equal(due(at(23, 20), y), '', 'not before the evening');
  assert.equal(due(at(23, 21), y), '2026-11-23');
  assert.equal(due(at(23, 22), { ...y, '2026-11-23': at(23, 20) }), '2026-11-23', 'one he asked for earlier does not replace the evening one');
  assert.equal(due(at(23, 22), { ...y, '2026-11-23': at(23, 21, 1) }), '');
  assert.equal(due(at(23, 22), y, () => false), '', 'a day without anything gets none');
  // The day is over: again, if something came after the evening report.
  const late = (from) => (w) => w.from <= from && from < w.to;
  assert.equal(due(at(24, 5), { '2026-11-23': at(23, 21) }, late(at(24, 0, 25))), '2026-11-23');
  assert.equal(due(at(24, 5), { '2026-11-23': at(23, 21) }, late(at(23, 20))), '', 'nothing new since');
  assert.equal(due(at(24, 5), {}, late(at(23, 20))), '2026-11-23', 'the evening one was missed (the laptop slept)');
  assert.equal(due(at(24, 5), { '2026-11-23': at(24, 4, 30) }), '');
});

test('what counts as his doing in a thread', () => {
  const win = dayWindow('2026-11-23');
  const u = (ts, text, more = {}) => ({ role: 'user', ts, text, ...more });
  const o = ofThread({ spunFrom: 'x', spunAt: 1, notes: { text: ' talked to Anna ', ts: at(23, 12) } }, [
    u(at(23, 9), 'copied from the thread this was spun off from'),
    u(at(22, 9), 'the day before'),
    u(at(23, 10), 'he called me'),
    u(at(23, 10), 'a brief of the app', { auto: true }),
    u(at(23, 11), '[Florian sent the mail "A.md" (version 1) from the app.]', { event: true }),
    u(at(23, 11), '[The app ran the tests, they passed, and it merged the branch claude/x into main of fburgerdev/app and pushed it, on 23-11-2026 11:00.]', { event: true }),
    u(at(23, 11), '[The app could not merge this branch into main by itself.]', { event: true }),
    { role: 'assistant', ts: at(23, 12), parts: [{ type: 'text', text: 'working' }, { type: 'tool', name: 'Read' }, { type: 'text', text: 'the end' }] },
    u(at(24, 5), 'the next day'),
  ], win);
  assert.deepEqual(o.said.map((m) => m.text), ['he called me']);
  assert.equal(o.did.length, 1);
  assert.deepEqual(o.merges.map((m) => m.repo), ['fburgerdev/app']);
  assert.equal(o.answer, 'the end');
  assert.equal(o.notes.text, 'talked to Anna');
});

test('only lines that rest on something recorded, in the order of the levels', () => {
  const evidence = new Map([
    ['M1', { kind: 'said', ref: { kind: 'thread', id: 'a', title: 'A' } }],
    ['S1', { kind: 'did', ref: { kind: 'mail', href: 'h', title: 'B' } }],
    ['G1', { kind: 'merge', ref: { kind: 'thread', id: 'a', title: 'A' } }],
    ['R1', { kind: 'work', ref: null }],
  ]);
  const items = checkItems([
    { level: 'thought', text: 'decided', refs: ['M1'] },
    { level: 'result', text: 'a merge', refs: ['G1', 'R1'] },
    { level: 'result', text: 'made up', refs: ['M9'] },
    { level: 'result', text: 'no source' },
    { level: 'result', area: '[[KStW]]', text: 'she agreed', refs: ['[M1]', 'G1', 'S1'] },
    { level: 'grand', text: 'unknown level', refs: ['M1'] },
    { level: 'out', text: '', refs: ['S1'] },
  ], evidence);
  assert.deepEqual(items.map((i) => [i.level, i.text]), [['result', 'she agreed'], ['made', 'a merge'], ['made', 'unknown level'], ['thought', 'decided']]);
  assert.equal(items[0].area, 'KStW');
  assert.deepEqual(items[0].sources.map((s) => s.kind), ['thread', 'mail'], 'each source once');
  assert.equal(parseAnswer('here: {"headline":"x","items":[]} done').headline, 'x');
  assert.equal(parseAnswer('no report'), null);
  assert.equal(parseAnswer('{"headline": "x"}'), null);
});

// ---------- over the API ----------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-days-'));
const vault = path.join(dir, 'vault.git');
const data = path.join(dir, 'data');
const port = await freePort();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
git(dir, 'init', '--bare', '-b', 'main', vault);
const seed = path.join(dir, 'seed');
git(dir, 'clone', vault, seed);
for (const d of ['Core/Projects', 'Core/Areas', 'Claude']) fs.mkdirSync(path.join(seed, d), { recursive: true });
fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# vault\n');
fs.writeFileSync(path.join(seed, 'Claude', 'Instructions.md'), '# Instructions\n');
fs.writeFileSync(path.join(seed, 'Core', 'Areas', 'Campaign.md'), '# Campaign\n');
fs.writeFileSync(path.join(seed, 'Core', 'Projects', 'Mensa Tracker.md'), '# Mensa Tracker\n\nStatus: active\n');
fs.writeFileSync(path.join(seed, 'Core', 'Projects', 'Projects Index.md'), '# Projects Index\n\n## [[Campaign]]\n\n- [[Mensa Tracker]] — the website\n');
git(seed, 'checkout', '-B', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, brainRepo: vault, dataRepo: '', cards: { auto: false }, report: { auto: false } }));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, APP_AI_FAKE: '1', APP_AI_FAKE_SPEED: '0.05', APP_AI_DATA: data }, stdio: ['ignore', fs.openSync(path.join(dir, 'log'), 'w'), 'inherit'] });
test.after(() => cleanup(dir, [server]));
const call = async (method, url, body) => {
  const res = await fetch(`http://localhost:${port}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('a report is written on request, shows where it comes from, and takes in what he adds', async () => {
  await until(async () => (await call('GET', '/api/state')).data.brain.brain.ready, 'brain cloned', 40000);
  const { today, days } = (await call('GET', '/api/reports')).data;
  assert.equal(days.length, 14);
  assert.equal(days[0].day, today);
  assert.equal((await call('GET', `/api/reports/${today}`)).data.report, null);

  const t = (await call('POST', '/api/threads', { text: 'Anna called and agreed', project: 'Mensa Tracker' })).data.thread;
  await until(async () => (await call('GET', `/api/threads/${t.id}`)).data.thread.state === 'ready', 'answered');
  assert.equal((await call('POST', `/api/reports/${today}/make`, {})).status, 200);
  const report = await until(async () => (await call('GET', `/api/reports/${today}`)).data.report, 'written');
  assert.equal(report.headline, 'Stand-in headline of the day.');
  assert.deepEqual(report.items.map((i) => [i.level, i.text]), [['result', 'Stand-in line for M1']], 'the made-up line is gone');
  assert.deepEqual(report.items[0].sources.map((s) => s.id), [t.id]);
  assert.deepEqual(report.split, [{ area: 'Campaign', n: 1 }], 'a project counts for its area');

  assert.equal((await call('POST', `/api/reports/${today}/add`, { text: '  ' })).status, 400);
  assert.equal((await call('POST', `/api/reports/${today}/add`, { text: 'Met Ben at the market' })).status, 200);
  const more = await until(async () => { const r = (await call('GET', `/api/reports/${today}`)).data.report; return r.items.some((i) => /A1/.test(i.text)) ? r : null; }, 'written again with his line');
  assert.deepEqual(more.added.map((a) => a.text), ['Met Ben at the market']);
  assert.match((await call('GET', '/api/pads/notes')).data.text, /^What I did on \d\d-\d\d-\d{4} .*: Met Ben at the market$/m, 'the next brain update files it');
});

test('an empty day, and days that are not', async () => {
  const { today } = (await call('GET', '/api/reports')).data;
  const before = shiftDay(today, -3);
  await call('POST', `/api/reports/${before}/make`, {});
  const r = await until(async () => (await call('GET', `/api/reports/${before}`)).data.report, 'looked at');
  assert.deepEqual([r.items, r.headline], [[], '']);
  assert.equal((await call('POST', `/api/reports/${shiftDay(today, 1)}/make`, {})).status, 400, 'tomorrow');
  assert.equal((await call('GET', '/api/reports/nonsense')).status, 404);
});
