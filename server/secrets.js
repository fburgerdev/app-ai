// Florian's secrets, from the brain, encrypted with age.
//
// The brain holds his high-risk data only encrypted: `Core/Secrets.md.age` is a Markdown
// list, one `name: value` line per secret, and documents sit in `Files/` with `.age` added
// to their names. The app is the only thing that holds the key (an age identity file,
// `secretsKey` in config.json). Claude never sees a value: it writes `{{secret:name}}`
// where one belongs, and the app fills that in at the last step (copying, Gmail, a
// download, a script's environment). Everything the app writes elsewhere (Threads/ in the
// vault, the app-ai-data repo, a brain update's commit) goes through redact(), so a value
// Florian typed himself comes out as its placeholder.
//
// The values are kept in memory only. A document is decrypted into memory, or into a
// temporary file a tool asked for, which goes when the turn ends.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, log } from './config.js';

export const SECRETS_FILE = 'Core/Secrets.md.age';
const PLACEHOLDER = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g;
const MIN_LENGTH = 4; // shorter values would blank out ordinary words and numbers

let brainDir = '';
let identities = [];
let reason = 'off'; // why there are no secrets: '' once the key is read
let values = new Map(); // name -> value
let patterns = []; // [{ name, regex }], longest value first
let stamp = '';

const inside = (file, root) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Reads the key. Refuses a key inside the data folder, which is pushed to GitHub.
export function initSecrets(config) {
  brainDir = config.brainDir || '';
  identities = [];
  values = new Map();
  patterns = [];
  stamp = '';
  const given = String(config.secretsKey || '').trim();
  if (!given) { reason = 'off'; return status(); }
  const keyFile = path.resolve(given.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (inside(keyFile, DATA_DIR)) {
    reason = 'The age key is inside the app\'s data folder, which is saved to GitHub. Move it elsewhere and set secretsKey to the new path; secrets stay off until then.';
    log(`secrets: off. ${reason}`);
    return status();
  }
  let text = '';
  try { text = fs.readFileSync(keyFile, 'utf8'); } catch (err) {
    reason = `The age key at secretsKey cannot be read (${err.code || err.message}); secrets stay off.`;
    log(`secrets: off. ${reason}`);
    return status();
  }
  identities = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^AGE-SECRET-KEY-/i.test(l));
  if (!identities.length) {
    reason = 'The file at secretsKey holds no age identity (a line starting with AGE-SECRET-KEY-); secrets stay off.';
    log(`secrets: off. ${reason}`);
    return status();
  }
  reason = '';
  return status();
}

export const secretsEnabled = () => !reason;
export const status = () => ({ enabled: !reason, reason, names: [...values.keys()] });
export const secretNames = () => [...values.keys()];

async function decrypter() {
  const { Decrypter } = await import('age-encryption');
  const d = new Decrypter();
  for (const id of identities) d.addIdentity(id);
  return d;
}

// An age file as bytes, binary or armored.
async function decryptBytes(data) {
  let bytes = new Uint8Array(data);
  const head = Buffer.from(bytes.subarray(0, 40)).toString('latin1');
  if (head.startsWith('-----BEGIN AGE ENCRYPTED FILE-----')) {
    const { armor } = await import('age-encryption');
    bytes = armor.decode(Buffer.from(bytes).toString('latin1'));
  }
  return (await decrypter()).decrypt(bytes);
}

// `name: value` lines; list markers and backticks around either side are allowed.
export function parseSecrets(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?`?([A-Za-z0-9_]+)`?\s*:\s*(.*?)\s*$/.exec(line);
    if (!m || !m[2]) continue;
    const value = m[2].replace(/^`(.*)`$/, '$1').trim();
    if (value) out.set(m[1].toLowerCase(), value);
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What a value may look like in text: as written; for one made of letters and digits
// only, also with or without spaces between them (an IBAN in groups of four, a tax id
// as 12 345 678 901); inside JSON, with its escapes. Only whole tokens are matched.
function patternFor(value) {
  const forms = new Set([escape(value)]);
  const bare = value.replace(/\s+/g, '');
  if (/^[A-Za-z0-9]+$/.test(bare) && bare.length >= 6) forms.add([...bare].map(escape).join('[ \\u00a0]?'));
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) forms.add(escape(json));
  return new RegExp(`(?<![A-Za-z0-9])(?:${[...forms].join('|')})(?![A-Za-z0-9])`, 'g');
}

export function setSecrets(map) {
  values = new Map(map);
  patterns = [...values]
    .filter(([, v]) => v.replace(/\s+/g, '').length >= MIN_LENGTH)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, value]) => ({ name, regex: patternFor(value) }));
}

// Reads Core/Secrets.md.age from the brain clone again when it changed. Cheap to call
// often. Never throws: without the file or the key there are simply no values.
export async function refreshSecrets() {
  if (reason || !brainDir) return status();
  const file = path.join(brainDir, ...SECRETS_FILE.split('/'));
  let st;
  try { st = fs.statSync(file); } catch { if (values.size) setSecrets(new Map()); stamp = ''; return status(); }
  const now = `${st.size}:${st.mtimeMs}`;
  if (now === stamp) return status();
  try {
    const text = Buffer.from(await decryptBytes(fs.readFileSync(file))).toString('utf8');
    setSecrets(parseSecrets(text));
    stamp = now;
    log(`secrets: ${values.size} read from ${SECRETS_FILE}`);
  } catch (err) {
    stamp = now;
    log(`secrets: ${SECRETS_FILE} could not be decrypted with the key (${err.message})`);
  }
  return status();
}

// Placeholders filled in. Unknown names stay as they are, so a missing value shows.
export function fill(text) {
  if (typeof text !== 'string' || !values.size) return text;
  return text.replace(PLACEHOLDER, (all, name) => values.get(name.toLowerCase()) ?? all);
}

export const hasPlaceholder = (text) => typeof text === 'string' && /\{\{\s*secret:[A-Za-z0-9_]+\s*\}\}/.test(text);

// Every known value replaced by its placeholder.
export function redact(text) {
  if (typeof text !== 'string' || !patterns.length) return text;
  let out = text;
  for (const { name, regex } of patterns) out = out.replace(regex, `{{secret:${name}}}`);
  return out;
}

export const containsSecret = (text) => typeof text === 'string' && patterns.some(({ regex }) => { regex.lastIndex = 0; const hit = regex.test(text); regex.lastIndex = 0; return hit; });

// For a script on the artifacts workbench: APP_SECRET_IBAN and so on.
export function secretEnv() {
  const env = {};
  for (const [name, value] of values) env[`APP_SECRET_${name.toUpperCase()}`] = value;
  return env;
}

// A document of the vault's Files/ folder, decrypted into memory. `rel` is "Files/…",
// with or without ".age". Null when there is no such encrypted file.
export function encryptedDocPath(rel) {
  if (reason || !brainDir) return null;
  const root = path.join(brainDir, 'Files');
  const name = String(rel || '').replace(/^Files[\\/]/i, '');
  const full = path.resolve(root, /\.age$/i.test(name) ? name : `${name}.age`);
  if (!inside(full, root) || full === path.resolve(root)) return null;
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

export async function decryptDocument(rel) {
  const file = encryptedDocPath(rel);
  if (!file) return null;
  return { name: path.basename(file).replace(/\.age$/i, ''), data: Buffer.from(await decryptBytes(fs.readFileSync(file))) };
}

// The values as a file a shell command loads before it runs: kept in a folder of its own
// in the system's temp folder (outside everything a thread can read with its file tools),
// readable by this user only, and removed with dropEnvFile when the turn ends.
const envFiles = new Map(); // key -> folder
export function envFileFor(key, kind) {
  if (!values.size) return null;
  let dir = envFiles.get(key);
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `app-ai-env-${crypto.randomBytes(4).toString('hex')}-`));
    envFiles.set(key, dir);
  }
  const env = secretEnv();
  const ps = kind === 'powershell';
  const file = path.join(dir, ps ? 'env.ps1' : 'env.sh');
  const lines = Object.entries(env).map(([k, v]) => (ps ? `$env:${k} = '${v.replace(/'/g, "''")}'` : `export ${k}='${v.replace(/'/g, "'\\''")}'`));
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

export function dropEnvFile(key) {
  const dir = envFiles.get(key);
  if (!dir) return;
  envFiles.delete(key);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the temp folder is cleaned by the system too */ }
}

// A shell command that first loads the values, for Bash or PowerShell. The command itself
// is unchanged; only a path is put in front of it.
export function withEnv(command, key, tool) {
  const ps = tool === 'PowerShell';
  const file = envFileFor(key, ps ? 'powershell' : 'bash');
  if (!file) return command;
  if (ps) return `. '${file.replace(/'/g, "''")}'; ${command}`;
  const posix = file.split(path.sep).join('/');
  return `. '${posix.replace(/'/g, "'\\''")}'; ${command}`;
}
