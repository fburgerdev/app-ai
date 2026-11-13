// Moves threads through their states.
//
//   ready    Claude has finished; the thread waits in the inbox for Florian
//   working  Claude is on it
//   done     Florian closed it
//
// A message Florian sends makes a thread "working"; the end of Claude's turn makes it
// "ready" again and puts it at the back of the inbox.

import { runAgent } from './agent.js';
import * as brain from './brain.js';
import * as store from './store.js';
import { DATA_DIR, log } from './config.js';
import * as google from './google.js';
import { logRead, logToolRead } from './reads.js';
import path from 'node:path';
import { messageText, readPrompt, todayLine, dateTimeDMY, voiceActivity } from './util.js';
import { getState, TIERS, TIER_NAMES } from './state.js';
import { projectContext, repoOf, projectChoices } from './projects.js';
import * as repos from './repos.js';
import * as repair from './repair.js';

let config;
const running = new Map(); // threadId -> { abort: AbortController, parts: [] }
const waiting = []; // threadIds waiting for a free slot

export function initRunner(cfg) {
  config = cfg;
}

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
  // A message into a deferred thread wakes it again.
  if (!auto) store.updateThread(threadId, { doneAfter: false, deferred: false });
  // What he sent with "send and done" goes in first, so Claude has it too.
  const withUnsent = [...(thread.unsent || []), prompt].join('\n\n');
  if (thread.unsent?.length) store.updateThread(threadId, { unsent: [] });
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
  store.updateThread(threadId, { state: 'working', error: '', archived: false, activity: 'Starting' });
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
    store.updateThread(threadId, { state: 'ready', queuedAt: Date.now(), activity: '', error: err.message });
  });
}

export function stopTurn(threadId) {
  const idx = waiting.findIndex((w) => w.threadId === threadId);
  if (idx >= 0) {
    waiting.splice(idx, 1);
    store.updateThread(threadId, { state: 'ready', queuedAt: Date.now(), activity: '', pending: [] });
    return true;
  }
  const run = running.get(threadId);
  if (!run) return false;
  run.abort.abort();
  return true;
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
  let body = lines.join('\n\n');
  if (body.length > 60_000) body = `(the beginning is cut)\n\n${body.slice(-60_000)}`;
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

  const recordArtifacts = () => {
    for (const { name, v } of store.scanArtifacts(threadId)) {
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
    } else if (ev.type === 'tool-result') {
      recordArtifacts();
    } else if (ev.type === 'activity') {
      activity(ev.text);
    }
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
        repos.release(before.repo, threadId);
      }
      const other = repos.holder(full);
      if (other && other !== threadId) {
        activity(`Waiting for ${full}: "${store.getThread(other)?.title || 'another thread'}" is working in it`);
        const got = await Promise.race([repos.acquire(full, threadId), new Promise((r) => setTimeout(() => r(false), 20 * 60_000))]);
        if (!got) throw new Error(`${full} is still in use by the thread "${store.getThread(repos.holder(full))?.title}". Tell Florian; he can come back to this when that thread is done.`);
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

  try {
    activity('Getting the vault up to date');
    await brain.refresh();
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
      artifactsDir: store.artifactsDir(threadId),
      readDirs: [store.uploadsDir(threadId)],
      protectedPaths: config.protectedPaths,
      shell: config.threadShell,
      signal: abort.signal,
      title: thread.title,
      fake: config.fake,
      onEvent,
      spinOff,
      mcpServers: !config.fake && google.googleConnected() ? { google: await google.buildGoogleServer() } : undefined,
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

    recordArtifacts();
    // Claude Code puts an error into the reply as text too; it is shown once, as the error.
    const repeatsError = (p) => result.error && p.type === 'text' && result.error.includes(p.text.trim());
    const parts = run.parts.filter((p) => (p.type !== 'text' || p.text.trim()) && !repeatsError(p));
    const message = { role: 'assistant', parts, durationMs: result.durationMs };
    if (result.aborted) message.stopped = true;
    if (result.error) message.error = result.error;
    if (parts.length || message.error || message.stopped) store.appendMessage(threadId, message);

    // The repo is saved and given back before the thread shows as ready, so nothing
    // Florian does next (another repo, merging) meets a turn still holding it.
    await repos.saveWork(threadId).catch(() => {});
    repos.releaseAll(threadId);
    if (store.getThread(threadId)?.kind === 'repair') repair.afterTurn(threadId).catch(() => {});
    const fresh = store.getThread(threadId);
    const pending = fresh.pending || [];
    running.delete(threadId);
    if (pending.length && !result.aborted) {
      store.updateThread(threadId, { pending: [] });
      startTurn(threadId, pending.join('\n\n'));
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
    // What Claude left uncommitted goes onto the thread's branch, and the repo is free again.
    await repos.saveWork(threadId).catch(() => {});
    repos.releaseAll(threadId);
    running.delete(threadId);
    emitLive({ op: 'end' });
    // His own messages first; background work only into a slot it may have.
    let i = waiting.findIndex((w) => !w.background);
    if (i < 0 && waiting.length && slotFree(true)) i = 0;
    if (i >= 0) { const [next] = waiting.splice(i, 1); startTurn(next.threadId, next.prompt, next.background); }
  }
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
  return tierOf(TIER_NAMES.includes(answer) ? answer : 'default');
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
