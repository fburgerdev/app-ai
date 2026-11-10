// Threads Florian starts on many projects or areas at once, from the outline.
//
//   active   every active project: where it stands and what the next step is
//   paused   every paused project: has what it waits for happened?
//   areas    every area (or one): which new project would be worth starting there
//
// A project or area that already has an open thread is left alone. The threads are the
// app's own work, so they run behind Florian's own messages.

import * as store from './store.js';
import * as runner from './runner.js';
import { projectTree } from './projects.js';
import { readPrompt } from './util.js';

const KINDS = {
  active: { prompt: 'checkin-active.md', title: (n) => `Check-in: ${n}` },
  paused: { prompt: 'checkin-paused.md', title: (n) => `Still waiting? ${n}` },
  areas: { prompt: 'checkin-area.md', title: (n) => `New project in ${n}?` },
};

export function startCheckins(which, only = '') {
  const kind = KINDS[which];
  if (!kind) throw new Error('Unknown kind of check-in.');
  const tree = projectTree();
  if (tree.missing) throw new Error('The vault has no Projects Index yet.');
  let names;
  if (which === 'areas') names = tree.groups.filter((g) => g.isArea).map((g) => g.name);
  else names = tree.groups.flatMap((g) => g.projects).filter((p) => p.paused === (which === 'paused') && p.status !== 'done').map((p) => p.name);
  if (only) names = names.filter((n) => n === only);
  const busy = new Set(store.listThreads().filter((t) => t.kind !== 'card' && t.state !== 'done' && (which !== 'areas' || t.kind === 'checkin-areas')).map((t) => t.project));
  const started = [];
  const skipped = [];
  for (const name of names) {
    if (busy.has(name)) { skipped.push(name); continue; }
    const thread = store.createThread({ title: kind.title(name), kind: `checkin-${which}`, project: name });
    runner.sendMessage(thread.id, readPrompt(kind.prompt, { name }), { auto: true });
    started.push(thread.id);
  }
  return { started: started.length, skipped: skipped.length };
}
