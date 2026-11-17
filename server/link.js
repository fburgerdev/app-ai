// The laptop and the Pi.
//
// On the laptop the app is always opened from the laptop itself (localhost), so it is
// there whether or not the Pi is, and the laptop does the work: that is the faster side.
// When config.remote names the Pi, Florian can hand everything over to it, for example
// before the laptop goes to sleep. From then on this server only passes the page's
// requests on to the Pi, until the threads are taken back:
//
//   hand over   the laptop saves to GitHub, the Pi takes that in, then the page is
//               passed on. Waits until Claude has finished what it is doing here.
//   take back   the Pi is asked to save (if it still answers), the laptop takes in what
//               is on GitHub, then works by itself again. Only by his click.
//
// The choice is remembered on this computer (link.json, never synced): handed over, it
// stays on the Pi when the app restarts (also after a self-update), when the laptop
// wakes up, and when the Pi stops answering for a while, until he takes it back
// (Florian, 16-11-2026). While the Pi does not answer, the status row says so and offers
// to take everything back.
//
// In between, both sides save to and take in from the data repo every few minutes, and
// the laptop tells the Pi whenever it saved, so the phone (which talks to the Pi) is
// never far behind. The Pi itself runs with no remote and only answers /api/sync/*.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';
import * as datasync from './datasync.js';
import { events } from './store.js';

let config;
let isBusy = () => false;
let choice = 'local'; // local: the laptop does the work | remote: handed over to the Pi
let lastTick = Date.now();
let active = 'local'; // where the page's requests go right now: local | remote
let online = false;
let misses = 0;
let switching = false;
let note = '';
let step = ''; // what the handover is doing right now, in a few words
let handedOverAt = 0;
let checkedAt = 0;
let leaseAt = 0; // on the Pi: when the laptop last said it is doing the work
const LEASE_MS = 3 * 60_000;
const streams = new Set(); // passed-on requests still open (the live updates)

export const enabled = () => Boolean(config?.remote);
export const isRemote = () => active === 'remote';

// Where the choice is kept on this computer.
const CHOICE_FILE = () => path.join(DATA_DIR, 'link.json');
function remember() {
  try { fs.writeFileSync(CHOICE_FILE(), JSON.stringify({ choice, handedOverAt }) + '\n'); } catch (err) { log(`link: could not remember the choice (${err.message})`); }
}
function recall() {
  try { return JSON.parse(fs.readFileSync(CHOICE_FILE(), 'utf8')); } catch { return {}; }
}
function setChoice(next) {
  if (choice === next) return;
  choice = next;
  remember();
}

// Background work (cards, events, sorting threads) runs on one computer only: on the
// laptop while it does the work and is not handing over; on the Pi while the laptop has
// not said for a few minutes that it does.
export const mayRunBackground = () => !finalizing && (enabled() ? choice === 'local' && !isRemote() : Date.now() - leaseAt > LEASE_MS);

// Getting ready to suspend: no new background work starts, and what is here is saved, so
// the status line can say when the computer can sleep. Any message from Florian ends it.
let finalizing = false;
export const isFinalizing = () => finalizing;
export function setFinalize(on) {
  finalizing = Boolean(on);
  if (finalizing) datasync.saveNow('getting ready to suspend').catch(() => {});
  return finalizing;
}
export const leaseHeld = () => !enabled() && Date.now() - leaseAt <= LEASE_MS;
export function takeLease(on) { leaseAt = on ? Date.now() : 0; }

export function status() {
  return {
    enabled: enabled(), choice, active, online, switching, note, step, handedOverAt, checkedAt, finalizing,
    remote: config.remote, remoteName: config.remoteName, localName: config.localName,
  };
}

function setNote(text) { if (note !== text) { note = text; if (text) log(`link: ${text}`); } }

async function remoteCall(method, route, { timeout = 5000 } = {}) {
  const res = await fetch(config.remote + route, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${config.remoteName} answered ${res.status}`);
  return data;
}

async function ping() {
  try { online = Boolean((await remoteCall('GET', '/api/health', { timeout: 4000 })).ok); } catch { online = false; }
  checkedAt = Date.now();
  misses = online ? 0 : misses + 1;
  return online;
}

// Ends every open connection of the page, so it connects again and reads the state of
// the side it now talks to.
function cutOver(to) {
  active = to;
  for (const s of streams) s.destroy();
  streams.clear();
  events.emit('link-switched', {});
  log(`link: now on ${to === 'remote' ? config.remoteName : config.localName}`);
}

async function toRemote() {
  // The laptop's threads go to GitHub and the Pi takes them in, before anything moves.
  step = 'Saving to GitHub';
  const saved = await datasync.saveNow('handover');
  if (saved.enabled && saved.error) throw new Error(`could not save to GitHub first (${saved.error})`);
  step = `${config.remoteName} takes everything in`;
  await remoteCall('POST', '/api/sync/pull', { timeout: 120_000 });
  // The Pi does the background work from now on.
  await remoteCall('POST', '/api/sync/lease?release=1', { timeout: 10_000 }).catch(() => {});
  step = '';
  handedOverAt = Date.now();
  cutOver('remote');
  remember();
}

async function toLocal() {
  step = `${config.remoteName} saves to GitHub`;
  if (online) await remoteCall('POST', '/api/sync/push', { timeout: 120_000 }).catch((err) => log(`link: ${config.remoteName} could not save first: ${err.message}`));
  step = 'Taking everything in';
  await datasync.pullNow().catch((err) => log(`link: working from what is on this computer (${err.message})`));
  step = '';
  handedOverAt = 0;
  cutOver('local');
  remember();
  if (online) remoteCall('POST', '/api/sync/lease', { timeout: 10_000 }).catch(() => {});
}

// Decides where the page should be, and moves it there.
async function settle() {
  if (!enabled() || switching) return;
  const want = choice === 'remote' ? 'remote' : 'local';
  if (want === active) {
    step = '';
    // Handed over and the Pi does not answer: it stays handed over until he takes it back.
    if (want === 'remote') setNote(online ? '' : `${config.remoteName} is not answering. Everything stays with it until you take it back.`);
    return;
  }
  if (want === 'remote' && !online) {
    // Not handed over yet, and the Pi is off: no handing over to a Pi that is off. One
    // missed answer is not "off": only two in a row give up.
    if (misses < 2) return;
    step = '';
    setChoice('local');
    setNote(`${config.remoteName} is not reachable.`);
    return;
  }
  if (want === 'remote' && isBusy()) { step = 'Waiting for Claude to finish here'; setNote(''); return; }
  switching = true;
  try {
    if (want === 'remote') { await toRemote(); setNote(''); } else await toLocal();
  } catch (err) {
    step = '';
    setNote(`Staying on ${active === 'remote' ? config.remoteName : config.localName}: ${err.message}`);
    if (want === 'remote') setChoice('local');
  } finally {
    switching = false;
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Awake again after sleeping, the laptop stays handed over: only his click takes back.
    lastTick = Date.now();
    await ping();
    await settle();
    // Doing the work here: the Pi leaves the background work to the laptop.
    if (online && active === 'local' && choice === 'local') remoteCall('POST', '/api/sync/lease', { timeout: 10_000 }).catch(() => {});
  } finally { ticking = false; lastTick = Date.now(); }
}

// Returns at once; the status says how the change goes.
// Asks the other computer to save what it has to GitHub now. False when it is not there.
export async function remoteSave() {
  if (!enabled() || !online) return false;
  try { await remoteCall('POST', '/api/sync/push', { timeout: 120_000 }); return true; } catch { return false; }
}

export function choose(next) {
  setChoice(next === 'remote' ? 'remote' : 'local');
  note = '';
  if ((choice === 'remote') !== (active === 'remote')) step = choice === 'remote' ? 'Starting the handover' : 'Taking everything back';
  else step = '';
  tick();
  return Promise.resolve(status());
}

export async function initLink(cfg, { busy }) {
  config = cfg;
  isBusy = busy;
  if (!enabled()) return;
  // Handed over before the app stopped: still handed over. The laptop did nothing since,
  // so the page goes straight to the Pi.
  const kept = recall();
  if (kept.choice === 'remote') {
    choice = 'remote';
    if (kept.handedOverAt) { handedOverAt = kept.handedOverAt; active = 'remote'; }
    log(`link: ${kept.handedOverAt ? 'still handed over to' : 'handing over to'} ${config.remoteName}, as before the restart`);
  } else log(`link: ${config.localName} does the work; ${config.remoteName} is ${config.remote}`);
  // Starting up: whatever the Pi has that is not on GitHub yet comes over first.
  ping().then(async (up) => {
    if (!up) return;
    await remoteCall('POST', '/api/sync/push', { timeout: 120_000 }).catch(() => {});
    await datasync.pullNow().catch(() => {});
  });
  // What the laptop saves, the Pi takes in straight away, so the phone is not behind.
  datasync.onPushed(() => { if (online && active === 'local') remoteCall('POST', '/api/sync/pull', { timeout: 120_000 }).catch(() => {}); });
  const timer = setInterval(tick, Math.max(1, Number(config.remoteCheckSeconds) || 15) * 1000);
  timer.unref?.();
  // A handover waiting for Claude goes ahead as soon as Claude has finished.
  setInterval(() => { if (choice === 'remote' && active === 'local' && !switching) settle(); }, 2000).unref?.();
}

// Passes a request of the page on to the Pi, body and answer streamed as they are.
export function passOn(req, res) {
  const target = new URL(config.remote + req.originalUrl);
  const headers = { ...req.headers, host: target.host };
  delete headers.origin; // the Pi knows this page only as itself
  delete headers.referer;
  delete headers.connection;
  const lib = target.protocol === 'https:' ? https : http;
  const out = lib.request(target, { method: req.method, headers }, (back) => {
    res.writeHead(back.statusCode || 502, back.headers);
    back.pipe(res);
    back.on('close', () => streams.delete(out));
  });
  streams.add(out);
  out.on('error', (err) => {
    streams.delete(out);
    if (res.headersSent) { res.destroy(); return; }
    res.status(502).json({ error: `${config.remoteName} did not answer (${err.code || err.message}). Checking whether it is still there…` });
    tick();
  });
  res.on('close', () => { if (!res.writableEnded) out.destroy(); streams.delete(out); });
  req.pipe(out);
}
