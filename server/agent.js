// Runs one turn of Claude through the Claude Agent SDK and reports what happens as
// simple events. The rest of the app never touches the SDK directly, so an SDK change
// lands in this one file.
//
// Permissions are decided here, in code, not by asking: nobody is sitting at a prompt.
//   thread   reads the vault, searches the web, writes only into its artifacts folder
//            (what Florian sees) and its workbench, and runs commands on the workbench
//            (scripts that fill a PDF, edit a Word file); once it has opened a repo, also
//            writes and runs commands in that repo
//   extract  the brain update: reads and writes the vault, no web, no git history
//   plain    no tools at all (used to turn a reply into something to listen to)
//   lookup   like plain, but it may search and read the web (the voice host's harder questions)

import { record as recordUsage } from './usage.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './config.js';
import { fromEvent, limitOf, noteLimit } from './limits.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const FREE_TOOLS = new Set(['WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Task', 'Skill', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Monitor']);
const NEVER = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'CronDelete', 'CronList'];
const GIT_HISTORY = /\bgit\b[^|;&\n]*\b(commit|push|pull|fetch|reset|rebase|checkout|switch|restore|clean|stash|merge|branch|remote|config)\b/;

// In a repo, Claude commits on its own branch; pushing, switching branches and throwing
// work away are the app's and Florian's.
const REPO_FORBIDDEN = [
  [/\bgit\b[^|;&\n]*\bpush\b/, 'Do not push yourself: when the turn ends the app pushes this thread\'s branch, tests it and merges it into main by itself.'],
  [/\bgit\b[^|;&\n]*\b(switch|worktree)\b|\bgit\b[^|;&\n]*\bcheckout\b(?![^|;&\n]*\s--\s)/, 'Stay on this thread\'s branch: the app manages branches. To undo changes to a file use "git restore <file>".'],
  [/\bgit\b[^|;&\n]*\b(reset\s+--hard|branch\s+-[dD]|remote|filter-branch|clean\s+-[a-z]*f)/, 'That git command can lose work or change the repo\'s setup; the app does not allow it.'],
  [/\bgh\b[^|;&\n]*\b(repo\s+(delete|rename|archive)|pr\s+(merge|create))/, 'Use the app\'s GitHub tools; deleting a repo is not possible at all.'],
];

function isInside(file, root) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Whether a shell command starts by going into `dir` (or a folder inside it):
// `cd "<dir>"`, `Set-Location`, `pushd`. That is where a thread without a repo runs its
// scripts. It is a rule Claude is held to, not a sandbox: a script can still reach
// other folders, so the vault's own safety net (stray changes are thrown away) stays.
export function startsIn(command, dir) {
  const m = /^\s*(?:cd|chdir|pushd|Set-Location|Push-Location|sl)\s+(?:\/d\s+)?(?:-(?:Literal)?Path\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(String(command || ''));
  if (!m) return false;
  let p = m[1] || m[2] || m[3];
  // Git Bash writes C:\Users as /c/Users.
  const drive = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (drive && process.platform === 'win32') p = `${drive[1]}:/${drive[2]}`;
  return isInside(path.resolve(p), dir);
}

function allow(input) {
  return { behavior: 'allow', updatedInput: input };
}

function deny(message) {
  return { behavior: 'deny', message };
}

// Builds the function the SDK calls before every tool use that needs a decision.
export function buildPolicy({ mode, cwd, artifactsDir, workDir = '', readDirs = [], protectedPaths = [], shell = false, artifactsShell = false, google = false, repoDir = () => null, reposDir = '' }) {
  const readable = [cwd, artifactsDir, workDir, ...readDirs, reposDir].filter(Boolean);
  const target = (input) => {
    const p = input.file_path || input.notebook_path || input.path;
    return p ? path.resolve(cwd, String(p)) : null;
  };

  return async (toolName, input) => {
    if (WRITE_TOOLS.has(toolName)) {
      const file = target(input);
      if (!file) return deny('No file path given.');
      if (mode === 'thread') {
        if (isInside(file, artifactsDir)) return allow(input);
        if (workDir && isInside(file, workDir)) return allow(input);
        const repo = repoDir();
        if (repo && isInside(file, repo)) {
          if (isInside(file, path.join(repo, '.git'))) return deny('The .git folder is the app\'s to manage.');
          return allow(input);
        }
        if (reposDir && isInside(file, reposDir)) return deny('Open that repo with open_repo first: only the repo this thread holds can be changed.');
        return deny(
          `Threads in this app cannot write there. Write files only into the artifacts folder: ${artifactsDir}. ` +
          'The vault is written by the brain update, which Florian starts himself.',
        );
      }
      if (!isInside(file, cwd)) return deny('The brain update writes only inside the vault.');
      for (const p of protectedPaths) {
        if (isInside(file, path.join(cwd, p))) return deny(`"${p}" is Florian's own or shared; the brain update never writes it.`);
      }
      return allow(input);
    }

    if (READ_TOOLS.has(toolName)) {
      const file = target(input);
      if (!file || readable.some((root) => isInside(file, root))) return allow(input);
      return deny('That path is outside the vault and this thread\'s folders.');
    }

    if (FREE_TOOLS.has(toolName)) {
      if (mode === 'extract' && (toolName === 'WebSearch' || toolName === 'WebFetch')) {
        return deny('The brain update works only from the transcripts and the vault.');
      }
      return allow(input);
    }

    if (SHELL_TOOLS.has(toolName)) {
      if (mode === 'thread') {
        const repo = repoDir();
        if (repo) {
          const command = String(input.command || '');
          for (const [pattern, why] of REPO_FORBIDDEN) if (pattern.test(command)) return deny(why);
          return allow(input);
        }
        if (shell) return allow(input);
        const bench = workDir || artifactsDir;
        if (!artifactsShell || !bench) return deny('Shell commands work only in a repo: call open_repo first. Otherwise they are turned off for threads in this app.');
        // Without a repo: scripts on the thread's own files, run from its workbench.
        if (toolName !== 'Bash' && toolName !== 'PowerShell') return allow(input); // the output of a command already allowed, or stopping it
        const command = String(input.command || '');
        if (/(^|[\s;&|(])(git|gh)(\.exe)?\s/i.test(command)) return deny('No git here: the vault is the app\'s to manage, and code lives in repos. Call open_repo to work in one.');
        if (!startsIn(command, bench)) return deny(`Without a repo, commands run on this thread's workbench: start the command with cd "${bench}". Keep scripts, libraries and everything made on the way there; write only the finished file into the artifacts folder, or hand it over with show_file. Never write into the vault.`);
        return allow(input);
      }
      const command = String(input.command || '');
      if (GIT_HISTORY.test(command)) {
        return deny('Do not use git here beyond "git mv" and "git rm": the app commits and pushes when you finish.');
      }
      return allow(input);
    }

    // Gmail and Calendar: the app's own tools, which can read, draft and add, never send.
    if (toolName.startsWith('mcp__google__')) {
      return mode === 'thread' && google ? allow(input) : deny('Gmail and Calendar are not connected in this app.');
    }

    // The app's own tools for a thread (spinning off another thread).
    if (toolName.startsWith('mcp__app__')) {
      return mode === 'thread' ? allow(input) : deny('That is only available in a thread.');
    }

    return deny(`${toolName} is not available in this app.`);
  };
}

// The app's own tools for a thread. `spinOff` starts a new thread from this one.
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (err) => ({ content: [{ type: 'text', text: err.message || String(err) }], isError: true });

async function buildAppServer({ spinOff, repoTools, showFile, piShell, moveEvent }) {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  return createSdkMcpServer({
    name: 'app',
    version: '1.0.0',
    instructions: 'Tools of Florian\'s inbox app itself.',
    tools: [
      ...(repoTools ? [
        tool('open_repo', 'Open one of Florian\'s GitHub repos to work in it during this turn: the app clones or updates it and puts this thread on its own branch. Call it before reading or changing the code, in every turn that needs the code. Only one thread can hold a repo at a time; if another thread holds it, this waits until that thread\'s turn ends. Returns the folder to work in.',
          { repo: z.string().optional().describe('owner/name or just the name (owner fburgerdev); leave out for this thread\'s own repo') },
          async ({ repo }) => {
            try {
              const r = await repoTools.open(repo);
              return ok(`Opened ${r.full} at ${r.dir}, on the branch ${r.branch} (made from ${r.base}). Work only inside that folder: start shell commands with cd "${r.dir}". Commit as you go with clear messages. Do not push, merge or switch branches yourself: when the turn ends the app commits whatever you left uncommitted, pushes this branch, runs the repo's tests and, if they pass, merges it into main by itself. End the turn only with work that may go live.`);
            } catch (err) { return fail(err); }
          }),
        tool('list_repos', 'List Florian\'s GitHub repos.', {}, async () => {
          try { return ok((await repoTools.list()).join('\n') || 'No repos found.'); } catch (err) { return fail(err); }
        }),
        tool('github_rename_repo', 'Rename one of Florian\'s GitHub repos. Only when Florian asks for it. GitHub forwards the old address; the app moves its own copy and the threads that use it.',
          { repo: z.string().describe('owner/name or name'), new_name: z.string().describe('the new name, without the owner') },
          async (args) => { try { return ok(`Renamed to ${await repoTools.rename(args)}.`); } catch (err) { return fail(err); } }),
        tool('github_create_repo', 'Create a new GitHub repo for Florian. Only after he agreed in this thread, to the repo and to its name (lowercase with hyphens: what it is first, then a very concise description, e.g. "website-mensa-mail", "ytvideo-gtd-framework"). Private unless he says otherwise. Open it with open_repo afterwards.',
          { name: z.string(), private: z.boolean().optional(), description: z.string().optional() },
          async (args) => { try { return ok(`Created ${await repoTools.create(args)}. Open it with open_repo to work in it.`); } catch (err) { return fail(err); } }),
        tool('github_describe_repo', 'Set the description of one of Florian\'s GitHub repos.',
          { repo: z.string(), description: z.string() },
          async (args) => { try { return ok(`Description of ${await repoTools.describe(args)} set.`); } catch (err) { return fail(err); } }),
      ] : []),
      ...(piShell ? [tool('pi_shell', 'Run a shell command on Florian\'s Raspberry Pi, which is yours to administer: install and update software, read logs, manage the app\'s services (systemctl --user ... app-ai), check disk and memory. Runs as the user florian with passwordless sudo, in bash, from the home folder. Commands that would wipe a disk, delete a system or home folder, reboot it, or cut off SSH or Tailscale are refused until Florian has agreed in the thread; then call again with confirmed: true. Returns the exit code and the output.',
        { command: z.string().describe('The bash command'), confirmed: z.boolean().optional().describe('Only after Florian agreed to a command that was refused'), timeout_minutes: z.number().optional().describe('Up to 60; default 10') },
        async (args) => { try { return ok(await piShell(args)); } catch (err) { return fail(err); } })] : []),
      ...(showFile ? [tool('show_file', 'Show Florian a file a script made: it is copied into this thread\'s artifacts folder and appears in the thread. Files you write into the artifacts folder with Write or Edit are shown already; use this for the finished result of a script (a filled PDF, an edited Word file, a chart). Only for files he should see: never for libraries, scripts or intermediate files.',
        { path: z.string().describe('The file, absolute or relative to the workbench'), name: z.string().optional().describe('The name he sees, if different from the file\'s; a name he would recognise') },
        async (args) => { try { return ok(await showFile(args)); } catch (err) { return fail(err); } })] : []),
      ...(moveEvent ? [tool('move_event', 'Move one of the app\'s events (the threads in Events, made from his calendar) to a new time. Call it as soon as Florian says an entry was postponed, moved or brought forward, in any thread, so Events shows the new time at once and the briefing opens by it. Without `event`, in an event\'s own thread, it moves that one. It changes only the app; it does not change Google Calendar.',
        {
          event: z.string().optional().describe('The event\'s thread id, or words from its title ("Blom"); leave out in the event\'s own thread'),
          start: z.string().describe('The new start, ISO 8601 with offset'),
          end: z.string().optional().describe('The new end; left out, the event keeps its length'),
          where: z.string().optional().describe('The new place, if that changed too'),
        },
        async (args) => { try { return ok(moveEvent(args)); } catch (err) { return fail(err); } })] : []),
      tool('spin_off', 'Start a new thread that begins as a copy of this conversation and works on one task by itself. Use it only when Florian asks in his message for something to be spun off into its own thread or task. The new thread sees the conversation so far and its files, then gets `task` as its instruction, so write `task` to stand alone: what to do, what to hand back, and what to leave to this thread.',
        { title: z.string().describe('A short name for the new thread, at most eight words'), task: z.string().describe('The complete instruction for the new thread') },
        async (args) => {
          try {
            return { content: [{ type: 'text', text: await spinOff(args) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: err.message }], isError: true };
          }
        }),
    ],
  });
}

// A short line for the interface saying what a tool call does.
export function describeTool(name, input = {}, cwd = '') {
  const rel = (p) => {
    if (!p) return '';
    const r = path.relative(cwd, path.resolve(cwd, String(p)));
    return (r.startsWith('..') ? path.basename(String(p)) : r).split(path.sep).join('/');
  };
  const clip = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  switch (name) {
    case 'Read': return `Read ${rel(input.file_path)}`;
    case 'Write': return `Wrote ${rel(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Edited ${rel(input.file_path)}`;
    case 'Glob': return `Looked for files matching ${clip(input.pattern, 60)}`;
    case 'Grep': return `Searched the vault for "${clip(input.pattern, 60)}"`;
    case 'WebSearch': return `Searched the web for "${clip(input.query, 70)}"`;
    case 'WebFetch': {
      try { return `Read ${new URL(String(input.url)).hostname}`; } catch { return 'Read a web page'; }
    }
    case 'Bash':
    case 'PowerShell': return `Ran ${clip(input.command, 80)}`;
    case 'Agent':
    case 'Task': return `Started a helper: ${clip(input.description || 'subtask', 70)}`;
    case 'mcp__app__open_repo': return `Opened the repo ${input.repo || ''}`.trim();
    case 'mcp__app__list_repos': return 'Listed the repos';
    case 'mcp__app__github_rename_repo': return `Renamed the repo ${input.repo} to ${input.new_name}`;
    case 'mcp__app__github_create_repo': return `Created the repo ${input.name}`;
    case 'mcp__app__github_describe_repo': return `Described the repo ${input.repo}`;
    case 'mcp__app__spin_off': return `Spun off a thread: ${clip(input.title, 60)}`;
    case 'mcp__app__move_event': return `Moved ${input.event ? `the event "${clip(input.event, 50)}"` : 'this event'} in Events`;
    case 'mcp__google__gmail_search': return `Searched your mail for "${clip(input.query, 70)}"`;
    case 'mcp__google__gmail_read_thread': return 'Read a mail thread';
    case 'mcp__google__calendar_list': return 'Looked at your calendar';
    case 'mcp__google__calendar_create': return `Added to your calendar: ${clip(input.title, 60)}${input.guests?.length ? `, inviting ${clip(input.guests.join(', '), 60)}` : ''}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'ToolSearch': return null;
    default: return name;
  }
}

function friendlyError(text) {
  const t = String(text || 'Claude stopped with an error.');
  if (/login|api key|authenticat|unauthori[sz]ed|oauth|credential/i.test(t)) {
    return `Claude is not signed in on this computer. Run "npm run login" in the app's folder, then send your message again. (${t.trim()})`;
  }
  if (/rate limit|usage limit|overloaded|quota/i.test(t)) {
    return `Claude's usage limit was reached or the service is busy. Send your message again later. (${t.trim()})`;
  }
  return t.trim();
}

/**
 * Runs one turn.
 * `limit` is set when the run was cut off by Claude's usage limit: { until, type }, with
 * `until` 0 when Claude did not say when it lifts (limits.js).
 * @returns {Promise<{sessionId: string|null, text: string, error: string, durationMs: number, aborted: boolean, limit?: {until: number, type: string}|null}>}
 */
export async function runAgent(params) {
  const started = Date.now();
  const run = params.fake ? runFake : runReal;
  try {
    const out = await run(params);
    const durationMs = Date.now() - started;
    // The stand-in reports a made-up amount, so the usage view has something to show.
    const usage = out.usage || (params.fake ? { input_tokens: 1200, output_tokens: Math.ceil((out.text || '').length / 4) } : null);
    // The SDK's price is the session's total so far; usage.js takes the earlier runs off.
    // Only a real run that keeps its session can be carried on, so only those are tracked.
    const kept = !params.fake && params.mode !== 'plain' && params.mode !== 'lookup';
    recordUsage({ kind: params.usageKind || params.mode, model: params.model, usage, cost: out.cost || (params.fake ? 0.01 : 0), durationMs, sessionId: kept ? out.sessionId || '' : '', resumed: Boolean(params.resume) });
    if (out.limit && !out.aborted) noteLimit(out.limit);
    else if (!out.error && !out.aborted) noteLimit(null);
    return { ...out, durationMs };
  } catch (err) {
    if (params.signal?.aborted) {
      return { sessionId: params.resume || null, text: '', error: '', aborted: true, durationMs: Date.now() - started };
    }
    log(`agent error: ${err.stack || err.message}`);
    const limit = limitOf({ error: err.message });
    if (limit) noteLimit(limit);
    return { sessionId: params.resume || null, text: '', error: friendlyError(err.message), aborted: false, limit, durationMs: Date.now() - started };
  }
}

async function runReal({ prompt, cwd, resume, systemAppend, model, effort, mode, artifactsDir, readDirs, protectedPaths, shell, artifactsShell, workDir, showFile, piShell, moveEvent, signal, title, onEvent, mcpServers: givenServers, spinOff, repoTools, repoDir, reposDir }) {
  const mcpServers = spinOff && mode === 'thread' ? { ...(givenServers || {}), app: await buildAppServer({ spinOff, repoTools, showFile, piShell, moveEvent }) } : givenServers;
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const disallowedTools = [...NEVER];
  if (mode === 'extract') disallowedTools.push('WebSearch', 'WebFetch');
  // A thread that can open a repo keeps the shell tools: the policy allows them only once
  // a repo is open (tests, builds, running the app). Taking them away
  // here would leave repo threads able to change code but never run it.
  if (mode === 'thread' && !shell && !repoTools) disallowedTools.push('Bash', 'PowerShell');

  // "plain" is Claude with no tools and no vault: text in, text out. "lookup" adds the web.
  const plain = mode === 'plain' || mode === 'lookup';
  const web = mode === 'lookup' ? ['WebSearch', 'WebFetch'] : [];
  const google = Boolean(mcpServers?.google);
  const options = plain ? {
    cwd,
    abortController,
    settingSources: [],
    systemPrompt: systemAppend,
    tools: web,
    permissionMode: 'default',
    canUseTool: async (name, input) => (web.includes(name) ? allow(input) : deny(`${name} is not available here.`)),
    persistSession: false,
  } : {
    cwd,
    abortController,
    includePartialMessages: true,
    // 'project' loads the vault's CLAUDE.md. The user's own Claude Code settings,
    // plugins and MCP servers stay out, so a thread behaves the same every time.
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
    permissionMode: 'default',
    canUseTool: buildPolicy({ mode, cwd, artifactsDir, workDir, readDirs, protectedPaths, shell, artifactsShell, google, repoDir, reposDir }),
    additionalDirectories: [artifactsDir, workDir, ...(readDirs || [])].filter(Boolean),
    disallowedTools,
  };
  if (!plain && mcpServers) options.mcpServers = mcpServers;
  if (resume) options.resume = resume;
  else if (title && !plain) options.title = title;
  if (model) options.model = model;
  if (effort && !plain) options.effort = effort;

  // The permission callback needs the streaming form of the prompt.
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: resume || '' };
  }

  let sessionId = resume || null;
  let text = '';
  let lastText = '';
  let error = '';
  let sawDelta = false;
  let usage = null;
  let cost = 0;
  let raw = ''; // the error as Claude Code worded it
  let code = ''; // its kind, e.g. 'rate_limit'
  let rejected = null; // the last limit Claude Code reported as reached
  let context = 0; // how many tokens the conversation held at Claude's last step

  for await (const msg of query({ prompt: input(), options })) {
    if (msg.session_id && msg.session_id !== sessionId) {
      sessionId = msg.session_id;
      onEvent?.({ type: 'session', sessionId });
    }
    if (msg.type === 'rate_limit_event') {
      // Which limit, and exactly when it lifts. A later "allowed" takes it back.
      rejected = fromEvent(msg.rate_limit_info);
    } else if (msg.type === 'stream_event') {
      if (msg.parent_tool_use_id) continue; // a helper's own text is not shown
      const ev = msg.event;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
        lastText = '';
        onEvent?.({ type: 'text-start' });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        sawDelta = true;
        text += ev.delta.text;
        lastText += ev.delta.text;
        onEvent?.({ type: 'text', delta: ev.delta.text });
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
        onEvent?.({ type: 'activity', text: 'Thinking' });
      }
    } else if (msg.type === 'assistant') {
      if (msg.error) {
        error = friendlyError(msg.error);
        code = msg.error;
        raw = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ') || msg.error;
      } else if (!msg.parent_tool_use_id) {
        code = '';
      }
      // What Claude read for this step plus what it wrote: the size of the conversation now.
      const u = !msg.parent_tool_use_id && msg.message?.usage;
      if (u) context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          const summary = describeTool(block.name, block.input, cwd);
          onEvent?.({ type: 'tool-input', name: block.name, input: block.input || {} });
          if (summary) onEvent?.({ type: 'tool', name: block.name, summary, helper: Boolean(msg.parent_tool_use_id) });
        } else if (block.type === 'text' && !msg.parent_tool_use_id && !sawDelta) {
          // No partial messages arrived for this block: show it whole.
          text += block.text;
          lastText = block.text;
          onEvent?.({ type: 'text-start' });
          onEvent?.({ type: 'text', delta: block.text });
        }
      }
      sawDelta = false;
    } else if (msg.type === 'user' && !msg.parent_tool_use_id) {
      onEvent?.({ type: 'tool-result' });
    } else if (msg.type === 'result') {
      if (msg.is_error || msg.subtype !== 'success') {
        raw = msg.result || (msg.errors || []).join(' ') || raw || msg.subtype;
        error = friendlyError(raw);
      } else {
        // A turn whose last word was "limit reached" did not finish, whatever the result says.
        if (code !== 'rate_limit') { error = ''; raw = ''; }
        if (!lastText && msg.result) lastText = msg.result;
      }
      usage = msg.usage || null;
      cost = msg.total_cost_usd || 0;
    }
  }
  const limit = error ? limitOf({ error: raw, code, seen: rejected }) : null;
  return { sessionId, text, finalText: lastText, error, aborted: abortController.signal.aborted, usage, cost, limit, context };
}

// ---------- a stand-in for Claude, for trying the app without an account ----------
//
// Started with APP_AI_FAKE=1. It streams canned text, pretends to use tools, writes an
// artifact when the message mentions a draft, and in a brain update edits one file.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fakeBrainLimited = false;

async function runFake({ prompt: userPrompt, systemAppend, cwd, resume, mode: givenMode, artifactsDir, workDir, readDirs, signal, onEvent, spinOff, repoTools, showFile, moveEvent }) {
  // In the no-tools modes the instructions are the system prompt; the stand-in reads both.
  const mode = givenMode === 'lookup' ? 'plain' : givenMode;
  const prompt = mode === 'plain' ? `${systemAppend || ''}\n${userPrompt}` : userPrompt;
  const sessionId = resume || `fake-${Date.now().toString(36)}`;
  onEvent?.({ type: 'session', sessionId });
  const speed = Number(process.env.APP_AI_FAKE_SPEED || 1);
  const say = async (full) => {
    onEvent?.({ type: 'text-start' });
    for (const piece of full.match(/[\s\S]{1,14}/g) || []) {
      if (signal?.aborted) throw new Error('aborted');
      onEvent?.({ type: 'text', delta: piece });
      await sleep(12 * speed);
    }
    return full;
  };

  if (mode === 'plain' && /PICK-NEXT/.test(prompt)) {
    // A stand-in picker: whatever matches a word of the mood line comes first.
    const mood = (/^Mood line: (.*)$/m.exec(prompt)?.[1] || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const items = [...(prompt.split('\nWaiting:\n')[1] || '').matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), line: m[2].toLowerCase() }));
    const hits = items.filter((i) => mood.some((w) => i.line.includes(w)));
    const order = [...hits, ...items.filter((i) => !hits.includes(i))].map((i) => i.n);
    const out = JSON.stringify({ order, why: hits.length ? 'matches your mood line' : 'oldest first' });
    return { sessionId: null, text: out, finalText: out, error: '', aborted: false };
  }
  if (mode === 'plain' && /LEARN-PROFILE/.test(prompt)) {
    const out = '- Stand-in profile: accepts short messages, requeues long reads.';
    return { sessionId: null, text: out, finalText: out, error: '', aborted: false };
  }
  if (mode === 'plain' && /HOST-ROUTE/.test(prompt)) {
    // A stand-in host: a few plain rules instead of judgement.
    const said = /^Florian said: (.*)$/m.exec(userPrompt)?.[1] || '';
    const low = said.toLowerCase();
    const open = !/^Open thread: none$/m.test(userPrompt);
    const waiting = [...userPrompt.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), line: m[2].toLowerCase() }));
    let decision;
    if (/HOST-FAIL/.test(said)) decision = 'not json at all';
    else if (/\b(um|and then)$/.test(low)) decision = { do: 'wait' };
    else if (/^look up\b/.test(low)) decision = { do: 'think', question: said };
    else if (/^(what|how many|who|why|when|is|are|do)\b.*\?$/.test(low)) decision = { do: 'answer', say: `Stand-in answer. ${waiting.length} waiting.` };
    else if (/^open the (\w+)/.test(low)) {
      const word = /^open the (\w+)/.exec(low)[1];
      decision = { do: 'open', thread: waiting.find((w) => w.line.includes(word))?.n || 99 };
    } else if (/^my mood is (.*)$/.test(low)) decision = { do: 'mood', text: /^my mood is (.*)$/i.exec(said)[1] };
    else if (/^(ask claude to|start a thread)\b/.test(low)) decision = { do: 'new', text: said };
    else if (/^close this one$/.test(low)) decision = { do: 'command', name: 'done' };
    else decision = open ? { do: 'reply', fix: { 'case TW': 'KStW' } } : { do: 'new', text: said };
    const out = typeof decision === 'string' ? decision : JSON.stringify(decision);
    return { sessionId: null, text: out, finalText: out, error: '', aborted: false };
  }
  if (mode === 'plain' && /asked out loud/.test(prompt)) {
    const out = `Stand-in careful answer to: ${/^The question to answer: (.*)$/m.exec(userPrompt)?.[1] || ''}`;
    return { sessionId: null, text: out, finalText: out, error: '', aborted: false };
  }
  if (mode === 'plain') {
    const source = userPrompt.split('---').pop().replace(/[#*_`>|\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const digest = source.length > 260 ? `${source.slice(0, 260)}…` : source;
    return { sessionId: null, text: digest, finalText: digest, error: '', aborted: false };
  }

  if (mode === 'extract') {
    onEvent?.({ type: 'tool', name: 'Read', summary: 'Read CLAUDE.md' });
    await sleep(150 * speed);
    const dir = path.join(cwd, fs.existsSync(path.join(cwd, 'Brain')) && !fs.existsSync(path.join(cwd, 'Core')) ? 'Brain' : 'Core');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'App Test.md');
    const stamp = new Date().toISOString();
    fs.appendFileSync(file, `- stand-in brain update at ${stamp}\n`);
    onEvent?.({ type: 'tool', name: 'Edit', summary: 'Edited Core/App Test.md' });
    const transcripts = (readDirs || []).flatMap((dir) => fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8')));
    // "BRAIN-LIMIT-TEST" in what is filed: the first run meets the usage limit, once.
    if (!fakeBrainLimited && transcripts.some((t) => /BRAIN-LIMIT-TEST/.test(t))) {
      fakeBrainLimited = true;
      return { sessionId, text: '', finalText: '', error: friendlyError('You\'ve hit your weekly limit · resets Fri 9am'), aborted: false, limit: { until: Date.now() + 400, type: 'seven_day' } };
    }
    const wantsQuestions = transcripts.some((t) => /QUESTION-TEST/.test(t.split('## New')[1] || ''));
    const wantsReply = transcripts.some((t) => /MAIL-TEST/.test(t));
    const report = [
      wantsQuestions ? 'STATUS: questions' : 'STATUS: updated',
      'COMMIT: thinking: stand-in brain update from the app',
      '',
      '## Written',
      '- Core/App Test.md — one test line',
      ...(wantsQuestions ? ['', '## Questions', '**App test**', '1. Add "Call the office" to Next Actions?'] : []),
      ...(wantsReply ? ['', '## Mail to answer', '- T-EXAMPLE | Terminvorschlag | asks for a date'] : []),
    ].join('\n');
    await say(report);
    return { sessionId, text: report, finalText: report, error: '', aborted: false };
  }

  if (/CARDS-RUN/.test(prompt)) {
    // A stand-in card run: an opportunity, a chase, a proposal, and something from the calendar.
    fs.mkdirSync(artifactsDir, { recursive: true });
    const stamp = Date.now().toString(36);
    // Names from the vault's own index, so the stand-in's cards land in real folders.
    let index = '';
    try { index = fs.readFileSync(path.join(cwd, fs.existsSync(path.join(cwd, 'Core')) ? 'Core' : 'Brain', 'Projects', 'Projects Index.md'), 'utf8'); } catch { /* no index */ }
    const someProject = /^- \[\[([^\]]+)\]\]/m.exec(index)?.[1] || '';
    const someArea = /^## \[\[([^\]]+)\]\]/m.exec(index)?.[1] || '';
    fs.writeFileSync(path.join(artifactsDir, 'one.json'), JSON.stringify({
      type: 'opportunity', channel: 'linkedin', key: `opp:example-person:${stamp}`,
      title: 'Connect with an example person', why: 'Runs catering at an example Studierendenwerk; no contact yet.',
      project: '', to: 'Example Person', link: 'https://www.linkedin.com/in/example',
      text: 'Hallo Frau Beispiel,\n\nich arbeite mit einem Studierendenwerk an pflanzlicher Hochschulgastronomie und würde mich gern mit Ihnen vernetzen.\n\nDieser zweite Absatz ist vielleicht zu viel.\n\nViele Grüße\nFlorian',
    }));
    fs.writeFileSync(path.join(artifactsDir, 'two.json'), JSON.stringify({
      type: 'chase', channel: 'mail', key: `chase:example-office:${stamp}`,
      title: 'Chase the example office', why: 'Waiting since 02-11 for their answer; chase date reached.',
      project: '', to: 'office@example.org', subject: 'Re: Kurze Nachfrage', replyTo: '18c2f0a1b2c3d4e5',
      text: 'Hallo Frau Beispiel,\n\nich wollte kurz nachfragen, ob es schon Neuigkeiten gibt.\n\nViele Grüße\nFlorian',
    }));
    fs.writeFileSync(path.join(artifactsDir, 'three.json'), JSON.stringify({
      type: 'proposal', channel: 'thread', key: 'proposal:example-motion:timeline',
      title: 'Work out the motion\'s timeline', why: 'The motion has had no activity for two weeks and the session date is close.',
      project: someProject,
      text: '**Work out a timeline for the motion, counted back from the session date.**\n\n- You get: a one-page plan and the first two mails as drafts\n- From: the project note and Waiting For',
    }));
    if (/The calendar is connected/.test(userPrompt)) {
      // EVENT-SOON in the prompt (tests): the fair starts in two hours instead of tomorrow.
      const soon = /EVENT-SOON/.test(userPrompt);
      const at = new Date(Date.now() + (soon ? 2 : 26) * 3600_000);
      fs.writeFileSync(path.join(artifactsDir, 'four.json'), JSON.stringify({
        type: 'prep', channel: 'thread', key: `prep:${at.toISOString().slice(0, 10)}:example-fair`,
        title: 'Example fair', why: 'In the calendar, and nothing in the Brain prepares it.',
        project: someArea, important: true, start: at.toISOString(), end: new Date(at.getTime() + 3 * 3600_000).toISOString(), where: 'Messe Köln',
        text: 'The calendar has "Example fair". Brief Florian on what he wants out of it, from the project notes, then start a preparation session with him.',
      }));
      fs.writeFileSync(path.join(artifactsDir, 'five.json'), JSON.stringify({
        type: 'prep', channel: 'thread', key: `prep:${at.toISOString().slice(0, 10)}:example-call`,
        title: 'Call with the example office', why: 'A call about one of his projects.',
        project: '', important: false, start: at.toISOString(), end: new Date(at.getTime() + 1800_000).toISOString(),
        text: 'A short call. Brief Florian in a few lines.',
      }));
    }
    return { sessionId, text: 'Made the cards.', finalText: 'Made the cards.', error: '', aborted: false };
  }

  // "LIMIT-TEST" or "LIMIT-TEST=<ms>": the usage limit cuts the turn off after a first
  // sentence; it lifts <ms> later. The run the app starts again by itself goes through.
  const limitAsk = /LIMIT-TEST(?:=(\d+))?/.exec(userPrompt);
  if (limitAsk && !/cut off by Claude's usage limit/.test(userPrompt)) {
    const said = await say('Started on it.');
    return { sessionId, text: said, finalText: said, error: friendlyError('You\'ve hit your 5-hour limit · resets 8:50pm'), aborted: false, limit: { until: Date.now() + Number(limitAsk[1] || 400), type: 'five_hour' } };
  }

  if (/FAIL-TEST/.test(prompt)) {
    return { sessionId, text: '', finalText: '', error: friendlyError('Invalid API key · Please run /login'), aborted: false };
  }

  let text = '';
  // "…spin off a new task about X": the stand-in does it, as the real Claude would with its tool.
  const newest = userPrompt.split('The new message:').pop();
  if (/SLOW-TEST/.test(newest)) await new Promise((res) => setTimeout(res, 2500));
  // "REPO-TEST" or "REPO-TEST=name": open the repo and change a file in it, as the real Claude would.
  const repoAsk = repoTools && /REPO-TEST(?:=([\w./-]+))?/.exec(newest);
  if (repoAsk) {
    onEvent?.({ type: 'tool', name: 'mcp__app__open_repo', summary: `Opened the repo ${repoAsk[1] || ''}`.trim() });
    try {
      const r = await repoTools.open(repoAsk[1]);
      fs.writeFileSync(path.join(r.dir, 'CHANGED-BY-CLAUDE.md'), `Changed in a turn at ${new Date().toISOString()}\n`);
      // "REPO-HOLD=name": stay in the repo for as long as the file hold-<name> is in the data
      // folder, so a test decides when the turn ends instead of racing a clock.
      const hold = /REPO-HOLD=([\w-]+)/.exec(newest);
      for (let i = 0; hold && i < 3000 && fs.existsSync(path.join(DATA_DIR, `hold-${hold[1]}`)); i += 1) await new Promise((res) => setTimeout(res, 100));
    } catch (err) { onEvent?.({ type: 'activity', text: err.message }); }
  }
  const renameAsk = repoTools && /RENAME-TEST ([\w./-]+) ([\w.-]+)/.exec(newest);
  if (renameAsk) await repoTools.rename({ repo: renameAsk[1], new_name: renameAsk[2] }).catch((err) => onEvent?.({ type: 'activity', text: err.message }));
  // "CREATE-TEST name": he agreed to a new repo; it is made, opened and worked in.
  const createAsk = repoTools && /CREATE-TEST ([\w.-]+)/.exec(newest);
  if (createAsk) {
    try {
      const full = await repoTools.create({ name: createAsk[1] });
      const r = await repoTools.open(full);
      fs.writeFileSync(path.join(r.dir, 'README.md'), `# ${createAsk[1]}\n`);
    } catch (err) { onEvent?.({ type: 'activity', text: err.message }); }
  }
  // "MOVE-TEST <title words> TO <iso>": he said an entry moved; the stand-in moves it, as the real Claude would.
  const moveAsk = moveEvent && /MOVE-TEST (.*?) TO (\S+)/.exec(newest);
  if (moveAsk) {
    onEvent?.({ type: 'tool', name: 'mcp__app__move_event', summary: `Moved the event "${moveAsk[1]}" in Events` });
    try { moveEvent({ event: moveAsk[1], start: moveAsk[2] }); } catch (err) { onEvent?.({ type: 'activity', text: err.message }); }
  }
  const wanted = spinOff && /spin off (?:a |another )?(?:new )?(?:task|thread)s? (?:only )?(?:about|for|on) ([^.\n]+)/i.exec(newest);
  if (wanted) {
    onEvent?.({ type: 'tool', name: 'mcp__app__spin_off', summary: `Spun off a thread: ${wanted[1].trim()}` });
    await spinOff({ title: `Only ${wanted[1].trim()}`, task: `Work only on ${wanted[1].trim()}.` });
  }
  text += await say('Let me look at what the vault has on this.\n\n');
  onEvent?.({ type: 'tool-input', name: 'Read', input: { file_path: path.join(cwd, 'Core', 'Next Actions.md'), offset: 1, limit: 40 } });
  onEvent?.({ type: 'tool', name: 'Read', summary: 'Read Core/Next Actions.md' });
  await sleep(400 * speed);
  onEvent?.({ type: 'tool-input', name: 'Grep', input: { pattern: 'deadline', path: path.join(cwd, 'Core') } });
  onEvent?.({ type: 'tool', name: 'Grep', summary: 'Searched the vault for "deadline"' });
  await sleep(400 * speed);
  onEvent?.({ type: 'tool', name: 'WebSearch', summary: 'Searched the web for "example query"' });
  await sleep(400 * speed);

  if (/SCRIPT-TEST/.test(prompt) && workDir && showFile) {
    // A careless install into the artifacts folder, a script on the workbench, its result.
    for (let i = 0; i < 40; i += 1) {
      const f = path.join(artifactsDir, 'pylib', 'yaml', '__pycache__', `m${i}.cpython-312.pyc`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `compiled ${i}`);
    }
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'fill.py'), 'print("filled")\n');
    fs.writeFileSync(path.join(workDir, 'Formular ausgefüllt.pdf'), '%PDF-1.4 stand-in\n');
    onEvent?.({ type: 'tool-result' });
    await showFile({ path: 'Formular ausgefüllt.pdf' });
    text += await say('The filled form is in **Formular ausgefüllt.pdf**.');
  }

  if (/draft|entwurf|mail/i.test(prompt)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    const file = path.join(artifactsDir, 'Mail an das Büro.md');
    const round = fs.existsSync(file) ? 2 : 1;
    const body = round === 1
      ? '---\ntype: mail\nto: office@example.org\nsubject: Konzept, nächste Schritte\n---\nHallo Frau Beispiel,\n\nvielen Dank für das Gespräch am Montag. Anbei der überarbeitete Entwurf des Konzepts.\n\nIch schlage vor, dass wir die offenen Punkte in der kommenden Woche besprechen.\n\nViele Grüße\nFlorian\n'
      : '---\ntype: mail\nto: office@example.org\nsubject: Konzept, nächste Schritte\n---\nHallo Frau Beispiel,\n\ndanke für das Gespräch am Montag. Anbei der überarbeitete Entwurf des Konzepts.\n\nPasst Ihnen Donnerstag, 14 Uhr, um die offenen Punkte durchzugehen?\n\nViele Grüße\nFlorian\n';
    onEvent?.({ type: 'tool-input', name: 'Write', input: { file_path: file, content: body } });
    fs.writeFileSync(file, body);
    onEvent?.({ type: 'tool', name: 'Write', summary: 'Wrote Mail an das Büro.md' });
    onEvent?.({ type: 'tool-result' });
    await sleep(200 * speed);
    text += await say(round === 1
      ? 'The draft is in **Mail an das Büro.md**. One thing to decide: do you want to propose a date yourself, or leave it open?'
      : 'Updated the draft: shorter opening, and it now proposes Thursday 14:00.');
  } else {
    text += await say([
      '## Where this stands',
      '',
      'The decision noted in [[Next Actions]] is the gate for everything else. Two things follow from the notes:',
      '',
      '1. **Announcement timing** depends on the board date.',
      '2. *Partners* should be on board before the press line goes out.',
      '',
      '> Your earlier position: lead with taste, not ethics.',
      '',
      '| Option | Effort | Risk |',
      '|---|---|---|',
      '| Quiet rollout | low | backlash arrives unprepared |',
      '| Announced with partners | medium | needs one more sign-off |',
      '',
      'If each site converts with probability $p$, the expected number converted is $n \\cdot p$:',
      '',
      '$$\\mathbb{E}[X] = \\sum_{k=0}^{n} k \\binom{n}{k} p^k (1-p)^{n-k} = np$$',
      '',
      '```js',
      'const ready = threads.filter((t) => t.state === "ready");',
      '```',
      '',
      'Which of the two options do you want me to work out?',
    ].join('\n'));
  }
  return { sessionId, text, finalText: text, error: '', aborted: false };
}
