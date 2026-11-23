// Threads, their messages and their artifacts, kept as plain files in the app's data
// folder so they can be inspected and backed up without any tool:
//
//   threads/<id>/thread.json      state of the thread
//   threads/<id>/messages.jsonl   one message per line
//   threads/<id>/artifacts/       the files Claude chose to show Florian, as they are now
//   threads/<id>/work/            Claude's workbench: scripts, installed libraries, pages
//                                 rendered on the way. Never shown, never synced.
//   threads/<id>/work/mail/       mail attachments Claude downloaded (see saveMailFile)
//   threads/<id>/versions/        every earlier state of each artifact
//   threads/<id>/artifacts.json   which versions exist

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { THREADS_DIR, log } from './config.js';

export const events = new EventEmitter();
events.setMaxListeners(100);

/** @type {Map<string, object>} */
const threads = new Map();

const threadDir = (id) => path.join(THREADS_DIR, id);
const metaFile = (id) => path.join(threadDir(id), 'thread.json');
const messagesFile = (id) => path.join(threadDir(id), 'messages.jsonl');
const artifactIndexFile = (id) => path.join(threadDir(id), 'artifacts.json');
export const artifactsDir = (id) => path.join(threadDir(id), 'artifacts');
export const uploadsDir = (id) => path.join(threadDir(id), 'uploads'); // files Florian attached
export const workDir = (id) => path.join(threadDir(id), 'work'); // Claude's workbench, never shown
const versionsDir = (id) => path.join(threadDir(id), 'versions');

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function newId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// Which computer this is. A thread that is working says which computer runs the turn
// (`workingOn`); only that computer can tell that the turn is gone. The other one only
// ever sees the saved copy of a turn that is still running there, and must leave it be:
// marking it "ended on an error" was wrong, and its copy then won over the real answer.
const HOST = os.hostname();
const mine = (meta) => !meta.workingOn || meta.workingOn === HOST;

// Loads every thread from disk. A turn this computer was running when the app closed
// cannot still be running, so its thread goes back to the inbox with a note. A turn the
// other computer runs is left as it is.
export function loadThreads() {
  threads.clear();
  if (!fs.existsSync(THREADS_DIR)) return;
  for (const id of fs.readdirSync(THREADS_DIR)) {
    const meta = readJson(metaFile(id), null);
    if (!meta || meta.id !== id) continue;
    // A turn held by the usage limit is not running anywhere: it waits, and stays as it is.
    if (meta.state === 'working' && mine(meta) && !meta.held) {
      meta.state = 'ready';
      meta.queuedAt = Date.now();
      meta.error = 'The app was closed while Claude was working on this. Send a message to pick it up again.';
      // The app carries on with it by itself once it runs again (runner.retryInterrupted).
      meta.interrupted = Date.now();
      meta.activity = '';
      meta.pending = [];
      writeJson(metaFile(id), meta);
    }
    // Left over from older versions: a tier fixed on the thread (no longer read), and a
    // tier picked for a message that started no turn, which the next message would get.
    delete meta.tier;
    if (meta.nextTier) meta.nextTier = '';
    // Background jobs of a turn that ran here ended with the app.
    if (meta.background?.length && mine(meta)) meta.background = [];
    // A merge into main this computer was in the middle of ended with the app too (Update
    // now, a crash, the laptop shut down): it is tried again by itself shortly
    // (runner.retryMerges), so a finished branch is never left behind. A merge already
    // planned for later keeps its time.
    if (meta.merging && (!meta.merging.on || meta.merging.on === HOST)) {
      log(`thread "${meta.title}": its merge into main was cut off when the app stopped; trying again by itself`);
      meta.remerge ||= { at: Date.now() + 30_000 };
      meta.merging = null;
      writeJson(metaFile(id), meta);
    }
    threads.set(id, meta);
  }
  log(`loaded ${threads.size} threads`);
}

// After the data folder took in what the other computer saved: threads are read from
// disk again. A thread Claude is working on right here keeps what is in memory.
const sizeSeen = new Map(); // thread id -> size of its conversation file when last read
export function reloadThreads() {
  const seen = new Set();
  if (fs.existsSync(THREADS_DIR)) {
    for (const id of fs.readdirSync(THREADS_DIR)) {
      const meta = readJson(metaFile(id), null);
      if (!meta || meta.id !== id) continue;
      seen.add(id);
      // Only a turn running on this computer keeps what is in memory. A turn the other
      // computer runs is shown as it saved it: working while it works, then its answer.
      // Keeping the old "working" copy here hid the finished turn, and settleOrphans()
      // later called it lost ("ended on an error") although the answer was there.
      // (A held turn is not being worked on: the other computer may have carried on with it.)
      const cur = threads.get(id);
      if (cur?.state === 'working' && !cur.held && mine(cur)) continue;
      threads.set(id, meta);
      // A conversation continued on both computers has more lines than either counted.
      // Only looked at when the conversation's file changed since the last time: this runs
      // for every thread whenever the other computer saved.
      let size = -1;
      try { size = fs.statSync(messagesFile(id)).size; } catch { /* no conversation yet */ }
      if (sizeSeen.get(id) === size) continue;
      sizeSeen.set(id, size);
      const all = readMessages(id);
      const count = all.length;
      if (count > (meta.messageCount || 0)) {
        meta.messageCount = count;
        meta.lastUserAt = count; // so the next brain update looks at it again
        // When he last wrote, from the lines themselves: the other computer's state does
        // not know a message sent here (runner.js looks for ones no turn took up).
        meta.lastUserTs = all.reduce((max, m) => (m.role === 'user' && !m.auto && (m.ts || 0) > max ? m.ts : max), meta.lastUserTs || 0);
        writeJson(metaFile(id), meta);
      }
    }
  }
  for (const [id, t] of threads) if (!seen.has(id) && t.state !== 'working') threads.delete(id);
  log(`reloaded ${threads.size} threads`);
}

// Turns that will never finish: they say this computer runs them but nothing here does
// (`isRunning` says what runs here), or the other computer that ran them is gone and this
// one does the work now (`otherGone`). Each goes back to the inbox with a note.
export function settleOrphans({ isRunning, otherGone = false, olderThanMs = 10 * 60_000 }) {
  const now = Date.now();
  let settled = 0;
  for (const t of threads.values()) {
    if (t.state !== 'working' || t.held || isRunning(t.id)) continue;
    const here = mine(t);
    if (!here && !(otherGone && now - (t.updatedAt || 0) > olderThanMs)) continue;
    // The other computer finished the turn and its answer is here, only its last state
    // did not arrive: the thread is simply ready, with no note.
    if (!here && finishedAnswer(t)) {
      updateThread(t.id, { state: 'ready', queuedAt: now, activity: '', pending: [], workingOn: '', error: '' });
      continue;
    }
    updateThread(t.id, {
      state: 'ready', queuedAt: now, activity: '', pending: [], workingOn: '',
      error: here ? 'The app was closed while Claude was working on this. Send a message to pick it up again.'
        : 'Claude was working on this on the other computer, which went away before it finished. Send a message to pick it up again.',
    });
    settled += 1;
  }
  return settled;
}

// Threads marked "ended on an error" by the bug fixed above, although their turn finished
// fine: the last message is Claude's complete answer. The note goes; once per thread.
// True when the thread's last message is Claude's complete answer.
function finishedAnswer(t) {
  const last = readMessages(t.id).at(-1);
  return last?.role === 'assistant' && !last.error && !last.stopped && (last.parts || []).length > 0;
}

// Also the threads the reload bug above marked "went away before it finished".
export function clearFalseErrors() {
  let cleared = 0;
  for (const t of threads.values()) {
    if (t.state !== 'ready' || !/^Claude was working on this on the other computer(,| when this one took over)/.test(t.error || '')) continue;
    if (finishedAnswer(t)) { updateThread(t.id, { error: '' }); cleared += 1; }
  }
  return cleared;
}

export function listThreads() {
  return [...threads.values()];
}

export function getThread(id) {
  return threads.get(id) || null;
}

// True when Florian has said something in the thread that no brain update has seen,
// his notes during an event included.
export function isUnfiled(thread) {
  return (thread.lastUserAt || 0) > (thread.extractedCount || 0)
    || Boolean(thread.notes?.text?.trim() && (thread.notes.ts || 0) > (thread.extractedAt || 0));
}

// A spin-off: a new thread that starts as a copy of another one's conversation and
// files. The copy counts as already seen by the brain update, which files those
// messages from the original; only what is said in the spin-off itself is new there.
export function copyThread(sourceId, { title }) {
  const source = threads.get(sourceId);
  if (!source) return null;
  const copy = createThread({ title, project: source.project });
  for (const name of ['messages.jsonl', 'artifacts.json']) {
    const from = path.join(threadDir(sourceId), name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(threadDir(copy.id), name));
  }
  for (const dir of ['artifacts', 'versions', 'uploads']) {
    const from = path.join(threadDir(sourceId), dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(threadDir(copy.id), dir), { recursive: true });
  }
  const count = readMessages(copy.id).length;
  return updateThread(copy.id, { messageCount: count, extractedCount: count, spunFrom: sourceId, spunTitle: source.title, spunAt: count });
}

export function createThread({ title, kind = 'chat', sessionId = null, project = '', card = null }) {
  const id = newId();
  const now = Date.now();
  const meta = {
    id,
    title: title || 'New thread',
    kind,
    state: 'ready', // working | ready | done
    sessionId,
    createdAt: now,
    updatedAt: now,
    queuedAt: now, // position in the inbox: oldest first
    messageCount: 0,
    extractedCount: 0, // how many messages the last brain update has seen
    lastUserAt: 0, // messageCount right after Florian's latest message
    lastUserTs: 0, // when that was
    archived: false,
    error: '',
    activity: '', // what Claude is doing right now, while working
    pending: [], // messages sent while Claude was still working
    project, // the vault project or area this thread belongs to, by note name
    card, // for an opportunity or chase card: what it is about
    requeuedAt: 0,
    gist: '', // one line of what is waiting, for the queue
  };
  fs.mkdirSync(artifactsDir(id), { recursive: true });
  fs.mkdirSync(versionsDir(id), { recursive: true });
  writeJson(metaFile(id), meta);
  threads.set(id, meta);
  events.emit('thread', meta);
  return meta;
}

// Moves files Florian uploaded into a thread. `pending` are folders holding one file
// each. Returns what the message carries: the name the file has in the thread, and its size.
export function attachFiles(id, pending) {
  const out = [];
  if (!threads.has(id)) return out;
  for (const dir of pending) {
    let name;
    try { name = fs.readdirSync(dir)[0]; } catch { continue; }
    if (!name) continue;
    fs.mkdirSync(uploadsDir(id), { recursive: true });
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let final = name;
    for (let n = 2; fs.existsSync(path.join(uploadsDir(id), final)); n += 1) final = `${stem} (${n})${ext}`;
    fs.renameSync(path.join(dir, name), path.join(uploadsDir(id), final));
    fs.rmSync(dir, { recursive: true, force: true });
    out.push({ name: final, size: fs.statSync(path.join(uploadsDir(id), final)).size });
  }
  return out;
}

export function uploadPath(id, name) {
  const file = path.join(uploadsDir(id), path.basename(String(name)));
  return fs.existsSync(file) ? file : null;
}

// Mail attachments Claude downloaded in a thread. They sit on its workbench (work/mail/),
// with the scripts that use them, and like the workbench they stay on the computer that
// downloaded them. The thread remembers each one (`mailFiles`: the mail's message id and
// part), so the brain update can fetch it again from Gmail wherever it runs, and file it
// into the vault's Files/ when Florian asked for that.
export const mailDir = (id) => path.join(workDir(id), 'mail');
const fileNameOf = (name) => String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(-120).trim() || 'attachment';

export function mailFilePath(id, name) {
  const file = path.join(mailDir(id), path.basename(String(name)));
  return fs.existsSync(file) ? file : null;
}

// Saves one downloaded attachment. The same one asked for again is not stored twice.
export function saveMailFile(id, { name, data, mail = {} }, { messageId, part }) {
  if (!threads.has(id)) throw new Error('This thread is gone.');
  const list = threads.get(id).mailFiles || [];
  const known = list.find((f) => f.messageId === messageId && f.part === String(part));
  if (known && mailFilePath(id, known.name)) return { file: path.join(mailDir(id), known.name), entry: known, again: true };
  fs.mkdirSync(mailDir(id), { recursive: true });
  const clean = fileNameOf(name);
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let final = known?.name || clean;
  if (!known) for (let n = 2; fs.existsSync(path.join(mailDir(id), final)); n += 1) final = `${stem} (${n})${ext}`;
  fs.writeFileSync(path.join(mailDir(id), final), data);
  const entry = { name: final, messageId, part: String(part), subject: mail.subject || '', from: mail.from || '', date: mail.date || '', at: Date.now() };
  updateThread(id, { mailFiles: [...list.filter((f) => f !== known), entry] });
  return { file: path.join(mailDir(id), final), entry, again: false };
}

// Removes a thread for good: its conversation, its files and their versions. What a
// brain update has already filed from it stays in the brain.
export function deleteThread(id) {
  if (!threads.has(id)) return false;
  threads.delete(id);
  fs.rmSync(threadDir(id), { recursive: true, force: true });
  events.emit('thread-deleted', { id });
  return true;
}

// What the app started by itself and he has not answered yet: cards, proposals, the
// brain update's questions, mail to answer, check-ins, repairs, preparations. While he
// focuses these wait outside the queue. Once he has written in one, it is his.
const APP_KINDS = new Set(['card', 'brain-update', 'mail-reply', 'checkin-active', 'checkin-paused', 'checkin-areas', 'repair', 'prep']);
export function isAppThread(thread) {
  return Boolean(thread) && APP_KINDS.has(thread.kind) && !(thread.lastUserAt > 0);
}

// Whether a thread waits outside the queue while he focuses (Florian, 23-11-2026). Focus
// has two scopes: `deep` (his own threads, on anything) and `project` (only the threads
// of one project, or of an area and its projects: `focus.members`). In both, events and
// mail replies Claude marked pressing (they have to go out today) come through, and
// cards wait for Catch-up. His own mark wins over all of it: `later` true sends any
// thread there (even one he wrote in), false keeps any thread in the queue (even one
// the app started).
export function isLater(thread, focus = null) {
  if (!thread) return false;
  if (typeof thread.later === 'boolean') return thread.later;
  if (thread.kind === 'event') return false;
  if (thread.kind === 'card') return true;
  if (thread.kind === 'mail-reply' && thread.pressing) return false;
  if (focus?.scope === 'project') return !(focus.members?.length ? focus.members : [focus.project]).includes(thread.project);
  return isAppThread(thread);
}

// Deep work: the threads he is invested in and that take Claude long, a thinking session,
// building in a repo, a document. They come first in the queue, so that whenever one is
// waiting for him he answers it and it goes back to work; small things (cards, mail,
// questions, quick lookups) fill the time while the deep ones run.
const DEEP_TYPES = new Set(['thinking', 'build', 'document']);
const DEEP_TIERS = new Set(['high', 'extra']);
export function isDeep(thread) {
  if (!thread || thread.kind === 'card' || isAppThread(thread)) return false;
  return DEEP_TYPES.has(thread.type) || Boolean(thread.repo) || (thread.messageCount || 0) >= 8
    || DEEP_TIERS.has(thread.lastTier) || DEEP_TIERS.has(thread.keepTier);
}

// Pinned threads sit on top of the inbox and are not part of the queue. An event is
// pinned unless Florian unpinned it; any other thread only once he pinned it. Threads
// from before pins existed have no `pinned` field and fall under the same rule.
export function isPinned(thread) {
  return Boolean(thread) && thread.kind !== 'card' && (thread.pinned ?? thread.kind === 'event');
}

// Where a pinned thread stands among the pinned: the place he dragged it to, else when
// it starts (an event) or when it was made.
export const pinPlace = (t) => t.pinAt ?? t.event?.start ?? t.createdAt ?? 0;

// `quiet` skips the disk write and is for fast-changing display fields only.
export function updateThread(id, patch, { quiet = false } = {}) {
  const meta = threads.get(id);
  if (!meta) return null;
  Object.assign(meta, patch);
  // Closing or deferring a thread he pinned by hand takes the pin off. An event keeps
  // its place in case it is reopened.
  if (patch.state === 'done' && meta.pinned && meta.kind !== 'event') meta.pinned = false;
  if (!quiet) writeJson(metaFile(id), meta);
  events.emit('thread', meta);
  return meta;
}

export function appendMessage(id, message) {
  const meta = threads.get(id);
  if (!meta) return null;
  const full = { id: newId(), ts: Date.now(), ...message };
  fs.appendFileSync(messagesFile(id), JSON.stringify(full) + '\n');
  meta.messageCount += 1;
  meta.updatedAt = full.ts;
  // A message the app wrote to start a thread is not something Florian said.
  if (full.role === 'user' && !full.auto) { meta.lastUserAt = meta.messageCount; meta.lastUserTs = Date.now(); }
  writeJson(metaFile(id), meta);
  events.emit('message', { threadId: id, message: full });
  events.emit('thread', meta);
  return full;
}

export function readMessages(id) {
  if (!fs.existsSync(messagesFile(id))) return [];
  return fs
    .readFileSync(messagesFile(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------- artifacts ----------

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function versionFile(id, name, v) {
  const safe = name.replace(/[\\/]/g, '__');
  return path.join(versionsDir(id), `v${v}__${safe}`);
}

export function listArtifacts(id) {
  const index = readJson(artifactIndexFile(id), {});
  return Object.entries(index)
    .map(([name, info]) => ({ name, versions: info.versions, mail: info.mail || null }))
    .sort((a, b) => b.versions.at(-1).ts - a.versions.at(-1).ts);
}

// Records a new version of every shown file that changed, and shows a new file only
// when it is named in `serve`: a file Claude wrote with its file tools, or handed over
// with show_file. Whatever else lands in the artifacts folder (a library a script
// installed, pages rendered on the way) is not shown; tidyArtifacts moves it out.
// Returns what changed.
export function scanArtifacts(id, by = 'claude', { serve = [] } = {}) {
  const dir = artifactsDir(id);
  const index = readJson(artifactIndexFile(id), {});
  const wanted = new Set(serve);
  const changed = [];
  for (const name of walk(dir)) {
    if (!index[name] && !wanted.has(name)) continue;
    const file = path.join(dir, name);
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      continue;
    }
    const hash = crypto.createHash('sha1').update(data).digest('hex');
    const entry = index[name] || { versions: [] };
    const last = entry.versions.at(-1);
    if (last && last.hash === hash) continue;
    const v = (last ? last.v : 0) + 1;
    fs.mkdirSync(versionsDir(id), { recursive: true });
    fs.writeFileSync(versionFile(id, name, v), data);
    entry.versions.push({ v, ts: Date.now(), hash, size: data.length, by });
    index[name] = entry;
    changed.push({ name, v });
  }
  if (changed.length) {
    writeJson(artifactIndexFile(id), index);
    events.emit('artifacts', { threadId: id, changed });
  }
  return changed;
}

// The file holding one version of an artifact, or null. `name` comes from the browser,
// so it is only ever used as a key into the index, never as a path.
// After a turn: files in the artifacts folder that were never shown go to the
// workbench (work/unshown/), so the folder holds what Florian sees and nothing else, and
// none of it is saved to GitHub with the app's data.
export function tidyArtifacts(id) {
  const dir = artifactsDir(id);
  const index = readJson(artifactIndexFile(id), {});
  let moved = 0;
  for (const name of walk(dir)) {
    if (index[name]) continue;
    const to = path.join(workDir(id), 'unshown', ...name.split('/'));
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.rmSync(to, { force: true });
      fs.renameSync(path.join(dir, ...name.split('/')), to);
      moved += 1;
    } catch { /* in use: next time */ }
  }
  removeEmptyDirs(dir);
  return moved;
}

function removeEmptyDirs(dir, root = dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name), root);
  }
  if (dir !== root && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

// Threads from before the workbench showed everything a script left in the artifacts
// folder: a library with thousands of files, rendered pages. Once per thread, what was
// clearly not meant for Florian leaves the list: anything in a cache or package folder,
// and any folder holding more than 25 files. The files move to the workbench, their
// saved versions go (the files themselves stay), and the answers stop listing them.
const JUNK = /(^|\/)(__pycache__|node_modules|site-packages|dist-packages|\.git|\.venv|venv|[^/]+\.(dist|egg)-info)(\/|$)|\.py[co]$/i;
export function pruneArtifacts(id) {
  const meta = threads.get(id);
  if (!meta || meta.artifactsPruned) return 0;
  const index = readJson(artifactIndexFile(id), {});
  const perFolder = new Map();
  for (const name of Object.keys(index)) if (name.includes('/')) { const top = name.split('/')[0]; perFolder.set(top, (perFolder.get(top) || 0) + 1); }
  const drop = Object.keys(index).filter((name) => JUNK.test(name) || (name.includes('/') && perFolder.get(name.split('/')[0]) > 25));
  if (drop.length) {
    const repoPaths = [];
    const rel = (file) => path.relative(path.dirname(THREADS_DIR), file).split(path.sep).join('/');
    for (const name of drop) {
      repoPaths.push(rel(path.join(artifactsDir(id), ...name.split('/'))));
      for (const ver of index[name].versions || []) { repoPaths.push(rel(versionFile(id, name, ver.v))); fs.rmSync(versionFile(id, name, ver.v), { force: true }); }
      delete index[name];
    }
    // They are in the data repo's history too: listed here, taken out by datasync.purgeHistory.
    const listFile = path.join(path.dirname(THREADS_DIR), 'purge-history.json');
    const listed = readJson(listFile, []);
    writeJson(listFile, [...new Set([...listed, ...repoPaths])]);
    writeJson(artifactIndexFile(id), index);
    tidyArtifacts(id);
    const gone = new Set(drop);
    const kept = readMessages(id).map((m) => (m.parts ? { ...m, parts: m.parts.filter((p) => p.type !== 'artifact' || !gone.has(p.name)) } : m));
    const tmp = `${messagesFile(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''));
    fs.renameSync(tmp, messagesFile(id));
    log(`thread ${id}: ${drop.length} files a script had left were taken out of the shown files`);
    // Marked only when something was done: a thread with nothing to tidy is not
    // written at all (looking again at the next start costs one small read).
    updateThread(id, { artifactsPruned: Date.now() });
  }
  return drop.length;
}

export function artifactPath(id, name, v) {
  const index = readJson(artifactIndexFile(id), {});
  const entry = index[name];
  if (!entry) return null;
  const version = v ? entry.versions.find((x) => x.v === Number(v)) : entry.versions.at(-1);
  if (!version) return null;
  const file = versionFile(id, name, version.v);
  return fs.existsSync(file) ? file : null;
}

// The live file in the artifacts folder (for opening in another program).
export function artifactLivePath(id, name) {
  const index = readJson(artifactIndexFile(id), {});
  if (!index[name]) return null;
  const file = path.join(artifactsDir(id), ...name.split('/'));
  return fs.existsSync(file) ? file : null;
}

// Florian's own edit of a file Claude made (or of a card's text). It becomes a version
// like any other, marked as his.
export function saveArtifact(id, name, content) {
  const index = readJson(artifactIndexFile(id), {});
  if (!index[name]) return null;
  const file = path.join(artifactsDir(id), ...name.split('/'));
  fs.writeFileSync(file, String(content));
  scanArtifacts(id, 'you');
  return listArtifacts(id).find((a) => a.name === name) || null;
}

// What the app knows about a mail file beyond its text: its Gmail draft, when it was sent.
export function setMailInfo(id, name, patch) {
  const index = readJson(artifactIndexFile(id), {});
  if (!index[name]) return null;
  index[name].mail = { ...(index[name].mail || {}), ...patch };
  writeJson(artifactIndexFile(id), index);
  events.emit('artifacts', { threadId: id, changed: [] });
  return index[name].mail;
}

export function readArtifactText(id, name, v) {
  const file = artifactPath(id, name, v);
  return file ? fs.readFileSync(file, 'utf8') : null;
}
