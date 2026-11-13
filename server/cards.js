// Opportunity and chase cards.
//
// A card is one finished message in the queue: a LinkedIn note, a first mail, a
// follow-up on something Florian is waiting for. He can edit the text right in the
// card, then accepts or declines; the card is done either way.
//
// Cards are made by a background run that reads the vault (and searches the web for the
// right person). It starts by itself when few unseen cards are left while Florian is
// working the queue, or when he asks for it. What he does with each card is kept in
// cards/log.jsonl: nothing is ever proposed twice, the queue learns from it, and the
// next brain update files it.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';
import { runAgent } from './agent.js';
import * as brain from './brain.js';
import * as google from './google.js';
import * as store from './store.js';
import * as runner from './runner.js';
import { createEvent } from './events.js';
import { isNetworkError, report } from './repair.js';
import { isKnownProject } from './projects.js';
import { getState, readPad } from './state.js';
import { parseMail, serializeMail } from './mail.js';
import { recordDecision } from './queue.js';
import { readPrompt, todayLine } from './util.js';

const DIR = path.join(DATA_DIR, 'cards');
const LOG = path.join(DIR, 'log.jsonl');
const RUNS = path.join(DIR, 'runs');
export const CARD_FILE = 'Message.md';

let config;
let running = false;
let lastRun = 0;
let lastLook = 0; // when the calendar was last looked at
let lastMade = -1;
let lastError = '';

export function initCards(cfg) {
  config = cfg;
  fs.mkdirSync(RUNS, { recursive: true });
}

export function readCardLog() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const openCards = () => store.listThreads().filter((t) => t.kind === 'card' && t.state === 'ready');

export function cardsStatus() {
  return { running, lastRun, lastMade, lastError, ready: openCards().length };
}

// The text of a card as it stands, and as Claude first wrote it.
export function cardText(thread, v) {
  const raw = store.readArtifactText(thread.id, CARD_FILE, v) || '';
  const mail = parseMail(raw);
  return mail ? { mail, text: mail.body } : { mail: null, text: raw.trim() };
}

function createCard(card) {
  const thread = store.createThread({
    title: card.title,
    kind: 'card',
    project: isKnownProject(card.project) ? card.project : '',
    card: { type: card.type, channel: card.channel, key: card.key, why: card.why, to: card.to, link: card.link || '' },
  });
  const body = card.channel === 'mail'
    ? serializeMail({ to: card.to, subject: card.subject || '', body: card.text })
    : `${card.text.trim()}\n`;
  fs.writeFileSync(path.join(store.artifactsDir(thread.id), CARD_FILE), body);
  store.scanArtifacts(thread.id, 'claude');
  store.updateThread(thread.id, { gist: card.why, queuedAt: Date.now() });
  return thread;
}

// A proposal or a prep is work in a thread, not a message to someone.
const WORK = ['proposal', 'prep'];

function valid(card) {
  if (!card || !['opportunity', 'chase', ...WORK].includes(card.type)) return false;
  if (WORK.includes(card.type)) card.channel = 'thread';
  return ['mail', 'linkedin', 'message', 'thread'].includes(card.channel) && (card.channel === 'thread') === WORK.includes(card.type)
    && typeof card.title === 'string' && card.title.trim() && typeof card.text === 'string' && card.text.trim()
    && typeof card.key === 'string' && card.key.trim();
}

const calendarOn = () => config.fake || google.googleConnected();
const enoughCards = () => openCards().length >= (Number(config.cards.keepReady) || 3);

// Starts a run if it is time for one. Called whenever Florian moves through the queue.
// Two things can make it time: fewer cards waiting than there should be, or the calendar
// not having been looked at for a while.
let mayRun = () => true; // false on the computer that is not doing the work right now
export const setMayRun = (fn) => { mayRun = fn; };

export function maybeMakeCards() {
  if (!config.cards.auto || running || !brain.brainStatus().ready || !mayRun()) return false;
  // After a run that found nothing, wait much longer before looking again.
  const pause = (lastMade === 0 ? 6 * 60 : Number(config.cards.pauseMinutes) || 45) * 60_000;
  const wantCards = !enoughCards() && Date.now() - lastRun >= pause;
  const wantCalendar = calendarOn() && Date.now() - lastLook >= (Number(config.cards.calendarHours) || 3) * 3600_000;
  if (!wantCards && !wantCalendar) return false;
  makeCards({ cards: wantCards }).catch(() => {});
  return true;
}

// A thread the app starts by itself: the brief becomes the first message, marked as the
// app's, and the Claude in the thread takes it from there.
function startWork(card, text, lead) {
  const thread = store.createThread({ title: card.title, kind: card.type === 'prep' ? 'prep' : 'chat', project: isKnownProject(card.project) ? card.project : '' });
  runner.sendMessage(thread.id, `${lead}\n\n${text.trim()}`, { auto: true });
  return thread;
}

export async function makeCards({ cards: wantCards = true } = {}) {
  if (running) return cardsStatus();
  if (!brain.brainStatus().ready) throw new Error('The brain is not cloned yet.');
  running = true;
  if (wantCards) lastRun = Date.now();
  if (calendarOn()) lastLook = Date.now();
  lastError = '';
  store.events.emit('cards', cardsStatus());
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(RUNS, id);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await brain.refresh();
    const made = [...readCardLog().map((e) => `- ${e.key} (${e.outcome}${e.reason ? `; he wrote: ${e.reason}` : ''}): ${e.title}`), ...openCards().map((t) => `- ${t.card.key} (waiting for him now): ${t.title}`)];
    const profile = (readPad('profile') || '').trim();
    const state = getState();
    const result = await runAgent({
      prompt: readPrompt('cards.md', {
        today: todayLine(),
        count: String(wantCards ? Math.max(1, Number(config.cards.perRun) || 3) : 0),
        calendar: calendarOn() ? readPrompt('cards-calendar.md').trim() : 'The calendar is not connected. Skip this part.',
        threads: store.listThreads().filter((t) => t.kind !== 'card' && (t.state !== 'done' || t.kind === 'event')).map((t) => `- ${t.title}${t.project ? ` (${t.project})` : ''}`).slice(0, 60).join('\n') || '(none)',
        outDir,
        made: made.length ? made.slice(-300).join('\n') : '(none yet)',
        profile: profile ? `What his earlier choices have shown (make more of what he takes, none of what he declines):\n\n${profile}` : '',
      }),
      cwd: brain.brainDir(),
      systemAppend: 'You are running inside Florian\'s inbox app as its card run. The run\'s instructions are in the user message.',
      model: state.model,
      effort: state.effort,
      mode: 'thread',
      usageKind: 'cards',
      artifactsDir: outDir,
      protectedPaths: config.protectedPaths,
      shell: false,
      title: `Cards ${id}`,
      fake: config.fake,
      mcpServers: !config.fake && google.googleConnected() ? { google: await google.buildGoogleServer() } : undefined,
    });
    if (result.error) throw new Error(result.error);
    const known = new Set([...readCardLog().map((e) => e.key), ...openCards().map((t) => t.card.key), ...store.listThreads().filter((t) => t.event?.key).map((t) => t.event.key)]);
    let count = 0;
    let preps = 0;
    for (const name of fs.readdirSync(outDir).filter((n) => n.endsWith('.json'))) {
      let card;
      try { card = JSON.parse(fs.readFileSync(path.join(outDir, name), 'utf8')); } catch { continue; }
      if (!valid(card) || known.has(card.key)) continue;
      known.add(card.key);
      if (card.type === 'prep') {
        // Something coming up in the calendar: an event thread, outside the inbox, that
        // opens when it is time.
        if (preps >= 4) continue;
        const thread = createEvent(card);
        if (!thread) continue;
        preps += 1;
        fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), key: card.key, type: 'prep', channel: 'thread', title: thread.title, project: thread.project, to: '', outcome: 'started', how: 'by itself, from the calendar, as an event', edited: false, mood: getState().mood.trim(), proposed: card.text }) + '\n');
        continue;
      }
      if (!wantCards) continue;
      createCard(card);
      count += 1;
    }
    if (wantCards) lastMade = count;
    log(`cards: made ${count}${preps ? `, ${preps} event${preps === 1 ? '' : 's'} to prepare` : ''}`);
  } catch (err) {
    lastError = isNetworkError(err.message) ? '' : err.message;
    report('looking for opportunities', err.message);
    lastMade = -1;
    log(`cards: run failed: ${err.message}`);
  } finally {
    running = false;
    fs.rmSync(outDir, { recursive: true, force: true });
    store.events.emit('cards', cardsStatus());
  }
  return cardsStatus();
}

// Florian's verdict on a card. `how` says what accepting meant: copied, drafted, sent.
// `reason` is what he wrote about it, if anything: why not, or what the card got wrong.
export function decideCard(thread, outcome, how = '', reason = '') {
  reason = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const first = cardText(thread, 1).text;
  const final = cardText(thread).text;
  const edited = first !== final;
  const entry = {
    ts: Date.now(),
    key: thread.card.key,
    type: thread.card.type,
    channel: thread.card.channel,
    title: thread.title,
    project: thread.project || '',
    to: thread.card.to || '',
    outcome,
    how,
    reason,
    edited,
    mood: getState().mood.trim(),
    proposed: first,
    final: outcome === 'accepted' ? final : undefined,
  };
  // For the queue's learning: what kind of change he made, in a few words.
  let change = '';
  if (edited) change = final.length < first.length * 0.85 ? 'shortened it' : final.length > first.length * 1.15 ? 'added to it' : 'reworded it';
  recordDecision(outcome, thread, { ...(change ? { edited: change } : {}), ...(reason ? { reason } : {}) });
  // An accepted proposal becomes the thread that does the work.
  let started = null;
  if (outcome === 'accepted' && thread.card.type === 'proposal') {
    started = startWork({ ...thread.card, title: thread.title, project: thread.project }, final,
      `Florian accepted this proposal of yours${edited ? ', after editing it' : ''}${reason ? ` (he added: ${reason})` : ''}. Do the work:`);
    how = 'started as a thread';
    entry.how = how;
  }
  store.updateThread(thread.id, { state: 'done', doneAt: Date.now(), archived: true, card: { ...thread.card, outcome, how, reason, started: started?.id || '' } });
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  maybeMakeCards();
  return { ...entry, started };
}
