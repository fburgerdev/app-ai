// Next Actions as sleeping threads.
//
// A line in Brain/Next Actions.md and a thread in the inbox are two states of the same
// to-do: asleep ("I will do this, not now") and awake ("I am working on it").
//
//   wake    Florian starts a line: it becomes a thread in the inbox, opening with a
//           brief. The line leaves the sleeping list at once and is taken out of the
//           file by the next brain update.
//   defer   Florian puts a thread to sleep: it is closed, and the next brain update
//           files what it produced, writes its to-do into Next Actions.md under its
//           project (with where he left off), and deletes the thread.
//
// The file stays the record. The app only remembers which lines are awake until the
// brain update has taken them out. His click is the confirmation the vault asks for.

import fs from 'node:fs';
import * as brain from './brain.js';
import * as store from './store.js';
import * as runner from './runner.js';
import { isKnownProject } from './projects.js';
import { readPrompt } from './util.js';

const FILE = 'Brain/Next Actions.md';
const unlink = (s) => s.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');

export function parse(text) {
  const out = [];
  let project = '';
  for (const line of String(text).split(/\r?\n/)) {
    const head = /^##\s+(.*)$/.exec(line);
    if (head) { project = unlink(head[1]).trim(); continue; }
    const item = /^[-*]\s+\[ \]\s+(.*)$/.exec(line);
    if (item) out.push({ project, text: item[1].trim(), show: unlink(item[1]).trim() });
  }
  return out;
}

const awake = () => store.listThreads().filter((t) => t.nextAction && !t.nextAction.removed);

export function list() {
  const file = brain.readVaultFile(FILE);
  const lines = file ? parse(fs.readFileSync(file.full, 'utf8')) : [];
  const woken = new Set(awake().map((t) => t.nextAction.text));
  return {
    actions: lines.filter((l) => !woken.has(l.text)),
    // Put to sleep, waiting for the brain update to write their line.
    deferred: store.listThreads().filter((t) => t.deferred && !t.archived).map((t) => ({ id: t.id, title: t.title, project: t.project || '' })),
  };
}

export function wake({ project, text }) {
  const file = brain.readVaultFile(FILE);
  const line = file && parse(fs.readFileSync(file.full, 'utf8')).find((l) => l.text === text && (!project || l.project === project));
  if (!line) throw new Error('That line is not in Next Actions any more.');
  if (awake().some((t) => t.nextAction.text === line.text)) throw new Error('That one is already awake.');
  const thread = store.createThread({ title: line.show.slice(0, 100), kind: 'next-action', project: isKnownProject(line.project) ? line.project : '' });
  store.updateThread(thread.id, { nextAction: { text: line.text, project: line.project, wokenAt: Date.now(), removed: false }, projectGuessed: true });
  runner.sendMessage(thread.id, readPrompt('next-action.md', { text: line.show, project: line.project || 'no project' }), { auto: true });
  return store.getThread(thread.id);
}

export function defer(threadId, note = '') {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('No such thread');
  if (thread.state === 'working') throw new Error('Claude is still working on this thread.');
  if (note.trim()) store.appendMessage(threadId, { role: 'user', text: note.trim(), unanswered: true });
  return store.updateThread(threadId, { state: 'done', doneAt: Date.now(), deferred: true, deferredAt: Date.now(), archived: false, error: '', activity: '' });
}

// After a brain update that saw these threads: woken lines are out of the file, and
// deferred threads have become lines, so the threads go.
export function afterUpdate(changed) {
  for (const c of changed) {
    const t = store.getThread(c.thread.id);
    if (!t) continue;
    if (t.nextAction && !t.nextAction.removed) store.updateThread(t.id, { nextAction: { ...t.nextAction, removed: true } });
    if (c.thread.deferred && t.deferred && t.state === 'done' && (t.messageCount || 0) <= c.count) store.deleteThread(t.id);
  }
}
