// How long a project or area note in the vault may be (Florian, 25-11-2026). A note holds
// where things stand; Threads/ holds what was said. The app counts the words of the notes a
// brain update changed, and has the update shorten the ones that are over.

import fs from 'node:fs';
import path from 'node:path';

export const NOTE_LIMITS = { Projects: 1200, Areas: 1500 };

export const countWords = (text) => (text.match(/\S+/g) || []).length;

// The limit of a vault path, or 0 when it has none.
export function limitFor(rel) {
  const m = /^(?:Core|Brain)\/(Projects|Areas)\/([^/]+)\.md$/.exec(String(rel).split('\\').join('/'));
  if (!m || / Index$/.test(m[2])) return 0;
  return NOTE_LIMITS[m[1]];
}

export function overLimit(vaultDir, paths) {
  const out = [];
  for (const rel of paths) {
    const limit = limitFor(rel);
    if (!limit) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(vaultDir, rel), 'utf8'); } catch { continue; } // deleted or moved
    const words = countWords(text);
    if (words > limit) out.push({ path: rel, words, limit });
  }
  return out;
}
