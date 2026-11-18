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

- **The top bar** is always there: the inbox button with the number waiting, this computer's status, the cost of today, Talk and Settings.
- **The inbox** is out of the way until you want it: move the pointer to the left edge of the window and it slides in; move away and it leaves. Alt+L or the inbox button does the same, and "Keep open" at its top makes it a fixed column.
- **Projects and areas** on the right, most recently dealt with first (see below).
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
- onto a **project or area** on the right to file it there.

**Requeue** (Alt+S) means "not now": the thread goes to the back for 20 minutes and you get the next one.

**Send and done** (Ctrl+Enter), next to Send: your message is kept in the thread and the thread closes, and Claude does not answer it, so it costs no usage. It is for things you only want on record: the next brain update reads them like any other message. If you reopen the thread later, Claude gets those messages together with your next one. Sent while Claude is still working, the thread closes when that turn ends.

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

Cards are made in the background by a run that reads the vault and searches the web for the right person. It starts by itself when fewer than three unseen cards are left while you work the queue, at most every 45 minutes, or when you press "Look for opportunities". Chase cards come from rows in `Core/Waiting For.md` whose chase date has passed.

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

**The threads themselves go into the vault too.** Before the commit, the app writes every thread you said or did something in as a Markdown file into `Threads/` (`YYYY-MM-DD Title.md`): the conversation, each turn labelled with who said it, and the final text of the files Claude made. No tool output, and no model is involved: `server/threadexport.js` makes the files from the app's data, which stays the original, and writes each one again on every update, so the two cannot drift. A thread the app has deleted since keeps its file. The vault then has two layers: `Core/` (the notes: dense, current, read by default) and `Threads/` with `Archive/` (finished projects' notes, frozen), which a thread only searches. One exception: a thread on a project is told which thread on that project came last, and reads it in full once.

Then the app makes one `thinking:` commit and pushes. What the vault says needs your confirmation is not written; it comes back as a thread called "Brain update …: questions".

**Update Gmail**, next to it, is the mail part by itself, with its own water level: everything received and sent since mail was last taken in (the first time: the last day). What matters is filed in the brain, sent mail gets its Waiting For row, and a mail that needs your answer becomes a thread in the queue with Claude already drafting the reply. Under the buttons you see up to when mail has been taken in.

**Done stays short.** A closed thread whose content is entirely in the brain is archived by the next "Update brain" and leaves the Done list. A thread closed with nothing of yours left to file is archived by the press alone, even when there is nothing else to file. Archived threads are kept in the app's data, not deleted; reopening one brings it back.

These two buttons are the only things in the app that write the vault, and they run only when you press them.

## Projects and areas

The outline on the right is an overview of projects and areas, read from the vault. It shows no threads; those are in the inbox.

- **Projects**, most recently dealt with first (your latest message in one of its threads, or the last change to its note). Paused and blocked projects (`Status:` in the project's note) are grey and at the bottom, in the same order.
- **Areas** the same way; an area with no project right now is grey.
- A dot after a name means it has open threads. The project of the open thread is highlighted. A long name runs onto a second line; the full name is in the tooltip.
- Hover a row for **+**: a new thread on that project or area, with its notes loaded. Click a row to read its note. Drag a thread from the inbox onto a row to file it there.
- Next to the headings: **+ active** and **+ paused** start one thread on every active or paused project. **+ project ideas** starts one per area about which project to start there. Each asks once more, and skips what already has an open thread.
- When the window is too narrow for the outline (and on the phone), it is the **Folders** tab in the inbox.

## Repos

Any thread can work in any of your GitHub repos: from the project's `repo:` line, by naming it
in the thread, or by picking it in the repo panel (the repo button in the thread header). The
repo is cloned the moment Claude opens it; one thread works in a repo at a time, the others
wait; every thread gets a branch of its own. Claude commits; when its turn ends the app pushes
the branch, runs the repo's tests (`npm test`, if it has any) and, if they pass, merges it
into main by itself, with a note in the thread. Failing tests or a clash with main leave the
branch on GitHub, and the note says why. The panel's buttons are still there for doing it by
hand. Claude can rename and create repos when you ask. Detail, and the token for renaming, in
[docs/repos.md](docs/repos.md).

## Video Kit

Video Kit, the player for your videos' scripts, versions and comments (repo `app-ytvideo-kit`),
starts with the app on http://localhost:4400 and starts again if it stops; **Video Kit** in the
top bar opens it. It shows every `ytvideo-*` repo of yours: the app clones the ones not here
yet, and keeps the copies no thread is working in on main and up to date (every ten minutes,
and when Video Kit opens a video). What you type there (scripts, comments) is saved through the
app: committed onto main and pushed, after the thread working in that repo, if any, is done.
Renders and recordings are not in git; they stay in the copy on this computer. Turned off with
`"videoKit": { "enabled": false }` in config.json; another port with `"port"`.

## Sleep time

From 00:00 to 08:00 the app shows a go-to-sleep screen instead of the queue. **Let me in anyway**
gets you past it, but only for as long as the window stays open: opening the app again, or
coming back after more than ten minutes away, shows it again. Change the hours or turn it off in
Settings → Queue.

## Scratchpad

Switched off since 15-11-2026: a thread closed with Done does the same job and sorts better. The code and `scratchpad.md` in the data folder are still there; the button in `public/index.html` and the Alt+P key in `public/app.js` would turn it on again.

## Talk: the host

`/walk`, or **Talk** in the top bar. You speak or type to the **host**, a small model (Haiku) that sits between you and the threads. For everything you say it decides where it goes:

- **To the open thread.** After a thread has been read to you, what you say is your reply to it. It is sent, and the next thread is read out. No closing keyword is needed.
- **To a new thread**, when it is a new piece of work for Claude ("ask Claude to find out when the board meets").
- **To the app**, when it is a command: next, done, repeat, read all, new thread, cancel, goodbye. A thread by name works too ("open the grant one"), and so does "my mood is …".
- **Nowhere: it answers itself.** Ask what is waiting, what a thread said, or anything a chatbot can answer. Questions that need more (something current from the web, careful thought) go to a stronger model (Sonnet), which may search the web. The host keeps the conversation in mind, so you can ask follow-ups, and "make that a thread" turns the conversation into one.

The short commands and "…and send it" at the end of a sentence work without the model, at once. If the model fails, nothing is lost: say "send" to give what you said to the open thread as it is.

**A better ear and voice.** By default the page uses the phone's own speech recognition and voice. With a Groq key the page records you itself and Groq's Whisper transcribes, which is far more accurate; with Piper installed the app speaks in its own voice, made on the machine it runs on. Both work from the Pi with the laptop off: [docs/voice.md](docs/voice.md).

How it listens and speaks with the phone's own engines:

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

## The laptop and the Pi

The laptop does the work and is where the app is installed from (`http://localhost:4317`), so
it opens whether or not the Pi is on. A status line under the top bar says which side does the
work and when it is safe to suspend the laptop (nothing running, everything on GitHub). With
the Pi's address as `remote` in the laptop's `config.json`, it also says whether the Pi could
take over, and has **Hand over to the Pi** (for when the laptop sleeps; it waits for Claude to
finish and then says when it is safe to suspend) and **Take back**, which also happens by
itself when the laptop wakes. In between, both sides sync through the data repo every two
minutes. Setup and the odd cases: [docs/laptop.md](docs/laptop.md).

## Events

What is coming up in your calendar is not in the inbox. Each entry worth preparing gets a
thread of its own under **Events** in the top bar: important ones (a fair, a talk, a first
meeting) open a day before, smaller ones on the morning of the day, each with a briefing and
the first question of a preparation session. The thread stays until you mark it done, so after
the entry it is the place to debrief ("How did it go?"); the brain update files what came out
of it. Sending in an event thread keeps you there instead of moving on to the next thread.
Events only come while the calendar is connected (Settings → Connections → Google).

## The outline's slides

The outline on the right has two slides; scroll sideways (it snaps) or click the words on top.

- **Projects**: the active projects, the paused ones folded away (they unfold on hover: paused
  means you are waiting on something), then the **areas** in the order of
  `Core/Horizons/30,000 ft Goals.md` (a numbered list, `1. [[Area]] — where it should stand`;
  areas not in it follow by recency, and the line above them opens that file), then **Someday**
  (each item newest first, the parked old actions grey; **+** starts a thread on the item: do
  it now, keep it, or fold it).
- **People**: everyone in `Core/People/`, in four groups from the `Status:` line in each
  person's file: **Your move**, **Keep warm**, **Waiting** (hover for what), **Nothing open**.
  Inside a group, longest since you dealt with them first. **+** starts a thread on the person.

The order is the vault's, not the app's: change a `Status:` line or the 30,000 ft list (ask
Claude in a thread) and the outline follows.

## What a message is worth

Five tiers, cheapest first: **Cheap** (Opus, low effort), **Low** (Opus, medium), **Default**
(Opus, high), **High** (Fable, medium), **Extra** (Fable, high). The picker in the composer
is one switch, the same in every thread. **Auto**: before each turn a cheap model reads the
message and picks a tier, so there is nothing to choose. **Quick select** instead asks on
sending: five buttons over the box, 1 to 5 or a click, Enter for Default (3), which is always marked, Escape
back to writing. It asks where a message starts new work (Send, Start, a spin-off). It does
not ask for Done, which Claude does not answer, nor for a message added while Claude is
working, which runs on the tier of the work it belongs to. The tier a turn used is shown in the thread
header; clicking it runs the same message again one tier up and keeps that tier for the
thread, until you pick Auto or Quick select there again.

## Focus

The switch in the top bar ("Everything" / "Focus") is for working through your own threads
only. In Focus, what the app started by itself and you have not answered yet waits under one
folded line in the inbox ("3 waiting for later"): opportunity and chase cards, proposals, the
brain update's questions, mail to answer, check-ins, repairs. The card run makes no new cards;
"Look for opportunities" still works when you click it. Events stay pinned, and your own
threads, next actions you woke and spin-offs stay in the queue. Focus ends by itself at your
sleep time (midnight if the sleep screen is off), so a day never starts in it by accident.

## Pinned threads

The top of the inbox is **Pinned**. Events from the calendar are there from the start; any
other thread gets there with **Pin** in its header or by dragging it onto the section. Pinned
threads are not part of the queue: the app never jumps to one by itself, and each shows
"Claude…" or "yours". Events always come first, by date, and cannot be reordered; below a thin
line are the threads you pinned, which you drag into your own order. That order is kept with
the thread, so every device shows the same. Unpin (the button, or drag it into Next up) puts a thread back
among the others. Done or Defer takes the pin off.

## A thread's name, project and type

A new thread is named by the first line of what you wrote. After Claude's first answer, and
once more when you press Done or Defer, a small model reads the conversation and gives it a
name by its topic, the project or area it belongs to, and a type (Thinking, Mail, Build,
Document, Question; threads the app started keep theirs, such as Event or Mail to answer).
A name you typed and a project you chose are never changed. Threads from before this get
theirs in the background after the app starts.

## Cards, for looking at later

Every card you decide on is one line in `cards/log.jsonl` in the data folder (and so in the
data repo): what was proposed and why, to whom, on which channel, what you did with it and
how, your reason, whether and how you edited it, the text as proposed and as accepted, the
mood line, when it was made and how long it waited.

## Next actions, Done and Defer

A line in `Core/Next Actions.md` and a thread in the inbox are two states of the same to-do.

- The lines show in the inbox drawer under **Next actions**, below Done, asleep. Click one and
  click again to confirm, and it **wakes**: it becomes a thread in the inbox that opens with a
  brief, and the next brain update takes the line out of the file. Below them is **Events**.
- **Defer**, next to Send, puts any thread to sleep: it moves under Next actions, and the next
  brain update writes its to-do into `Next Actions.md` (with where you left off; text in the
  box is kept for that) and deletes the thread. Replying in a deferred thread wakes it again.
- **Done** is the same button as "Send and done": with an empty box it closes the thread
  (also Alt+X), with text it keeps the message and closes without an answer.

## What the colours mean

In the inbox a thread carries a bar in its own colour: **green** waiting for you, **yellow**
Claude is working, **blue** done, **purple** an event from the calendar, **grey** a next action
asleep. The same colours carry the thread's state wherever it is shown.

## The status line: four stages

The dot on the left says where the computer stands. **Locked** means the app starts nothing by
itself; anything you send unlocks it again.

| Dot | What it means |
|---|---|
| Green | Locked and nothing running: safe to suspend |
| Blue | Locked, still finishing what was running |
| Yellow | Something running, not locked |
| Grey | Nothing running, but not locked: the app may start something by itself |

**Get ready to suspend** locks it: what is running finishes, nothing new starts (no cards, no
events, no sorting), everything is saved to GitHub, and the line turns green. It works whether
or not the server is reachable. **Handover** gives everything to the server (see above).

## Updating now

The app updates itself every ten minutes. For something urgent, **Settings → Connections →
Check for updates** looks right away and restarts into the new version; the page reloads by
itself. If Claude is working, it says so and offers **Update now anyway**, which cuts that
turn off.

## The app looks after itself

- **The network is away** (the laptop just woke, GitHub cannot be reached): the app tries again
  by itself with growing pauses and says nothing, unless it lasts more than ten minutes.
- **Anything else fails** (a brain update, the card run, saving, updating, a crash): the app
  opens a **Repair** thread by itself. Claude gets the error and the end of the log, finds the
  cause, and if it is a bug fixes it in the app's own repo. Its fix is tested and merged like
  any thread's work, the thread closes, and the self-update takes it (and goes back if the new
  version does not start). If the tests fail, the thread waits in the inbox. One repair thread
  per kind of error per day. Turn it off with `"repair": { "auto": false }`, or only its
  merging with `"repair": { "autoMerge": false }`.

## Usage

The amount in the top bar is what Claude used through this app today, counted at API prices
as the Agent SDK reports it per run; click it for the last five hours, seven days, and today
by kind. It covers both computers. It is not your plan's limit: the app cannot read how much
of that is left.

## Usage limits: held, then carried on

When Claude's five-hour or weekly limit cuts a turn off, the thread does not come back with an error. It stays out of the inbox and says "Held by the five-hour limit: carries on by itself at 02:43". Three minutes after the limit lifts, the app starts the turn again and tells Claude to carry on where it stopped. So you can send something late, go to sleep, and find it done.

- The time comes from Claude's own report (an exact time, and which limit), so a weekly limit is held until its day, not until the same clock time tonight. With no time given, the app tries again after 15 minutes.
- What you send into a held thread waits in the same hold and goes in with the next try. "Cancel the hold" gives the thread back to you as it is.
- The hold is saved with the thread, not kept as a timer. It survives a restart and an update of the app, and it travels to the Pi when you hand over: whichever computer does the work when the limit lifts carries on. A held thread does not keep the laptop from handing over or going to sleep.
- A turn cut off while working in a repo leaves its work on the thread's branch on GitHub but is not merged into main. That happens when the turn has finished.
- A brain update cut off by the limit files nothing and runs again by itself when the limit lifts. Cards skip their round while a limit is on.
- The times are in `config.json` under `limits` (`marginMs`, `fallbackMs`, `checkMs`).

## Threads find their project

A thread you start without a project gets one by itself after its first answer: a small
model reads the start of the conversation against the Projects Index and files it under the
project or area it is about (or none). The outline then counts it like any other. What you
set yourself always stands.

## On the phone

The whole app works in the phone's browser under the same address as Talk. One column: the top bar, the thread, the reply box at the bottom. The inbox and the folders are behind the inbox button. On a card, swipe right to accept and left to decline, or use the buttons; the text is edited in place. "Add to Home screen" in the browser's menu makes it open like an app.

## How the brain is handled

- **One clone stays on disk** in the app's data folder. Before a turn starts, the app brings it up to GitHub's state. Claude never clones, pulls, commits or pushes.
- **Threads only read the vault.** That is enforced in code: a thread can write into its own files folder and nowhere else.
- **The vault's Scratchpad is never on this disk.** `Scratchpad.md`, `.obsidian/` and `For Claude/processed/` are left out of the clone.
- **The current rules ride along.** `Claude/Instructions.md` and `Claude/Thinking With Me.md` are put into every thread's instructions fresh each turn.
- **Only the brain update writes**, as described above. `For Claude/`, `For Florian/`, `Scratchpad.md` and `.obsidian/` are put back before the commit, whatever the run did.

Since 13-11-2026 the app is the only way into the vault: there is no Obsidian copy and no laptop sync any more, and the vault's `CLAUDE.md` describes the app's brain update as the way it changes.

The prompts are in `prompts/`. They point at the vault's rules rather than repeating them.

## Where things are, and how the state is saved

App data is in its own folder, outside the vault:

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\app-ai` |
| macOS | `~/Library/Application Support/app-ai` |
| Linux | `~/.local/share/app-ai` |

That folder is a git repository. Every two minutes, and after every brain update, the app commits what changed and pushes it to the data repo (`fburgerdev/app-ai-data`): threads and their files, water levels, the scratchpad, the mood line, model and effort, the queue's record and profile, the card log. Settings → Connections shows when it last saved.

Never committed: `config.json` and `google-token.json` (they hold secrets), the brain clone, logs, and each thread's workbench (`threads/<id>/work/`: scripts, installed libraries, files made on the way).

Files that got into a thread's shown files by mistake (a script's library, before the workbench existed) are taken out once, by themselves: off the list when the app starts, and then out of the data repo's whole history, at a quiet moment, so the repo does not keep downloading them. The computer doing the work rewrites the history and pushes it over GitHub's, but only if GitHub has not changed since it checked; the other computer saves first, and on its next fetch takes the cleaned history and keeps whatever only it had changed. The log says `app data: the saved history was rewritten`. GitHub itself frees the space some time later.

A computer that starts with an empty data folder takes over the saved state. Run the app in one place at a time.

## Settings

`config.json` in the data folder, created on first start. Restart the app after changing it.

| Setting | Default | Meaning |
|---|---|---|
| `port` | `4317` | The local address. |
| `brainRepo`, `brainBranch` | the brain repo, `main` | What to clone. |
| `dataRepo`, `dataSyncMinutes` | the data repo, `5` | Where and how often the app's state is saved. Empty repo: not saved. |
| `preload` | Instructions, Thinking With Me | Vault files put into every thread's instructions. |
| `protectedPaths` | Scratchpad, .obsidian, For Claude, For Florian (all gone from the vault since 13-11-2026; harmless) | Never written by the app. |
| `hiddenPaths` | Scratchpad, .obsidian, For Claude/processed | Never on the app's disk. |
| `queue` | Haiku ranks, Sonnet learns, every 30 choices, requeue 20 min | The queue's models and rhythm. |
| `cards` | automatic, keep 3 ready, 3 per run, 45 min pause, calendar every 3 h | The card run, which also looks at the calendar. `auto: false` makes cards and preparations only on request. |
| `artifactsShell` | `true` | Whether a thread without a repo may run scripts in its own artifacts folder: filling a PDF form, reading or editing a Word or Excel file, converting a file. Every command has to start with `cd` into that folder, and git is refused. It is a rule the app checks, not a sandbox: a script can still reach other folders on the computer. |
| `autoPush` | `true` | Whether a thread's branch in a repo is pushed to GitHub by itself when its turn ends. |
| `autoMerge` | `true` | Whether that branch is then merged into main by itself: once the repo's tests pass (`npm test`), or at once if it has none. For the app's own repo, the change reaches the running app with its next self-update. |
| `threadShell` | `false` | Whether Claude may run shell commands in threads outside a repo. Once a thread has opened a repo, it can always run them (tests, builds); it is told to work only in that repo's folder, and push, branch switching and destructive git commands are refused. |
| `maxParallel` | `6` | Turns that run at once. Your own messages go first; work the app started by itself leaves one slot free for you. Use 3 on a Pi with 2 GB. |
| `allowedHosts` | empty | Other addresses the app answers under (Tailscale). |
| `google` | empty | Client id and secret of your Google Cloud project. |
| `voice` | off | `groqKey`, `speak`, `piper`, `openaiKey`: the Talk page's ear and voice (docs/voice.md). Calling through Twilio. Also `hostModel` (`haiku`) and `thinkModel` (`sonnet`): the host you talk to and the model it hands harder questions to. |
| `readLog` | `false` | Recording what is read from the vault (`reads.jsonl`, `npm run reads`). Off for now. |

## Tests

```
npm test
```

Runs the whole app against throwaway repos with the stand-in Claude.

## Not built yet

Threads that wait for a mail reply and wake up when it arrives. Standing project threads with spin-offs. A desktop app of its own (it is a page in the browser). The host's conversations are not kept. Nothing acts on the read log.
