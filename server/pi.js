// The Raspberry Pi as Claude's own computer: any thread can run a shell command on it,
// as root where needed (passwordless sudo), through the `pi_shell` tool.
//
// From the laptop the command goes over SSH (the `pi` entry in ~/.ssh/config, a key made
// for the app, Tailscale underneath). On the Pi itself it runs locally. Every command is
// a tool call in the thread, so Florian sees what was run.
//
// A few commands could make the Pi unusable or cut off the app (wiping a disk, deleting
// the home or root folder, rebooting). Those are refused until Florian has agreed in the
// thread; the tool then runs them with `confirmed`.

import os from 'node:os';
import { spawn } from 'node:child_process';
import { log } from './config.js';

let config = {};
export function initPi(cfg) { config = cfg || {}; }

const DANGEROUS = [
  [/\brm\s+(-[a-zA-Z]*\s+)*(\/|\/\*|~|~\/|\$HOME\/?|\/home\/?\S*|\/etc\/?|\/usr\/?|\/var\/?|\/boot\/?)(\s|;|&|$)/, 'deletes a whole system or home folder'],
  [/\b(mkfs(\.\w+)?|wipefs|fdisk|parted|sfdisk)\b/, 'changes a disk or its partitions'],
  [/\bdd\b[^|;&]*\bof=\/dev\//, 'writes straight onto a device'],
  [/>\s*\/dev\/(sd|mmcblk|nvme)/, 'writes straight onto a disk'],
  [/\b(reboot|shutdown|poweroff|halt)\b|systemctl\s+(reboot|poweroff|halt)/, 'restarts or switches off the Pi'],
  [/\b(userdel|passwd)\b|\/etc\/sudoers/, 'changes logins or sudo rights'],
  [/tailscale\s+(down|logout)|systemctl\s+(stop|disable)\s+(ssh|sshd|tailscaled)/, 'cuts off the way in to the Pi'],
];

// Why a command needs Florian's OK first, or '' when it does not.
export function needsConsent(command) {
  for (const [pattern, why] of DANGEROUS) if (pattern.test(String(command || ''))) return why;
  return '';
}

const onThePi = () => (config.pi?.local ?? os.hostname().toLowerCase() === 'pi');

// Runs a command on the Pi. Resolves with its output (the end of it, if long) and exit code.
export function runOnPi(command, { timeoutMs = 10 * 60_000 } = {}) {
  const host = config.pi?.host || 'pi';
  const [cmd, args] = onThePi()
    ? ['bash', ['-lc', command]]
    : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, 'bash', '-lc', `'${String(command).replace(/'/g, `'\\''`)}'`]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d) => { out = (out + d).slice(-40_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { out += '\n(stopped: it ran longer than allowed)'; child.kill(); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: `Could not reach the Pi: ${err.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 255 && !onThePi() && /Could not resolve|timed out|Connection refused|Permission denied/i.test(out)) out += '\n(The Pi could not be reached over SSH: is it on, and is Tailscale up?)';
      resolve({ code, out: out.trim() });
    });
  });
}

// The tool's body: refuses what needs consent unless confirmed, runs the rest.
export async function piShell({ command, confirmed = false, timeout_minutes: minutes }) {
  const why = needsConsent(command);
  if (why && !confirmed) {
    throw new Error(`Not run: this command ${why}. Ask Florian in the thread first, saying exactly what it does; only after he agreed, call pi_shell again with confirmed: true.`);
  }
  const timeoutMs = Math.min(Math.max(Number(minutes) || 10, 1), 60) * 60_000;
  log(`pi: ${why ? '(confirmed) ' : ''}${String(command).slice(0, 200)}`);
  const { code, out } = await runOnPi(command, { timeoutMs });
  return `exit code ${code}\n${out || '(no output)'}`;
}
