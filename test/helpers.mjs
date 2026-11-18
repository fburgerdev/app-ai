// Shared by the test files.

import fs from 'node:fs';
import net from 'node:net';

// How much longer than its stated time a wait may take. The stated times fit a machine
// that has nothing else to do; when the app runs the suite by itself, the laptop may be
// busy or throttled and everything takes several times as long. A wait that succeeds
// costs nothing extra, so being patient only shows when something is really broken.
export const patience = Math.max(1, Number(process.env.APP_AI_TEST_PATIENCE) || 5);

// "localhost" is two addresses (::1 and 127.0.0.1) and Node gives each 250 ms before it
// moves on. The servers listen on 127.0.0.1 only, so on a slow machine a request could
// fail ("fetch failed") although the server was up.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(5000);

// A request that never reached the server is sent again. Between two requests of a test
// the server may close the connection the last one used (it does after five idle seconds),
// and a slow machine notices too late: the next request goes into the closed connection
// and fails with "fetch failed", although the server is fine.
const plainFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  for (let i = 0; ; i += 1) {
    try { return await plainFetch(...args); } catch (err) {
      if (i >= 2 || err?.message !== 'fetch failed') throw err;
      await sleep(150);
    }
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stops the servers a test file started and removes its temp folder. On Windows a killed
// server, or a git it had started, can hold a folder for a moment longer (EBUSY): this
// waits for the processes to exit and tries again for a while. A temp folder that still
// cannot be removed is left behind; that is no reason for the suite to fail.
export async function cleanup(dir, procs = []) {
  await Promise.all(procs.filter(Boolean).map((p) => new Promise((done) => {
    if (p.exitCode !== null || p.signalCode !== null) return done();
    p.once('exit', done);
    p.kill();
    setTimeout(done, 5000).unref();
  })));
  for (let i = 0; i < 40; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(250); }
  }
}

// Waits until `fn` returns something truthy, by the clock rather than by a count of
// tries: with eight servers and their gits running side by side, a step that takes two
// seconds alone can take much longer.
export async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms * patience;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (err) { last = err; }
    await sleep(60);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last.message})` : ''}`);
}

// A port nothing is listening on, from the operating system. The test files used to
// pick one at random from a range each, which collides as soon as two runs of the suite
// overlap (the app runs it by itself after a repair, while a thread may be running it too).
export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}
