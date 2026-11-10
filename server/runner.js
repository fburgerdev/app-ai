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
import { log } from './config.js';
import { messageText, readPrompt, todayLine, dateTimeDMY } from './util.js';

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

// Florian sends a message. Returns the stored message.
export function sendMessage(threadId, text) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('No such thread');
  const message = store.appendMessage(threadId, { role: 'user', text });
  if (thread.state === 'working') {
    // Claude is still on the previous message: this one goes in as soon as that turn ends.
    store.updateThread(threadId, { pending: [...(thread.pending || []), text] });
    return message;
  }
  startTurn(threadId, text);
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
  return readPrompt('thread.md', {
    today: todayLine(),
    artifactsDir: store.artifactsDir(thread.id),
    preload: preloadText,
  });
}

// When Claude Code no longer has the session on disk, the conversation so far is handed
// over as text instead, so the thread carries on rather than failing.
function recap(threadId, newPrompt) {
  const earlier = store.readMessages(threadId).slice(0, -1);
  const lines = earlier.map((m) => `### ${m.role === 'user' ? 'Florian' : 'Claude'}, ${dateTimeDMY(m.ts)}\n\n${messageText(m)}`);
  let body = lines.join('\n\n');
  if (body.length > 60_000) body = `(the beginning is cut)\n\n${body.slice(-60_000)}`;
  return `This thread's earlier session could not be reopened, so here is the conversation so far.\n\n${body}\n\n---\n\nFlorian's new message:\n\n${newPrompt}`;
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
    } else if (ev.type === 'tool-result') {
      recordArtifacts();
    } else if (ev.type === 'activity') {
      activity(ev.text);
    }
  };

  try {
    activity('Getting the vault up to date');
    await brain.refresh();
    activity('Starting');

    const base = {
      cwd: brain.brainDir(),
      systemAppend: threadInstructions(thread),
      model: config.model,
      mode: 'thread',
      artifactsDir: store.artifactsDir(threadId),
      protectedPaths: config.protectedPaths,
      shell: config.threadShell,
      signal: abort.signal,
      title: thread.title,
      fake: config.fake,
      onEvent,
    };
    let result = await runAgent({ ...base, prompt, resume: thread.sessionId || undefined });
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
      store.updateThread(threadId, {
        state: 'ready',
        queuedAt: Date.now(),
        activity: '',
        pending: [],
        error: result.error || '',
      });
    }
  } finally {
    running.delete(threadId);
    emitLive({ op: 'end' });
    const next = waiting.shift();
    if (next) startTurn(next.threadId, next.prompt);
  }
}
