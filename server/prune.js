// "Prune brain" without Florian there: a pass that runs at night, started by a timer.
//
// Florian, 16-11-2026: "make sure that you regularly save improvements so that its not
// 100% purge happened or 0% purge happened", and it must not stop at once over a
// permission or a usage limit, as an earlier attempt did. So:
//
//   checks first   before it touches anything: Claude answers and is signed in, a push to
//                  GitHub works, files in the vault can be written and deleted, both by
//                  the app and by Claude through the same permissions the run uses. A
//                  check that fails stops the run before it starts and says which.
//   in parts       the vault is cut into parts (People in groups, Organizations, Projects
//                  and Areas, Learnings, then the indexes). Each part is one Claude run,
//                  ends in its own commit and push, and holds the brain's writer lock
//                  only while it runs, so a brain update can go in between.
//   limits         "You've hit your 5-hour limit · resets 8:50pm": wait until then and
//                  carry on with the same part, until the deadline (07:00 by default).
//                  Any other failure: the part's half-done edits are thrown away, it is
//                  tried once more, then skipped, and the run goes on.
//   restarts       the progress is a file on this computer (prune-run.json, never synced),
//                  so an app restart, an update or a crash picks up at the part it was on.
//   the morning    one thread: what went in, what failed, and the questions the prune
//                  would have asked him (stale records, action-file lines), in one batch.
//
// Everything outside (Claude, the brain clone, threads, the clock) comes in as `deps`,
// so the tests run it against stand-ins.

import fs from 'node:fs';
import path from 'node:path';

export const PART_SIZE = 25;

// Where the reset time is in a limit message, e.g. "resets 8:50pm (Europe/Berlin)".
export const isLimitError = (text) => /hit your .*limit|usage limit|rate limit|limit reached|overloaded|quota/i.test(String(text || ''));
export const isAuthError = (text) => /not signed in|not logged in|\/login|api key|authenticat|unauthori[sz]ed|oauth|credential/i.test(String(text || ''));

// When the limit lifts, as a timestamp, or 0 when the message does not say. Times are the
// computer's own clock (the Pi runs on Europe/Berlin, like the message).
export function resetTime(text, now = Date.now()) {
  const m = /resets\s+(?:at\s+)?(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text || ''));
  if (!m) return 0;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ampm = (m[3] || '').toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return 0;
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// The next 07:00 after `now` (or the hour given).
export function deadlineAfter(now = Date.now(), hour = 7) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function listMd(root, rel) {
  const out = [];
  const visit = (r) => {
    const full = path.join(root, r);
    if (!fs.existsSync(full)) return;
    for (const e of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${r}/${e.name}`;
      if (e.isDirectory()) visit(child);
      else if (e.name.toLowerCase().endsWith('.md')) out.push(child);
    }
  };
  visit(rel);
  return out;
}

const INDEX = /Index\.md$/;
const ACTION_FILES = ['Brain/Calendar.md', 'Brain/Next Actions.md', 'Brain/Waiting For.md', 'Brain/Someday.md'];

// The parts, from what is in the vault right now. Fixed when the run starts.
export function planParts(vaultDir, size = PART_SIZE) {
  const parts = [];
  const chunked = (label, files) => {
    const n = Math.max(1, Math.ceil(files.length / size));
    const per = Math.ceil(files.length / n);
    for (let i = 0; i < n; i += 1) {
      const chunk = files.slice(i * per, (i + 1) * per);
      if (!chunk.length) continue;
      parts.push({ label: n > 1 ? `${label} ${i + 1}/${n}` : label, files: chunk });
    }
  };
  const notIndex = (files) => files.filter((f) => !INDEX.test(f));
  chunked('People', notIndex(listMd(vaultDir, 'Brain/People')));
  chunked('Organizations', notIndex(listMd(vaultDir, 'Brain/Organizations')));
  chunked('Projects and Areas', notIndex([...listMd(vaultDir, 'Brain/Projects'), ...listMd(vaultDir, 'Brain/Areas')]));
  chunked('Learnings', notIndex(listMd(vaultDir, 'Brain/Learnings')));
  const known = new Set(parts.flatMap((p) => p.files));
  const rest = listMd(vaultDir, 'Brain').filter((f) => !known.has(f) && !INDEX.test(f) && !ACTION_FILES.includes(f) && !f.startsWith('Brain/Horizons/'));
  const indexes = listMd(vaultDir, 'Brain').filter((f) => INDEX.test(f));
  parts.push({
    label: 'Indexes, Horizons and the rest',
    files: [...indexes, ...listMd(vaultDir, 'Brain/Horizons').filter((f) => !INDEX.test(f)), ...rest],
    extra: [
      'This is the last part. Earlier parts deleted and moved notes; bring every index in line with what is in the vault now (every entry points to a file that exists, every note has its entry), without restructuring any of them.',
      `Also read the four action files (${ACTION_FILES.map((f) => `\`${f}\``).join(', ')}) against the rest of the Brain: a line that is plainly done, overtaken or past its date goes under Questions. Do not change them.`,
    ].join('\n\n'),
  });
  return parts.map((p, i) => ({ key: `p${i + 1}`, ...p, status: 'pending', attempts: 0, commit: '', pushed: false, written: '', questions: '', error: '' }));
}

// The final message of one part.
export function parsePartReport(text) {
  const raw = String(text || '').replace(/^```[a-z]*\s*$/gm, '').trim();
  const status = (raw.match(/^STATUS:\s*(\w+)/m)?.[1] || '').toLowerCase();
  const sections = {};
  let name = 'written';
  for (const line of raw.replace(/^STATUS:.*$/m, '').split('\n')) {
    const head = /^## (Written|Questions)\s*$/i.exec(line);
    if (head) { name = head[1].toLowerCase(); continue; }
    sections[name] = `${sections[name] || ''}${line}\n`;
  }
  return { status, written: (sections.written || '').trim(), questions: (sections.questions || '').trim() };
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

// The morning thread.
export function reportText(run) {
  const done = run.parts.filter((p) => p.status === 'done');
  const lines = [];
  const head = run.stopped
    ? `The prune stopped: ${run.stopped}`
    : done.length === run.parts.length
      ? `The prune went through: all ${run.parts.length} parts are on GitHub.`
      : `The prune saved ${done.length} of ${run.parts.length} parts to GitHub.`;
  lines.push(head, '');
  lines.push('| Part | Result |', '|---|---|');
  for (const p of run.parts) {
    const result = {
      done: p.commit ? `saved (${p.commit}${p.pushed ? '' : ', push still pending'})` : 'nothing to change',
      failed: `failed: ${p.error}`,
      pending: 'not reached',
      running: 'cut off',
    }[p.status] || p.status;
    lines.push(`| ${p.label} | ${String(result).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300)} |`);
  }
  if (run.waits?.length) lines.push('', `Waited for the usage limit ${run.waits.length}× (${run.waits.map((w) => `${fmtTime(w.from)}–${fmtTime(w.until)}`).join(', ')}).`);
  const written = run.parts.filter((p) => p.written).map((p) => `**${p.label}**\n${p.written}`);
  if (written.length) lines.push('', '## What went in', '', written.join('\n\n'));
  const questions = run.parts.filter((p) => p.questions).map((p) => p.questions);
  if (questions.length) {
    lines.push('', '## Questions', '', 'Nothing below has been changed. Answer in a few words each; the next brain update files your answers.', '', questions.join('\n\n'));
  }
  const left = run.parts.filter((p) => p.status !== 'done');
  if (left.length && !run.stopped) lines.push('', `${left.length === 1 ? 'The part' : `The ${left.length} parts`} that did not go through can run another night; nothing of them was changed.`);
  return lines.join('\n');
}

export function createPruner(deps) {
  const {
    stateFile, vaultDir, runAgent, withWriter, pullForWriting, commitAndPush, discardChanges,
    checkPush, checkPolicy, createReport, log = () => {}, today = () => '', dateDMY = () => '',
    readPrompt, model = () => undefined, effort = () => undefined,
    now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    partTimeoutMs = 50 * 60_000, retryMs = 3 * 60_000, writerWaitMs = 5 * 60_000, limitFallbackMs = 30 * 60_000,
  } = deps;

  let run = null;
  let active = false; // a loop is going in this process
  let partRunning = false;

  const save = () => { if (run) fs.writeFileSync(stateFile, JSON.stringify(run, null, 2)); };
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };

  const status = () => ({
    running: active,
    partRunning,
    run: run && { id: run.id, startedAt: run.startedAt, deadline: run.deadline, waitingUntil: run.waitingUntil || 0, finished: run.finished || 0, stopped: run.stopped || '', parts: run.parts.map((p) => ({ label: p.label, status: p.status, commit: p.commit })) },
  });

  // Waits out a usage limit. Returns false when the wait would end after the deadline.
  async function waitForLimit(message) {
    const until = (resetTime(message, now()) || now() + limitFallbackMs) + 3 * 60_000;
    if (until >= run.deadline) return false;
    run.waitingUntil = until;
    run.waits = [...(run.waits || []), { from: now(), until }];
    save();
    log(`prune: usage limit, waiting until ${new Date(until).toISOString()}`);
    await sleep(until - now());
    run.waitingUntil = 0;
    save();
    return true;
  }

  // The brain's writer lock: a brain update may hold it. Wait for it, up to the deadline.
  async function asWriter(fn) {
    for (;;) {
      try {
        return await withWriter('prune', fn);
      } catch (err) {
        if (!/already writing/.test(err.message) || now() + writerWaitMs >= run.deadline) throw err;
        log(`prune: ${err.message}; waiting`);
        await sleep(writerWaitMs);
      }
    }
  }

  // Checks before anything is touched. Returns '' or what failed; 'limit:<message>'
  // for a usage limit, which is waited out rather than reported.
  async function preflight() {
    return asWriter(async () => {
      try { await pullForWriting(); } catch (err) { return `the vault could not be brought up to GitHub's state (${err.message}).`; }
      try { await checkPush(); } catch (err) { return `a push to GitHub does not go through (${err.message}).`; }
      const probe = path.join(vaultDir, 'Brain', '.prune-check.md');
      try {
        fs.writeFileSync(probe, 'check\n');
        fs.rmSync(probe);
      } catch (err) { return `the app cannot write and delete files in the vault (${err.message}).`; }
      const policy = await checkPolicy();
      if (policy) return `the permissions refuse what the prune needs: ${policy}`;
      // The real thing: Claude, through the permissions the run uses, writes a file and
      // deletes it. This is where an earlier run stopped at once.
      const r = await runAgent({
        prompt: 'This is a check before a night run. Do exactly this, nothing else: 1. Use the Write tool to create `Brain/.prune-check.md` containing the word check. 2. Delete it with the Bash tool: rm "Brain/.prune-check.md". 3. Reply with the single line CHECK-OK. If any tool is refused, reply with CHECK-FAILED and the refusal text.',
        cwd: vaultDir,
        systemAppend: 'You are running a short check for Florian\'s inbox app. Nobody is watching.',
        model: 'haiku',
        mode: 'extract',
        artifactsDir: null,
        readDirs: [],
        protectedPaths: deps.protectedPaths || [],
        title: `Prune check ${dateDMY()}`,
      });
      const left = fs.existsSync(probe);
      await discardChanges();
      if (r.error) {
        if (isLimitError(r.error)) return `limit:${r.error}`;
        if (isAuthError(r.error)) return `Claude is not signed in on the Pi (${r.error}).`;
        return `Claude did not answer the check (${r.error}).`;
      }
      const said = String(r.finalText || r.text || '');
      if (!/CHECK-OK/.test(said) || left) return `Claude could not write and delete a file in the vault: ${said.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no answer'}.`;
      return '';
    });
  }

  // One part. Returns 'done', 'limit:<message>', or throws.
  async function runPart(part, index) {
    return asWriter(async () => {
      await pullForWriting();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), partTimeoutMs);
      timer.unref?.();
      let r;
      partRunning = true;
      try {
        r = await runAgent({
          prompt: readPrompt('prune.md', {
            today: today(),
            part: String(index + 1),
            parts: String(run.parts.length),
            label: part.label,
            files: part.files.map((f) => `- \`${f}\``).join('\n'),
            extra: part.extra || '',
          }),
          cwd: vaultDir,
          systemAppend: 'You are running inside Florian\'s inbox app, pruning his brain vault at night. The run\'s instructions are in the user message.',
          model: model(),
          effort: effort(),
          mode: 'extract',
          artifactsDir: null,
          readDirs: [],
          protectedPaths: deps.protectedPaths || [],
          title: `Prune ${dateDMY()}: ${part.label}`,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        partRunning = false;
      }
      if (r.aborted) { await discardChanges(); throw new Error(`it took longer than ${Math.round(partTimeoutMs / 60_000)} minutes`); }
      if (r.error) {
        await discardChanges();
        if (isLimitError(r.error)) return `limit:${r.error}`;
        throw new Error(r.error);
      }
      const rep = parsePartReport(r.finalText || r.text);
      const committed = await commitAndPush({
        subject: `prune: ${dateDMY()}, part ${index + 1} of ${run.parts.length} (${part.label})`,
        body: `Co-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: app-ai prune ${run.id}`,
      });
      part.written = rep.written;
      part.questions = rep.questions;
      part.commit = committed?.commit || '';
      part.pushed = committed ? committed.pushed : true;
      if (committed && !committed.pushed) log(`prune: part ${index + 1} committed, push failed (${committed.pushError}); the app pushes it later`);
      return 'done';
    });
  }

  async function loop() {
    if (active) return;
    active = true;
    try {
      if (!run.checked) {
        for (;;) {
          const failed = await preflight().catch((err) => `the checks themselves failed (${err.message}).`);
          if (failed.startsWith('limit:')) {
            if (await waitForLimit(failed.slice(6))) continue;
            run.stopped = `Claude's usage limit does not lift before ${fmtTime(run.deadline)}. Nothing was changed.`;
            break;
          }
          if (failed) { run.stopped = `${failed} Nothing was changed.`; break; }
          run.checked = now();
          save();
          log('prune: checks passed');
          break;
        }
      }

      for (let i = 0; i < run.parts.length && !run.stopped; i += 1) {
        const part = run.parts[i];
        if (part.status === 'done' || part.status === 'failed') continue;
        if (now() >= run.deadline) { log(`prune: it is past ${fmtTime(run.deadline)}; stopping before "${part.label}"`); break; }
        part.status = 'running';
        save();
        let outcome;
        try {
          outcome = await runPart(part, i);
        } catch (err) {
          part.attempts += 1;
          part.error = String(err.message || err).replace(/\s+/g, ' ').slice(0, 300);
          log(`prune: part ${i + 1} (${part.label}) failed, attempt ${part.attempts}: ${part.error}`);
          if (part.attempts < 2 && now() + retryMs < run.deadline) {
            part.status = 'pending';
            save();
            await sleep(retryMs);
            i -= 1;
          } else {
            part.status = 'failed';
            save();
          }
          continue;
        }
        if (outcome.startsWith('limit:')) {
          part.status = 'pending';
          save();
          if (await waitForLimit(outcome.slice(6))) { i -= 1; continue; }
          log('prune: the usage limit lasts past the deadline; stopping');
          break;
        }
        part.status = 'done';
        part.error = '';
        save();
        log(`prune: part ${i + 1} of ${run.parts.length} (${part.label}) done${part.commit ? `, ${part.commit}` : ', nothing changed'}`);
      }

      for (const p of run.parts) if (p.status === 'running') p.status = 'pending';
      run.finished = now();
      run.reportThread = createReport({
        title: `Prune ${dateDMY(run.startedAt)}: ${run.stopped ? 'did not run' : 'report and questions'}`,
        text: reportText(run),
      });
      save();
      log(`prune: finished, ${run.parts.filter((p) => p.status === 'done').length} of ${run.parts.length} parts saved`);
    } catch (err) {
      log(`prune: ${err.stack || err.message}`);
    } finally {
      active = false;
    }
  }

  return {
    status,
    // Starts a pass. `deadline`: no part starts after it (default: the next 07:00).
    // `only`: run just these parts of the last run again ("prune the rest").
    start({ deadline } = {}) {
      if (active) return { started: false, reason: 'A prune is already running.' };
      const prior = load();
      if (prior && !prior.finished && now() < prior.deadline) {
        run = prior;
        loop();
        return { started: true, resumed: true };
      }
      const parts = planParts(vaultDir);
      run = { id: new Date(now()).toISOString().replace(/[:.]/g, '-'), startedAt: now(), deadline: Number(deadline) || deadlineAfter(now()), checked: 0, parts, waits: [] };
      save();
      log(`prune: starting, ${parts.length} parts, deadline ${new Date(run.deadline).toISOString()}`);
      loop();
      return { started: true, parts: parts.map((p) => p.label) };
    },
    // On startup: a pass that was cut off (a restart, an update) carries on.
    resume() {
      const prior = load();
      if (!prior || prior.finished || active) return false;
      run = prior;
      if (now() >= run.deadline) {
        // Too late to go on: still give him the morning report.
        for (const p of run.parts) if (p.status === 'running') p.status = 'pending';
        run.finished = now();
        run.reportThread = createReport({ title: `Prune ${dateDMY(run.startedAt)}: report and questions`, text: reportText(run) });
        save();
        return false;
      }
      log('prune: carrying on with the pass that was cut off');
      loop();
      return true;
    },
    // Resolves when the current loop has ended (tests).
    async idle() { while (active) await sleep(20); },
  };
}
