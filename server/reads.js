// A log of what gets read from the vault: which file, which part, by which thread.
//
// This only records. Nothing in the app acts on it yet. Every line of reads.jsonl in the
// app's data folder is one read:
//
//   ts        when
//   by        "thread", "brain-update", "preload" (rules put into a thread's
//             instructions) or "you" (a note you opened beside the chat)
//   threadId  the thread, when there is one
//   kind      "file" (a file was opened), "search" (its content was searched),
//             "list" (file names were looked up)
//   path      vault path of the file, or of the folder that was searched
//   lines     for a partial read: [first line, number of lines]
//   pattern   for a search or a lookup: what was looked for
//
// "npm run reads" prints a summary.

import fs from 'node:fs';
import path from 'node:path';
import { READS_FILE } from './config.js';

function vaultPath(vaultDir, file) {
  if (!file) return '';
  const rel = path.relative(vaultDir, path.resolve(vaultDir, String(file)));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside the vault
  return rel.split(path.sep).join('/');
}

function write(entry) {
  try {
    fs.appendFileSync(READS_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch {
    // the log must never get in the way of the work
  }
}

// One tool call by Claude.
export function logToolRead({ vaultDir, by, threadId, tool, input = {} }) {
  if (tool === 'Read') {
    const p = vaultPath(vaultDir, input.file_path);
    if (!p) return;
    const entry = { by, threadId, kind: 'file', path: p };
    if (input.offset || input.limit) entry.lines = [input.offset || 1, input.limit || null];
    write(entry);
  } else if (tool === 'Grep') {
    const p = vaultPath(vaultDir, input.path || '.');
    if (p === null) return;
    write({ by, threadId, kind: 'search', path: p || '.', pattern: String(input.pattern || ''), glob: input.glob || undefined });
  } else if (tool === 'Glob') {
    const p = vaultPath(vaultDir, input.path || '.');
    if (p === null) return;
    write({ by, threadId, kind: 'list', path: p || '.', pattern: String(input.pattern || '') });
  }
}

export function logRead({ by, threadId, path: p }) {
  write({ by, threadId, kind: 'file', path: p });
}
