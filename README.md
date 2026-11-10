# Inbox

A local app for working with Claude across many threads at once. It shows you one thing at a time: a thread where Claude needs you, a mail to send, an opportunity to accept or decline. You reply or decide, and it brings up the next one. Claude works in the background, and each thread comes back when it needs you.

It runs on your own computer as a small web server, signed in with your Claude plan. It reads your brain vault from its own clone of the GitHub repo and writes it only when you press "Update brain".

## First start (Windows)

You need [Node.js](https://nodejs.org) 20 or newer and Git.

```
git clone https://github.com/fburgerdev/app-ai
cd app-ai
npm install
npm run login
npm start
```

- `npm run login` signs this computer in with your Claude subscription. Once is enough. `npm run login -- status` shows whether you are signed in.
- `npm start` starts the app and opens it at http://localhost:4317. Afterwards, double-clicking `start.cmd` does the same.
- To get it as its own window with a taskbar icon: open the page in Chrome or Edge and use the browser menu's install entry (Edge: Apps → Install this site as an app; Chrome: Cast, save and share → Install page as app).

The first start clones the brain into the app's data folder and, if the data repo already holds a saved state, takes that over.

To look at the app without your account or your brain: `npm run demo`. It uses a throwaway vault and a stand-in for Claude that gives canned answers.

## The screen

- **The top bar** is always there: the inbox button with the number waiting, the mood line, Talk, Scratchpad and Settings.
- **The inbox** is out of the way until you want it: move the pointer to the left edge of the window and it slides in; move away and it leaves. Alt+L or the inbox button does the same, and "Keep open" at its top makes it a fixed column.
- **The outline** on the right shows where the open thread sits: its area, its project and the threads beside it, joined by lines like a file tree (see Folders below).
- **Settings** opens as a window: Connections, Queue (what the queue has learned), Keys.

## The queue

The inbox shows what is waiting under **Next up**. The order is not oldest-first: a small model ranks what is waiting, from three things.

- **The mood line** in the top bar (Alt+M). Type what you feel like ("maths", "research, no mails"). It saves as you type and nothing is sent; the queue reorders within a few seconds. Empty it to go back to normal.
- **What it has learned.** Every choice you make is recorded: what you reply to, requeue, close, drag, spin off, open by hand instead of what was offered, which cards you accept or decline, and the reasons you give. Every 30 choices a model rewrites a short profile from that record. You can read and correct it: Settings → Queue. Your own lines are kept.
- **Otherwise:** things with a date or that block others first, then what has waited longest, kinds mixed.

The order is worked out in the background, so moving on never waits for a model. Under the heading you see in a few words why the first one is first. You can always click any thread yourself.

**Drag a thread** (with a finger: press and hold, then move):

- to another place in **Next up**. It stays there until you have dealt with it, whatever the model thinks; the rest is ordered around it.
- onto **Done** to close it, and from Done back into Next up to reopen it.
- onto a **folder** in the outline to file it under that project. A closed folder opens when the thread rests on it.

**Requeue** (Alt+S) means "not now": the thread goes to the back for 20 minutes and you get the next one.

**Send and done** (Ctrl+Enter), next to Send: your message goes out and the thread closes by itself once Claude has answered, without stopping in the inbox. If the turn fails or you stop it, the thread comes back to the inbox instead.

**Attach files** with the paperclip, by dropping them on the thread, or by pasting. They upload at once and go out with your next message; Claude reads them (text, images, PDFs; up to 25 MB each). They live in the thread, not in the vault.

**Send into spin-off** (Alt+Enter), next to Send: your message starts a new thread that begins as a copy of this one, files included. Nothing is sent to the thread you are in; it goes to the back of the queue, since you have just dealt with it. The spin-off gets the conversation so far as text, not Claude's working memory of it. The brain update files the copied part from the original only.

You can also ask for a spin-off in the message itself: "…also spin off a new task only about the mail draft". Claude then starts that thread, which works in parallel, and carries on with the rest of your message where you are. It does this only when you ask.

**Delete**, in a thread's header, removes it for good after a second click: for chats that were a test, random, or nothing for the brain. What an update already filed from it stays in the brain.

| Key | What it does |
|---|---|
| Enter | Send, then open what the queue puts next |
| Ctrl+Enter | Send and done |
| Alt+Enter | Send into a spin-off |
| Shift+Enter | New line |
| Alt+N | New thread |
| Alt+S | Requeue |
| Alt+X | Done: close this thread |
| Y / N | On a card: accept / decline. While typing in the card: Ctrl+Enter accepts, Alt+N declines |
| Alt+J / Alt+K | Next / previous thread in the inbox |
| Alt+A | Show or hide the files Claude made in this thread |
| Alt+U | Update the brain |
| Alt+L | Show or hide the inbox |
| Alt+M | Jump to the mood line |
| Alt+P | Scratchpad, and back |
| Esc | Close the side panel or the settings window |

### Model and effort

Next to the reply box: Haiku, Sonnet, Opus or Fable (always the latest of each), and medium or high effort. The choice applies to the next turn in any thread, to brain updates and to the card run. It starts on Opus, high.

## Cards: opportunities and chases

A card is one finished message: a LinkedIn note, a first mail, a follow-up on something you are waiting for. It appears in the queue between your threads.

- Click into the text and change it right there. No editor opens.
- **Y** accepts: the text is copied and the person's page opens, if there is one. **N** declines. Either way the card is done and the next thing comes up.
- A mail card has **Put in Gmail** and **Send** instead; using either accepts the card.
- **A line for your reason**, under the text, for either verdict: why not, or what the card got wrong ("this is outdated, we already met"). It is optional. It is kept with the decision, the queue and the next card run read it, and the next brain update files it: a reason as a rule about that kind of card, a correction as a fact in the note it concerns.

A **proposal** is a third kind of card: a piece of work Claude offers to do in a thread for one of your projects or areas, such as research for a next step, a first draft, a timeline, or checking where something quiet stands. The text is the brief, editable like any card. **Accept and start** opens the thread in that project and Claude begins; decline, with a reason if you like, and it is not proposed again.

**What is coming up.** With the calendar connected, the same run looks at today and tomorrow every few hours. For an entry worth preparing (a meeting, a fair, a talk) it starts a thread by itself, marked "Coming up": Claude writes a briefing from the Brain and opens a preparation session with you. There is nothing to accept; delete the thread if you do not want it. Each entry is prepared once.

Cards are made in the background by a run that reads the vault and searches the web for the right person. It starts by itself when fewer than three unseen cards are left while you work the queue, at most every 45 minutes, or when you press "Look for opportunities". Chase cards come from rows in `Brain/Waiting For.md` whose chase date has passed.

Nothing is proposed twice, whether you accepted or declined it. What you edited before accepting is recorded too, and both the queue and the next card run learn from it.

## Mail

A mail Claude writes shows up in the thread as a mail card: To, Subject and the text, all editable in place.

- **Put in Gmail** saves it as a draft. After further changes the button updates that same draft.
- **Send…** asks once, showing recipient and subject, then sends.
- Your own edits are kept as versions marked as yours; "versions" shows what changed.
- When you send, the thread gets a note. The next brain update files the version Claude wrote and the version you sent side by side, which is what "improve on writing mails" learns from.

Claude itself cannot put anything into Gmail or send. Only these two buttons can, and only when you press them.

This needs Gmail connected, once: [docs/google.md](docs/google.md). Without it the card still works for editing and copying.

## Updating the brain: the water level

Every thread has a line: **In the brain up to here**. Everything above it has been filed.

"Update brain" (Alt+U, at the bottom of the inbox) raises that line, in every thread at once, to where each thread stood when you pressed. You can keep working while it runs; whatever you write after pressing stays below the line and waits for the next update.

The same press also takes in:

- **New mail**, as "Update Gmail" below does.
- **Cards you decided**, with your reasons, so sent messages and their Waiting For rows land in the vault.

For every thread in which Claude made something (a mail, a document, a deck, a script) the update also does the first two stages of the vault's `Claude/Learning From Feedback.md`:

- **Capture, every time.** Your feedback rounds in your words, the first and the latest version as outlines, your own edits, and what you praised go into the piece's capture file under `Artifacts/<Format>/`. A thinking session gets its session file in `Artifacts/Thinking/`.
- **Extract, once you closed the thread.** A thread marked Done means the piece is finished: its learnings go into that format's `Pool.md`.
- Turning a pool into rules ("improve on mails" and the like) stays your call and is not something the update does.

Then the app makes one `thinking:` commit and pushes. What the vault says needs your confirmation is not written; it comes back as a thread called "Brain update …: questions".

**Update Gmail**, next to it, is the mail part by itself, with its own water level: everything received and sent since mail was last taken in (the first time: the last day). What matters is filed in the brain, sent mail gets its Waiting For row, and a mail that needs your answer becomes a thread in the queue with Claude already drafting the reply. Under the buttons you see up to when mail has been taken in.

These two buttons are the only things in the app that write the vault, and they run only when you press them.

## Folders

The outline on the right shows where the open thread is, read from `Brain/Projects/Projects Index.md`: the area, under it the project, under that the threads in the same project, joined by lines. The thread's header shows the same path under its name. A thread without a project is shown under "No project" with the other loose threads.

- Click the project's name to read its note. "+ New thread" starts another thread there, with the project's note and its area's note already loaded.
- **All folders**, underneath, opens the whole tree of areas and projects: rest the pointer on it, or click to keep it open. A folder in it opens while the pointer rests on it; a number says how many threads in it wait for you.
- To file a thread somewhere else, drag it: the whole tree shows while a thread is being dragged. Or open the folder under All folders and use "Move this thread here".
- When the window is too narrow for the outline (and on the phone), the whole tree is the **Folders** tab in the inbox.

## Scratchpad

A page to write in, like the one in Obsidian, one click away in the top bar (Alt+P; again to go back). It saves as you type. Claude never reads it: it is not in the vault and is never handed to any run.

## Talk: the host

`/walk`, or **Talk** in the top bar. You speak or type to the **host**, a small model (Haiku) that sits between you and the threads. For everything you say it decides where it goes:

- **To the open thread.** After a thread has been read to you, what you say is your reply to it. It is sent, and the next thread is read out. No closing keyword is needed.
- **To a new thread**, when it is a new piece of work for Claude ("ask Claude to find out when the board meets").
- **To the app**, when it is a command: next, done, repeat, read all, new thread, cancel, goodbye. A thread by name works too ("open the grant one"), and so does "my mood is …".
- **Nowhere: it answers itself.** Ask what is waiting, what a thread said, or anything a chatbot can answer. Questions that need more (something current from the web, careful thought) go to a stronger model (Sonnet), which may search the web. The host keeps the conversation in mind, so you can ask follow-ups, and "make that a thread" turns the conversation into one.

The short commands and "…and send it" at the end of a sentence work without the model, at once. If the model fails, nothing is lost: say "send" to give what you said to the open thread as it is.

How it listens and speaks, with nothing but the phone's own speech recognition and voice:

- **Pauses.** The phone stops listening after every sentence. The page joins the pieces and hands them on only after a pause (2.5 seconds; settable), so a thought with a breath in it stays one message. A bar under the text shows the pause running. If you break off mid-thought, the host holds it and adds what comes next.
- **Mistakes.** The host gets the phone's other guesses along with its first one, and the names you use: your project names, plus any you list under "Names and words I use" in the settings. It repairs clear mishearings and leaves the rest as you said it. A reply sent by voice is marked as dictated.
- **Reading aloud** goes sentence by sentence in a voice you can choose, at a speed you can set. Tap the big button, or use a chip, to interrupt. With "I am wearing headphones" on, the page keeps listening while it speaks and you can talk over it.
- **Sounds.** A short tone tells you that something was taken, and another where it went, so you do not have to look.
- **The screen** shows the conversation, the open thread and, under everything you said, where it went.
- **A dropped connection** (a tunnel, a dead spot) is picked up again by itself. What you said meanwhile is delivered then, and what the host said meanwhile is read out then.
- **English and German.** Set what you speak in the settings; the host and the summaries of the threads follow.
- "What happened" in the settings lists the page's last steps, with a Copy button, for when something does not work.

Good to know:

- Speaking needs Chrome (Android or computer) and, on the phone, the app reachable over https: [docs/pi.md](docs/pi.md) (the Tailscale part works for a laptop too). Typing works everywhere.
- Chrome stops listening when the screen goes off. The page keeps the screen on; "Lock for the pocket" covers it with a dark shield that ignores touches.
- Cards are left out; they are for reading and editing.
- Every thing you say costs one small Haiku request. The conversation with the host itself is not kept and does not go into the brain; only what it passes to a thread or the mood line does.

A real phone number does the same through Twilio, for a per-minute price: [docs/calling.md](docs/calling.md).

## On the phone

The whole app works in the phone's browser under the same address as Talk. One column: the top bar, the thread, the reply box at the bottom. The inbox and the folders are behind the inbox button. On a card, swipe right to accept and left to decline, or use the buttons; the text is edited in place. "Add to Home screen" in the browser's menu makes it open like an app.

## How the brain is handled

- **One clone stays on disk** in the app's data folder. Before a turn starts, the app brings it up to GitHub's state. Claude never clones, pulls, commits or pushes.
- **Threads only read the vault.** That is enforced in code: a thread can write into its own files folder and nowhere else.
- **The vault's Scratchpad is never on this disk.** `Scratchpad.md`, `.obsidian/` and `For Claude/processed/` are left out of the clone.
- **The current rules ride along.** `Claude/Instructions.md` and `Claude/Thinking With Me.md` are put into every thread's instructions fresh each turn.
- **Only the brain update writes**, as described above. `For Claude/`, `For Florian/`, `Scratchpad.md` and `.obsidian/` are put back before the commit, whatever the run did.

The vault itself is untouched by installing the app: Obsidian, Brain Sync and the vault's own instructions keep working as they are.

The prompts are in `prompts/`. They point at the vault's rules rather than repeating them.

## Where things are, and how the state is saved

App data is in its own folder, outside the vault:

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\app-ai` |
| macOS | `~/Library/Application Support/app-ai` |
| Linux | `~/.local/share/app-ai` |

That folder is a git repository. Every five minutes, and after every brain update, the app commits what changed and pushes it to the data repo (`fburgerdev/app-ai-data`): threads and their files, water levels, the scratchpad, the mood line, model and effort, the queue's record and profile, the card log. Settings → Connections shows when it last saved.

Never committed: `config.json` and `google-token.json` (they hold secrets), the brain clone, logs.

A computer that starts with an empty data folder takes over the saved state. Run the app in one place at a time.

## Settings

`config.json` in the data folder, created on first start. Restart the app after changing it.

| Setting | Default | Meaning |
|---|---|---|
| `port` | `4317` | The local address. |
| `brainRepo`, `brainBranch` | the brain repo, `main` | What to clone. |
| `dataRepo`, `dataSyncMinutes` | the data repo, `5` | Where and how often the app's state is saved. Empty repo: not saved. |
| `preload` | Instructions, Thinking With Me | Vault files put into every thread's instructions. |
| `protectedPaths` | Scratchpad, .obsidian, For Claude, For Florian | Never written by the app. |
| `hiddenPaths` | Scratchpad, .obsidian, For Claude/processed | Never on the app's disk. |
| `queue` | Haiku ranks, Sonnet learns, every 30 choices, requeue 20 min | The queue's models and rhythm. |
| `cards` | automatic, keep 3 ready, 3 per run, 45 min pause, calendar every 3 h | The card run, which also looks at the calendar. `auto: false` makes cards and preparations only on request. |
| `threadShell` | `false` | Whether Claude may run shell commands in threads. |
| `maxParallel` | `4` | Threads worked on at once. |
| `allowedHosts` | empty | Other addresses the app answers under (Tailscale). |
| `google` | empty | Client id and secret of your Google Cloud project. |
| `voice` | off | Calling through Twilio. Also `hostModel` (`haiku`) and `thinkModel` (`sonnet`): the host you talk to and the model it hands harder questions to. |
| `readLog` | `false` | Recording what is read from the vault (`reads.jsonl`, `npm run reads`). Off for now. |

## Tests

```
npm test
```

Runs the whole app against throwaway repos with the stand-in Claude.

## Not built yet

Threads that wait for a mail reply and wake up when it arrives. Standing project threads with spin-offs. A desktop app of its own (it is a page in the browser). The host's conversations are not kept. Nothing acts on the read log.
