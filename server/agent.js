// Runs one turn of Claude through the Claude Agent SDK and reports what happens as
// simple events. The rest of the app never touches the SDK directly, so an SDK change
// lands in this one file.
//
// Permissions are decided here, in code, not by asking: nobody is sitting at a prompt.
//   thread   reads the vault, searches the web, writes only into its artifacts folder
//   extract  the brain update: reads and writes the vault, no web, no git history
//   plain    no tools at all (used to turn a reply into something to listen to)
//   lookup   like plain, but it may search and read the web (the voice host's harder questions)

import fs from 'node:fs';
import path from 'node:path';
import { log } from './config.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const FREE_TOOLS = new Set(['WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Task', 'Skill', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Monitor']);
const NEVER = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'CronDelete', 'CronList'];
const GIT_HISTORY = /\bgit\b[^|;&\n]*\b(commit|push|pull|fetch|reset|rebase|checkout|switch|restore|clean|stash|merge|branch|remote|config)\b/;

function isInside(file, root) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function allow(input) {
  return { behavior: 'allow', updatedInput: input };
}

function deny(message) {
  return { behavior: 'deny', message };
}

// Builds the function the SDK calls before every tool use that needs a decision.
export function buildPolicy({ mode, cwd, artifactsDir, readDirs = [], protectedPaths = [], shell = false, google = false }) {
  const readable = [cwd, artifactsDir, ...readDirs].filter(Boolean);
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
        return shell ? allow(input) : deny('Shell commands are turned off for threads in this app.');
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

    return deny(`${toolName} is not available in this app.`);
  };
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
    case 'mcp__google__gmail_search': return `Searched your mail for "${clip(input.query, 70)}"`;
    case 'mcp__google__gmail_read_thread': return 'Read a mail thread';
    case 'mcp__google__calendar_list': return 'Looked at your calendar';
    case 'mcp__google__calendar_create': return `Added to your calendar: ${clip(input.title, 60)}`;
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
 * @returns {Promise<{sessionId: string|null, text: string, error: string, durationMs: number, aborted: boolean}>}
 */
export async function runAgent(params) {
  const started = Date.now();
  const run = params.fake ? runFake : runReal;
  try {
    const out = await run(params);
    return { ...out, durationMs: Date.now() - started };
  } catch (err) {
    if (params.signal?.aborted) {
      return { sessionId: params.resume || null, text: '', error: '', aborted: true, durationMs: Date.now() - started };
    }
    log(`agent error: ${err.stack || err.message}`);
    return { sessionId: params.resume || null, text: '', error: friendlyError(err.message), aborted: false, durationMs: Date.now() - started };
  }
}

async function runReal({ prompt, cwd, resume, systemAppend, model, effort, mode, artifactsDir, readDirs, protectedPaths, shell, signal, title, onEvent, mcpServers }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const disallowedTools = [...NEVER];
  if (mode === 'extract') disallowedTools.push('WebSearch', 'WebFetch');
  if (mode === 'thread' && !shell) disallowedTools.push('Bash', 'PowerShell');

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
    canUseTool: buildPolicy({ mode, cwd, artifactsDir, readDirs, protectedPaths, shell, google }),
    additionalDirectories: [artifactsDir, ...(readDirs || [])].filter(Boolean),
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

  for await (const msg of query({ prompt: input(), options })) {
    if (msg.session_id && msg.session_id !== sessionId) {
      sessionId = msg.session_id;
      onEvent?.({ type: 'session', sessionId });
    }
    if (msg.type === 'stream_event') {
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
      if (msg.error) error = friendlyError(msg.error);
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
        error = friendlyError(msg.result || (msg.errors || []).join(' ') || msg.subtype);
      } else {
        error = '';
        if (!lastText && msg.result) lastText = msg.result;
      }
    }
  }
  return { sessionId, text, finalText: lastText, error, aborted: abortController.signal.aborted };
}

// ---------- a stand-in for Claude, for trying the app without an account ----------
//
// Started with APP_AI_FAKE=1. It streams canned text, pretends to use tools, writes an
// artifact when the message mentions a draft, and in a brain update edits one file.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runFake({ prompt: userPrompt, systemAppend, cwd, resume, mode: givenMode, artifactsDir, readDirs, signal, onEvent }) {
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
    else if (/^note for claude (.*)$/.test(low)) decision = { do: 'note', text: /^note for claude (.*)$/i.exec(said)[1] };
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
    const dir = path.join(cwd, 'Brain');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'App Test.md');
    const stamp = new Date().toISOString();
    fs.appendFileSync(file, `- stand-in brain update at ${stamp}\n`);
    onEvent?.({ type: 'tool', name: 'Edit', summary: 'Edited Brain/App Test.md' });
    const transcripts = (readDirs || []).flatMap((dir) => fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8')));
    const wantsQuestions = transcripts.some((t) => /QUESTION-TEST/.test(t.split('## New')[1] || ''));
    const wantsReply = transcripts.some((t) => /MAIL-TEST/.test(t));
    const report = [
      wantsQuestions ? 'STATUS: questions' : 'STATUS: updated',
      'COMMIT: thinking: stand-in brain update from the app',
      '',
      '## Written',
      '- Brain/App Test.md — one test line',
      ...(wantsQuestions ? ['', '## Questions', '**App test**', '1. Add "Call the office" to Next Actions?'] : []),
      ...(wantsReply ? ['', '## Mail to answer', '- T-EXAMPLE | Terminvorschlag | asks for a date'] : []),
    ].join('\n');
    await say(report);
    return { sessionId, text: report, finalText: report, error: '', aborted: false };
  }

  if (/CARDS-RUN/.test(prompt)) {
    // A stand-in card run: one opportunity and one chase card.
    fs.mkdirSync(artifactsDir, { recursive: true });
    const stamp = Date.now().toString(36);
    fs.writeFileSync(path.join(artifactsDir, 'one.json'), JSON.stringify({
      type: 'opportunity', channel: 'linkedin', key: `opp:example-person:${stamp}`,
      title: 'Connect with an example person', why: 'Runs catering at an example Studierendenwerk; no contact yet.',
      project: '', to: 'Example Person', link: 'https://www.linkedin.com/in/example',
      text: 'Hallo Frau Beispiel,\n\nich arbeite mit einem Studierendenwerk an pflanzlicher Hochschulgastronomie und würde mich gern mit Ihnen vernetzen.\n\nDieser zweite Absatz ist vielleicht zu viel.\n\nViele Grüße\nFlorian',
    }));
    fs.writeFileSync(path.join(artifactsDir, 'two.json'), JSON.stringify({
      type: 'chase', channel: 'mail', key: `chase:example-office:${stamp}`,
      title: 'Chase the example office', why: 'Waiting since 02-11 for their answer; chase date reached.',
      project: '', to: 'office@example.org', subject: 'Kurze Nachfrage',
      text: 'Hallo Frau Beispiel,\n\nich wollte kurz nachfragen, ob es schon Neuigkeiten gibt.\n\nViele Grüße\nFlorian',
    }));
    return { sessionId, text: 'Made 2 cards.', finalText: 'Made 2 cards.', error: '', aborted: false };
  }

  if (/FAIL-TEST/.test(prompt)) {
    return { sessionId, text: '', finalText: '', error: friendlyError('Invalid API key · Please run /login'), aborted: false };
  }

  let text = '';
  text += await say('Let me look at what the vault has on this.\n\n');
  onEvent?.({ type: 'tool-input', name: 'Read', input: { file_path: path.join(cwd, 'Brain', 'Next Actions.md'), offset: 1, limit: 40 } });
  onEvent?.({ type: 'tool', name: 'Read', summary: 'Read Brain/Next Actions.md' });
  await sleep(400 * speed);
  onEvent?.({ type: 'tool-input', name: 'Grep', input: { pattern: 'deadline', path: path.join(cwd, 'Brain') } });
  onEvent?.({ type: 'tool', name: 'Grep', summary: 'Searched the vault for "deadline"' });
  await sleep(400 * speed);
  onEvent?.({ type: 'tool', name: 'WebSearch', summary: 'Searched the web for "example query"' });
  await sleep(400 * speed);

  if (/draft|entwurf|mail/i.test(prompt)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    const file = path.join(artifactsDir, 'Mail an das Büro.md');
    const round = fs.existsSync(file) ? 2 : 1;
    const body = round === 1
      ? '---\ntype: mail\nto: office@example.org\nsubject: Konzept, nächste Schritte\n---\nHallo Frau Beispiel,\n\nvielen Dank für das Gespräch am Montag. Anbei der überarbeitete Entwurf des Konzepts.\n\nIch schlage vor, dass wir die offenen Punkte in der kommenden Woche besprechen.\n\nViele Grüße\nFlorian\n'
      : '---\ntype: mail\nto: office@example.org\nsubject: Konzept, nächste Schritte\n---\nHallo Frau Beispiel,\n\ndanke für das Gespräch am Montag. Anbei der überarbeitete Entwurf des Konzepts.\n\nPasst Ihnen Donnerstag, 14 Uhr, um die offenen Punkte durchzugehen?\n\nViele Grüße\nFlorian\n';
    fs.writeFileSync(file, body);
    onEvent?.({ type: 'tool', name: 'Write', summary: 'Wrote Mail an das Büro.md' });
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
