// Prints which vault files were read most, from the app's read log.
//   npm run reads            everything
//   npm run reads -- 14      the last 14 days

import fs from 'node:fs';
import { READS_FILE } from '../server/config.js';

const days = Number(process.argv[2]) || 0;
const since = days ? Date.now() - days * 86_400_000 : 0;
if (!fs.existsSync(READS_FILE)) {
  console.log('Nothing has been read yet.');
  process.exit(0);
}
const files = new Map();
let searches = 0;
for (const line of fs.readFileSync(READS_FILE, 'utf8').split('\n')) {
  if (!line) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.ts < since) continue;
  if (e.kind !== 'file') { searches += 1; continue; }
  const f = files.get(e.path) || { claude: 0, preload: 0, you: 0, threads: new Set(), last: 0 };
  if (e.by === 'preload') f.preload += 1;
  else if (e.by === 'you') f.you += 1;
  else f.claude += 1;
  if (e.threadId) f.threads.add(e.threadId);
  f.last = Math.max(f.last, e.ts);
  files.set(e.path, f);
}
const rows = [...files.entries()].sort((a, b) => b[1].claude - a[1].claude || b[1].last - a[1].last);
console.log(`${days ? `Last ${days} days` : 'All time'}: ${rows.length} files read, ${searches} searches and lookups.\n`);
console.log('opened by Claude | threads | by you | as rules | last read  | file');
for (const [p, f] of rows) {
  const d = new Date(f.last).toISOString().slice(0, 10);
  console.log(`${String(f.claude).padStart(16)} | ${String(f.threads.size).padStart(7)} | ${String(f.you).padStart(6)} | ${String(f.preload).padStart(8)} | ${d} | ${p}`);
}
