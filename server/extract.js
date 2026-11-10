// The brain update: files what Florian said in his threads into the brain vault.
//
// It runs only when he asks for it (the "Update brain" button). One run covers every
// thread that changed since the last one. It is the only thing in the app that writes
// the vault, and only one can run at a time:
//
//   1. bring the clone up to GitHub's state
//   2. write each changed thread out as a transcript, old part and new part marked
//   3. let Claude file the new parts under the vault's own rules
//   4. commit once, push
//   5. if Claude has questions, put them into the inbox as a thread

import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';
import * as brain from './brain.js';
import * as store from './store.js';
import { EXTRACTIONS_DIR, log } from './config.js';
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

// Threads with something Florian said that no brain update has seen yet.
function changedThreads() {
  const out = [];
  for (const thread of store.listThreads()) {
    if (thread.state === 'working') continue;
    if (!store.isUnfiled(thread)) continue;
    out.push({ thread, messages: store.readMessages(thread.id) });
  }
  return out;
}

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
  return {
    running: Boolean(current),
    step: current?.step || '',
    startedAt: current?.startedAt || 0,
    waiting: store.listThreads().filter((t) => t.state !== 'working' && store.isUnfiled(t)).length, // threads not yet in the brain
    last: lastRuns(1)[0] || null,
    brain: brain.brainStatus(),
  };
}

function writeTranscripts(runDir, changed) {
  const dir = path.join(runDir, 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  changed.forEach(({ thread, messages }, i) => {
    const n = String(i + 1).padStart(2, '0');
    const artifacts = store.listArtifacts(thread.id);
    const filesDir = path.join(dir, `${n} files`);
    const artifactLines = [];
    for (const artifact of artifacts) {
      for (const version of artifact.versions) {
        const src = store.artifactPath(thread.id, artifact.name, version.v);
        if (!src) continue;
        fs.mkdirSync(filesDir, { recursive: true });
        const ext = path.extname(artifact.name);
        const base = safeFileName(artifact.name.slice(0, artifact.name.length - ext.length).replace(/\//g, ' - '));
        const dest = path.join(filesDir, `${base} (v${version.v})${ext}`);
        fs.copyFileSync(src, dest);
        artifactLines.push(`- "${artifact.name}" version ${version.v}, saved ${dateTimeDMY(version.ts)}: \`${dest}\``);
      }
    }

    const render = (m) => `### ${m.role === 'user' ? 'Florian' : 'Claude'}, ${dateTimeDMY(m.ts)}\n\n${messageText(m) || '(no text)'}`;
    let earlier = messages.slice(0, thread.extractedCount).map(render).join('\n\n');
    if (earlier.length > 40_000) earlier = `(the beginning is cut)\n\n${earlier.slice(-40_000)}`;
    const fresh = messages.slice(thread.extractedCount).map(render).join('\n\n');

    const text = [
      `# Thread: ${thread.title}`,
      '',
      `Started: ${dateTimeDMY(thread.createdAt)}`,
      `Closed by Florian: ${thread.state === 'done' ? 'yes' : 'no, still open'}`,
      '',
      '## Files Claude made in this thread',
      '',
      artifactLines.length ? artifactLines.join('\n') : 'None.',
      '',
      '## Earlier (seen by a previous brain update; context only, do not file again)',
      '',
      earlier || 'Nothing.',
      '',
      '## New (file from this part)',
      '',
      fresh,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `${n} ${safeFileName(thread.title, 60)}.md`), text);
  });
  return dir;
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
  const qIndex = body.search(/^## Questions\s*$/m);
  const questions = qIndex >= 0 ? body.slice(qIndex).replace(/^## Questions\s*$/m, '').trim() : '';
  const written = (qIndex >= 0 ? body.slice(0, qIndex) : body).trim();
  return { status, subject, written, questions };
}

// What changed in the vault, for display. Session files in Artifacts/Thinking hold what
// Claude read into a session; the vault says those are never shown to Florian.
function visibleChanges(changes) {
  return changes.filter((c) => !c.path.startsWith('Artifacts/Thinking/'));
}

export function startExtraction() {
  if (current) return { started: false, reason: 'A brain update is already running.' };
  if (!brain.brainStatus().ready) return { started: false, reason: brain.brainStatus().error || 'The brain is not cloned yet.' };
  const changed = changedThreads();
  if (!changed.length) return { started: false, reason: 'Nothing new to file: every thread is already in the brain.' };

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  current = { id, startedAt: Date.now(), step: 'Starting', threads: changed.map((c) => c.thread.title) };
  runExtraction(id, changed)
    .catch((err) => {
      log(`brain update failed: ${err.stack || err.message}`);
      return { id, startedAt: current.startedAt, finishedAt: Date.now(), status: 'failed', error: err.message, threads: current.threads };
    })
    .then(async (record) => {
      if (record.status === 'failed') await brain.discardChanges();
      const runDir = path.join(EXTRACTIONS_DIR, id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2));
      current = null;
      store.events.emit('brain', extractionStatus());
    });
  store.events.emit('brain', extractionStatus());
  return { started: true, threads: current.threads };
}

async function runExtraction(id, changed) {
  const startedAt = current.startedAt;
  const runDir = path.join(EXTRACTIONS_DIR, id);
  fs.mkdirSync(runDir, { recursive: true });
  // How far each thread had got when the run started: later messages wait for the next run.
  const seen = changed.map(({ thread, messages }) => ({ id: thread.id, title: thread.title, count: messages.length }));

  return brain.withWriter('brain update', async () => {
    setStep('Getting the vault up to date');
    await brain.pullForWriting();

    setStep(`Reading ${changed.length} ${changed.length === 1 ? 'thread' : 'threads'}`);
    const transcriptsDir = writeTranscripts(runDir, changed);

    const result = await runAgent({
      prompt: readPrompt('extract.md', { today: todayLine(), transcriptsDir }),
      cwd: brain.brainDir(),
      systemAppend: 'You are running inside Florian\'s inbox app as its brain update. The run\'s instructions are in the user message.',
      model: config.extractModel || config.model,
      mode: 'extract',
      artifactsDir: null,
      readDirs: [transcriptsDir],
      protectedPaths: config.protectedPaths,
      title: `Brain update ${dateDMY()}`,
      fake: config.fake,
      onEvent: (ev) => {
        if (ev.type === 'tool') setStep(ev.summary);
        else if (ev.type === 'text-start') setStep('Writing the report');
      },
    });
    if (result.error) throw new Error(result.error);

    const report = parseReport(result.finalText || result.text);
    setStep('Committing and pushing');
    const committed = await brain.commitAndPush({
      subject: report.subject || `thinking: threads from the app, ${dateDMY()}`,
      body: `Co-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: app-ai brain update ${id}`,
    });

    for (const s of seen) {
      const thread = store.getThread(s.id);
      if (!thread) continue;
      const patch = { extractedCount: s.count };
      if (thread.state === 'done' && thread.messageCount <= s.count) patch.archived = true;
      store.updateThread(s.id, patch);
    }

    let questionsThread = null;
    if (report.questions) {
      const thread = store.createThread({
        title: `Brain update ${dateDMY()}: questions`,
        kind: 'brain-update',
        sessionId: config.fake ? null : result.sessionId,
      });
      store.appendMessage(thread.id, {
        role: 'assistant',
        parts: [{
          type: 'text',
          text: `These came up while filing your threads into the brain. Nothing below has been written yet. Answer here, then update the brain again.\n\n${report.questions}`,
        }],
      });
      store.updateThread(thread.id, { extractedCount: 1, queuedAt: Date.now() });
      questionsThread = thread.id;
    }

    return {
      id,
      startedAt,
      finishedAt: Date.now(),
      status: committed ? 'updated' : 'nothing',
      threads: seen.map((s) => s.title),
      written: report.written,
      hasQuestions: Boolean(report.questions),
      questionsThread,
      commit: committed?.commit || '',
      subject: committed ? report.subject || `thinking: threads from the app, ${dateDMY()}` : '',
      pushed: committed ? committed.pushed : true,
      pushError: committed?.pushError || '',
      changes: committed ? visibleChanges(committed.changes) : [],
      restored: committed?.restored || [],
    };
  });
}
