// Shared by the test files.

import fs from 'node:fs';

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
  const end = Date.now() + ms;
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
