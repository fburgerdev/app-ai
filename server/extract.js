// The brain update: files what happened in the app into the brain vault.
//
// Think of every thread as having a water level: everything above it is in the brain.
// "Update brain" raises the level, in every thread at once, to where the thread stood at
// the moment of the press. Florian can keep working while the update runs; what he
// writes after pressing waits for the next update.
//
// The same press also covers, each with its own level:
//   - the mailbox: mail received and sent since the last update (when Gmail is connected)
//   - the "Notes for Claude" pad, which is emptied once filed
//   - the cards he accepted or declined
//
// "Update Gmail" is the mail part by itself: it takes in the mail since the mail level
// and raises only that level.
//
// It runs only when he asks, it is the only thing in the app that writes the vault, and
// only one can run at a time. It ends in one commit and a push.

import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';
import * as brain from './brain.js';
import * as google from './google.js';
import * as runner from './runner.js';
import * as store from './store.js';
import { EXTRACTIONS_DIR, log } from './config.js';
import { logToolRead } from './reads.js';
import { readCardLog } from './cards.js';
import { saveNow } from './datasync.js';
import { getState, readPad, setState, writePad } from './state.js';
import { dateDMY, dateTimeDMY, messageText, readPrompt, safeFileName, todayLine } from './util.js';

let config;
let current = null; // { id, startedAt, step, threads }

export function initExtraction(cfg) {
  config = cfg;
}

function setStep(step) {
  if (current) current.step = step;
  store.events.emit('brain', extractionStatus());
}

// Threads with something Florian said or did that no brain update has seen yet.
// Cards are not conversations; their outcomes are filed from the card log.
const unfiledThreads = () => store.listThreads().filter((t) => t.kind !== 'card' && store.isUnfiled(t));

export function lastRuns(limit = 15) {
  if (!fs.existsSync(EXTRACTIONS_DIR)) return [];
  return fs
    .readdirSync(EXTRACTIONS_DIR)
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(EXTRACTIONS_DIR, id, 'run.json'), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function extractionStatus() {
  const state = getState();
  return {
    running: Boolean(current),
    mailOnly: Boolean(current?.mailOnly),
    step: current?.step || '',
    startedAt: current?.startedAt || 0,
    waiting: unfiledThreads().length, // threads not yet in the brain
    notes: Boolean((readPad('notes') || '').trim()),
    cards: readCardLog().filter((e) => e.ts > state.cardsLevel && e.type !== 'prep').length,
    mail: google.googleConnected(),
    mailLevel: state.mailLevel,
    last: lastRuns(1)[0] || null,
    brain: brain.brainStatus(),
  };
}

function speaker(m) {
  if (m.role !== 'user') return 'Claude';
  if (m.auto) return 'The app (automatic, not Florian)';
  return 'Florian';
}

function writeThreads(dir, changed) {
  changed.forEach(({ thread, messages, count }, i) => {
    const n = String(i + 1).padStart(2, '0');
    const filesDir = path.join(dir, `${n} files`);
    const artifactLines = [];
    for (const artifact of store.listArtifacts(thread.id)) {
      for (const version of artifact.versions) {
        const src = store.artifactPath(thread.id, artifact.name, version.v);
        if (!src) continue;
        fs.mkdirSync(filesDir, { recursive: true });
        const ext = path.extname(artifact.name);
        const base = safeFileName(artifact.name.slice(0, artifact.name.length - ext.length).replace(/\//g, ' - '));
        const dest = path.join(filesDir, `${base} (v${version.v})${ext}`);
        fs.copyFileSync(src, dest);
        const who = version.by === 'you' ? 'edited by Florian' : 'written by Claude';
        const sent = artifact.mail?.sentVersion === version.v ? `, SENT by Florian ${dateTimeDMY(artifact.mail.sentAt)}` : '';
        artifactLines.push(`- "${artifact.name}" version ${version.v}, ${who}, ${dateTimeDMY(version.ts)}${sent}: \`${dest}\``);
      }
    }
    // What Florian attached is copied next to the thread file, so the update can read it.
    const attached = new Map();
    for (const m of messages.slice(0, count)) {
      for (const f of m.files || []) {
        const src = store.uploadPath(thread.id, f.name);
        if (!src) continue;
        fs.mkdirSync(filesDir, { recursive: true });
        const dest = path.join(filesDir, `attached - ${safeFileName(f.name, 120)}`);
        fs.copyFileSync(src, dest);
        attached.set(f.name, dest);
      }
    }
    const render = (m) => `### ${speaker(m)}, ${dateTimeDMY(m.ts)}\n\n${messageText(m) || '(no text)'}${m.files?.length ? `\n\n[He attached: ${m.files.map((f) => `"${f.name}"${attached.has(f.name) ? ` at \`${attached.get(f.name)}\`` : ''}`).join(', ')}]` : ''}`;
    const upTo = messages.slice(0, count);
    let earlier = upTo.slice(0, thread.extractedCount).map(render).join('\n\n');
    if (earlier.length > 40_000) earlier = `(the beginning is cut)\n\n${earlier.slice(-40_000)}`;
    const fresh = upTo.slice(thread.extractedCount).map(render).join('\n\n');
    const text = [
      `# Thread: ${thread.title}`,
      '',
      `Started: ${dateTimeDMY(thread.createdAt)}`,
      `Project or area: ${thread.project || 'none named'}`,
      `Closed by Florian: ${thread.state === 'done' ? 'yes' : 'no, still open'}`,
      ...(thread.spunFrom ? [`Spin-off: Florian spun this thread off from the thread "${thread.spunTitle}". Its first ${thread.spunAt} messages are a copy of that thread and are filed from there.`] : []),
      '',
      '## Files Claude made in this thread',
      '',
      artifactLines.length ? artifactLines.join('\n') : 'None.',
      '',
      '## Earlier (filed by a previous brain update; context only, do not file again)',
      '',
      earlier || 'Nothing.',
      '',
      '## New (file from this part)',
      '',
      fresh,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `Thread ${n} ${safeFileName(thread.title, 60)}.md`), text);
  });
}

function writeCards(dir, cards) {
  const blocks = cards.map((c) => [
    `## ${c.outcome === 'accepted' ? 'Accepted' : 'Declined'}: ${c.title}`,
    '',
    `- Kind: ${c.type}${c.type === 'proposal' ? ' (work Claude offered to do in a thread)' : `, by ${c.channel}`}`,
    `- To: ${c.to || 'not named'}`,
    `- Project or area: ${c.project || 'none named'}`,
    `- Decided: ${dateTimeDMY(c.ts)}${c.how ? ` (${c.how})` : ''}`,
    ...(c.reason ? [`- Florian wrote about it: ${c.reason}`] : []),
    `- Id: ${c.key}`,
    '',
    '### As proposed',
    '',
    c.proposed,
    ...(c.outcome === 'accepted' ? ['', `### As Florian took it${c.edited ? ' (he edited it)' : ' (unchanged)'}`, '', c.final] : []),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Cards.md'), `# Cards Florian decided since the last brain update\n\n${blocks.join('\n\n')}\n`);
}

function writeMail(dir, threads, since) {
  const blocks = threads.map((t) => [
    `## ${t.subject || '(no subject)'}`,
    '',
    `Gmail thread id: ${t.threadId}`,
    '',
    ...t.messages.map((m) => [
      `### ${m.sent ? 'SENT by Florian' : 'RECEIVED'}, ${m.date}`,
      '',
      `From: ${m.from}`,
      `To: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ''}`,
      '',
      m.text || '(no text)',
    ].join('\n')),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Mail.md'), `# Mail since ${dateTimeDMY(since)}\n\nOnly the messages that are new since then; earlier messages of a conversation are in Gmail.\n\n${blocks.join('\n\n')}\n`);
}

// Splits Claude's final message into the parts the app needs.
export function parseReport(text) {
  const raw = String(text || '').trim();
  const status = (raw.match(/^STATUS:\s*(\w+)/m)?.[1] || '').toLowerCase();
  let subject = (raw.match(/^COMMIT:\s*(.+)$/m)?.[1] || '').trim();
  if (!/^thinking: \S/.test(subject) || subject.length > 140) subject = '';
  const body = raw
    .replace(/^```[a-z]*\s*$/gm, '')
    .replace(/^STATUS:.*$/m, '')
    .replace(/^COMMIT:.*$/m, '')
    .trim();
  const sections = {};
  let name = 'written';
  for (const line of body.split('\n')) {
    const head = /^## (Written|Questions|Mail to answer)\s*$/i.exec(line);
    if (head) { name = head[1].toLowerCase(); continue; }
    sections[name] = `${sections[name] || ''}${line}\n`;
  }
  const mail = (sections['mail to answer'] || '')
    .split('\n')
    .map((l) => /^[-*]\s*([^|]+)\|([^|]*)\|?(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ threadId: m[1].trim(), subject: m[2].trim(), why: m[3].trim() }))
    .filter((m) => m.threadId);
  return { status, subject, written: (sections.written || '').trim(), questions: (sections.questions || '').trim(), mail };
}

// What changed in the vault, for display. Session files in Artifacts/Thinking hold what
// Claude read into a session; the vault says those are never shown to Florian.
const visibleChanges = (changes) => changes.filter((c) => !c.path.startsWith('Artifacts/Thinking/'));

export function startExtraction({ only = '' } = {}) {
  if (current) return { started: false, reason: 'A brain update is already running.' };
  if (!brain.brainStatus().ready) return { started: false, reason: brain.brainStatus().error || 'The brain is not cloned yet.' };
  const status = extractionStatus();
  const mailOnly = only === 'mail';
  if (mailOnly && !status.mail) return { started: false, reason: 'Gmail is not connected. Connect it in the settings.' };
  if (!mailOnly && !status.waiting && !status.notes && !status.cards && !status.mail) {
    return { started: false, reason: 'Nothing new to file: everything is already in the brain.' };
  }

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  // The press fixes the level: each thread as it stands right now, and this moment for
  // mail and cards. Whatever comes after waits for the next update.
  const pressedAt = Date.now();
  const changed = mailOnly ? [] : unfiledThreads().map((thread) => {
    const messages = store.readMessages(thread.id);
    return { thread: { ...thread }, messages, count: messages.length };
  });
  current = { id, startedAt: pressedAt, step: 'Starting', threads: changed.map((c) => c.thread.title), mailOnly };
  runExtraction(id, changed, pressedAt, mailOnly)
    .catch((err) => {
      log(`brain update failed: ${err.stack || err.message}`);
      return { id, startedAt: pressedAt, finishedAt: Date.now(), status: 'failed', error: err.message, threads: current.threads, mailOnly };
    })
    .then(async (record) => {
      if (record.status === 'failed') await brain.discardChanges();
      const runDir = path.join(EXTRACTIONS_DIR, id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2));
      current = null;
      store.events.emit('brain', extractionStatus());
      saveNow('brain update').catch(() => {});
    });
  store.events.emit('brain', extractionStatus());
  return { started: true, threads: current.threads };
}

async function runExtraction(id, changed, pressedAt, mailOnly = false) {
  const runDir = path.join(EXTRACTIONS_DIR, id);
  const dir = path.join(runDir, 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const state = getState();

  return brain.withWriter('brain update', async () => {
    setStep('Getting the vault up to date');
    await brain.pullForWriting();

    const material = [];
    if (changed.length) {
      writeThreads(dir, changed);
      material.push(`- ${changed.length} thread file${changed.length === 1 ? '' : 's'} ("Thread NN ….md"), each with its files in a folder next to it`);
    }

    const notes = mailOnly ? '' : (readPad('notes') || '');
    if (notes.trim()) {
      fs.writeFileSync(path.join(dir, 'Notes for Claude.md'), `# Notes for Claude\n\nWritten by Florian in the app, up to ${dateTimeDMY(pressedAt)}.\n\n${notes.trim()}\n`);
      material.push('- `Notes for Claude.md`');
    }

    // A preparation the app started from the calendar is a thread, and is filed as one.
    const cards = mailOnly ? [] : readCardLog().filter((e) => e.ts > state.cardsLevel && e.ts <= pressedAt && e.type !== 'prep');
    if (cards.length) {
      writeCards(dir, cards);
      material.push('- `Cards.md`');
    }

    let mailThreads = [];
    let mailError = '';
    let mailRead = false;
    if (google.googleConnected()) {
      setStep('Reading new mail');
      // The first time, look back one day.
      const since = state.mailLevel || pressedAt - 24 * 3600_000;
      try {
        mailThreads = await google.gmailSince(since);
        mailRead = true;
        if (mailThreads.length) {
          writeMail(dir, mailThreads, since);
          material.push('- `Mail.md`');
        }
      } catch (err) {
        mailError = err.message;
        log(`brain update: mail could not be read: ${err.message}`);
      }
    }

    const finishLevels = () => {
      for (const c of changed) {
        const thread = store.getThread(c.thread.id);
        if (!thread) continue;
        const patch = { extractedCount: c.count, extractedAt: pressedAt };
        if (thread.state === 'done' && thread.messageCount <= c.count) patch.archived = true;
        store.updateThread(c.thread.id, patch);
      }
      const levels = mailOnly ? {} : { cardsLevel: pressedAt };
      if (mailRead) levels.mailLevel = pressedAt;
      setState(levels);
      // The notes pad is emptied of what was filed; anything typed since stays.
      if (notes.trim()) {
        const now = readPad('notes') || '';
        writePad('notes', now.startsWith(notes) ? now.slice(notes.length).replace(/^\s+/, '') : now);
      }
    };

    if (mailOnly && mailError) throw new Error(`Gmail could not be read: ${mailError}`);

    const base = { id, mailOnly, startedAt: pressedAt, threads: changed.map((c) => c.thread.title), mailCount: mailThreads.length, mailError, notes: Boolean(notes.trim()), cardCount: cards.length };

    if (!material.length) {
      finishLevels();
      return { ...base, finishedAt: Date.now(), status: 'nothing', written: '', changes: [], pushed: true, replyThreads: [] };
    }

    setStep('Reading what is new');
    const result = await runAgent({
      prompt: readPrompt('extract.md', { today: todayLine(), transcriptsDir: dir, material: material.join('\n') }),
      cwd: brain.brainDir(),
      systemAppend: 'You are running inside Florian\'s inbox app as its brain update. The run\'s instructions are in the user message.',
      model: state.model,
      effort: state.effort,
      mode: 'extract',
      artifactsDir: null,
      readDirs: [dir],
      protectedPaths: config.protectedPaths,
      title: `${mailOnly ? 'Gmail update' : 'Brain update'} ${dateDMY()}`,
      fake: config.fake,
      onEvent: (ev) => {
        if (ev.type === 'tool-input') logToolRead({ vaultDir: brain.brainDir(), by: 'brain-update', tool: ev.name, input: ev.input });
        else if (ev.type === 'tool') setStep(ev.summary);
        else if (ev.type === 'text-start') setStep('Writing the report');
      },
    });
    if (result.error) throw new Error(result.error);

    const report = parseReport(result.finalText || result.text);
    setStep('Committing and pushing');
    const subject = report.subject || `thinking: the app, ${dateDMY()}`;
    const committed = await brain.commitAndPush({
      subject,
      body: `Co-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: app-ai brain update ${id}`,
    });
    finishLevels();

    let questionsThread = null;
    if (report.questions) {
      const thread = store.createThread({
        title: `${mailOnly ? 'Gmail update' : 'Brain update'} ${dateDMY()}: questions`,
        kind: 'brain-update',
        sessionId: config.fake ? null : result.sessionId,
      });
      store.appendMessage(thread.id, {
        role: 'assistant',
        parts: [{
          type: 'text',
          text: `These came up while filing into the brain. Nothing below has been written yet. Answer here, then update the brain again.\n\n${report.questions}`,
        }],
      });
      store.updateThread(thread.id, { extractedCount: 1, queuedAt: Date.now(), gist: 'Questions from the brain update' });
      questionsThread = thread.id;
    }

    // Mail that needs an answer: one thread each, with Claude already drafting the reply.
    const replyThreads = [];
    for (const m of report.mail.slice(0, 8)) {
      const thread = store.createThread({ title: `Reply: ${m.subject || 'a mail'}`.slice(0, 100), kind: 'mail-reply' });
      runner.sendMessage(thread.id, [
        'A mail arrived that needs an answer from Florian. The brain update noticed it; he has not seen it yet.',
        '',
        `Gmail thread id: ${m.threadId}`,
        `Subject: ${m.subject}`,
        `What it is about: ${m.why}`,
        '',
        'Read the conversation with the mail tools and the notes in the vault that it concerns. Then draft the reply as a mail file, with this thread id in `reply-to-thread:`. In your message, tell Florian in two or three sentences who wrote and what they want, say that a draft is ready, and ask the one thing you need from him, if any.',
      ].join('\n'), { auto: true });
      replyThreads.push(thread.id);
    }

    return {
      ...base,
      finishedAt: Date.now(),
      status: committed ? 'updated' : 'nothing',
      written: report.written,
      hasQuestions: Boolean(report.questions),
      questionsThread,
      replyThreads,
      commit: committed?.commit || '',
      subject: committed ? subject : '',
      pushed: committed ? committed.pushed : true,
      pushError: committed?.pushError || '',
      changes: committed ? visibleChanges(committed.changes) : [],
      restored: committed?.restored || [],
    };
  });
}
