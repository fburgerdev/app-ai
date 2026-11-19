# The manual

Everything the app does, feature by feature. What it is, how to install it and which setup step is needed for what: the [README](../README.md).

## The screen

- **The top bar** is always there: the inbox button with the number waiting, Focus, which computer does the work, what Claude used today, Video Kit, Talk and Settings.
- **The inbox** is out of the way until you want it: move the pointer to the left edge of the window and it slides in; move away and it leaves. Alt+L or the inbox button does the same, and "Keep open" at its top makes it a fixed column.
- **The outline** on the right: projects and areas, People and Someday (see "The outline" below).
- **Settings** opens as a window: Connections, General (look, sleep time, what the queue has learned), Layout, Keys, Stats.
- **Layout** (in Settings) switches off what you do not use: buttons of the top bar, the reply box and the thread's header, parts of the inbox drawer, the right bar or its parts, the key hints. **Pick on the page** outlines everything that can go; click a part to hide it, a faded one to bring it back. Saved with the app's state, so laptop, Pi and phone look the same; keys keep working.

## The queue

The inbox shows what is waiting under **Next up**. The order is not oldest-first: a small model ranks what is waiting, from two things.

- **What it has learned.** Every choice you make is recorded: what you reply to, requeue, close, drag, spin off, open by hand instead of what was offered, which cards you accept or decline, and the reasons you give. Every 30 choices a model rewrites a short profile from that record. You can read and correct it: Settings → General. Your own lines are kept.
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
| Esc | Close the side panel or the settings window |

## What a message is worth

Five tiers, cheapest first: **Cheap** (Opus, low effort), **Low** (Opus, medium), **Default** (Opus, high), **High** (Fable, medium), **Extra** (Fable, high). The picker in the composer is one switch, the same in every thread.

- **Auto**: before each turn a cheap model reads the message and picks a tier, so there is nothing to choose.
- **Quick select** instead asks on sending: five buttons over the box, 1 to 5 or a click, Enter for Default (3), which is always marked, Escape back to writing. It asks where a message starts new work (Send, Start, a spin-off). It does not ask for Done, which Claude does not answer, nor for a message added while Claude is working, which runs on the tier of the work it belongs to.
- The tier a turn used is shown in the thread header; clicking it runs the same message again one tier up and keeps that tier for the thread, until you pick Auto or Quick select there again.

Auto does not step down from Fable to Opus in a conversation that is still fresh (its last turn less than an hour ago, and more than a few pages long): Claude keeps what it has read ready per model, so a turn on the other model reads the whole conversation again at full price, which costs more than the easier message saves. It takes Fable's lower tier (High) instead. Stepping up, the effort, and your own choice are not touched.

## A thread's name, project and type

A new thread is named by the first line of what you wrote. After Claude's first answer, and once more when you press Done or Defer, a small model reads the conversation and gives it a name by its topic, the project or area it belongs to (read against the vault's Projects Index, or none), and a type (Thinking, Mail, Build, Document, Question; threads the app started keep theirs, such as Event or Mail to answer). A name you typed and a project you chose are never changed.

## Pinned threads

The top of the inbox is **Pinned**. Events from the calendar are there from the start; any other thread gets there with **Pin** in its header or by dragging it onto the section. Pinned threads are not part of the queue: the app never jumps to one by itself, and each shows "Claude…" or "yours". Events always come first, by date, and cannot be reordered; below a thin line are the threads you pinned, which you drag into your own order. That order is kept with the thread, so every device shows the same. Unpin (the button, or drag it into Next up) puts a thread back among the others. Done or Defer takes the pin off.

## Focus

The switch in the top bar ("Everything" / "Focus") is for working through your own threads only. In Focus, what the app started by itself and you have not answered yet waits under one folded line in the inbox ("3 waiting for later"): opportunity and chase cards, proposals, the brain update's questions, mail to answer, check-ins, repairs. The card run makes no new cards; "Look for opportunities" still works when you click it. Events stay pinned, and your own threads, next actions you woke and spin-offs stay in the queue. Focus ends by itself at your sleep time (midnight if the sleep screen is off), so a day never starts in it by accident.

When the app sorts a thread wrongly, correct it with **Later** in the thread's header: in Focus the thread then waits under "waiting for later", even if it is your own and you keep writing in it. On a thread that waits there, the same button says **Back to focus** and keeps it in your queue, even a card. Dragging a thread onto the "waiting for later" line marks it Later, and dragging one out of it into the queue brings it back to focus. Your mark stays until you flip it. In "Everything" it changes nothing; threads you marked Later are only shown dimmed.

## Next actions, Done and Defer

A line in `Core/Next Actions.md` and a thread in the inbox are two states of the same to-do.

- The lines show in the inbox drawer under **Next actions**, below Done, asleep. Click one and click again to confirm, and it **wakes**: it becomes a thread in the inbox that opens with a brief, and the next brain update takes the line out of the file.
- **Defer**, next to Send, puts any thread to sleep: it moves under Next actions, and the next brain update writes its to-do into `Next Actions.md` (with where you left off; text in the box is kept for that) and deletes the thread. Replying in a deferred thread wakes it again.
- **Done** is the same button as "Send and done": with an empty box it closes the thread (also Alt+X), with text it keeps the message and closes without an answer.

## What the colours mean

In the inbox a thread carries a bar in its own colour: **green** waiting for you, **yellow** Claude is working, **blue** done, **purple** an event from the calendar, **grey** a next action asleep. The same colours carry the thread's state wherever it is shown.

## Cards: opportunities, chases and proposals

A card is one finished message: a LinkedIn note, a first mail, a follow-up on something you are waiting for. It appears in the queue between your threads.

- Click into the text and change it right there. No editor opens.
- **Y** accepts: the text is copied and the person's page opens, if there is one. **N** declines. Either way the card is done and the next thing comes up.
- A mail card has **Put in Gmail** and **Send** instead; using either accepts the card.
- **A line for your reason**, under the text, for either verdict: why not, or what the card got wrong ("this is outdated, we already met"). It is optional. It is kept with the decision, the queue and the next card run read it, and the next brain update files it: a reason as a rule about that kind of card, a correction as a fact in the note it concerns.

A **proposal** is a third kind of card: a piece of work Claude offers to do in a thread for one of your projects or areas, such as research for a next step, a first draft, a timeline, or checking where something quiet stands. The text is the brief, editable like any card. **Accept and start** opens the thread in that project and Claude begins; decline, with a reason if you like, and it is not proposed again.

Cards are made in the background by a run that reads the vault and searches the web for the right person. It starts by itself when fewer than three unseen cards are left while you work the queue, at most every 45 minutes, or when you press "Look for opportunities". Chase cards come from rows in `Core/Waiting For.md` whose chase date has passed.

Nothing is proposed twice, whether you accepted or declined it. What you edited before accepting is recorded too, and both the queue and the next card run learn from it. Every card you decide on is one line in `cards/log.jsonl` in the data folder: what was proposed and why, to whom, on which channel, what you did with it and how, your reason, whether and how you edited it, the text as proposed and as accepted, when it was made and how long it waited.

## Events

What is coming up in your calendar is not in the inbox. With the calendar connected, the card run looks at it every three hours, and each entry worth preparing (a meeting, a fair, a talk) gets a thread of its own under **Events** in the top bar: important ones (a fair, a talk, a first meeting) open a day before, smaller ones at 07:00 on the day, each with a briefing from the vault and the first question of a preparation session. Click one waiting in "Coming" twice to prepare it now. The thread stays until you mark it done, so after the entry it is the place to debrief ("How did it go?"); the brain update files what came out of it. Sending in an event thread keeps you there instead of moving on to the next thread. When you tell Claude in any thread that an entry moved, it moves the event in the app (the Google entry you move yourself).

## Mail and calendar

A mail Claude writes shows up in the thread as a mail card: To, Subject and the text, all editable in place.

- **Files go along** when the mail file names them, one `attach:` line each: a file Claude made in the thread, a file you attached to a message, or a document from the vault's `Files/` folder. Ask Claude ("send me the sketch as a PDF by mail", "attach the concept"). The card lists them under **Attached**; × takes one off. A name that leads to no file stops the mail, so nothing goes out missing what it promises. 15 MB together at most.
- **Put in Gmail** saves it as a draft. After further changes the button updates that same draft.
- **Send…** asks once, showing recipient and subject, then sends. Sending a reply archives its conversation in Gmail and closes the thread.
- Your own edits are kept as versions marked as yours; "versions" shows what changed.
- When you send, the thread gets a note. The next brain update files the version Claude wrote and the version you sent side by side, which is what "improve on writing mails" learns from.

Claude itself cannot put anything into Gmail or send. Only these two buttons can, and only when you press them.

**Calendar.** Claude can read your calendar and add entries: orange (Pumpkin), with a Meet link when it is a call. When you ask for people to be invited, it passes them as guests and Google mails them the invitation; the thread then carries a note saying who was invited. Without your asking, an entry has no guests.

This needs Google connected, once: [google.md](google.md). Without it the mail card still works for editing and copying.

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

These two buttons are the only things in the app that file facts into the vault, and they run only when you press them. Changes to the vault itself (renaming a folder, a rule in `Claude/`, a change that goes with a change to the app) are made by the thread doing that work, in the vault's repo like in any other: on its own branch, merged into main by the app when the turn ends. The two never write at the same time: an update waits for a thread that is working in the vault ("Waiting for … which is changing the vault"), and a thread that opens the vault during an update waits for the update.

## The night prune

"Prune brain" without you there: a pass through `Core/` that runs at night, started once by a timer on the Pi (`POST /api/prune/start`; there is no button). Before it touches anything it checks that Claude answers, that a push to GitHub works and that the vault can be written. Then it goes part by part (People in groups, Organizations, Projects and Areas, Learnings, the indexes), each part one Claude run ending in its own commit and push, so the brain update can go in between. A usage limit makes it wait and carry on with the same part until 07:00; a restart picks up where it was (`prune-run.json`, never synced). In the morning one thread says what went in, what failed, and asks the questions it could not ask in the night, in one batch.

## The outline

The outline on the right has three slides; scroll sideways (it snaps) or click the switch on top. People and Someday can be switched off in Settings → Layout.

- **Projects**: the **areas** in the order of `Core/Horizons/30,000 ft Goals.md` (a numbered list, `1. [[Area]] — where it should stand`; areas not in it follow alphabetically, and the line at the foot opens that file), each with its active projects below it, most recently dealt with first (your latest message in one of its threads, or the last change to its note). Paused projects (`Status: paused` in the project's note) are folded away under their own line and unfold on hover. An area with no project right now is grey.
- **Someday**: each item newest first, the parked old actions under their own heading; **+** starts a thread on the item: do it now, keep it, or fold it.
- **People**: everyone in `Core/People/`, in four groups from the `Status:` line in each person's file: **Your move**, **Keep warm**, **Waiting** (hover for what), **Nothing open**. Inside a group, longest since you dealt with them first. **+** starts a thread on the person.

On every slide:

- A dot after a name means it has open threads; the project of the open thread is highlighted. A long name runs onto a second line; the full name is in the tooltip.
- Hover a row for **+**: a new thread on it, with its notes loaded. Click a row to read its note. Drag a thread from the inbox onto a row to file it there.
- At the foot of Projects: **Start a thread on every** active or paused project, or area (about which project to start there). Each asks once more, and skips what already has an open thread.
- When the window is too narrow for the outline (and on the phone), or the right bar is switched off in Layout, it is the **Folders** tab in the inbox.

The order is the vault's, not the app's: change a `Status:` line or the 30,000 ft list (ask Claude in a thread) and the outline follows.

## Repos

Any thread can work in any of your GitHub repos: from the project's `repo:` line, by naming it in the thread, or by picking it in the repo panel (the repo button in the thread header). The repo is cloned the moment Claude opens it; one thread works in a repo at a time, the others wait; every thread gets a branch of its own. Claude commits; when its turn ends the app pushes the branch, runs the repo's tests (`npm test`, if it has any) and, if they pass, merges it into main by itself, with a note in the thread. Failing tests or a clash with main leave the branch on GitHub, and the note says why. The panel's buttons are still there for doing it by hand. Claude can rename and create repos when you ask. Detail, and the token for renaming: [repos.md](repos.md).

## Scripts on files

A thread without a repo can run scripts in a workbench of its own (`threads/<id>/work/`): filling a PDF form, reading or editing a Word or Excel file, converting a file. Every command has to start with `cd` into that folder, and git is refused. Only what Claude hands over (with its `show_file` tool) appears in the thread; the workbench itself is never saved. `artifactsShell: false` turns this off.

## Video Kit

Video Kit, the player for your videos' scripts, versions and comments (repo `app-ytvideo-kit`), starts with the app on http://localhost:4400 and starts again if it stops; **Video Kit** in the top bar opens it. It runs from a copy of its own that always follows GitHub's main: every three minutes the app looks for a new version and, if there is one, starts Video Kit again on it, so a change merged into `app-ytvideo-kit` is live within minutes without restarting the app. It shows every `ytvideo-*` repo of yours: the app clones the ones not here yet, and keeps the copies no thread is working in on main and up to date (every ten minutes, and when Video Kit opens a video). What you type there (scripts, comments) is saved through the app: committed onto main and pushed, after the thread working in that repo, if any, is done. Renders and recordings are not in git; they stay in the copy on this computer. Turned off with `"videoKit": { "enabled": false }` in config.json; another port with `"port"`.

## Talk: the host

`/walk`, or **Talk** in the top bar. You speak or type to the **host**, a small model (Haiku) that sits between you and the threads. For everything you say it decides where it goes:

- **To the open thread.** After a thread has been read to you, what you say is your reply to it. It is sent, and the next thread is read out. No closing keyword is needed.
- **To a new thread**, when it is a new piece of work for Claude ("ask Claude to find out when the board meets").
- **To the app**, when it is a command: next, done, repeat, read all, new thread, cancel, goodbye. A thread by name works too ("open the grant one").
- **Nowhere: it answers itself.** Ask what is waiting, what a thread said, or anything a chatbot can answer. Questions that need more (something current from the web, careful thought) go to a stronger model (Sonnet), which may search the web. The host keeps the conversation in mind, so you can ask follow-ups, and "make that a thread" turns the conversation into one.

The short commands and "…and send it" at the end of a sentence work without the model, at once. If the model fails, nothing is lost: say "send" to give what you said to the open thread as it is.

**A better ear and voice.** By default the page uses the phone's own speech recognition and voice. With a Groq key the page records you itself and Groq's Whisper transcribes, which is far more accurate; with Piper installed the app speaks in its own voice, made on the machine it runs on. Both work from the Pi with the laptop off: [voice.md](voice.md).

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

- Speaking needs Chrome (Android or computer) and, on the phone, the app reachable over https: [pi.md](pi.md) (the Tailscale part works for a laptop too). Typing works everywhere.
- Chrome stops listening when the screen goes off. The page keeps the screen on; "Lock for the pocket" covers it with a dark shield that ignores touches.
- Cards are left out; they are for reading and editing.
- Every thing you say costs one small Haiku request. The conversation with the host itself is not kept and does not go into the brain; only what it passes to a thread does.

A real phone number does the same through Twilio, for a per-minute price: [calling.md](calling.md).

## On the phone

The whole app works in the phone's browser under the same address as Talk. One column: the top bar, the thread, the reply box at the bottom. The inbox and the folders are behind the inbox button. On a card, swipe right to accept and left to decline, or use the buttons; the text is edited in place. "Add to Home screen" in the browser's menu makes it open like an app.

## Sleep time

From 00:00 to 08:00 the app shows a go-to-sleep screen instead of the queue. **Let me in anyway** gets you past it, but only for as long as the window stays open: opening the app again, or coming back after more than ten minutes away, shows it again. Change the hours or turn it off in Settings → General.

## The laptop and the Pi

The laptop does the work and is where the app is installed from (`http://localhost:4317`), so it opens whether or not the Pi is on. With the Pi's address as `remote` in the laptop's `config.json`, the app has **Hand over to the Pi** (for when the laptop sleeps; it waits for Claude to finish and then says when it is safe to suspend) and **Take back**. In between, both sides sync through the data repo every two minutes. Setup and the odd cases: [laptop.md](laptop.md).

### The status item: four stages

The dot in the top bar says where the computer stands. **Locked** means the app starts nothing by itself; anything you send unlocks it again.

| Dot | What it means |
|---|---|
| Green | Locked and nothing running: safe to suspend |
| Blue | Locked, still finishing what was running |
| Yellow | Something running, not locked |
| Grey | Nothing running, but not locked: the app may start something by itself |

**Get ready to suspend** locks it: what is running finishes, nothing new starts (no cards, no events, no sorting), everything is saved to GitHub, and the dot turns green. It works whether or not the Pi is reachable. **Handover** gives everything to the Pi (see above).

Most of the time the status is only the small item in the top bar. The row under it opens only when something bigger is going on: getting ready to suspend, a handover, saving to GitHub failing, or the Pi not answering. Repo branches that are only on this computer (a turn still working on one counts as neither) are in the item's panel, and open the row only while you are getting ready to suspend or handing over, when they would be left behind.

## The app looks after itself

- **It updates itself.** On Windows the app looks for a new version every ten minutes, takes it as soon as Claude is not working, restarts, and goes back if the new version does not start; the page reloads by itself. The Pi does the same through `deploy/update.sh` ([pi.md](pi.md)). For something urgent, **Settings → Connections → Check for updates** looks right away; if Claude is working, it offers **Update now anyway**, which cuts that turn off.
- **The network is away** (the laptop just woke, GitHub cannot be reached): the app tries again by itself with growing pauses and says nothing, unless it lasts more than ten minutes.
- **A message nobody answered.** A message sent just as the work moved between the laptop and the Pi could end up in a thread with no turn to take it up. The app looks for such messages every minute (on the computer doing the work, for messages of the last six hours) and starts the turn itself, with a note in the thread. After Stop it does not.
- **Anything else fails** (a brain update, the card run, saving, updating, a crash): the app opens a **Repair** thread by itself. Claude gets the error and the end of the log, finds the cause, and if it is a bug fixes it in the app's own repo. Its fix is tested and merged like any thread's work, the thread closes, and the self-update takes it (and goes back if the new version does not start). If the tests fail, the thread waits in the inbox. One repair thread per kind of error per day. Turn it off with `"repair": { "auto": false }`, or only its merging with `"repair": { "autoMerge": false }`.

### Usage limits: held, then carried on

When Claude's five-hour or weekly limit cuts a turn off, the thread does not come back with an error. It stays out of the inbox and says "Held by the five-hour limit: carries on by itself at 02:43". Three minutes after the limit lifts, the app starts the turn again and tells Claude to carry on where it stopped. So you can send something late, go to sleep, and find it done.

- The time comes from Claude's own report (an exact time, and which limit), so a weekly limit is held until its day, not until the same clock time tonight. With no time given, the app tries again after 15 minutes.
- What you send into a held thread waits in the same hold and goes in with the next try. "Cancel the hold" gives the thread back to you as it is.
- The hold is saved with the thread, not kept as a timer. It survives a restart and an update of the app, and it travels to the Pi when you hand over: whichever computer does the work when the limit lifts carries on. A held thread does not keep the laptop from handing over or going to sleep.
- A turn cut off while working in a repo leaves its work on the thread's branch on GitHub but is not merged into main. That happens when the turn has finished.
- A brain update cut off by the limit files nothing and runs again by itself when the limit lifts. Cards skip their round while a limit is on.
- The times are in `config.json` under `limits` (`marginMs`, `fallbackMs`, `checkMs`).

## Usage

The amount in the top bar is what Claude used through this app today, counted at API prices as the Agent SDK reports it per run; click it for the last five hours, seven days, and today by kind. It covers both computers. It is not your plan's limit: the app cannot read how much of that is left.

## How the brain is handled

- **One clone stays on disk** in the app's data folder. Before a turn starts, the app brings it up to GitHub's state. Claude never clones, pulls, commits or pushes in it.
- **Threads only read the app's clone.** That is enforced in code: a thread can write into its own files folder, its workbench, and a repo it holds, nowhere else. To change the vault's structure or rules, a thread opens the vault's repo (`brain`) like any other; facts stay with the brain update.
- **The current rules ride along.** The vault files under `preload` (`Claude/Instructions.md` and `Claude/Thinking With Me.md`) are put into every thread's instructions fresh each turn.
- **Only the brain update files facts**, as described above.

The prompts are in `prompts/`. They point at the vault's rules rather than repeating them.

## Where things are, and how the state is saved

App data is in its own folder, outside the vault (`APP_AI_DATA` sets another):

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\app-ai` |
| macOS | `~/Library/Application Support/app-ai` |
| Linux | `~/.local/share/app-ai` |

That folder is a git repository. Every two minutes, and after every brain update, the app commits what changed and pushes it to the data repo (`dataRepo`): threads and their files, water levels, the tier setting, the queue's record and profile, the card log. Settings → Connections shows when it last saved.

Never committed: `config.json` and `google-token.json` (they hold secrets), the brain clone, the repo clones, logs, and each thread's workbench (`threads/<id>/work/`).

A computer that starts with an empty data folder takes over the saved state. Two computers share it only through the handover described in [laptop.md](laptop.md); without `remote` set, run the app in one place at a time.

## Settings

`config.json` in the data folder, created on first start. Restart the app after changing it.

| Setting | Default | Meaning |
|---|---|---|
| `port` | `4317` | The local address. |
| `brainRepo`, `brainBranch` | `fburgerdev/brain`, `main` | The vault to clone. |
| `dataRepo`, `dataSyncMinutes` | `fburgerdev/app-ai-data`, `2` | Where and how often the app's state is saved. Empty repo: not saved. |
| `preload` | Instructions, Thinking With Me | Vault files put into every thread's instructions. |
| `protectedPaths`, `hiddenPaths` | Scratchpad, .obsidian, For Claude, For Florian | Never written by the app / never on its disk. All gone from the vault since 13-11-2026; harmless. |
| `remote` | empty | On the laptop: the Pi's address, for handing over ([laptop.md](laptop.md)). Empty on the Pi. |
| `allowedHosts` | empty | Other addresses the app answers under (Tailscale). |
| `maxParallel` | `6` | Turns that run at once. Your own messages go first; work the app started by itself leaves one slot free for you. Use 2 on a Pi with 2 GB. |
| `queue` | Haiku ranks, Sonnet learns, every 30 choices, requeue 20 min | The queue's models and rhythm. |
| `routeModel` | `haiku` | The model that picks a tier under Auto. |
| `cards` | automatic, keep 3 ready, 3 per run, 45 min pause, calendar every 3 h | The card run, which also looks at the calendar. `auto: false` makes cards and preparations only on request. |
| `google` | empty | Client id and secret of your Google Cloud project ([google.md](google.md)). |
| `github` | owner `fburgerdev`, no token | For renaming and creating repos; the token only if git's own does not work ([repos.md](repos.md)). |
| `artifactsShell` | `true` | Whether a thread without a repo may run scripts on its workbench. It is a rule the app checks, not a sandbox: a script can still reach other folders on the computer. |
| `threadShell` | `false` | Whether Claude may run shell commands in threads outside a repo. Once a thread has opened a repo, it can always run them there; push, branch switching and destructive git commands are refused. |
| `autoPush`, `autoMerge` | `true`, `true` | Whether a thread's branch is pushed when its turn ends, and then merged into main once the repo's tests pass (or at once if it has none). |
| `repair` | on, merges | The self-repair threads (see "The app looks after itself"). |
| `selfUpdate`, `selfUpdateMinutes` | on Windows, `10` | Taking new versions while running. The Pi uses `deploy/update.sh` instead. |
| `limits` | 3 min margin, 15 min fallback | When a turn held by a usage limit is tried again. |
| `leftOver` | every minute, messages 1 min to 6 h old | Looking for a message of yours that no turn took up. |
| `voice` | off | `groqKey`, `speak`, `piper`, `openaiKey`: the Talk page's ear and voice ([voice.md](voice.md)). Calling through Twilio ([calling.md](calling.md)). Also `hostModel` (`haiku`) and `thinkModel` (`sonnet`). |
| `pi` | on, SSH host `pi` | Claude's `pi_shell` tool; `"host"` names another SSH host, `"enabled": false` turns it off ([pi.md](pi.md)). |
| `videoKit` | on | `"enabled": false` turns Video Kit off; `"port"` moves it. |
| `readLog` | `false` | Recording what is read from the vault (`reads.jsonl`, `npm run reads`). |

## Tests

```
npm test
```

Runs the whole app against throwaway repos with the stand-in Claude.

## Not built yet

Threads that wait for a mail reply and wake up when it arrives. A desktop app of its own (it is a page in the browser). The host's conversations are not kept. Nothing acts on the read log.
