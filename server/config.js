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
  for (const key of ['google', 'voice', 'queue', 'cards', 'github']) config[key] = { ...DEFAULTS[key], ...(stored[key] || {}) };
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
