// Moves threads through their states.
//
//   ready    Claude has finished; the thread waits in the inbox for Florian
//   working  Claude is on it
//   done     Florian closed it
//
// A turn cut off by Claude's usage limit keeps its thread "working", with `held` on it:
// it runs again by itself once the limit has lifted (limits.js, "held turns" below).
//
// A message Florian sends makes a thread "working"; the end of Claude's turn makes it
// "ready" again and puts it at the back of the inbox.

import { runAgent } from './agent.js';
import * as brain from './brain.js';
import * as store from './store.js';
import { DATA_DIR, log } from './config.js';
import * as google from './google.js';
import { logRead, logToolRead } from './reads.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { messageText, readPrompt, todayLine, dateTimeDMY, voiceActivity } from './util.js';
import { getState, TIERS, TIER_NAMES } from './state.js';
import { projectContext, repoOf, projectChoices, followRenames } from './projects.js';
import { lastThreadOn } from './threadexport.js';
import * as repos from './repos.js';
import * as secrets from './secrets.js';
import * as repair from './repair.js';
import * as ship from './ship.js';
import { piShell } from './pi.js';
import { moveEvent } from './events.js';
import { limitLabel, resumeAt, clock } from './limits.js';
import * as retry from './retry.js';

let config;
const running = new Map(); // threadId -> { abort: AbortController, parts: [] }
const waiting = []; // threadIds waiting for a free slot
const heldPrompt = new Map(); // threadId -> the message a turn started again after a hold is really about

export function initRunner(cfg) {
  config = cfg;
  ship.onMergeFailed(mergeFailed);
}

// Whether a turn of this thread runs in this process right now.
export const isRunning = (threadId) => running.has(threadId) || waiting.some((w) => w.threadId === threadId);

export function liveParts(threadId) {
  return running.get(threadId)?.parts || null;
}

export function titleFrom(text) {
  const line = String(text).trim().split('\n').find((l) => l.trim() && !l.trim().startsWith('>')) || 'New thread';
  const clean = line.replace(/[#*_`>\[\]]/g, '').trim();
  return clean.length > 64 ? `${clean.slice(0, 63).trim()}…` : clean || 'New thread';
}

// What Claude gets for a message: its text, and where the attached files are.
function promptFor(threadId, text, files) {
  if (!files?.length) return text;
  const lines = files.map((f) => `- ${path.join(store.uploadsDir(threadId), f.name)}`);
  return `${text || '(no text, only the files)'}\n\n[Florian attached ${files.length === 1 ? 'this file' : 'these files'} to his message. Read ${files.length === 1 ? 'it' : 'them'} with the Read tool; images and PDFs can be read too:\n${lines.join('\n')}\n]`;
}

// Florian sends a message. Returns the stored message.
// `auto` marks a message the app wrote itself to start a thread (a mail to answer).
// `files` are attachments already moved into the thread. `doneAfter` is "send and done":
// the message is kept and the thread closes, without a turn. He is closing it, so an
// answer would only cost usage; the brain update reads the message like any other, and
// if he reopens the thread, Claude gets it with his next message.
export function sendMessage(threadId, text, { auto = false, files = [], doneAfter = false, tier = '' } = {}) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('No such thread');
  const stored = { role: 'user', text };
  if (auto) stored.auto = true;
  if (files.length) stored.files = files;
  if (doneAfter && !auto) stored.unanswered = true;
  const message = store.appendMessage(threadId, stored);
  // Only for a message Claude answers: one that just closes the thread starts no turn.
  if (tier && TIER_NAMES.includes(tier) && !doneAfter) store.updateThread(threadId, { nextTier: tier }, { quiet: true });
  const prompt = promptFor(threadId, text, files);
  if (doneAfter && !auto) {
    const unsent = [...(thread.unsent || []), prompt];
    // Mid-turn: the thread closes when that turn ends; this message starts no turn of its own.
    if (thread.state === 'working') store.updateThread(threadId, { unsent, doneAfter: true });
    else store.updateThread(threadId, { unsent, doneAfter: false, state: 'done', doneAt: Date.now(), activity: '', requeuedAt: 0 });
    sign(threadId, { again: true }).catch(() => {});
    return message;
  }
  // A plain message after "send and done" means he wants to see the answer after all.
  // A message into a deferred thread wakes it again. A message of his also sets the
  // count of what the app retried by itself back (retry.js).
  if (!auto) store.updateThread(threadId, { doneAfter: false, deferred: false, auto: null, remerge: null, interrupted: 0 });
  // What he sent with "send and done" goes in first, so Claude has it too.
  const withUnsent = [...(thread.unsent || []), prompt].join('\n\n');
  if (thread.unsent?.length) store.updateThread(threadId, { unsent: [] });
  // Waiting to carry on by itself (not for the usage limit): his message starts the turn now.
  if (thread.state === 'working' && thread.held?.kind && thread.held.kind !== 'limit' && !isRunning(threadId)) {
    const { held } = thread;
    const added = thread.pending || [];
    heldPrompt.set(threadId, { prompt: held.prompt, tries: 0, kind: held.kind });
    store.updateThread(threadId, { held: null, pending: [], nextTier: thread.nextTier || (TIER_NAMES.includes(held.tier) ? held.tier : '') }, { quiet: true });
    log(`thread "${thread.title}": he wrote while it waited to carry on by itself; starting now`);
    startTurn(threadId, retry.interruptedText(held, [...added, withUnsent].join('\n\n')));
    return message;
  }
  if (thread.state === 'working') {
    // Claude is still on the previous message: this one goes in as soon as that turn ends.
    store.updateThread(threadId, { pending: [...(thread.pending || []), withUnsent] });
    return message;
  }
  startTurn(threadId, withUnsent, auto);
  return message;
}

// How many turns may run at once. Work the app started by itself (`background`) leaves
// one slot free, so a message of Florian's never waits behind it for long.
const slotFree = (background) => running.size < (background ? Math.max(1, config.maxParallel - 1) : config.maxParallel);

function startTurn(threadId, prompt, background = false) {
  // The prompt is kept with the thread, so a turn cut off by the app closing can be started
  // again by itself (retryInterrupted).
  store.updateThread(threadId, { state: 'working', error: '', archived: false, activity: 'Starting', workingOn: os.hostname(), held: null, interrupted: 0, turnPrompt: prompt });
  if (!slotFree(background)) {
    waiting.push({ threadId, prompt, background });
    store.updateThread(threadId, { activity: background ? 'Waiting its turn (your own messages go first)' : 'Waiting for a free slot' }, { quiet: true });
    return;
  }
  running.set(threadId, { abort: new AbortController(), parts: [] }); // holds the slot until runTurn takes over
  runTurn(threadId, prompt).catch((err) => {
    log(`turn failed unexpectedly: ${err.stack || err.message}`);
    if (store.getThread(threadId)?.kind !== 'repair') repair.report('a turn', err.stack || err.message);
    running.delete(threadId);
    heldPrompt.delete(threadId);
    store.updateThread(threadId, { state: 'ready', queuedAt: Date.now(), activity: '', error: err.message });
  });
}

export function stopTurn(threadId) {
  const idx = waiting.findIndex((w) => w.threadId === threadId);
  if (idx >= 0) {
    waiting.splice(idx, 1);
    store.updateThread(threadId, { state: 'ready', queuedAt: Date.now(), activity: '', pending: [], stoppedAt: Date.now() });
    return true;
  }
  const run = running.get(threadId);
  if (!run) {
    // Held by the usage limit: stopping it cancels the hold, and it is his again.
    const thread = store.getThread(threadId);
    if (!thread?.held) return false;
    heldPrompt.delete(threadId);
    store.updateThread(threadId, { state: 'ready', queuedAt: Date.now(), activity: '', pending: [], held: null, workingOn: '', doneAfter: false, stoppedAt: Date.now() });
    log(`thread "${thread.title}": hold cancelled`);
    return true;
  }
  run.abort.abort();
  return true;
}

// ---------- held turns: cut off by the usage limit, run again when it lifts ----------
//
// `held` on the thread: { until (when it runs again), type (which limit), prompt (the
// message the turn was about), at, tier, tries }. The thread stays "working", so what
// Florian adds meanwhile waits in `pending` like any message sent mid-turn, and "Stop"
// cancels the hold. Nothing here keeps a timer per thread: the hold is data, and
// resumeHeld() looks at the clock, on whichever computer does the work at that moment.

const holdLine = (held) => (held.kind && held.kind !== 'limit' ? retry.holdLine(held) : `Held by the ${limitLabel(held.type)}: carries on by itself at ${clock(held.until)}`);

function hold(threadId, limit, { prompt, tier, tries = 0 }) {
  const until = resumeAt(limit, { marginMs: config.limits?.marginMs, fallbackMs: config.limits?.fallbackMs });
  const held = { until, type: limit.type || '', prompt, at: Date.now(), tier, tries: tries + 1 };
  store.updateThread(threadId, { state: 'working', held, activity: holdLine(held), workingOn: '', error: '' });
  log(`thread "${store.getThread(threadId)?.title}": held by the ${limitLabel(held.type)} until ${new Date(until).toISOString()}`);
  return held;
}

// Held to carry on by itself (retry.js): after an error, when Claude asked to look again,
// or to fix a merge. The same data as a hold for the usage limit, with its `kind`.
function holdAuto(threadId, { kind, until, reason = '', prompt, tier = '', tries = 1 }) {
  const held = { until, type: '', kind, reason, prompt, at: Date.now(), tier, tries };
  store.updateThread(threadId, { state: 'working', held, activity: holdLine(held), workingOn: '', error: '' });
  log(`thread "${store.getThread(threadId)?.title}": ${kind}, carries on by itself at ${new Date(until).toISOString()}`);
  return held;
}

// Starts every held turn whose limit has lifted. `mayRun` says whether this computer is
// the one doing the work; the other one leaves the hold alone.
export function resumeHeld({ mayRun = () => true, now = Date.now() } = {}) {
  let started = 0;
  for (const t of store.listThreads()) {
    if (!t.held || t.state !== 'working' || isRunning(t.id) || now < t.held.until) continue;
    if (!mayRun()) return started;
    const { held } = t;
    const added = t.pending || [];
    const kind = held.kind || 'limit';
    const own = kind === 'limit' ? null : retry.resumeText(held, now);
    const prompt = [
      own ? own.prompt : `[The app: this turn was cut off by Claude's usage limit (the ${limitLabel(held.type)}) at ${dateTimeDMY(held.at)}. The limit has lifted now and the app started the turn again by itself; Florian has not written anything since, unless a message follows below. Carry on where you stopped and finish the work. Do not start over: look first at what is already there (what you wrote above, the files in the artifacts folder, commits on the thread's branch), and open the repo again if you were working in one. The message the turn was about:]`,
      ...(own ? [] : [held.prompt]),
      ...(added.length ? ['[While the turn was held, Florian added:]', added.join('\n\n')] : []),
    ].join('\n\n');
    store.appendMessage(t.id, { role: 'user', event: true, auto: true, text: own ? own.note : `[The ${limitLabel(held.type)} lifted; the app carried on with this turn by itself on ${dateTimeDMY(now)}.]` });
    heldPrompt.set(t.id, { prompt: added.length ? `${held.prompt}\n\n${added.join('\n\n')}` : held.prompt, tries: kind === 'limit' ? held.tries || 1 : 0, kind });
    store.updateThread(t.id, { pending: [], nextTier: TIER_NAMES.includes(held.tier) ? held.tier : '' }, { quiet: true });
    log(`thread "${t.title}": ${kind === 'limit' ? `the ${limitLabel(held.type)} lifted` : `the ${kind} hold is over`}, carrying on`);
    startTurn(t.id, prompt);
    started += 1;
  }
  return started;
}

// Merges that failed for a reason a turn cannot fix (GitHub not reachable) are tried
// again by themselves once `remerge.at` has come (retry.js).
export function retryMerges({ mayRun = () => true, now = Date.now() } = {}) {
  let started = 0;
  for (const t of store.listThreads()) {
    if (!t.remerge || now < t.remerge.at || t.state === 'working' || isRunning(t.id) || ship.isShipping(t.id)) continue;
    if (!mayRun()) return started;
    store.updateThread(t.id, { remerge: null }, { quiet: true });
    log(`thread "${t.title}": trying the merge again by itself`);
    ship.afterTurn(t.id).catch(() => {});
    started += 1;
  }
  return started;
}

// Turns cut off because the app closed (or restarted) in the middle of them: started
// again by itself, as after an error, with the same safety handles (retry.js).
export function retryInterrupted({ mayRun = () => true, now = Date.now() } = {}) {
  let started = 0;
  for (const t of store.listThreads()) {
    if (!t.interrupted || t.state !== 'ready' || isRunning(t.id)) continue;
    if (!mayRun()) return started;
    store.updateThread(t.id, { interrupted: 0 }, { quiet: true });
    if (!t.turnPrompt) continue; // from before the app kept the prompt
    const reason = 'the app was closed in the middle of the turn';
    const plan = retry.turnPlan({ auto: t.auto, error: reason, didWork: false, opts: config.autoRetry, now });
    if (plan?.stop) {
      store.updateThread(t.id, { auto: plan.auto }, { quiet: true });
      store.appendMessage(t.id, { role: 'user', event: true, auto: true, text: `[The app stopped carrying on by itself: ${plan.stop}. Send a message to pick it up again.]` });
      continue;
    }
    if (!plan?.kind) continue;
    store.updateThread(t.id, { auto: plan.auto }, { quiet: true });
    holdAuto(t.id, { kind: 'retry', until: now, reason, prompt: t.turnPrompt, tier: t.lastTier || '', tries: plan.tries });
    started += 1;
  }
  return started;
}

let holdTimer = null;
export function watchHolds(mayRun) {
  clearInterval(holdTimer);
  holdTimer = setInterval(() => {
    try { retryInterrupted({ mayRun }); } catch (err) { log(`interrupted turns: ${err.stack || err.message}`); }
    try { resumeHeld({ mayRun }); } catch (err) { log(`held turns: ${err.stack || err.message}`); }
    try { retryMerges({ mayRun }); } catch (err) { log(`merges to try again: ${err.stack || err.message}`); }
  }, config.limits?.checkMs || 20_000);
  holdTimer.unref?.();
}

// ---------- messages no turn took up ----------
//
// A message sent into a thread that says "working" waits for that turn to end. When the
// turn was the other computer's, or was already over and only its last state had not
// arrived yet (the laptop just took the work back from the Pi), nothing here ever picks
// the message up: the thread comes back "ready" with the message in it and no answer
// (18-11-2026: "start again, read my latest messages"). The conversation itself is never
// lost, since both computers' lines are kept, so that is what this looks at: a message
// of Florian's that no turn started after is still owed an answer.

// The messages of his in `messages` that no turn took up, oldest first. A turn took a
// message up when it started after the message was sent (its answer's time minus how
// long it ran); the two computers' clocks may differ by a few seconds. Not counted:
// what the app wrote itself, notes about what he did, messages sent with "send and
// done" (they wait for his next one), and anything from before he pressed Stop.
export function leftOver(messages, { stoppedAt = 0, slackMs = 5000 } = {}) {
  let lastStart = 0;
  for (const m of messages) if (m.role === 'assistant') lastStart = Math.max(lastStart, (m.ts || 0) - (m.durationMs || 0));
  return messages.filter((m) => m.role === 'user' && !m.auto && !m.event && !m.unanswered && (m.ts || 0) > stoppedAt && (m.ts || 0) - slackMs > lastStart);
}

// Starts a turn for every waiting thread that holds such messages. Only on the computer
// that does the work, only for messages of the last hours, and once per message: a turn
// that fails says so in the thread, and trying again is his call then.
export function answerLeftOver({ mayRun = () => true, now = Date.now() } = {}) {
  const { minAgeMs = 60_000, maxAgeMs = 6 * 3600_000, slackMs = 5000 } = config.leftOver || {};
  let started = 0;
  for (const t of store.listThreads()) {
    if (t.state !== 'ready' || t.held || t.deferred || t.archived || t.error || t.kind === 'card' || isRunning(t.id)) continue;
    // Cheap first: nothing of his since the thread was last looked at.
    if (!t.lastUserTs || now - t.lastUserTs > maxAgeMs || t.leftOverAt === t.lastUserTs) continue;
    if (!mayRun()) return started;
    const owed = leftOver(store.readMessages(t.id), { stoppedAt: t.stoppedAt || 0, slackMs });
    const newest = owed.at(-1);
    if (newest && now - newest.ts < minAgeMs) continue; // too fresh to tell: looked at again
    store.updateThread(t.id, { leftOverAt: t.lastUserTs }, { quiet: true });
    if (!newest || now - newest.ts > maxAgeMs) continue;
    const prompt = [
      `[The app: Florian sent the message${owed.length > 1 ? 's' : ''} below ${owed.length > 1 ? 'between' : 'at'} ${owed.length > 1 ? `${clock(owed[0].ts)} and ${clock(newest.ts)}` : clock(newest.ts)}, while the work was moving between his two computers, and no turn took ${owed.length > 1 ? 'them' : 'it'} up. The app noticed and started this turn by itself; he has not written anything since. Answer ${owed.length > 1 ? 'them' : 'it'} now, in the light of everything said before.]`,
      ...owed.map((m) => promptFor(t.id, m.text || '', m.files || [])),
    ].join('\n\n');
    store.appendMessage(t.id, { role: 'user', event: true, auto: true, text: `[${owed.length > 1 ? `${owed.length} messages` : 'A message'} here had not been answered; the app started the turn by itself on ${dateTimeDMY(now)}.]` });
    log(`thread "${t.title}": ${owed.length} message(s) no turn took up; answering now`);
    startTurn(t.id, prompt);
    started += 1;
  }
  return started;
}

let leftOverTimer = null;
export function watchLeftOver(mayRun) {
  clearInterval(leftOverTimer);
  leftOverTimer = setInterval(() => { try { answerLeftOver({ mayRun }); } catch (err) { log(`unanswered messages: ${err.stack || err.message}`); } }, config.leftOver?.checkMs || 60_000);
  leftOverTimer.unref?.();
}

// The last thread on this thread's project, as the vault holds it: named, so that a new
// thread reads it once, in full. Everything else in Threads/ is only searched.
function lastThreadNote(thread) {
  let last = null;
  try { last = lastThreadOn(brain.brainDir(), thread.project, { exceptId: thread.id, cacheKey: brain.brainStatus().head }); } catch { /* starts without it */ }
  if (!last) return [];
  return [
    '',
    `The last thread on "${thread.project}" before this one is \`${last.path}\` ("${last.title}", last written in ${dateTimeDMY(last.last)}). If you have not read it in this thread yet, read it in full before you answer: it holds where the work stood, in more detail than the note's \`Left off:\` line. What Claude said in it is what Claude proposed then, not what Florian decided.`,
  ];
}

function threadInstructions(thread) {
  const preload = brain.readPreload();
  const preloadText = preload.length
    ? [
        '## Vault rules, current as of this turn',
        '',
        `These vault files are included here in full, so do not read them again: ${preload.map((f) => `\`${f.path}\``).join(', ')}.`,
        '',
        ...preload.map((f) => `<vault-file path="${f.path}">\n${f.text.trim()}\n</vault-file>`),
      ].join('\n')
    : '';
  for (const f of preload) logRead({ by: 'preload', threadId: thread.id, path: f.path });
  const project = projectContext(thread.project);
  const projectText = project.length
    ? [
        `## This thread belongs to "${thread.project}"`,
        '',
        `Its notes are included here in full, current as of this turn, so do not read them again: ${project.map((f) => `\`${f.path}\``).join(', ')}. Work from them; they are where this project's state lives.`,
        '',
        ...project.map((f) => `<vault-file path="${f.path}">\n${f.text.trim()}\n</vault-file>`),
        ...lastThreadNote(thread),
      ].join('\n')
    : '';
  const g = google.googleStatus();
  const repo = thread.repo
    ? `This thread's repo is ${thread.repo}${thread.repoBranch ? `; its work so far is on the branch \`${thread.repoBranch}\`` : ''}. Call \`open_repo\` before you read or change its code in this turn.`
    : 'This thread has no repo yet.';
  return readPrompt('thread.md', {
    repo,
    today: todayLine(),
    artifactsDir: store.artifactsDir(thread.id),
    workDir: store.workDir(thread.id),
    mail: g.connected ? readPrompt('mail-connected.md', { email: g.email || 'his Gmail account' }) : readPrompt('mail-offline.md').trim(),
    preload: [projectText, preloadText].filter(Boolean).join('\n\n'),
  });
}

// When Claude Code has no session for a thread that already has a conversation, the
// conversation so far is handed over as text, so the thread carries on. That is the case
// when the session is gone from disk, and for a spin-off, which starts as a copy of
// another thread's conversation.
function recap(threadId, newPrompt) {
  const thread = store.getThread(threadId);
  const earlier = store.readMessages(threadId).slice(0, -1);
  const lines = earlier.map((m) => `### ${m.role === 'user' ? (m.auto ? 'The app' : 'Florian') : 'Claude'}, ${dateTimeDMY(m.ts)}\n\n${messageText(m)}${m.files?.length ? `\n\n[He attached: ${m.files.map((f) => path.join(store.uploadsDir(threadId), f.name)).join(', ')}]` : ''}`);
  // A long conversation keeps its beginning (what the thread is for) and its end (where
  // it stands); only the middle is left out. Until 19-11-2026 everything but the last
  // 60,000 characters was cut, so a long thread that changed computers lost its task.
  let body = lines.join('\n\n');
  const HEAD = 40_000;
  const TAIL = 260_000;
  if (body.length > HEAD + TAIL) body = `${body.slice(0, HEAD)}\n\n[… the middle of the conversation is left out here: ${Math.round((body.length - HEAD - TAIL) / 1000)}k characters. The files made on the way are in the artifacts folder, and the thread's branch holds the commits. …]\n\n${body.slice(-TAIL)}`;
  const lead = thread?.spunFrom && earlier.length <= (thread.spunAt || 0)
    ? `This thread was spun off from the thread "${thread.spunTitle}". Below is that conversation up to that moment; the files made and attached there are copied into this thread's folders. The original thread carries on separately and does not see what happens here. The message at the end is the task for this spin-off: do that, not the original thread's work.`
    : 'This thread\'s earlier session could not be reopened, so here is the conversation so far.';
  return `${lead}\n\n${body}\n\n---\n\nThe new message:\n\n${newPrompt}`;
}

async function runTurn(threadId, prompt) {
  const thread = store.getThread(threadId);
  const abort = new AbortController();
  const run = { abort, parts: [] };
  running.set(threadId, run);
  const emitLive = (payload) => store.events.emit('live', { threadId, ...payload });
  const activity = (text) => store.updateThread(threadId, { activity: text }, { quiet: true });

  // Which new files Claude means to show: those it writes into the artifacts folder with
  // its file tools, and those it hands over with show_file. Anything else a script leaves
  // there is not shown, and is moved to the workbench when the turn ends.
  const artifactsDir = store.artifactsDir(threadId);
  const served = new Set();
  const serveName = (file) => {
    const rel = path.relative(artifactsDir, path.resolve(artifactsDir, String(file || '')));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) served.add(rel.split(path.sep).join('/'));
  };
  const recordArtifacts = () => {
    for (const { name, v } of store.scanArtifacts(threadId, 'claude', { serve: [...served] })) {
      const existing = run.parts.find((p) => p.type === 'artifact' && p.name === name);
      if (existing) existing.v = v;
      else run.parts.push({ type: 'artifact', name, v });
      emitLive({ op: 'parts', parts: run.parts });
    }
  };

  const onEvent = (ev) => {
    if (ev.type === 'session') {
      store.updateThread(threadId, { sessionId: ev.sessionId });
    } else if (ev.type === 'text-start') {
      run.parts.push({ type: 'text', text: '' });
      activity('Writing');
    } else if (ev.type === 'text') {
      let last = run.parts.at(-1);
      if (!last || last.type !== 'text') {
        last = { type: 'text', text: '' };
        run.parts.push(last);
      }
      last.text += ev.delta;
      emitLive({ op: 'text', index: run.parts.length - 1, delta: ev.delta });
    } else if (ev.type === 'tool') {
      run.parts.push({ type: 'tool', name: ev.name, summary: ev.summary });
      emitLive({ op: 'parts', parts: run.parts });
      activity(ev.summary);
    } else if (ev.type === 'tool-input') {
      logToolRead({ vaultDir: brain.brainDir(), by: 'thread', threadId, tool: ev.name, input: ev.input });
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(ev.name)) serveName(ev.input?.file_path || ev.input?.notebook_path);
    } else if (ev.type === 'tool-result') {
      recordArtifacts();
    } else if (ev.type === 'activity') {
      activity(ev.text);
    }
  };

  // show_file: a file a script made goes into the artifacts folder and is shown.
  const workDir = store.workDir(threadId);
  const showFile = async ({ path: given, name }) => {
    const from = path.resolve(workDir, String(given || ''));
    const inside = (root) => { const rel = path.relative(root, from); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
    if (!inside(workDir) && !inside(artifactsDir)) throw new Error(`Only files on the workbench (${workDir}) or in the artifacts folder can be shown.`);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) throw new Error(`There is no file at ${from}.`);
    const shown = String(name || path.basename(from)).replace(/[\\/:*?"<>|]/g, '-').trim() || path.basename(from);
    let target = inside(artifactsDir) && !name ? from : path.join(artifactsDir, shown);
    if (target !== from) { fs.mkdirSync(artifactsDir, { recursive: true }); fs.copyFileSync(from, target); }
    serveName(target);
    recordArtifacts();
    return `Shown to Florian as "${path.relative(artifactsDir, target).split(path.sep).join('/')}".`;
  };

  // use_document: one of his encrypted documents, decrypted onto the workbench for a
  // script; the copy goes when the turn ends (see the finally below).
  const decryptedDir = path.join(workDir, 'decrypted');
  const useDocument = async ({ path: given }) => {
    const doc = await secrets.decryptDocument(String(given || ''));
    if (!doc) throw new Error(`There is no encrypted document "${given}" in the vault's Files/ folder.`);
    fs.mkdirSync(decryptedDir, { recursive: true });
    const target = path.join(decryptedDir, doc.name);
    fs.writeFileSync(target, doc.data, { mode: 0o600 });
    return `Decrypted to ${target}. It is deleted when this turn ends.`;
  };

  // continue_later: something still runs (a render, a build) and the turn ends before it
  // is done. The app starts a turn by itself when Claude asked, instead of Claude asking
  // Florian to say "go on" (retry.js).
  const continueLater = async ({ minutes, why }) => {
    run.carryOn = { minutes: Number(minutes) || 10, why: String(why || '').trim() };
    const o = { ...retry.DEFAULTS, ...(config.autoRetry || {}) };
    const m = Math.max(1, Math.round(Math.min(Math.max(run.carryOn.minutes, o.continueMinMin), o.continueMaxMin)));
    return `The app starts a new turn in this thread by itself in about ${m} minute${m === 1 ? '' : 's'}, to look again. End this turn now, with one or two lines for Florian on where it stands; do not ask him to say "go on". What you leave on a repo's branch is not merged into main before the work is done.`;
  };

  // Claude starts a spin-off when Florian asks for one in his message: a new thread that
  // begins as a copy of this one and works on the task by itself.
  let spun = 0;
  const spinOff = async ({ title, task }) => {
    if (spun >= 4) throw new Error('That is enough spin-offs for one turn.');
    spun += 1;
    const copy = store.copyThread(threadId, { title: String(title || '').trim().slice(0, 100) || titleFrom(task) });
    sendMessage(copy.id, `Florian asked in the thread "${thread.title}" for this to be spun off into a thread of its own. The task for this thread:\n\n${String(task).trim()}`, { auto: true });
    log(`thread "${thread.title}" spun off "${copy.title}"`);
    return `Started the thread "${copy.title}". It works by itself from here, and Florian finds it in his inbox when it is ready. Do not do that task in this thread.`;
  };

  // Code. A thread on a project with a `repo:` line starts out with that repo; Claude
  // opens it (or any other repo of Florian's) when the work needs the code. Opening it
  // takes it for this turn: one thread at a time per repo.
  const repoDir = () => {
    const t = store.getThread(threadId);
    return t?.repo && repos.holder(t.repo) === threadId ? repos.dirOf(t.repo) : null;
  };
  const repoTools = {
    open: async (input) => {
      const full = repos.repoName(input || store.getThread(threadId)?.repo);
      if (!full) throw new Error(input ? `"${input}" is not a repo name. Give it as owner/name or just the name.` : 'Name the repo to open.');
      const before = store.getThread(threadId);
      if (before.repo && repos.holder(before.repo) === threadId && before.repo.toLowerCase() !== full.toLowerCase()) {
        await repos.saveWork(threadId);
        await repos.autoPush(threadId);
        repos.release(before.repo, threadId);
      }
      const other = repos.holder(full);
      if (other && other !== threadId) {
        activity(`Waiting for ${full}: ${repos.holderName(full) || 'another thread'} is working in it`);
        const got = await repos.acquire(full, threadId, { timeoutMs: 20 * 60_000 });
        if (!got) throw new Error(`${full} is still in use by ${repos.holderName(full) || 'another thread'}. Tell Florian; he can come back to this when it is done.`);
      } else await repos.acquire(full, threadId);
      if (abort.signal.aborted) { repos.release(full, threadId); throw new Error('Stopped.'); }
      activity(`Opening ${full}`);
      try {
        const { dir, branch, base } = await repos.openFor(threadId, full);
        store.updateThread(threadId, { repoSet: true });
        return { dir, branch, base, full };
      } catch (err) {
        repos.release(full, threadId);
        throw err;
      }
    },
    rename: async ({ repo, new_name: name }) => {
      const to = await repos.rename(repo, name);
      store.appendMessage(threadId, { role: 'user', event: true, auto: true, text: `[Claude renamed the GitHub repo ${repos.repoName(repo)} to ${to} on ${dateTimeDMY(Date.now())}. Notes in the vault that name the old repo need the new name.]` });
      return to;
    },
    create: async ({ name, private: isPrivate, description }) => {
      const full = await repos.create(name, { isPrivate, description });
      store.appendMessage(threadId, { role: 'user', event: true, auto: true, text: `[Claude created the GitHub repo ${full} (${isPrivate === false ? 'public' : 'private'}) on ${dateTimeDMY(Date.now())}.]` });
      return full;
    },
    describe: ({ repo, description }) => repos.describe(repo, description),
    list: () => repos.list(),
  };

  // What he added while Claude was working: started only once this turn has cleaned up,
  // so the cleanup below never takes the new turn's slot, repo or secrets with it.
  let followUp = '';
  try {
    activity('Getting the vault up to date');
    await brain.refresh();
    await secrets.refreshSecrets();
    // A project renamed in the vault keeps its threads, this one included.
    try { followRenames(); } catch { /* the thread runs without it */ }
    // The project's repo, once: after that the thread's own choice counts.
    if (!thread.repoSet && thread.project) {
      const r = repos.repoName(repoOf(thread.project));
      store.updateThread(threadId, { repoSet: true, ...(r ? { repo: r } : {}) });
    }
    activity('Starting');
    const tier = await tierFor(threadId, prompt);
    store.updateThread(threadId, { lastTier: tier.name }, { quiet: true });

    const base = {
      cwd: brain.brainDir(),
      systemAppend: threadInstructions(store.getThread(threadId)),
      repoDir,
      reposDir: config.reposDir,
      repoTools,
      model: tier.model,
      effort: tier.effort,
      mode: 'thread',
      artifactsDir,
      workDir,
      showFile,
      readDirs: [store.uploadsDir(threadId)],
      protectedPaths: config.protectedPaths,
      shell: config.threadShell,
      artifactsShell: config.artifactsShell !== false,
      piShell: config.pi?.enabled === false ? undefined : piShell,
      moveEvent: (args) => moveEvent({ ref: args.event, start: args.start, end: args.end, where: args.where, fromThreadId: threadId }),
      signal: abort.signal,
      title: thread.title,
      fake: config.fake,
      onEvent,
      spinOff,
      continueLater,
      // His secrets reach a script on the workbench as APP_SECRET_<NAME>, and his
      // encrypted documents through use_document. Only when this computer has the key.
      ...(secrets.secretsEnabled() ? { secretsKey: threadId, useDocument } : {}),
      mcpServers: !config.fake && google.googleConnected() ? { google: await google.buildGoogleServer({
        // An invitation went out to other people: the thread says so, for him and for the brain update.
        onInvite: ({ title, start, invited }) => store.appendMessage(threadId, { role: 'user', event: true, auto: true, text: `[Claude added "${title}" (${String(start).slice(0, 16).replace('T', ' ')}) to the calendar on ${dateTimeDMY(Date.now())}, and Google sent an invitation to: ${invited.join(', ')}.]` }),
        // A mail attachment goes onto this thread's workbench, never into the vault.
        saveAttachment: async (file, where) => {
          const { file: saved, again } = store.saveMailFile(threadId, file, where);
          return {
            path: saved,
            name: path.basename(saved),
            type: file.type,
            size: file.data.length,
            mail: `"${file.mail.subject}" from ${file.mail.from}, ${file.mail.date}`,
            note: `${again ? 'Already downloaded in this thread. ' : ''}On the workbench, not shown to Florian: show_file hands it to him (and makes it usable as an attach: line). It goes into the vault's Files/ only when he asks for that; the brain update does it.`,
          };
        },
      }) } : undefined,
    };
    // No session yet but a conversation already: start from its text.
    const cold = !thread.sessionId && store.readMessages(threadId).length > 1;
    let result = await runAgent({ ...base, prompt: cold ? recap(threadId, prompt) : prompt, resume: thread.sessionId || undefined });
    if (thread.sessionId && result.error && /no conversation found|session.*(not found|does not exist)/i.test(result.error)) {
      log(`session ${thread.sessionId} is gone; continuing thread ${threadId} from its transcript`);
      run.parts.length = 0;
      store.updateThread(threadId, { sessionId: null });
      result = await runAgent({ ...base, prompt: recap(threadId, prompt), resume: undefined });
    }

    // How big the conversation is now and when it was last read: Claude keeps what it
    // has read ready for an hour, per model (stickyTier below).
    store.updateThread(threadId, { turnEndedAt: Date.now(), ...(result.context ? { contextTokens: result.context } : {}) }, { quiet: true });
    recordArtifacts();
    // What was never shown leaves the artifacts folder for the workbench.
    try { store.tidyArtifacts(threadId); } catch { /* next turn */ }
    // Claude Code puts an error into the reply as text too; it is shown once, as the error.
    const repeatsError = (p) => result.error && p.type === 'text' && result.error.includes(p.text.trim());
    const parts = run.parts.filter((p) => (p.type !== 'text' || p.text.trim()) && !repeatsError(p));
    const message = { role: 'assistant', parts, durationMs: result.durationMs, tier: tier.name };
    // Cut off by the usage limit (and not stopped by him): held, not failed.
    const limited = result.limit && !result.aborted ? result.limit : null;
    const again = heldPrompt.get(threadId);
    heldPrompt.delete(threadId);
    if (result.aborted) { message.stopped = true; store.updateThread(threadId, { stoppedAt: Date.now() }, { quiet: true }); }
    if (limited) message.limit = { type: limited.type || '' };
    else if (result.error) message.error = result.error;
    if (parts.length || message.error || message.stopped) store.appendMessage(threadId, message);

    // The repo is saved and given back before the thread shows as ready, so nothing
    // Florian does next (another repo, merging) meets a turn still holding it.
    // The branch goes to GitHub by itself, so the work is not on this computer only.
    await repos.saveWork(threadId).catch(() => {});
    await repos.autoPush(threadId).catch(() => {});
    repos.releaseAll(threadId);
    // Ended on an error, or Claude asked to look again later: it carries on by itself
    // (retry.js), unless he added something meanwhile (that goes first) or a safety
    // handle is reached.
    const latest = store.getThread(threadId);
    const plan = !limited && !result.aborted && latest && !(latest.pending || []).length
      ? retry.turnPlan({ auto: latest.auto, error: result.error, carryOn: run.carryOn, didWork: parts.some((p) => p.type === 'tool'), opts: config.autoRetry })
      : null;
    if (plan?.kind) {
      // Like a hold for the usage limit: half-done work is not merged into main meanwhile.
      running.delete(threadId);
      store.updateThread(threadId, { auto: plan.auto }, { quiet: true });
      holdAuto(threadId, { kind: plan.kind, until: plan.until, reason: plan.reason, prompt: again?.prompt || prompt, tier: tier.name, tries: plan.tries });
      return;
    }
    if (plan?.stop) {
      store.updateThread(threadId, { auto: plan.auto }, { quiet: true });
      store.appendMessage(threadId, { role: 'user', event: true, auto: true, text: `[The app stopped carrying on by itself: ${plan.stop}. Send a message to pick it up again.]` });
      log(`thread "${latest.title}": stopped carrying on by itself (${plan.stop})`);
    }
    if (limited) {
      // The work so far is on its branch on GitHub, but half-done work is not merged into
      // main. What he added meanwhile stays in `pending` and goes in with the next try.
      running.delete(threadId);
      hold(threadId, limited, { prompt: again?.prompt || prompt, tier: tier.name, tries: again?.tries || 0 });
      return;
    }
    // Tested and merged into main by itself, in the background (ship.js).
    ship.afterTurn(threadId).catch(() => {});
    const fresh = store.getThread(threadId);
    // Deleted while Claude was working: nothing is left to update.
    if (!fresh) return;
    const pending = fresh.pending || [];
    // With a follow-up the slot stays taken until the cleanup hands it over, so a message
    // sent meanwhile is added to it rather than starting a second turn.
    const followsUp = pending.length && !result.aborted;
    if (!followsUp) running.delete(threadId);
    if (followsUp) {
      // What he added while Claude was working belongs to that work: it runs on the
      // same tier, without asking him or the picker again.
      store.updateThread(threadId, { pending: [], nextTier: fresh.nextTier || fresh.lastTier || '' });
      followUp = pending.join('\n\n');
    } else {
      const lastText = parts.filter((p) => p.type === 'text').at(-1)?.text || '';
      // "Send and done": the thread closes with Claude's answer in it. If the turn went
      // wrong or was stopped, it comes back to the inbox instead, so he sees it.
      const close = fresh.doneAfter && !result.error && !result.aborted;
      store.updateThread(threadId, {
        state: close ? 'done' : 'ready',
        ...(close ? { doneAt: Date.now() } : { queuedAt: Date.now() }),
        doneAfter: false,
        requeuedAt: 0,
        activity: '',
        pending: [],
        error: result.error || '',
        gist: lastText.replace(/[#*_`>|\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(-220),
      });
      // Named and sorted after the first answer, and once more when it closes.
      if (!result.error && !result.aborted) sign(threadId, { again: close }).catch(() => {});
      if (close) return;
      const walking = Date.now() - voiceActivity.at < 2 * 60 * 60_000;
      if (config.voice.enabled || walking) spokenDigest(threadId, walking ? voiceActivity.lang : 'en').catch(() => {});
    }
  } finally {
    // What a turn decrypted is gone once it ends.
    secrets.dropEnvFile(threadId);
    try { fs.rmSync(decryptedDir, { recursive: true, force: true }); } catch { /* next turn */ }
    // What Claude left uncommitted goes onto the thread's branch, and the repo is free again.
    await repos.saveWork(threadId).catch(() => {});
    await repos.autoPush(threadId).catch(() => {});
    repos.releaseAll(threadId);
    running.delete(threadId);
    emitLive({ op: 'end' });
    // The follow-up takes the slot this turn had; the waiting line moves only if it is free.
    if (followUp && store.getThread(threadId)) { startTurn(threadId, followUp); if (!slotFree(false)) return; }
    // His own messages first; background work only into a slot it may have.
    let i = waiting.findIndex((w) => !w.background);
    if (i < 0 && waiting.length && slotFree(true)) i = 0;
    if (i >= 0) { const [next] = waiting.splice(i, 1); startTurn(next.threadId, next.prompt, next.background); }
  }
}

// ---------- a merge that failed: fixed by itself ----------
//
// ship.js calls this when the branch could not go into main. Returns what the app does
// about it, for the note in the thread: { fix: true } (a turn fixes it, then the merge
// runs again), { remerge: at } (only the merge runs again), { stop: why }, or null.
export function mergeFailed(threadId, { failure, detail = '' }) {
  const t = store.getThread(threadId);
  if (!t || !failure) return null;
  if (t.state === 'working' || isRunning(threadId)) return null; // he answered: that turn's end merges again
  const plan = retry.mergePlan({ auto: t.auto, failure, opts: config.autoRetry });
  if (!plan) return null;
  if (plan.stop) return { stop: plan.stop };
  if (plan.kind === 'remerge') {
    store.updateThread(threadId, { auto: plan.auto, remerge: { at: plan.at } });
    return { remerge: plan.at };
  }
  store.updateThread(threadId, { auto: plan.auto }, { quiet: true });
  const prompt = retry.mergeFixPrompt({ repo: t.repo, branch: t.repoBranch, main: t.repoMain || 'main', failure, detail });
  holdAuto(threadId, { kind: 'merge', until: plan.until, reason: failure === 'clash' ? 'main clashes with the branch' : 'the tests failed', prompt, tier: t.lastTier || '', tries: plan.tries });
  return { fix: true };
}

// ---------- for calls: a reply as something to listen to ----------

const digesting = new Map(); // threadId -> promise

function plainSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The spoken version of a thread's latest reply, in the language the listener speaks.
// Made once per reply and kept with the thread, so it can be read out without waiting
// for a model.
const LANGUAGES = { en: 'English', de: 'German' };

export function spokenDigest(threadId, lang = 'en') {
  const thread = store.getThread(threadId);
  if (!thread) return Promise.resolve('');
  if (thread.spoken && thread.spoken.at === thread.messageCount && (thread.spoken.lang || 'en') === lang) return Promise.resolve(thread.spoken.text);
  const key = `${threadId}:${lang}`;
  if (digesting.has(key)) return digesting.get(key);
  const job = (async () => {
    const at = thread.messageCount;
    const last = store.readMessages(threadId).filter((m) => m.role === 'assistant').at(-1);
    if (!last) return '';
    let text;
    if (last.error && !(last.parts || []).length) {
      text = lang === 'de'
        ? 'Claude hat in diesem Thread mit einem Fehler aufgehört. Schau ihn dir am Bildschirm an.'
        : 'Claude stopped with an error in this thread. Have a look at it on a screen.';
    } else {
      const reply = messageText(last);
      const result = await runAgent({
        prompt: `The reply to turn into speech:\n\n---\n\n${reply.slice(0, 30_000)}`,
        cwd: DATA_DIR,
        systemAppend: readPrompt('digest.md', { language: LANGUAGES[lang] || 'English' }),
        model: config.voice.digestModel,
        mode: 'plain',
        fake: config.fake,
      });
      // If the model is unavailable, the start of the reply itself is better than silence.
      text = plainSpeech(result.finalText || result.text) || `${plainSpeech(reply).slice(0, 500)}`;
    }
    store.updateThread(threadId, { spoken: { at, text, lang } });
    return text;
  })().finally(() => digesting.delete(key));
  digesting.set(key, job);
  return job;
}

// ---------- a thread's signature: its name, its project, its type ----------
//
// After its first answer, and once more when Florian closes or defers it, a small model
// reads the conversation and says what the thread is about: a name by its topic, the
// project or area it belongs to, and what kind of work it is. What Florian set himself
// always stands: a name he typed, a project he filed it under.
//
//   titleAuto    the name is still the app's (the first line, or one it gave)
//   projectSet   he chose the project himself
//   projectAuto  the app chose the project, so it may choose again
//   type         thinking | mail | build | document | question (threads he started)
//   signedAt     how many messages the thread had when it was last signed

export const THREAD_TYPES = ['thinking', 'mail', 'build', 'document', 'question'];
const signing = new Set();
const NO_GUESS = new Set(['card', 'brain-update']);

const speaker = (m) => (m.role === 'user' ? (m.auto ? 'The app' : 'Florian') : 'Claude');
const firstOwnLine = (messages) => messages.find((m) => m.role === 'user' && !m.auto);

// Whether the app may rename it. Threads from before `titleAuto` existed count as the
// app's when the name is still the first line of his first message.
function mayRename(thread, messages) {
  if (thread.kind !== 'chat') return false;
  if (typeof thread.titleAuto === 'boolean') return thread.titleAuto;
  const first = firstOwnLine(messages);
  return Boolean(first) && thread.title === titleFrom(messageText(first) || 'Attached files');
}

// Whether the app may choose the project: never over his own choice. A thread from
// before `projectSet` existed keeps a project it has, unless he started it himself, in
// which case the model is told what it is filed under and to change it only if wrong.
function mayFile(thread) {
  if (NO_GUESS.has(thread.kind) || thread.projectSet) return false;
  return !thread.project || thread.projectAuto === true || (thread.projectAuto === undefined && thread.kind === 'chat');
}

export async function sign(threadId, { again = false } = {}) {
  const thread = store.getThread(threadId);
  if (!thread || NO_GUESS.has(thread.kind) || signing.has(threadId)) return null;
  const count = thread.messageCount || 0;
  if (thread.signedAt && (!again || thread.signedAt >= count)) return null;
  const messages = store.readMessages(threadId);
  const picked = messages.length > 7 ? [...messages.slice(0, 2), ...messages.slice(-5)] : messages;
  const said = picked.map((m) => `${speaker(m)}: ${messageText(m).slice(0, 1200)}`).join('\n\n');
  if (!said.trim()) return null;
  const rename = mayRename(thread, messages);
  const file = mayFile(thread);
  const typed = thread.kind === 'chat';
  const choices = file ? projectChoices() : [];
  if (!rename && !typed && !choices.length) {
    // Nothing to ask. If only the vault's list was missing, it is tried again later.
    if (!file) store.updateThread(threadId, { signedAt: count, projectGuessed: true });
    return null;
  }
  // The stored thread is one object that changes in place: what it says now is kept, to
  // see afterwards whether he renamed or filed it while the model was reading.
  const before = { title: thread.title, project: thread.project || '' };
  signing.add(threadId);
  try {
    let answer = {};
    if (config.fake) {
      // The stand-in: a project whose name Florian's side mentions; the name stays.
      const text = `${thread.title}\n${messages.filter((m) => m.role === 'user').map((m) => messageText(m)).join('\n')}`.toLowerCase();
      answer = {
        project: choices.map((c) => c.name).sort((a, b) => b.length - a.length).find((n) => text.includes(n.toLowerCase())) || 'none',
        type: /\bmail\b|draft a note/.test(text) ? 'mail' : /strategy|think|decide/.test(text) ? 'thinking' : /\bcode\b|repo|build|tracker/.test(text) ? 'build' : 'question',
      };
    } else {
      const result = await runAgent({
        prompt: readPrompt('sign.md', {
          title: thread.title,
          project: thread.project || 'none',
          projects: choices.length ? choices.map((c) => `- ${c.line}`).join('\n') : '(not asked: answer "keep")',
          conversation: said,
        }),
        cwd: DATA_DIR,
        systemAppend: 'You label threads of a personal work app. Answer with one JSON object and nothing else.',
        model: config.queue?.pickModel || 'haiku',
        mode: 'plain',
        usageKind: 'plain',
        fake: false,
      });
      const json = /\{[\s\S]*\}/.exec(result.finalText || result.text || '');
      try { answer = json ? JSON.parse(json[0]) : {}; } catch { answer = {}; }
    }
    const fresh = store.getThread(threadId);
    if (!fresh) return null;
    const patch = { signedAt: count, projectGuessed: true };
    const title = String(answer.title || '').replace(/[#*_`\[\]"\n]/g, '').trim().slice(0, 80);
    if (rename && title && fresh.titleAuto !== false && fresh.title === before.title) { patch.title = title; patch.titleAuto = true; }
    if (typed && THREAD_TYPES.includes(String(answer.type || '').toLowerCase())) patch.type = String(answer.type).toLowerCase();
    const named = String(answer.project || '').trim().replace(/^["'`*]+|["'`*.]+$/g, '');
    const match = choices.find((c) => c.name.toLowerCase() === named.toLowerCase());
    if (file && !fresh.projectSet && (fresh.project || '') === before.project) {
      if (match && match.name !== fresh.project) {
        patch.project = match.name;
        patch.projectAuto = true;
        if (!fresh.repo) { const repo = repoOf(match.name); if (repo) patch.repo = repo; }
        log(`thread "${patch.title || fresh.title}" is about ${match.name}`);
      } else if (/^none$/i.test(named) && fresh.project && fresh.projectAuto) {
        patch.project = '';
      }
    }
    return store.updateThread(threadId, patch);
  } finally {
    signing.delete(threadId);
  }
}

// The threads that were there before this, and any that missed it: one at a time, in
// the background. Archived threads are left as they are.
export async function backfillSignatures() {
  const todo = store.listThreads().filter((t) => !t.signedAt && !t.hidden && !NO_GUESS.has(t.kind) && !t.archived && (t.messageCount || 0) >= 2 && t.state !== 'working');
  for (const t of todo) await sign(t.id).catch(() => {});
  return todo.length;
}

// ---------- how much a message is worth ----------
//
// Florian's five tiers, from cheap to extra. He either picks one when sending (quick
// select) or a cheap model reads the message and picks, so he never has to choose. What
// was used is shown in the thread's header, and "Again, higher" runs the same message
// one tier up and keeps that tier for the thread (`keepTier`). Until 13-11-2026 a tier
// could also be fixed per thread (`tier`) or for everything; neither is read any more,
// so threads from then behave like all others.

function tierOf(name) { return { name, ...TIERS[name] }; }

// Auto picks a tier per message, but changing the model in the middle of a conversation
// has a price of its own. Claude keeps what it has read ready for an hour, per model, and
// reading it from there costs a twentieth (Opus) or a fortieth (Fable) of reading it fresh. A turn on the other model
// finds nothing ready and reads the whole conversation again, at full price, and writes it
// down once more. Measured over 13 to 18-11-2026: 18 of 21 such turns did, about an eighth
// of everything threads used; stepping down from Fable to Opus for an easy message cost
// more than the easy message saved. The effort can change freely (3 of 36 did).
// So while a conversation of some size is still ready, Auto does not step down to the
// cheaper model: it takes the current model's lowest tier instead. Stepping up stays, since
// that is asked for by what the message needs. His own choice (quick select, "Again,
// higher") is never touched.
const READY_MS = 55 * 60_000;
const WORTH_KEEPING = 30_000; // tokens
export function stickyTier(pick, thread, now = Date.now()) {
  const last = thread?.lastTier;
  if (!TIER_NAMES.includes(pick) || !TIER_NAMES.includes(last) || !thread.sessionId) return pick;
  if (TIERS[pick].model === TIERS[last].model || TIER_NAMES.indexOf(pick) > TIER_NAMES.indexOf(last)) return pick;
  if (now - (thread.turnEndedAt || 0) > READY_MS || (thread.contextTokens || 0) < WORTH_KEEPING) return pick;
  return TIER_NAMES.find((n) => TIERS[n].model === TIERS[last].model);
}

export async function tierFor(threadId, prompt) {
  const thread = store.getThread(threadId);
  // Chosen for this one message when sending (quick select), then forgotten.
  // Read it before clearing it: the stored thread is the same object.
  const once = thread?.nextTier || '';
  if (TIER_NAMES.includes(once)) {
    store.updateThread(threadId, { nextTier: '' }, { quiet: true });
    return tierOf(once);
  }
  if (TIER_NAMES.includes(thread?.keepTier)) return tierOf(thread.keepTier);
  const messages = store.readMessages(threadId);
  const earlier = messages.slice(-5, -1).map((m) => `${m.role === 'user' ? 'Florian' : 'Claude'}: ${messageText(m).slice(0, 400)}`).join('\n');
  let answer = '';
  try {
    if (config.fake) {
      const text = String(prompt).toLowerCase();
      answer = /strategy|negotiat|concept|paper/.test(text) ? 'high' : /quick|short|typo|look up/.test(text) ? 'cheap' : 'default';
    } else {
      const result = await runAgent({
        prompt: readPrompt('route.md', {
          tiers: TIER_NAMES.map((n) => `- ${n}: ${TIERS[n].about}`).join('\n'),
          title: thread?.title || 'new',
          project: thread?.project || 'none',
          history: earlier ? `What was said before:\n\n${earlier}` : 'Nothing was said before; this starts the thread.',
          message: String(prompt).slice(0, 4000),
        }),
        cwd: DATA_DIR,
        systemAppend: 'You answer with one word from the list and nothing else.',
        model: config.routeModel || 'haiku',
        mode: 'plain',
        usageKind: 'plain',
        fake: false,
      });
      answer = String(result.finalText || result.text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    }
  } catch { /* the default carries the turn */ }
  const pick = TIER_NAMES.includes(answer) ? answer : 'default';
  const kept = stickyTier(pick, thread);
  if (kept !== pick) log(`thread "${thread?.title}": stays on ${TIERS[kept].model} (${Math.round((thread.contextTokens || 0) / 1000)}k tokens still ready); Auto had picked ${pick}`);
  return tierOf(kept);
}

// The same message again, one tier higher, pinned on the thread from now on.
export function againHigher(threadId) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('No such thread');
  if (thread.state === 'working') throw new Error('Claude is still working on this thread.');
  const messages = store.readMessages(threadId);
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) throw new Error('There is nothing to run again here.');
  const at = TIER_NAMES.indexOf(thread.lastTier);
  const next = TIER_NAMES[Math.min(TIER_NAMES.length - 1, (at < 0 ? 2 : at) + 1)];
  store.updateThread(threadId, { keepTier: next, nextTier: '' });
  startTurn(threadId, promptFor(threadId, messageText(last), last.files || []));
  return { thread: store.getThread(threadId), tier: next };
}
