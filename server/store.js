// Threads, their messages and their artifacts, kept as plain files in the app's data
// folder so they can be inspected and backed up without any tool:
//
//   threads/<id>/thread.json      state of the thread
//   threads/<id>/messages.jsonl   one message per line
//   threads/<id>/artifacts/       the files Claude made, as they are now
//   threads/<id>/versions/        every earlier state of each artifact
//   threads/<id>/artifacts.json   which versions exist

import crypto from 'node:crypto';
import fs from 'node:fs';
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

// Loads every thread from disk. A thread that was mid-turn when the app closed cannot
// still be running, so it goes back to the inbox with a note.
export function loadThreads() {
  threads.clear();
  if (!fs.existsSync(THREADS_DIR)) return;
  for (const id of fs.readdirSync(THREADS_DIR)) {
    const meta = readJson(metaFile(id), null);
    if (!meta || meta.id !== id) continue;
    if (meta.state === 'working') {
      meta.state = 'ready';
      meta.queuedAt = Date.now();
      meta.error = 'The app was closed while Claude was working on this. Send a message to pick it up again.';
      meta.activity = '';
      meta.pending = [];
      writeJson(metaFile(id), meta);
    }
    threads.set(id, meta);
  }
  log(`loaded ${threads.size} threads`);
}

export function listThreads() {
  return [...threads.values()];
}

export function getThread(id) {
  return threads.get(id) || null;
}

// True when Florian has said something in the thread that no brain update has seen.
export function isUnfiled(thread) {
  return (thread.lastUserAt || 0) > (thread.extractedCount || 0);
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
  for (const dir of ['artifacts', 'versions']) {
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

// Removes a thread for good: its conversation, its files and their versions. What a
// brain update has already filed from it stays in the brain.
export function deleteThread(id) {
  if (!threads.has(id)) return false;
  threads.delete(id);
  fs.rmSync(threadDir(id), { recursive: true, force: true });
  events.emit('thread-deleted', { id });
  return true;
}

// `quiet` skips the disk write and is for fast-changing display fields only.
export function updateThread(id, patch, { quiet = false } = {}) {
  const meta = threads.get(id);
  if (!meta) return null;
  Object.assign(meta, patch);
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
  if (full.role === 'user' && !full.auto) meta.lastUserAt = meta.messageCount;
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

// Compares the artifacts folder with the last recorded versions and records a new
// version for every file that is new or changed. Returns what changed.
export function scanArtifacts(id, by = 'claude') {
  const dir = artifactsDir(id);
  const index = readJson(artifactIndexFile(id), {});
  const changed = [];
  for (const name of walk(dir)) {
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
