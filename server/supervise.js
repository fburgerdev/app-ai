// The supervisor: when a turn ends while Florian is away, a cheap model reads the end of
// Claude's reply and says what happens next, so he does not have to type "go on"
// (his wish, 23-11-2026).
//
//   goahead   the reply only waits for a go-ahead ("say go on when you're back"): the
//             app carries on by itself a minute later (retry.js, kind "goahead")
//   needs     the reply asks him something only he can decide: it waits for him
//   done      nothing open
//
// With a message he queued as "Next" it also says whether that runs now ("run") or
// waits for him to look first ("hold"). It leans towards running: he queued it on
// purpose. If the check itself fails, a queued message runs and nothing carries on.

import { runAgent } from './agent.js';
import { readPrompt } from './util.js';
import { DATA_DIR } from './config.js';

const VERDICTS = ['goahead', 'needs', 'done'];

// The stand-in, for tests: plain words in the reply decide.
export function fakeVerdict({ reply = '', queued = [] }) {
  const r = String(reply);
  const verdict = /say go on|when you're back/i.test(r) ? 'goahead' : /DECIDE-TEST/.test(r) ? 'needs' : 'done';
  return { verdict, next: queued.length && verdict === 'needs' ? 'hold' : 'run', why: verdict === 'needs' ? 'Claude asked you something first' : verdict === 'goahead' ? 'it only asked for a go-ahead' : '' };
}

export function parseVerdict(text) {
  const json = /\{[\s\S]*\}/.exec(String(text || ''));
  let a = {};
  try { a = json ? JSON.parse(json[0]) : {}; } catch { a = {}; }
  const verdict = VERDICTS.includes(String(a.verdict || '').toLowerCase()) ? String(a.verdict).toLowerCase() : 'done';
  const next = String(a.next || '').toLowerCase() === 'hold' ? 'hold' : 'run';
  const why = String(a.why || '').replace(/[\n"]/g, ' ').trim().slice(0, 160);
  return { verdict, next, why };
}

// `reply` is the text of Claude's turn, `queued` the texts he queued, `trouble` a line
// on what went wrong in the turn (if anything).
export async function supervise({ reply = '', queued = [], trouble = '', model = 'haiku', fake = false }) {
  if (fake) return fakeVerdict({ reply, queued });
  const tail = String(reply).slice(-4000);
  try {
    const result = await runAgent({
      prompt: readPrompt('supervise.md', {
        reply: tail || '(Claude wrote nothing)',
        trouble: trouble ? `What went wrong in the turn: ${trouble}` : '',
        queued: queued.length ? `Florian queued this to run after the turn ("Next"), before he saw the reply:\n\n${queued.map((q) => `> ${String(q).slice(0, 1500).replace(/\n/g, '\n> ')}`).join('\n\n')}` : 'Nothing is queued; answer "run" for next.',
      }),
      cwd: DATA_DIR,
      systemAppend: 'You supervise threads of a personal work app. Answer with one JSON object and nothing else.',
      model,
      mode: 'plain',
      usageKind: 'plain',
      fake: false,
    });
    return parseVerdict(result.finalText || result.text);
  } catch {
    return { verdict: 'done', next: 'run', why: '' };
  }
}
