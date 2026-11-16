// The night prune: checks first, one commit per part, usage limits waited out, a failed
// part skipped, a restart picked up where it stopped. Claude, git and the clock are
// stand-ins; the vault is a throwaway folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPruner, deadlineAfter, parsePartReport, planParts, resetTime } from '../server/prune.js';
import { cleanup } from './helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ai-prune-'));
test.after(() => cleanup(dir));

function makeVault(name) {
  const v = path.join(dir, name);
  const put = (f, t = 'x\n') => { fs.mkdirSync(path.dirname(path.join(v, f)), { recursive: true }); fs.writeFileSync(path.join(v, f), t); };
  for (let i = 0; i < 30; i += 1) put(`Brain/People/${String.fromCharCode(65 + (i % 26))}${i} Person.md`);
  put('Brain/People/People Index.md');
  put('Brain/Organizations/KStW.md');
  put('Brain/Projects/Mensa.md');
  put('Brain/Areas/KStW.md');
  put('Brain/Learnings/GTD.md');
  put('Brain/Horizons/50,000 ft Life.md');
  put('Brain/Horizons/Horizons Index.md');
  put('Brain/Next Actions.md');
  put('Brain/Stammdaten.md');
  return v;
}

test('the reset time is read from the limit message', () => {
  const now = new Date(2026, 10, 17, 2, 10).getTime();
  const at = new Date(resetTime("You've hit your 5-hour limit · resets 3:40am (Europe/Berlin)", now));
  assert.equal(at.getHours(), 3);
  assert.equal(at.getMinutes(), 40);
  assert.equal(at.getDate(), 17);
  const pm = new Date(resetTime('resets 8:50pm', now));
  assert.equal(pm.getHours(), 20);
  // A time already past today means tomorrow.
  const late = new Date(resetTime('resets 1am', now));
  assert.equal(late.getDate(), 18);
  assert.equal(resetTime('Service overloaded', now), 0);
  assert.equal(new Date(deadlineAfter(new Date(2026, 10, 17, 2, 0).getTime())).getHours(), 7);
});

test('the vault is cut into parts, the indexes and Horizons last', () => {
  const parts = planParts(makeVault('plan'));
  assert.equal(parts.length, 6);
  assert.match(parts[0].label, /^People [12]\/2$/);
  assert.match(parts[1].label, /^People [12]\/2$/);
  assert.deepEqual(parts.slice(2).map((p) => p.label), ['Organizations', 'Projects and Areas', 'Learnings', 'Indexes, Horizons and the rest']);
  assert.equal(parts.filter((p) => p.label.startsWith('People')).reduce((n, p) => n + p.files.length, 0), 30);
  const last = parts[parts.length - 1];
  assert.ok(last.files.includes('Brain/People/People Index.md'));
  assert.ok(last.files.includes('Brain/Horizons/50,000 ft Life.md'));
  assert.ok(last.files.includes('Brain/Stammdaten.md'));
  assert.ok(!parts.some((p) => p.files.includes('Brain/Next Actions.md')), 'the action files are never a part to prune');
  assert.ok(!parts.slice(0, -1).some((p) => p.files.some((f) => f.endsWith('Index.md'))));
});

test('the final message of a part is read', () => {
  const r = parsePartReport('STATUS: questions\n\n## Written\n- Brain/People/A.md — deleted\n\n## Questions\n**Carla**\n1. Still right?');
  assert.equal(r.status, 'questions');
  assert.match(r.written, /deleted/);
  assert.match(r.questions, /Carla/);
});

function harness(vault, { agent, preflightReply = 'CHECK-OK', start = new Date(2026, 10, 17, 2, 0).getTime() } = {}) {
  let clock = start;
  const commits = [];
  const reports = [];
  const calls = [];
  let discarded = 0;
  const pruner = createPruner({
    stateFile: path.join(vault, '..', `${path.basename(vault)}-run.json`),
    vaultDir: vault,
    now: () => clock,
    sleep: async (ms) => { clock += Math.max(0, ms); },
    runAgent: async (p) => {
      calls.push(p);
      if (p.model === 'haiku') return { text: preflightReply, finalText: preflightReply, error: '' };
      return agent(p, () => clock);
    },
    withWriter: async (name, fn) => fn(),
    pullForWriting: async () => {},
    commitAndPush: async ({ subject }) => { commits.push(subject); return { commit: `c${commits.length}`, pushed: true }; },
    discardChanges: async () => { discarded += 1; },
    checkPush: async () => {},
    checkPolicy: async () => '',
    createReport: (r) => { reports.push(r); return 'thread1'; },
    readPrompt: (name, v) => `${v.label}\n${v.files}`,
    dateDMY: () => '17-11-2026',
  });
  return { pruner, commits, reports, calls, discarded: () => discarded, clock: () => clock };
}

const label = (p) => p.prompt.split('\n')[0];

test('a limit is waited out, a failing part is skipped, the rest is saved part by part', async () => {
  const vault = makeVault('run');
  let limited = false;
  const h = harness(vault, {
    agent: async (p, now) => {
      if (label(p) === 'Organizations' && !limited) { limited = true; return { error: "You've hit your 5-hour limit · resets 3:00am (Europe/Berlin)" }; }
      if (label(p) === 'Learnings') return { error: 'something broke' };
      return { finalText: `STATUS: questions\n\n## Written\n- ${label(p)} done at ${new Date(now()).getHours()}\n\n## Questions\n**${label(p)}**\n1. Still right?` };
    },
  });
  h.pruner.start();
  await h.pruner.idle();
  const parts = h.calls.filter((c) => c.model !== 'haiku').map(label);
  assert.equal(parts.filter((l) => l === 'Organizations').length, 2, 'the limited part runs again after the wait');
  assert.equal(parts.filter((l) => l === 'Learnings').length, 2, 'a failing part is tried twice');
  assert.equal(h.commits.length, 5, 'one commit per part that went through');
  assert.ok(h.commits.every((s) => /^prune: 17-11-2026, part \d of 6 \(/.test(s)));
  assert.ok(h.clock() >= new Date(2026, 10, 17, 3, 0).getTime(), 'it waited for the reset');
  assert.equal(h.reports.length, 1);
  const text = h.reports[0].text;
  assert.match(h.reports[0].title, /report and questions/);
  assert.match(text, /saved 5 of 6 parts/);
  assert.match(text, /\| Learnings \| failed: something broke \|/);
  assert.match(text, /Waited for the usage limit 1×/);
  assert.match(text, /## Questions/);
  assert.ok(h.discarded() >= 3, 'half-done edits of a failed or limited part are thrown away');
});

test('a failed check stops the run before anything is touched', async () => {
  const vault = makeVault('check');
  const h = harness(vault, { preflightReply: 'CHECK-FAILED Bash is refused', agent: async () => { throw new Error('must not run'); } });
  h.pruner.start();
  await h.pruner.idle();
  assert.equal(h.commits.length, 0);
  assert.match(h.reports[0].title, /did not run/);
  assert.match(h.reports[0].text, /could not write and delete a file in the vault: CHECK-FAILED Bash is refused/);
});

test('a limit that lasts past the deadline ends the run with a report of what was saved', async () => {
  const vault = makeVault('deadline');
  const h = harness(vault, {
    agent: async (p) => (label(p) === 'Organizations' ? { error: "You've hit your weekly limit · resets 10am" } : { finalText: 'STATUS: pruned\n\n## Written\n- x' }),
  });
  h.pruner.start();
  await h.pruner.idle();
  assert.equal(h.commits.length, 2, 'the two People parts are saved');
  assert.match(h.reports[0].text, /saved 2 of 6 parts/);
  assert.match(h.reports[0].text, /\| Organizations \| not reached \|/);
});

test('after a restart the pass carries on at the part it was on', async () => {
  const vault = makeVault('resume');
  const first = harness(vault, { agent: async () => ({ finalText: 'STATUS: nothing' }) });
  // Write a cut-off run: checks passed, the first part done, the second was running.
  const parts = planParts(vault);
  parts[0].status = 'done';
  parts[0].commit = 'c0';
  parts[1].status = 'running';
  const start = new Date(2026, 10, 17, 2, 0).getTime();
  fs.writeFileSync(path.join(dir, 'resume-run.json'), JSON.stringify({ id: 'x', startedAt: start, deadline: deadlineAfter(start), checked: start, parts, waits: [] }));
  assert.equal(first.pruner.resume(), true);
  await first.pruner.idle();
  const ran = first.calls.map(label);
  assert.ok(!ran.includes(parts[0].label), 'a part already saved is not run again');
  assert.equal(ran[0], parts[1].label);
  assert.equal(first.calls.filter((c) => c.model === 'haiku').length, 0, 'the checks are not run twice');
  assert.equal(first.reports.length, 1);
  assert.equal(first.pruner.resume(), false, 'a finished pass is not resumed');
});
