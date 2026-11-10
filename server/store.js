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

export function createThread({ title, kind = 'chat', sessionId = null }) {
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
  };
  fs.mkdirSync(artifactsDir(id), { recursive: true });
  fs.mkdirSync(versionsDir(id), { recursive: true });
  writeJson(metaFile(id), meta);
  threads.set(id, meta);
  events.emit('thread', meta);
  return meta;
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
  if (full.role === 'user') meta.lastUserAt = meta.messageCount;
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
    .map(([name, info]) => ({ name, versions: info.versions }))
    .sort((a, b) => b.versions.at(-1).ts - a.versions.at(-1).ts);
}

// Compares the artifacts folder with the last recorded versions and records a new
// version for every file that is new or changed. Returns what changed.
export function scanArtifacts(id) {
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
    entry.versions.push({ v, ts: Date.now(), hash, size: data.length });
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
