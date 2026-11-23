// Where the app keeps its data, and its settings.
//
// App data lives outside the brain vault on purpose: the vault folder on the laptop is
// reset to GitHub every minute by Brain Sync, and thread state changes far too often to
// belong in the brain's git history.
//
//   Windows   %LOCALAPPDATA%\app-ai
//   macOS     ~/Library/Application Support/app-ai
//   Linux     ~/.local/share/app-ai
//
// Set APP_AI_DATA to use another folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultDataDir() {
  if (process.env.APP_AI_DATA) return path.resolve(process.env.APP_AI_DATA);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'app-ai');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'app-ai');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'app-ai');
}

export const DATA_DIR = defaultDataDir();
export const THREADS_DIR = path.join(DATA_DIR, 'threads');
export const EXTRACTIONS_DIR = path.join(DATA_DIR, 'extractions');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const LOG_FILE = path.join(DATA_DIR, 'log.txt');
export const READS_FILE = path.join(DATA_DIR, 'reads.jsonl');
export const GOOGLE_TOKEN_FILE = path.join(DATA_DIR, 'google-token.json');

const DEFAULTS = {
  // The local web address. Bound to this computer only.
  port: 4317,

  // The brain vault on GitHub and the branch that is its ground truth.
  brainRepo: 'https://github.com/fburgerdev/brain.git',
  brainBranch: 'main',
  // Where the app keeps its own clone. Never point this at the Obsidian folder.
  brainDir: '',

  // Vault files put into every thread's instructions, so Claude has the current rules
  // without spending a tool call on reading them. Paths relative to the vault.
  preload: ['Claude/Instructions.md', 'Claude/Thinking With Me.md'],

  // Paths in the vault the app never writes, whatever a run does.
  protectedPaths: ['Scratchpad.md', '.obsidian', 'For Claude', 'For Florian'],
  // Paths left out of the app's clone altogether, so Claude cannot even read them.
  hiddenPaths: ['Scratchpad.md', '.obsidian', 'For Claude/processed'],

  // The model and effort for threads and brain updates are chosen in the app itself
  // (next to the reply box) and kept with the app's state, not here.

  // Where the app's own state is saved: threads, water levels, pads, the queue's
  // learning. The data folder is a git repository that is committed and pushed to this
  // repo every few minutes. Empty: the state stays on this computer only.
  dataRepo: 'https://github.com/fburgerdev/app-ai-data.git',
  dataBranch: 'main',
  dataSyncMinutes: 2,
  // While the page is open, changes are saved ahead of that timer, this often (seconds);
  // every 15 seconds while getting ready to suspend or handing over.
  statusSaveSeconds: 60,

  // On the laptop: the address of the same app on the Raspberry Pi, for example
  // "https://pi.tail1234.ts.net". The laptop does the work; the app then has a switch
  // to hand everything over to the Pi and take it back. Empty on the Pi. See docs/laptop.md.
  remote: '',
  remoteName: 'Pi',
  localName: 'Laptop',
  remoteCheckSeconds: 15,

  // Git repos threads work in: cloned on demand into the data folder (repos/), from here.
  reposDir: '',
  repoBase: 'https://github.com',
  // GitHub's API, for renaming and creating repos. Empty token: the one git uses on this machine.
  github: { owner: 'fburgerdev', token: '' },

  // Taking the newest version from GitHub while the app runs, restarting when Claude is
  // not working. On by itself on Windows; the Pi has deploy/update.sh instead.
  selfUpdate: null,
  selfUpdateMinutes: 10,

  // Recording what gets read from the vault (reads.jsonl). Off for now.
  readLog: false,

  // The queue: a small model decides what you see next, from what is waiting, your mood
  // line and what it has learned from your choices.
  // The app repairs itself: a failure opens a thread in which Claude finds the cause and
  // fixes the app's own repo; a fix whose tests pass is merged and pushed by the app.
  repair: { auto: true, autoMerge: true, repo: 'fburgerdev/app-ai' },

  // Which tier a message gets when the tier is "auto": a cheap model reads it and picks.
  routeModel: 'haiku',

  queue: {
    pickModel: 'haiku', // ranks what is waiting
    learnModel: 'sonnet', // rewrites the learned profile from your choices
    learnEvery: 30, // after this many new choices, the profile is rewritten
    requeueMinutes: 20, // a requeued thread stays at the back this long
  },

  // Opportunity and chase cards, made in the background while you work the queue.
  cards: {
    auto: true, // make new ones by itself when few are left
    keepReady: 3, // how many unseen cards to keep in stock
    perRun: 3, // how many one run may make
    pauseMinutes: 45, // shortest time between two runs
    calendarHours: 3, // how often to look at the calendar for something to prepare
  },

  // Whether Claude may run shell commands inside threads. Off: threads can read the
  // vault, search the web and write artifacts, nothing else.
  threadShell: false,

  // The age identity file (made by age-keygen) that decrypts Core/Secrets.md.age and the
  // .age documents in the vault's Files/ folder. Empty: secrets are off. It must be outside
  // the data folder, which is pushed to GitHub; a key inside it is refused. See server/secrets.js.
  secretsKey: '',

  // Whether a thread without a repo may run commands in its own artifacts folder: scripts
  // that fill a PDF form, read or edit a Word or Excel file, convert a file. On by default.
  artifactsShell: true,

  // Whether a thread's branch is pushed to GitHub by itself when its turn ends, so the
  // work never sits on one computer only. Merging into main stays Florian's button.
  autoPush: true,

  // Whether that branch is then merged into main by itself: after the repo's tests pass
  // (npm test), or at once if it has none. Failing tests leave it with a note in the thread.
  autoMerge: true,

  // Where those tests run. A branch with a workflow in .github/workflows is tested by GitHub
  // Actions, and the app only waits for the result, so the laptop and the Pi stay free. If
  // no run has started after `startMs` (Actions off, a workflow that does not run on push)
  // or GitHub cannot be asked, the tests run here as before. `waitMs` is how long a run may
  // take; `pollMs` how often the app asks. `"ci": { "auto": false }` always tests here.
  ci: { auto: true, startMs: 4 * 60_000, waitMs: 30 * 60_000, pollMs: 15_000 },

  // Claude's usage limits (five-hour, weekly). A turn or brain update they cut off runs
  // again by itself once the limit has lifted: `marginMs` after the time Claude names,
  // or `fallbackMs` later when it names none. `checkMs` is how often the app looks.
  limits: { marginMs: 3 * 60_000, fallbackMs: 15 * 60_000, checkMs: 20_000 },

  // A message of Florian's that no turn took up (it was sent while the work moved between
  // the laptop and the Pi) is answered by itself: looked for every `checkMs`, once the
  // message is `minAgeMs` old, and never for one older than `maxAgeMs`. `slackMs` is how
  // far the two computers' clocks may be apart.
  leftOver: { checkMs: 60_000, minAgeMs: 60_000, maxAgeMs: 6 * 3600_000, slackMs: 5000 },

  // Work that stalls carries on by itself (retry.js), so Florian need not type "go on" or
  // "try again": a turn that ended on an error runs again after `backoffMin` minutes; a
  // turn in which Claude called continue_later (a render or build still running) runs
  // again when it asked; a branch whose tests failed or that clashes with main gets a turn
  // that fixes it, and a merge that failed for another reason (the network) is tried again
  // after `remergeMin` minutes. The safety handles, all counted since his last message:
  // at most `maxRuns` automatic turns, `errorTries` errors in a row in which Claude got
  // nothing done, `mergeFixes` fixing turns and `remerges` plain retries of the merge.
  // continue_later waits between `continueMinMin` and `continueMaxMin` minutes.
  autoRetry: { enabled: true, maxRuns: 10, goaheadDelayMs: 60_000, errorTries: 3, backoffMin: [1, 4, 15], mergeFixes: 2, remerges: 3, remergeMin: 5, mergeFixDelayMs: 20_000, continueMinMin: 1, continueMaxMin: 60 },

  // How many threads may be worked on at once. More than this wait in line.
  maxParallel: 6,

  // Other addresses this app may be opened under, besides localhost. Empty on a laptop.
  // On a Raspberry Pi behind "tailscale serve" this is the Pi's name in your tailnet,
  // for example ["pi.tail1234.ts.net"]. See docs/pi.md.
  allowedHosts: [],

  // Gmail and Google Calendar. The two values come from your own Google Cloud project;
  // see docs/google.md. Connecting happens in the app, under "Connections".
  google: {
    clientId: '',
    clientSecret: '',
  },

  // Calling the inbox from a phone, through Twilio. Off until set up; see docs/calling.md.
  voice: {
    enabled: false,
    publicUrl: '', // the https address Twilio reaches this app under
    authToken: '', // Twilio auth token, used to check that a call really comes from Twilio
    allowedCallers: [], // phone numbers that may call, like "+491701234567"
    language: 'en-US',
    speechTimeoutMs: 2500, // how long a pause ends what you are saying
    digestModel: 'haiku', // model that turns a reply into something to listen to
    hostModel: 'haiku', // the voice you talk to: decides where your speech goes
    thinkModel: 'sonnet', // answers the questions the host hands on
    groqKey: '', // Groq API key: the Talk page then listens through Groq's Whisper instead of the phone
    openaiKey: '', // OpenAI API key, only for the "openai" voice
    speak: 'piper', // the voice that reads aloud: piper (on this machine) or openai; the phone's own if neither is there
    piper: { command: 'piper', dir: '', voices: { de: 'de_DE-thorsten-medium', en: 'en_US-lessac-medium' } },
  },
};

function ensureDirs() {
  for (const dir of [DATA_DIR, THREADS_DIR, EXTRACTIONS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig() {
  ensureDirs();
  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON (${CONFIG_FILE}): ${err.message}`);
    }
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  const config = { ...DEFAULTS, ...stored };
  for (const key of ['google', 'voice', 'queue', 'cards', 'github', 'repair', 'limits', 'leftOver', 'autoRetry', 'ci']) config[key] = { ...DEFAULTS[key], ...(stored[key] || {}) };
  const piper = stored.voice?.piper || {};
  config.voice.piper = { ...DEFAULTS.voice.piper, ...piper, voices: { ...DEFAULTS.voice.piper.voices, ...(piper.voices || {}) } };
  if (process.env.APP_AI_PORT) config.port = Number(process.env.APP_AI_PORT);
  if (process.env.APP_AI_BRAIN_REPO) config.brainRepo = process.env.APP_AI_BRAIN_REPO;
  if (process.env.APP_AI_DATA_REPO !== undefined) config.dataRepo = process.env.APP_AI_DATA_REPO;
  if (process.env.APP_AI_REPO_BASE) config.repoBase = process.env.APP_AI_REPO_BASE;
  config.remote = String(config.remote || '').trim().replace(/\/+$/, '');
  if (!config.brainDir) config.brainDir = path.join(DATA_DIR, 'brain');
  config.brainDir = path.resolve(config.brainDir);
  config.fake = process.env.APP_AI_FAKE === '1';
  return config;
}

export function log(...parts) {
  const line = `${new Date().toISOString()}  ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // logging must never break the app
  }
}
