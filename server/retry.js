// Work that stalls carries on by itself, so Florian does not have to watch a thread and
// type "go on" or "try again" (his wish, 22-11-2026: "i dont need to pay attention to the
// thread all the time and it just retries itself").
//
// Three ways a thread stalls, and what the app does about each:
//
//   retry     the turn ended on an error (the API timed out, the stream closed, the
//             network was away). It runs again by itself after a pause that grows.
//   continue  Claude could not finish because something still runs (a render, a build,
//             an install) and called continue_later. The app starts a turn by itself
//             when it asked, to look again.
//   merge     the branch could not go into main: the tests failed, or main clashes with
//             it. A turn starts by itself to fix that, and the merge is tried again after.
//             When the merge failed for another reason (GitHub not reachable), only the
//             merge is tried again, a few minutes later, without a turn (`remerge`).
//
// A fourth hold, `repo`, is a turn parked because the repo it needs is in use (repos.js);
// it carries on when the repo is free for it, not by the clock (runner.resumeParked).
//
// The first three wait as a hold on the thread, like a turn cut off by the usage limit
// (runner.js): it stays "working", travels to the other computer with everything else,
// "Cancel the hold" stops it, and a message of his starts the turn at once instead.
//
// The safety handles, all counted on the thread (`auto`) since his last message, which
// sets them back: at most `maxRuns` automatic turns; at most `errorTries` errors in a row
// in which Claude got nothing done (no tool used), since that is the sign of something no
// waiting will fix; at most `mergeFixes` turns fixing a merge and `remerges` plain tries.
// Once one is reached, the thread comes back to him with a note saying so.

import { dateTimeDMY } from './util.js';
import { clock } from './limits.js';

export const DEFAULTS = { enabled: true, maxRuns: 20, errorTries: 3, backoffMin: [1, 4, 15], mergeFixes: 2, remerges: 3, remergeMin: 5, mergeFixDelayMs: 20_000, continueMinMin: 1, continueMaxMin: 60 };
const settings = (opts) => ({ ...DEFAULTS, ...(opts || {}) });

// Errors another try cannot fix: he has to sign in, or the conversation is too long.
const HOPELESS = /not signed in|npm run login|invalid api key|authenticat|unauthori[sz]ed|prompt is too long|context (window|length)|too many tokens|credit balance/i;
export const retryable = (error) => Boolean(String(error || '').trim()) && !HOPELESS.test(String(error));

// At the end of a turn that was neither stopped by him nor cut off by the usage limit:
// whether it runs again by itself, and when.
//   { kind: 'retry' | 'continue', until, tries, reason, auto }   held, runs again at `until`
//   { stop: why, auto }                                         a safety handle was reached
//   null                                                        nothing to do
export function turnPlan({ auto, error = '', carryOn = null, didWork = false, opts, now = Date.now() }) {
  const o = settings(opts);
  if (!o.enabled) return null;
  const a = { ...(auto || {}) };
  const runs = a.runs || 0;
  if (error) {
    if (!retryable(error)) return null;
    // Errors in a row in which Claude used no tool: nothing moves, so it stops early.
    const fails = didWork ? 1 : (a.fails || 0) + 1;
    if (fails > o.errorTries) return { stop: `it ended on an error ${fails} times in a row without getting anything done`, auto: { ...a, fails } };
    if (runs >= o.maxRuns) return { stop: `it already ran ${runs} times by itself since your last message`, auto: a };
    const steps = Array.isArray(o.backoffMin) && o.backoffMin.length ? o.backoffMin : DEFAULTS.backoffMin;
    const wait = Number(steps[Math.min(fails - 1, steps.length - 1)]) * 60_000;
    return { kind: 'retry', until: now + wait, tries: fails, reason: String(error).split('\n')[0].slice(0, 300), auto: { ...a, runs: runs + 1, fails } };
  }
  if (carryOn) {
    if (runs >= o.maxRuns) return { stop: `it already ran ${runs} times by itself since your last message`, auto: a };
    const minutes = Math.min(Math.max(Number(carryOn.minutes) || 10, o.continueMinMin), o.continueMaxMin);
    return { kind: 'continue', until: now + minutes * 60_000, tries: runs + 1, reason: String(carryOn.why || '').trim().slice(0, 300) || 'work still running', auto: { ...a, runs: runs + 1, fails: 0 } };
  }
  return null;
}

// What kind of merge failure an error message is.
export function mergeFailure(message) {
  const m = String(message || '');
  if (/clashes with this branch/i.test(m)) return 'clash';
  if (/nothing on this branch that main does not have/i.test(m)) return '';
  return 'other';
}

// After a merge that failed: `failure` is 'tests', 'clash' or 'other'.
//   { kind: 'merge', until, tries, auto }   a turn fixes it, then the merge runs again
//   { kind: 'remerge', at, tries, auto }    only the merge runs again, at `at`
//   { stop: why, tries }                    tried often enough by itself
//   null                                    switched off
export function mergePlan({ auto, failure, opts, now = Date.now() }) {
  const o = settings(opts);
  if (!o.enabled || !failure) return null;
  const a = { ...(auto || {}) };
  if (failure === 'other') {
    const remerges = (a.remerges || 0) + 1;
    if (remerges > o.remerges) return { stop: `the app already tried the merge ${o.remerges} more times by itself`, tries: o.remerges };
    return { kind: 'remerge', at: now + o.remergeMin * 60_000, tries: remerges, auto: { ...a, remerges } };
  }
  const fixes = (a.fixes || 0) + 1;
  if (fixes > o.mergeFixes) return { stop: `Claude already tried to fix it ${o.mergeFixes} times by itself`, tries: o.mergeFixes };
  if ((a.runs || 0) >= o.maxRuns) return { stop: `it already ran ${a.runs} times by itself since your last message`, tries: fixes - 1 };
  return { kind: 'merge', until: now + o.mergeFixDelayMs, tries: fixes, auto: { ...a, runs: (a.runs || 0) + 1, fixes } };
}

// The line the thread shows while it waits.
export function holdLine(held, now = Date.now()) {
  const at = clock(held.until, now);
  if (held.kind === 'retry') return `Ended on an error: tries again by itself at ${at}`;
  if (held.kind === 'continue') return `Waiting (${held.reason}): carries on by itself at ${at}`;
  if (held.kind === 'merge') return `Could not merge: Claude fixes it by itself at ${at}`;
  if (held.kind === 'repo') return `Waiting for ${held.repo || held.reason}${held.mode === 'exclusive' ? ' (alone)' : ''}${held.holder ? `, held by ${held.holder}` : ''}: carries on by itself when it is free`;
  return '';
}

// When the hold is over: what Claude gets, and the note the thread shows.
export function resumeText(held, now = Date.now()) {
  if (held.kind === 'retry') {
    return {
      prompt: `[The app: the last turn ended on an error at ${dateTimeDMY(held.at)}: "${held.reason}". The app started it again by itself (automatic try ${held.tries}); Florian has not written anything since, unless a message follows below. Carry on where you stopped and finish the work. Do not start over: look first at what is already there (what you wrote above, the files in the artifacts folder, commits on the thread's branch), and open the repo again if you were working in one. If a step failed or timed out before, do it differently this time: smaller steps, a longer timeout, or a long job started in the background with continue_later. The message the turn was about:]\n\n${held.prompt}`,
      note: `[The turn ended on an error ("${held.reason.slice(0, 120)}"); the app tried again by itself on ${dateTimeDMY(now)} (try ${held.tries}).]`,
    };
  }
  if (held.kind === 'continue') {
    return {
      prompt: `[The app: at the end of the last turn you called continue_later ("${held.reason}"). It is ${dateTimeDMY(now)} now, and the app started this turn by itself; Florian has not written anything since, unless a message follows below. Check on what you were waiting for and carry on with the work. If it is still running and has moved on since your last look, call continue_later again. If it has not moved, or it failed, do not wait again: find out why and fix it if you can; otherwise tell Florian what is stuck. The message the work is about:]\n\n${held.prompt}`,
      note: `[Claude was waiting for ${held.reason}; the app carried on by itself on ${dateTimeDMY(now)}.]`,
    };
  }
  if (held.kind === 'merge') {
    return {
      prompt: held.prompt,
      note: `[The merge into main had failed; the app started a turn by itself on ${dateTimeDMY(now)} to fix it (try ${held.tries}).]`,
    };
  }
  if (held.kind === 'repo') {
    const repo = held.repo || held.reason;
    return {
      prompt: `[The app: the last turn was parked at ${dateTimeDMY(held.at)} because ${repo} was in use. It is free for this thread now (${dateTimeDMY(now)}), and the app started this turn by itself; Florian has not written anything since, unless a message follows below. Open the repo again with open_repo${held.mode === 'exclusive' ? ', with exclusive: true as before' : ''}, then carry on where you stopped and finish the work. The message the turn was about:]\n\n${held.prompt}`,
      note: `[${repo} is free; the app carried on with this turn by itself on ${dateTimeDMY(now)}.]`,
    };
  }
  return null;
}

// What Claude gets when Florian writes while such a hold waits: his message goes first,
// at once, and Claude knows what was pending.
export function interruptedText(held, message) {
  if (held.kind === 'retry') return `[The app: the turn about the message below ended on an error ("${held.reason}") and was waiting to be tried again by itself. Florian has written since, so this turn starts now, with his new message at the end. Carry on with the work where it stopped, in the light of what he says.]\n\n${held.prompt}\n\n[Florian's new message:]\n\n${message}`;
  if (held.kind === 'continue') return `[The app: you had called continue_later ("${held.reason}"), and Florian wrote before the app looked again. Answer him, and check on that work too.]\n\n${message}`;
  if (held.kind === 'merge') return `[The app: the merge of this thread's branch into main had failed, and a turn to fix it was about to start by itself. Florian wrote first. Answer him; unless he says otherwise, also fix what stopped the merge. What the app had for that turn:]\n\n${held.prompt}\n\n[Florian's new message:]\n\n${message}`;
  if (held.kind === 'repo') return `[The app: the turn about the message below was parked, waiting for ${held.repo || held.reason}, and Florian wrote meanwhile. Answer him. This thread keeps its place in the queue for the repo: if the work needs it, open_repo waits for it, and parks the turn again if the wait is long. What the parked turn was about:]\n\n${held.prompt}\n\n[Florian's new message:]\n\n${message}`;
  return message;
}

// The turn that fixes a failed merge.
export function mergeFixPrompt({ repo, branch, main, failure, detail }) {
  const why = failure === 'clash' ? `${main} has changed in a way that clashes with this branch` : `the repo's tests did not pass on this branch. The end of their output:\n\n${detail}\n\n`;
  return `[The app: it could not merge this thread's branch \`${branch}\` into ${main} of ${repo}: ${why} It started this turn by itself so you fix that; Florian has not written anything since, unless a message follows below. Open the repo with open_repo, then: ${failure === 'clash' ? `merge ${main} into the branch and resolve the conflicts, keeping what both sides meant` : 'run the tests, find the cause and fix it; if a test only timed out or fails now and then, run it again, and make it steadier rather than weaker'}. Change nothing else, and run the full test suite before you end the turn: the app tries the merge again by itself after it. Say in two or three lines what was wrong and what you did.]`;
}
