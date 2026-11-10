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

## The queue

The thread list is out of the way until you want it: move the pointer to the right edge of the window and it slides in; move away and it leaves. The small tab on that edge shows how many threads wait. Alt+L shows it from the keyboard, and "Keep open" at its top makes it a fixed column again. On a phone it is behind the **Threads** button.

It shows what is waiting under **Next up**. The order is not oldest-first: a small model ranks what is waiting, from three things.

- **The mood line** at the top of the list (Alt+M). Type what you feel like ("maths", "research, no mails"). It saves as you type and nothing is sent; the queue reorders within a few seconds. Empty it to go back to normal.
- **What it has learned.** Every choice you make is recorded: what you reply to, requeue, close, open by hand instead of what was offered, and which cards you accept or decline. Every 30 choices a model rewrites a short profile from that record. You can read and correct it: Notes for Claude → "What the queue has learned". Your own lines are kept.
- **Otherwise:** things with a date or that block others first, then what has waited longest, kinds mixed.

The order is worked out in the background, so moving on never waits for a model. Under the heading you see in a few words why the first one is first. You can always click any thread yourself.

**Drag a thread** to where you want it (with a finger: press and hold, then move). It stays at that place until you have dealt with it, whatever the model thinks; the rest is ordered around it. The drag is recorded as a choice the queue learns from.

**Requeue** (Alt+S) means "not now": the thread goes to the back for 20 minutes and you get the next one.

| Key | What it does |
|---|---|
| Enter | Send, then open what the queue puts next |
| Shift+Enter | New line |
| Alt+N | New thread |
| Alt+S | Requeue |
| Alt+X | Done: close this thread |
| Y / N | On a card: accept / decline. While typing in the card: Ctrl+Enter accepts, Alt+N declines |
| Alt+J / Alt+K | Next / previous thread in the list |
| Alt+A | Show or hide the files Claude made in this thread |
| Alt+U | Update the brain |
| Alt+L | Show or hide the thread list |
| Alt+M | Jump to the mood line |
| Alt+P | Scratchpad |
| Esc | Close the side panel |

### Model and effort

Next to the reply box: Haiku, Sonnet, Opus or Fable (always the latest of each), and medium or high effort. The choice applies to the next turn in any thread, to brain updates and to the card run. It starts on Opus, high.

## Cards: opportunities and chases

A card is one finished message: a LinkedIn note, a first mail, a follow-up on something you are waiting for. It appears in the queue between your threads.

- Click into the text and change it right there. No editor opens.
- **Y** accepts: the text is copied and the person's page opens, if there is one. **N** declines. Either way the card is done and the next thing comes up.
- A mail card has **Put in Gmail** and **Send** instead; using either accepts the card.

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

"Update brain" (Alt+U) raises that line, in every thread at once, to where each thread stood when you pressed. You can keep working while it runs; whatever you write after pressing stays below the line and waits for the next update.

The same press also takes in:

- **New mail.** With Gmail connected, everything received and sent since the last update. What matters is filed. A mail that needs your answer becomes a thread in the queue, with Claude already drafting the reply.
- **Notes for Claude.** A page (at the bottom of the thread list) for half-sentences, updated facts and nudges about how Claude works. The update files them and empties the page, so an empty page means they went in.
- **Cards you decided**, so sent messages and their Waiting For rows land in the vault.

Then the app makes one `thinking:` commit and pushes. What the vault says needs your confirmation is not written; it comes back as a thread called "Brain update …: questions".

The update is the only thing in the app that writes the vault, and it runs only when you press the button.

## Projects

The **Projects** tab shows the vault's areas and projects, read from `Brain/Projects/Projects Index.md`. The app keeps no list of its own: a project is here exactly when it is in the vault.

- Each line shows how many open threads it has and when it was last touched, so you see what has gone quiet.
- "New thread here" starts a thread on that project. Claude begins with the project's note and its area's note already loaded.
- Any thread can be moved to a project with the picker in its header.

## Scratchpad

A page to write in, like the one in Obsidian (Alt+P). It saves as you type. Claude never reads it: it is not in the vault and is never handed to any run.

## Talk: the host

`/walk`, "Talk" at the bottom of the thread list, or the **Talk** button on the phone. You speak or type to the **host**, a small model (Haiku) that sits between you and the threads. For everything you say it decides where it goes:

- **To the open thread.** After a thread has been read to you, what you say is your reply to it. It is sent, and the next thread is read out. No closing keyword is needed.
- **To a new thread**, when it is a new piece of work for Claude ("ask Claude to find out when the board meets").
- **To the app**, when it is a command: next, done, repeat, read all, new thread, cancel, goodbye. A thread by name works too ("open the grant one"), and so do "my mood is …" and "note for Claude: …".
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
- Every thing you say costs one small Haiku request. The conversation with the host itself is not kept and does not go into the brain; only what it passes to a thread, the mood line or the notes does.

A real phone number does the same through Twilio, for a per-minute price: [docs/calling.md](docs/calling.md).

## On the phone

The whole app works in the phone's browser under the same address as Talk. One column: the thread on top, the reply box at the bottom, the thread list behind **Threads**. On a card, swipe right to accept and left to decline, or use the buttons; the text is edited in place. "Add to Home screen" in the browser's menu makes it open like an app.

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

That folder is a git repository. Every five minutes, and after every brain update, the app commits what changed and pushes it to the data repo (`fburgerdev/app-ai-data`): threads and their files, water levels, the scratchpad and notes, the mood line, model and effort, the queue's record and profile, the card log. Connections shows when it last saved.

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
| `cards` | automatic, keep 3 ready, 3 per run, 45 min pause | The card run. `auto: false` makes cards only on request. |
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
