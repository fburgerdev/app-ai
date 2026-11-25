// The brain update: files what happened in the app into the brain vault.
//
// Think of every thread as having a water level: everything above it is in the brain.
// "Update brain" raises the level, in every thread at once, to where the thread stood at
// the moment of the press. Florian can keep working while the update runs; what he
// writes after pressing waits for the next update.
//
// The same press also covers, each with its own level:
//   - the mailbox: mail received and sent since the last update (when Gmail is connected)
//   - the "Notes for Claude" pad, which is emptied once filed
//   - the cards he accepted or declined
//
// "Update Gmail" is the mail part by itself: it takes in the mail since the mail level
// and raises only that level.
//
// It runs only when he asks, it is the only thing in the app that files facts into the
// vault, and only one can run at a time. It ends in one commit and a push. (A thread can
// change the vault's structure and rules, through the vault's repo like any other repo;
// the two never write at once, see runExtraction.)
//
// Each press opens a thread of its own (Florian, 23-11-2026: "maybe have the update brain
// button create a thread in the first place … it lets me interact with the brain update").
// The update runs as that thread's first answer: its steps show while it works, and it
// ends in one short sentence, its questions, and any problem. A clean run closes the
// thread by itself. What he answers there is filed by that thread's next turn, which
// writes the vault itself (runner.js, `filesItself`), and a failed run is run again or
// looked into from there too, instead of in a separate questions or repair thread.

import { limitLabel, resumeAt, clock } from './limits.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from './agent.js';
import * as brain from './brain.js';
import * as google from './google.js';
import * as repos from './repos.js';
import * as runner from './runner.js';
import * as store from './store.js';
import { EXTRACTIONS_DIR, log } from './config.js';
import { logToolRead } from './reads.js';
import { readCardLog } from './cards.js';
import { saveNow } from './datasync.js';
import { getState, readPad, setState, writePad } from './state.js';
import * as nextActions from './nextactions.js';
import { exportThreads } from './threadexport.js';
import { overLimit } from './notelimits.js';
import { refreshSecrets } from './secrets.js';
import * as gate from './gate.js';
import { block, dateDMY, dateTimeDMY, messageText, readPrompt, safeFileName, todayLine } from './util.js';

let config;
let current = null; // { id, startedAt, step, threads, threadId, parts }

export function initExtraction(cfg) {
  config = cfg;
  // "Retry" in an update's thread: Claude asks for the update to run again, in that thread.
  runner.onRerunBrain((threadId) => {
    const t = store.getThread(threadId);
    const out = startExtraction({ only: t?.brainOnly === 'mail' ? 'mail' : '', threadId });
    if (!out.started) store.appendMessage(threadId, { role: 'assistant', parts: [{ type: 'text', text: out.reason }] });
    return out;
  });
}

// The steps of the running update, shown in its thread like a turn's tool lines.
// Whether a brain update is running in this thread right now. Its thread says "working"
// without a turn of the runner's, so whoever looks for turns that are gone asks here too.
export const runsIn = (threadId) => Boolean(current?.threadId && current.threadId === threadId);
export const liveParts = (threadId) => (current?.threadId && current.threadId === threadId ? current.parts : null);

// A brain update the usage limit cut off starts again once the limit has lifted. The hold
// is in the app's state, which both computers share; `mayRun` says whether this one does
// the work right now.
let holdTimer = null;
export function watchHold(mayRun = () => true) {
  clearInterval(holdTimer);
  holdTimer = setInterval(() => {
    try {
      const held = getState().brainHeld;
      if (!held || current || Date.now() < held.until || !mayRun() || gate.isLocked()) return;
      setState({ brainHeld: null });
      const out = startExtraction({ only: held.only === 'mail' ? 'mail' : '', threadId: held.threadId || '' });
      log(`brain update: ${held.gate ? 'the lock is over' : `the ${limitLabel(held.type)} lifted`}, ${out.started ? 'running again' : `not run again (${out.reason})`}`);
    } catch (err) { log(`held brain update: ${err.stack || err.message}`); }
  }, config.limits?.checkMs || 20_000);
  holdTimer.unref?.();
}

function setStep(step, tool = '') {
  if (current) {
    current.step = step;
    const id = current.threadId;
    if (id && store.getThread(id)) {
      if (tool) {
        current.parts.push({ type: 'tool', name: tool, summary: step });
        store.events.emit('live', { threadId: id, op: 'parts', parts: current.parts });
      }
      store.updateThread(id, { activity: step, activityAt: Date.now() }, { quiet: true });
    }
  }
  store.events.emit('brain', extractionStatus());
}

// Threads with something Florian said or did that no brain update has seen yet.
// Cards are not conversations; their outcomes are filed from the card log.
// A deferred thread, or one woken from Next Actions, has something to file even with
// nothing new said: its line in Next Actions.md.
const needsFiling = (t) => store.isUnfiled(t) || (t.deferred && !t.archived) || (t.nextAction && !t.nextAction.removed);
const unfiledThreads = () => store.listThreads().filter((t) => t.kind !== 'card' && needsFiling(t));

// Closed threads with nothing left to file: entirely in the brain. A brain update
// archives them, so the Done list holds only what still has to go in.
const filedDone = () => store.listThreads().filter((t) => t.kind !== 'card' && t.state === 'done' && !t.archived && !needsFiling(t));
function archiveFiled() {
  const list = filedDone();
  for (const t of list) store.updateThread(t.id, { archived: true });
  if (list.length) log(`brain update: archived ${list.length} closed ${list.length === 1 ? 'thread' : 'threads'} already in the brain`);
  return list.length;
}

export function lastRuns(limit = 15) {
  if (!fs.existsSync(EXTRACTIONS_DIR)) return [];
  return fs
    .readdirSync(EXTRACTIONS_DIR)
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(EXTRACTIONS_DIR, id, 'run.json'), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function extractionStatus() {
  const state = getState();
  return {
    running: Boolean(current),
    mailOnly: Boolean(current?.mailOnly),
    step: current?.step || '',
    startedAt: current?.startedAt || 0,
    threadId: current?.threadId || '',
    waiting: unfiledThreads().length, // threads not yet in the brain
    clean: filedDone().length, // closed threads already in the brain, archived by the next update
    notes: Boolean((readPad('notes') || '').trim()),
    cards: readCardLog().filter((e) => e.ts > state.cardsLevel && e.type !== 'prep').length,
    mail: google.googleConnected(),
    mailLevel: state.mailLevel,
    held: state.brainHeld || null, // cut off by the usage limit; runs again by itself at held.until
    last: lastRuns(1)[0] || null,
    brain: brain.brainStatus(),
  };
}

// What Florian typed into the notes field during an event: his own words, filed like
// anything he said in the thread. New since the last update, or context only.
export function notesSection(thread) {
  const text = thread.notes?.text?.trim();
  if (!text) return [];
  const fresh = (thread.notes.ts || 0) > (thread.extractedAt || 0);
  return [
    `## Florian's notes during the entry (typed by him in the app's notes field, last changed ${dateTimeDMY(thread.notes.ts)}; ${fresh ? 'new since the last brain update: file them' : 'filed by a previous brain update; context only, do not file again'})`,
    '',
    'If he also sent these notes as a message in the conversation, they are the same notes: file them once.',
    '',
    text,
    '',
  ];
}

function speaker(m) {
  if (m.role !== 'user') return 'Claude';
  if (m.auto) return 'The app (automatic, not Florian)';
  // "Send and done": said for the record, Claude did not answer it.
  if (m.unanswered) return 'Florian (for the record; closed without an answer)';
  return 'Florian';
}

// Mail attachments Claude downloaded in a thread, copied next to the thread file so the
// update can file one into Files/ when Florian asked for it. One that is not on this
// computer (downloaded on the other one) is fetched again from Gmail.
export async function mailFileLines(thread, filesDir) {
  const lines = [];
  for (const f of thread.mailFiles || []) {
    const dest = path.join(filesDir, `mail - ${safeFileName(f.name, 120)}`);
    const said = `- "${f.name}", attached to the mail "${f.subject}" from ${f.from} (${f.date}), downloaded ${dateTimeDMY(f.at)}`;
    try {
      fs.mkdirSync(filesDir, { recursive: true });
      const src = store.mailFilePath(thread.id, f.name);
      if (src) fs.copyFileSync(src, dest);
      else if (google.googleConnected()) fs.writeFileSync(dest, (await google.gmailAttachment({ messageId: f.messageId, part: f.part })).data);
      else throw new Error('not on this computer, and Gmail is not connected');
      lines.push(`${said}: \`${dest}\``);
    } catch (err) {
      lines.push(`${said}: could not be fetched (${err.message})`);
    }
  }
  return lines;
}

async function writeThreads(dir, changed) {
  for (const [i, { thread, messages, count }] of changed.entries()) {
    const n = String(i + 1).padStart(2, '0');
    const filesDir = path.join(dir, `${n} files`);
    const artifactLines = [];
    for (const artifact of store.listArtifacts(thread.id)) {
      for (const version of artifact.versions) {
        const src = store.artifactPath(thread.id, artifact.name, version.v);
        if (!src) continue;
        fs.mkdirSync(filesDir, { recursive: true });
        const ext = path.extname(artifact.name);
        const base = safeFileName(artifact.name.slice(0, artifact.name.length - ext.length).replace(/\//g, ' - '));
        const dest = path.join(filesDir, `${base} (v${version.v})${ext}`);
        fs.copyFileSync(src, dest);
        const who = version.by === 'you' ? 'edited by Florian' : version.by === 'app' ? 'put in by the app, the mails as they are in Gmail' : 'written by Claude';
        const sent = artifact.mail?.sentVersion === version.v ? `, SENT by Florian ${dateTimeDMY(artifact.mail.sentAt)}` : '';
        artifactLines.push(`- "${artifact.name}" version ${version.v}, ${who}, ${dateTimeDMY(version.ts)}${sent}: \`${dest}\``);
      }
    }
    // What Florian attached is copied next to the thread file, so the update can read it.
    const attached = new Map();
    for (const m of messages.slice(0, count)) {
      for (const f of m.files || []) {
        const src = store.uploadPath(thread.id, f.name);
        if (!src) continue;
        fs.mkdirSync(filesDir, { recursive: true });
        const dest = path.join(filesDir, `attached - ${safeFileName(f.name, 120)}`);
        fs.copyFileSync(src, dest);
        attached.set(f.name, dest);
      }
    }
    const mailLines = await mailFileLines(thread, filesDir);
    const render = (m) => `### ${speaker(m)}, ${dateTimeDMY(m.ts)}\n\n${messageText(m) || '(no text)'}${m.files?.length ? `\n\n[He attached: ${m.files.map((f) => `"${f.name}"${attached.has(f.name) ? ` at \`${attached.get(f.name)}\`` : ''}`).join(', ')}]` : ''}`;
    const upTo = messages.slice(0, count);
    let earlier = upTo.slice(0, thread.extractedCount).map(render).join('\n\n');
    if (earlier.length > 40_000) earlier = `(the beginning is cut)\n\n${earlier.slice(-40_000)}`;
    const fresh = upTo.slice(thread.extractedCount).map(render).join('\n\n');
    const text = [
      `# Thread: ${thread.title}`,
      '',
      `Link to it: [[${brain.THREADS_FOLDER}/${thread.id}|${dateDMY(thread.createdAt)} ${thread.title.replace(/[[\]|]/g, '')}]]`,
      `Started: ${dateTimeDMY(thread.createdAt)}`,
      `Project or area: ${thread.project || 'none named'}`,
      `Closed by Florian: ${thread.state === 'done' ? 'yes' : 'no, still open'}`,
      ...(thread.nextAction && !thread.nextAction.removed ? [`Woken from Next Actions: Florian started this thread from the line "${thread.nextAction.text}" under "${thread.nextAction.project || 'no project'}" in \`${brain.corePath('Next Actions.md')}\`. Remove that line from the file.`] : []),
      ...(thread.deferred ? [`Deferred by Florian, ${dateTimeDMY(thread.deferredAt)}: he put this thread to sleep. File what it produced, then write its to-do as one line into \`${brain.corePath('Next Actions.md')}\` (see "Next actions" in your instructions). The app deletes the thread afterwards.`] : []),
      ...(thread.spunFrom ? [`Spin-off: Florian spun this thread off from the thread "${thread.spunTitle}". Its first ${thread.spunAt} messages are a copy of that thread and are filed from there.`] : []),
      '',
      '## Files Claude made in this thread',
      '',
      artifactLines.length ? artifactLines.join('\n') : 'None.',
      '',
      ...(mailLines.length ? ['## Mail attachments Claude downloaded in this thread', '', ...mailLines, ''] : []),
      ...notesSection(thread),
      '## Earlier (filed by a previous brain update; context only, do not file again)',
      '',
      earlier || 'Nothing.',
      '',
      '## New (file from this part)',
      '',
      fresh,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `Thread ${n} ${safeFileName(thread.title, 60)}.md`), text);
  }
}

function writeCards(dir, cards) {
  const blocks = cards.map((c) => [
    `## ${c.outcome === 'accepted' ? 'Accepted' : 'Declined'}: ${c.title}`,
    '',
    `- Kind: ${c.type}${c.type === 'proposal' ? ' (work Claude offered to do in a thread)' : `, by ${c.channel}`}`,
    `- To: ${c.to || 'not named'}`,
    `- Project or area: ${c.project || 'none named'}`,
    `- Decided: ${dateTimeDMY(c.ts)}${c.how ? ` (${c.how})` : ''}`,
    ...(c.reason ? [`- Florian wrote about it: ${c.reason}`] : []),
    `- Id: ${c.key}`,
    '',
    '### As proposed',
    '',
    c.proposed,
    ...(c.outcome === 'accepted' ? ['', `### As Florian took it${c.edited ? ' (he edited it)' : ' (unchanged)'}`, '', c.final] : []),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Cards.md'), `# Cards Florian decided since the last brain update\n\n${blocks.join('\n\n')}\n`);
}

function writeMail(dir, threads, since) {
  const blocks = threads.map((t) => [
    `## ${t.subject || '(no subject)'}`,
    '',
    `Gmail thread id: ${t.threadId}`,
    '',
    ...t.messages.map((m) => [
      `### ${m.sent ? 'SENT by Florian' : 'RECEIVED'}, ${m.date}`,
      '',
      `From: ${m.from}`,
      `To: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ''}`,
      '',
      m.text || '(no text)',
    ].join('\n')),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Mail.md'), `# Mail since ${dateTimeDMY(since)}\n\nOnly the messages that are new since then; earlier messages of a conversation are in Gmail.\n\n${blocks.join('\n\n')}\n`);
}

// Splits Claude's final message into the parts the app needs.
export function parseReport(text) {
  const raw = String(text || '').trim();
  const status = (raw.match(/^STATUS:\s*(\w+)/m)?.[1] || '').toLowerCase();
  let subject = (raw.match(/^COMMIT:\s*(.+)$/m)?.[1] || '').trim();
  if (!/^thinking: \S/.test(subject) || subject.length > 140) subject = '';
  const body = raw
    .replace(/^```[a-z]*\s*$/gm, '')
    .replace(/^STATUS:.*$/m, '')
    .replace(/^COMMIT:.*$/m, '')
    .trim();
  const sections = {};
  let name = 'written';
  for (const line of body.split('\n')) {
    const head = /^## (Written|Questions|Mail to answer)\s*$/i.exec(line);
    if (head) { name = head[1].toLowerCase(); continue; }
    sections[name] = `${sections[name] || ''}${line}\n`;
  }
  const mail = (sections['mail to answer'] || '')
    .split('\n')
    .map((l) => /^[-*]\s*([^|]+)\|([^|]*)\|?(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ threadId: m[1].trim(), subject: m[2].trim(), why: m[3].trim() }))
    .filter((m) => m.threadId);
  return { status, subject, written: (sections.written || '').trim(), questions: (sections.questions || '').trim(), mail };
}

// What changed in the vault, for display. Session files in Artifacts/Thinking hold what
// Claude read into a session; the vault says those are never shown to Florian. The
// thread files are the app's own export of what he already knows: the conversations.
const visibleChanges = (changes) => changes.filter((c) => !c.path.startsWith('Artifacts/Thinking/') && !c.path.startsWith(`${brain.THREADS_FOLDER}/`));

// The thread an update runs in: a new one for a press, the same one when it runs again
// (after "retry", or once the usage limit lifted).
function threadFor(threadId, mailOnly, pressedAt) {
  let t = threadId ? store.getThread(threadId) : null;
  if (!t) t = store.createThread({ title: `${mailOnly ? 'Gmail update' : 'Brain update'} ${dateTimeDMY(pressedAt)}`, kind: 'brain-update' });
  // He pressed the button, so it is his: it stays in Focus.
  store.updateThread(t.id, {
    state: 'working', activity: 'Starting', activityAt: Date.now(), workingOn: os.hostname(), error: '', archived: false,
    later: false, filesItself: true, brainOnly: mailOnly ? 'mail' : '', queuedAt: Date.now(), gist: '',
  });
  return t.id;
}

// One short sentence on what went in (Florian, 23-11-2026: "dont put a report though, or
// only one sentence, super short. mainly the questions").
export function leadLine(record) {
  if (record.status === 'failed') return `The ${record.mailOnly ? 'Gmail update' : 'update'} stopped and filed nothing: ${record.error}`;
  if (record.status === 'held') return record.error;
  const said = String(record.written || '').replace(/^[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
  if (said && said.length <= 300) return said;
  if (record.status === 'nothing') return record.mailOnly ? 'No new mail needed filing.' : 'Nothing needed filing.';
  const n = record.changes?.length || 0;
  return `Filed into ${n} ${n === 1 ? 'file' : 'files'}.`;
}

// The update's answer in its thread, and where the thread goes: closed by itself when
// there is nothing for him; in the inbox when there are questions or a problem.
function finishThread(threadId, record, parts) {
  const t = store.getThread(threadId);
  if (!t) return;
  const problems = [];
  if (record.mailError && record.status !== 'failed') problems.push(`Mail could not be read, so it waits for the next update: ${record.mailError}`);
  if (record.pushed === false) problems.push(`Committed, but the push failed (${record.pushError}); the app pushes it the next time it reaches GitHub.`);
  if (record.exportError) problems.push(`The threads could not be written into \`Threads/\`: ${record.exportError}`);
  if (record.redacted?.length) problems.push(`A secret value was in ${record.redacted.join(', ')}; it went in as its placeholder.`);
  const text = [
    leadLine(record),
    record.questions ? block('move', 'Questions', record.questions) : '',
    problems.length ? block('found', 'Problems', problems.map((p) => `- ${p}`).join('\n')) : '',
    record.status === 'failed' ? 'Say "retry" to run it again, or ask me to look into it.' : '',
  ].filter(Boolean).join('\n\n');
  store.appendMessage(threadId, { role: 'assistant', parts: [...parts, { type: 'text', text }], durationMs: (record.finishedAt || Date.now()) - record.startedAt });
  store.events.emit('live', { threadId, op: 'end' });
  const open = record.status === 'failed' || Boolean(record.questions) || problems.length > 0;
  const now = Date.now();
  const patch = {
    activity: '', workingOn: '', error: record.status === 'failed' ? record.error : '',
    gist: record.questions ? 'Questions from the brain update' : record.status === 'failed' ? 'The brain update stopped' : problems[0] || '',
  };
  if (record.sessionId) patch.sessionId = record.sessionId;
  if (record.status === 'held') Object.assign(patch, { state: 'done', doneAt: now });
  else if (open) Object.assign(patch, { state: 'ready', queuedAt: now, requeuedAt: 0 });
  else Object.assign(patch, { state: 'done', doneAt: now, archived: true });
  store.updateThread(threadId, patch);
  // What he wrote into it while it ran is answered now.
  runner.runPending(threadId);
}

export function startExtraction({ only = '', threadId = '' } = {}) {
  if (current) return { started: false, reason: 'A brain update is already running.', threadId: current.threadId };
  if (!brain.brainStatus().ready) return { started: false, reason: brain.brainStatus().error || 'The brain is not cloned yet.' };
  const status = extractionStatus();
  const mailOnly = only === 'mail';
  if (mailOnly && !status.mail) return { started: false, reason: 'Gmail is not connected. Connect it in the settings.' };
  // Locked for an update or a handover (gate.js): it runs once that is through, on the
  // computer that works then (watchHold).
  if (gate.isLocked()) {
    const why = gate.reason() === 'handover' ? 'handover' : 'update';
    setState({ brainHeld: { until: 0, type: '', only: mailOnly ? 'mail' : '', gate: why, threadId } });
    store.events.emit('brain', extractionStatus());
    return { started: false, queued: true, reason: `Queued for the ${why}: the ${mailOnly ? 'Gmail update' : 'brain update'} runs once ${why === 'handover' ? 'the Pi has taken over' : 'the app has restarted'}.` };
  }
  // What is closed and already filed is archived at once; it needs no run.
  const cleared = mailOnly ? 0 : archiveFiled();
  if (!mailOnly && !status.waiting && !status.notes && !status.cards && !status.mail) {
    return { started: false, cleared, reason: cleared
      ? `Nothing new to file. Archived ${cleared} closed ${cleared === 1 ? 'thread' : 'threads'} already in the brain.`
      : 'Nothing new to file: everything is already in the brain.' };
  }

  if (getState().brainHeld) setState({ brainHeld: null }); // this run is the one that was waited for
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  // The press fixes the level: each thread as it stands right now, and this moment for
  // mail and cards. Whatever comes after waits for the next update.
  const pressedAt = Date.now();
  const changed = mailOnly ? [] : unfiledThreads().map((thread) => {
    const messages = store.readMessages(thread.id);
    return { thread: { ...thread }, messages, count: messages.length };
  });
  const ownThread = threadFor(threadId, mailOnly, pressedAt);
  current = { id, startedAt: pressedAt, step: 'Starting', threads: changed.map((c) => c.thread.title), mailOnly, threadId: ownThread, parts: [] };
  runExtraction(id, changed, pressedAt, mailOnly)
    .catch((err) => {
      if (err.limit) {
        // Cut off by the usage limit: nothing is filed, and the update runs again by
        // itself when the limit lifts (watchHold), on the computer that works then.
        const until = resumeAt(err.limit, { marginMs: config.limits?.marginMs, fallbackMs: config.limits?.fallbackMs });
        setState({ brainHeld: { until, type: err.limit.type || '', only: mailOnly ? 'mail' : '', threadId: ownThread } });
        log(`brain update: held by the ${limitLabel(err.limit.type)} until ${new Date(until).toISOString()}`);
        return { id, startedAt: pressedAt, finishedAt: Date.now(), status: 'held', until, pushed: true, error: `Claude's ${limitLabel(err.limit.type)} was reached. Nothing was filed; the update runs again by itself at ${clock(until)}.`, threads: current.threads, mailOnly };
      }
      // Shown in the update's own thread, where he can have it run again or looked into.
      log(`brain update failed: ${err.stack || err.message}`);
      return { id, startedAt: pressedAt, finishedAt: Date.now(), status: 'failed', error: err.message, threads: current.threads, mailOnly };
    })
    .then(async (record) => {
      // Whatever fails while tidying up, the update must not stay "running" for good: that
      // would keep the app from updating and handing over.
      const { sessionId, ...kept } = record;
      const parts = current?.parts || [];
      try {
        if (record.status === 'failed' || record.status === 'held') await brain.discardChanges();
        const runDir = path.join(EXTRACTIONS_DIR, id);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ ...kept, threadId: ownThread }, null, 2));
      } catch (err) { log(`brain update: tidying up after it failed: ${err.stack || err.message}`); }
      current = null;
      try { finishThread(ownThread, { ...record, sessionId: config.fake ? null : sessionId }, parts); } catch (err) { log(`brain update: its thread could not be finished: ${err.stack || err.message}`); }
      store.events.emit('brain', extractionStatus());
      saveNow('brain update').catch(() => {});
    });
  store.events.emit('brain', extractionStatus());
  return { started: true, threads: current.threads, threadId: ownThread };
}

async function runExtraction(id, changed, pressedAt, mailOnly = false) {
  const runDir = path.join(EXTRACTIONS_DIR, id);
  const dir = path.join(runDir, 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const state = getState();

  // The vault is also a repo threads can open, to change its structure or its rules. The
  // two never write it at once: the update waits for a thread that holds the vault, and a
  // thread that opens it while the update runs waits for the update.
  const vault = repos.vaultRepo(config.brainRepo);
  const job = repos.jobHolder('brain update');
  if (vault) {
    if (repos.holder(vault) && repos.holder(vault) !== job) setStep(`Waiting for ${repos.holderName(vault)}, which is changing the vault`);
    await repos.acquire(vault, job);
  }
  try {
    return await writeBrain(id, changed, pressedAt, mailOnly, dir, state);
  } finally {
    if (vault) repos.release(vault, job);
  }
}

async function writeBrain(id, changed, pressedAt, mailOnly, dir, state) {
  // A turn of an update's thread may be filing his answers right now: wait for it.
  const giveBack = await brain.takeWriter('the brain update', { onWait: (who) => setStep(`Waiting for ${who}, which is filing into the brain`) });
  try {
    return await fileAll(id, changed, pressedAt, mailOnly, dir, state);
  } finally {
    giveBack();
  }
}

async function fileAll(id, changed, pressedAt, mailOnly, dir, state) {
  {
    setStep('Getting the vault up to date');
    await brain.pullForWriting();

    const material = [];
    if (changed.length) {
      await writeThreads(dir, changed);
      material.push(`- ${changed.length} thread file${changed.length === 1 ? '' : 's'} ("Thread NN ….md"), each with its files in a folder next to it`);
    }

    const notes = mailOnly ? '' : (readPad('notes') || '');
    if (notes.trim()) {
      fs.writeFileSync(path.join(dir, 'Notes for Claude.md'), `# Notes for Claude\n\nWritten by Florian in the app, up to ${dateTimeDMY(pressedAt)}.\n\n${notes.trim()}\n`);
      material.push('- `Notes for Claude.md`');
    }

    // A preparation the app started from the calendar is a thread, and is filed as one.
    const cards = mailOnly ? [] : readCardLog().filter((e) => e.ts > state.cardsLevel && e.ts <= pressedAt && e.type !== 'prep');
    if (cards.length) {
      writeCards(dir, cards);
      material.push('- `Cards.md`');
    }

    let mailThreads = [];
    let mailError = '';
    let mailRead = false;
    if (google.googleConnected()) {
      setStep('Reading new mail');
      // The first time, look back one day.
      const since = state.mailLevel || pressedAt - 24 * 3600_000;
      try {
        mailThreads = await google.gmailSince(since);
        mailRead = true;
        log(`brain update: read ${mailThreads.read ?? '?'} mail(s) since ${new Date(since).toISOString()}, skipped ${mailThreads.skipped ?? 0} automated`);
        if (mailThreads.length) {
          writeMail(dir, mailThreads, since);
          material.push('- `Mail.md`');
        }
      } catch (err) {
        mailError = err.message;
        log(`brain update: mail could not be read: ${err.message}`);
      }
    }

    const finishLevels = () => {
      for (const c of changed) {
        const thread = store.getThread(c.thread.id);
        if (!thread) continue;
        const patch = { extractedCount: c.count, extractedAt: pressedAt };
        // Closed, and nothing said in it since the press: it is entirely in the brain now.
        if (thread.state === 'done' && thread.messageCount <= c.count) patch.archived = true;
        store.updateThread(c.thread.id, patch);
      }
      nextActions.afterUpdate(changed);
      const levels = mailOnly ? {} : { cardsLevel: pressedAt };
      if (mailRead) levels.mailLevel = pressedAt;
      setState(levels);
      // The notes pad is emptied of what was filed; anything typed since stays.
      if (notes.trim()) {
        const now = readPad('notes') || '';
        writePad('notes', now.startsWith(notes) ? now.slice(notes.length).replace(/^\s+/, '') : now);
      }
    };

    if (mailOnly && mailError) throw new Error(`Gmail could not be read: ${mailError}`);

    const base = { id, mailOnly, startedAt: pressedAt, threads: changed.map((c) => c.thread.title), mailCount: mailThreads.length, mailError, notes: Boolean(notes.trim()), cardCount: cards.length };

    if (!material.length) {
      finishLevels();
      return { ...base, finishedAt: Date.now(), status: 'nothing', written: '', changes: [], pushed: true, replyThreads: [] };
    }

    setStep('Reading what is new');
    const ask = (prompt, resume) => runAgent({
      prompt,
      resume,
      cwd: brain.brainDir(),
      systemAppend: 'You are running inside Florian\'s inbox app as its brain update. The run\'s instructions are in the user message.',
      model: state.model,
      effort: state.effort,
      mode: 'extract',
      artifactsDir: null,
      readDirs: [dir],
      // Threads/ is written by the app's export alone, and what is in Archive/ is frozen:
      // a note is moved there (git mv), never edited there.
      protectedPaths: [...config.protectedPaths, brain.THREADS_FOLDER, brain.ARCHIVE_FOLDER],
      title: `${mailOnly ? 'Gmail update' : 'Brain update'} ${dateDMY()}`,
      fake: config.fake,
      onEvent: (ev) => {
        if (ev.type === 'tool-input') logToolRead({ vaultDir: brain.brainDir(), by: 'brain-update', tool: ev.name, input: ev.input });
        else if (ev.type === 'tool') setStep(ev.summary, ev.helper ? '' : ev.name);
        else if (ev.type === 'text-start') setStep('Writing the report');
      },
    });
    const result = await ask(readPrompt('extract.md', { today: todayLine(), transcriptsDir: dir, material: material.join('\n') }));
    if (result.limit) throw Object.assign(new Error(result.error), { limit: result.limit });
    if (result.error) throw new Error(result.error);

    const report = parseReport(result.finalText || result.text);
    // A project or area note that grew past its limit is shortened in the same session.
    // Going over is no reason to lose what was filed: if this fails, the note stays long
    // and the next update that changes it tries again.
    const tooLong = overLimit(brain.brainDir(), await brain.changedPaths());
    if (tooLong.length) {
      setStep(`Shortening ${tooLong.map((n) => path.basename(n.path, '.md')).join(', ')}`);
      const cut = await ask(readPrompt('shorten.md', { notes: tooLong.map((n) => `- \`${n.path}\`: ${n.words} words, limit ${n.limit}`).join('\n') }), result.sessionId || undefined);
      if (cut.error || cut.limit) log(`brain update: the long notes were not shortened: ${cut.error || 'usage limit'}`);
      const left = overLimit(brain.brainDir(), tooLong.map((n) => n.path));
      if (left.length) log(`brain update: still over the limit: ${left.map((n) => `${n.path} (${n.words}/${n.limit})`).join(', ')}`);
    }
    // The threads as they stand now, written into the vault by the app itself; they go
    // into the same commit. A failure here must not cost the update what it filed.
    let exportError = '';
    if (!mailOnly) {
      setStep('Writing the threads into the vault');
      try {
        await refreshSecrets(); // so the export knows every value to keep out
        const done = exportThreads(brain.brainDir());
        log(`brain update: ${done.total} threads in the vault, ${done.written} written, ${done.renamed} renamed`);
      } catch (err) {
        log(`brain update: the threads could not be written into the vault: ${err.stack || err.message}`);
        exportError = err.message;
      }
    }
    setStep('Committing and pushing');
    const subject = report.subject || `thinking: the app, ${dateDMY()}`;
    const committed = await brain.commitAndPush({
      subject,
      body: `Co-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: app-ai brain update ${id}`,
    });
    finishLevels();

    // Mail that needs an answer: one thread each, with Claude already drafting the reply.
    const replyThreads = [];
    for (const m of report.mail.slice(0, 8)) {
      const thread = store.createThread({ title: `Reply: ${m.subject || 'a mail'}`.slice(0, 100), kind: 'mail-reply' });
      runner.sendMessage(thread.id, [
        'A mail arrived that needs an answer from Florian. The brain update noticed it; he has not seen it yet.',
        '',
        `Gmail thread id: ${m.threadId}`,
        `Subject: ${m.subject}`,
        `What it is about: ${m.why}`,
        '',
        'Read the conversation with the mail tools and the notes in the vault that it concerns. Then draft the reply as a mail file, with this thread id in `reply-to-thread:`. In your message, tell Florian in two or three sentences who wrote and what they want, say that a draft is ready, and ask the one thing you need from him, if any.',
        'If the reply has to go out today (a deadline today or tomorrow, a call or meeting with the sender today, or they have waited too long already; check his calendar when a date matters), call mark_pressing with a one-line reason, so it reaches him while he focuses. Otherwise do not call it: the reply waits for Catch-up.',
      ].join('\n'), { auto: true });
      replyThreads.push(thread.id);
    }

    return {
      ...base,
      finishedAt: Date.now(),
      // A commit that holds nothing but thread files filed nothing new.
      status: committed && (visibleChanges(committed.changes).length || committed.changes.some((c) => c.path.startsWith('Artifacts/Thinking/'))) ? 'updated' : 'nothing',
      written: report.written,
      questions: report.questions,
      hasQuestions: Boolean(report.questions),
      questionsThread: report.questions ? current?.threadId || null : null,
      replyThreads,
      exportError,
      sessionId: result.sessionId || null,
      commit: committed?.commit || '',
      subject: committed ? subject : '',
      pushed: committed ? committed.pushed : true,
      pushError: committed?.pushError || '',
      changes: committed ? visibleChanges(committed.changes) : [],
      restored: committed?.restored || [],
      redacted: committed?.redacted || [],
    };
  }
}
