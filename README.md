# Inbox

A local app for working with Claude across many threads at once. It shows you the thread that has waited longest, you reply, Enter sends it and opens the next one. Claude works in the background and each thread comes back to the inbox when it needs you.

It runs on your own computer as a small web server, signed in with your Claude plan, and reads your brain vault from its own clone of the GitHub repo.

## First start (Windows)

You need [Node.js](https://nodejs.org) 20 or newer and Git, both already on a machine that runs Brain Sync.

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

The first start clones the brain into the app's data folder. That takes a few seconds.

To look at the app without your account or your brain: `npm run demo`. It uses a throwaway vault and a stand-in for Claude that gives canned answers.

## Using it

| Key | What it does |
|---|---|
| Enter | Send, then open the next waiting thread |
| Shift+Enter | New line |
| Alt+N | New thread |
| Alt+S | Later: put this thread at the back of the inbox |
| Alt+X | Done: close this thread |
| Alt+J / Alt+K | Next / previous thread in the list |
| Alt+A | Show or hide the files Claude made in this thread |
| Alt+U | Update the brain from all threads |
| Esc | Close the side panel |

A thread is in one of three states: **waiting for you** (Claude has finished), **Claude is working**, or **done**. When nothing is waiting, the app shows the new-thread screen, and the first thread to finish opens by itself unless you are typing.

A message sent while Claude is still working is handed over as soon as that turn ends.

### Files Claude makes

Anything you would keep or send (a mail draft, a document, a page) is written as a file, not pasted into the chat. It appears as a card in the reply. Clicking it opens the file beside the chat.

- Every change Claude makes is kept as a version. "Show changes" marks what was added and removed since the version before.
- To give feedback on a passage, select it and press "Quote in reply". The quote goes into your message with the file name and version; write your comment under it. This works in replies and vault notes too.
- "Open in app" opens the file with the program your computer uses for it. "Copy" and "Download" do what they say.
- Pages (HTML) are shown boxed in: they cannot reach the app or your files.

### Vault notes

`[[Wikilinks]]` and vault paths in a reply are clickable and open the note beside the chat, read from the app's clone.

## How the brain is handled

In the Claude app every session clones the vault again. Here:

- **One clone stays on disk** in the app's data folder. Before a turn starts, the app brings it up to GitHub's state (at most once a minute; a fraction of a second when nothing changed). Claude never clones, pulls, commits or pushes.
- **Threads only read the vault.** That is enforced in code, not only by instruction: a thread can write into its own files folder and nowhere else. So several threads can work at once without stepping on each other.
- **The Scratchpad is never on this disk.** `Scratchpad.md`, `.obsidian/` and `For Claude/processed/` are left out of the clone with git's sparse checkout, so no run can read or change them.
- **The current rules ride along.** `Claude/Instructions.md` and `Claude/Thinking With Me.md` are put into every thread's instructions fresh each turn, so Claude has them without spending a tool call, and a rule you changed applies in every open thread at once.
- **Only the brain update writes.** It runs when you press "Update brain" (Alt+U), never on its own. It hands Claude every thread that changed since the last update, with the new part marked, and Claude files what you said under the vault's own rules ("update my brain" in `CLAUDE.md`). The app then makes one `thinking:` commit and pushes. `For Claude/`, `For Florian/`, `Scratchpad.md` and `.obsidian/` are put back before the commit, whatever the run did.
- **Questions come back as a thread.** What the vault says needs your confirmation (a line in one of the four action files, a new project file, an unclear date) is not written. It arrives in the inbox as "Brain update …: questions". Answer there, then update again.
- A closed thread that is fully in the brain is filed away under Done.

If a push fails because you are offline, the commit stays in the clone and goes out the next time the app reaches GitHub.

The prompts are in `prompts/`: `thread.md` (what every thread is told about the app) and `extract.md` (the brain update). They point at the vault's rules rather than repeating them.

## Where things are

App data is outside the vault, because the vault folder on the laptop is reset to GitHub every minute:

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\app-ai` |
| macOS | `~/Library/Application Support/app-ai` |
| Linux | `~/.local/share/app-ai` |

Inside: `config.json`, `brain/` (the clone), `threads/<id>/` (state, messages, files and their versions), `extractions/<time>/` (what each brain update was given and what it did), `log.txt`. Everything is plain files.

Claude's own session files are where Claude Code keeps them (`~/.claude`). If one goes missing, the thread carries on from the app's transcript.

## Settings

`config.json` in the data folder, created on first start. Restart the app after changing it.

| Setting | Default | Meaning |
|---|---|---|
| `port` | `4317` | The local address. Only this computer can reach it. |
| `brainRepo`, `brainBranch` | the brain repo, `main` | What to clone. |
| `preload` | Instructions, Thinking With Me | Vault files put into every thread's instructions. |
| `protectedPaths` | Scratchpad, .obsidian, For Claude, For Florian | Never written by the app. |
| `hiddenPaths` | Scratchpad, .obsidian, For Claude/processed | Never on the app's disk. |
| `model`, `extractModel` | empty | Model for threads and for the brain update. Empty means Claude Code's default. |
| `threadShell` | `false` | Whether Claude may run shell commands in threads. Off, a thread can read the vault, search the web and write files; nothing else. |
| `maxParallel` | `4` | Threads worked on at once. |

## Tests

```
npm test
```

Runs the whole app against a throwaway vault with the stand-in Claude: threads and their states, file versions, the brain update's commit, and that the protected paths stay untouched.

## Not built yet

Gmail and calendar are not connected, so a mail draft is a file you copy from. There is no scheduled brain update, no reordering by hand, no project threads with spin-offs, no opportunities view, and no phone call.
