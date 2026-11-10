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
import { getState } from './state.js';
import { projectContext } from './projects.js';

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
// `files` are attachments already moved into the thread. `doneAfter` closes the thread
// once Claude has answered, instead of putting it back into the inbox.
export function sendMessage(threadId, text, { auto = false, files = [], doneAfter = false } = {}) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('No such thread');
  const stored = { role: 'user', text };
  if (auto) stored.auto = true;
  if (files.length) stored.files = files;
  const message = store.appendMessage(threadId, stored);
  const prompt = promptFor(threadId, text, files);
  // A plain message after "send and done" means he wants to see the answer after all.
  if (!auto) store.updateThread(threadId, { doneAfter });
  if (thread.state === 'working') {
    // Claude is still on the previous message: this one goes in as soon as that turn ends.
    store.updateThread(threadId, { pending: [...(thread.pending || []), prompt] });
    return message;
  }
  startTurn(threadId, prompt);
  return message;
}

function startTurn(threadId, prompt) {
  store.updateThread(threadId, { state: 'working', error: '', archived: false, activity: 'Starting' });
  if (running.size >= config.maxParallel) {
    waiting.push({ threadId, prompt });
    store.updateThread(threadId, { activity: 'Waiting for a free slot' }, { quiet: true });
    return;
  }
  runTurn(threadId, prompt).catch((err) => {
    log(`turn failed unexpectedly: ${err.stack || err.message}`);
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
  return readPrompt('thread.md', {
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

  try {
    activity('Getting the vault up to date');
    await brain.refresh();
    activity('Starting');

    const base = {
      cwd: brain.brainDir(),
      systemAppend: threadInstructions(thread),
      model: getState().model,
      effort: getState().effort,
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
      if (close) return;
      const walking = Date.now() - voiceActivity.at < 2 * 60 * 60_000;
      if (config.voice.enabled || walking) spokenDigest(threadId, walking ? voiceActivity.lang : 'en').catch(() => {});
    }
  } finally {
    running.delete(threadId);
    emitLive({ op: 'end' });
    const next = waiting.shift();
    if (next) startTurn(next.threadId, next.prompt);
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
