# Threads that work in GitHub repos

Any thread can work in any of your GitHub repos. Nothing needs setting up for that; this page is
about how it behaves, and about the one extra for renaming and creating repos.

## How a thread gets a repo

- **From its project.** A project note can carry a line `repo: fburgerdev/website-pbu-cologne`
  (optional; most projects have none). A thread on that project starts with that repo.
- **By asking.** In any thread, say "work in app-ai" or name the repo. Claude opens it with its
  `open_repo` tool. Just the name works for your own repos (`app-ai` is `fburgerdev/app-ai`).
- **By picking.** The repo button in the thread header opens the repo panel; change the repo
  there. Without a repo the button is not shown: tell Claude in the thread instead.

## What happens on the machine

- The repo is cloned **the moment Claude opens it**, into `repos/<owner>/<name>` in the app's
  data folder, and fetched again every time a thread opens it. Never before.
- **Threads side by side** in every repo but the vault (see below); the vault, and a repo whose
  `.app/repo.json` says `"parallel": false`, take one thread at a time. A thread holds the repo from when Claude opens it until its turn ends. Another thread
  that wants it waits, and says so in the inbox ("Waiting for fburgerdev/app-ai: "Tidy the server
  code" is working in it"). After a few minutes (`repoWaitMs` in `config.json`, default three) its
  turn is parked: it ends, keeps its place in the queue, and the app starts it again by itself the
  moment the repo is free. Nobody has to say "go on".
- **Every thread gets a branch of its own**, `claude/<thread name>-<id>`, from the repo's main
  branch. Claude commits there; what it leaves uncommitted is committed for it when the turn
  ends, and the app then pushes the branch to GitHub by itself, so the work is never on one
  computer only (`"autoPush": false` in `config.json` turns that off). Claude itself cannot
  push, switch branches, reset, delete branches or touch the remote: the app blocks those
  commands.
- Shell commands on code (tests, builds, git commits) are allowed only while a thread holds a
  repo, and file writes only inside it. The app's clone of the vault stays read-only. (A thread
  without a repo can run scripts on its own workbench, for PDF forms and Word files; see
  "Scripts on files" in the [manual](manual.md#scripts-on-files).)
- **The vault is a repo too.** A thread that changes the vault's structure or rules opens
  `brain` and works there like anywhere else. Facts stay with the brain update. The two take
  turns: the brain update holds the vault's repo while it runs, so a thread opening it waits
  (the repo panel says "The brain update is working in this repo"), and the update waits for
  a thread that holds it.
- **Only the repo open at the end of a turn is merged by itself.** A thread that switches repos
  mid-turn leaves the first one's branch pushed but unmerged; it is merged once the thread
  ends a turn in it again.

## Threads side by side in one repo

Florian's decisions, 23-11-2026. Every repo lets several threads work in it at the same time,
except the vault, which stays one thread at a time (the brain update and the threads changing it
take turns). A repo can opt out, and name its shared folders, in a file on its main branch,
`.app/repo.json`:

```json
{
  "parallel": true,
  "shared": {
    "writable": ["takes", "renders", "films", "edit/work"],
    "addonly": ["films/final4k"],
    "readonly": ["fonts"]
  }
}
```

- **Worktrees on demand.** The first thread works in the main copy in `repos/`, as before. A
  thread that comes while another works there gets a worktree of its own, in
  `worktrees/<owner>/<name>/<thread>` in the app's data folder, on its own branch, and keeps it until
  its branch is merged (or the thread is deleted). `"parallel": false` makes a repo one thread at a
  time again.
- **The lock has two forms.** A normal turn shares the repo with the others. A turn that needs the
  repo quiet takes it alone: `open_repo` with `exclusive: true`, which Claude does by itself for
  migrations, renames, dependency upgrades, changes to `.app/repo.json` and writing into a
  read-only folder, and says so in the thread. It waits until the turns already working there
  have ended, and no new one starts meanwhile. Waiting longer than a few minutes parks the turn,
  as above.
- **Merges go one at a time**, in a worktree of their own (`_merge`), so a merge never moves files
  under a thread at work. Before its tests, a branch gets what main has now merged in, so what is
  tested is what main will be. An exclusive turn holds the merges back until it ends. A thread's
  next turn waits for the merge of its last one.
- **Shared folders** live once, in `shared/<owner>/<name>/`, and are linked into the main copy and
  every worktree. A folder a copy already had is moved in the first time. They are never synced to
  the Pi, and a folder git tracks files in is never shared.
  - **writable**: any thread writes, overwrites and deletes, as in one copy. Without a `shared`
    list in `.app/repo.json`, every top-level folder git ignores is shared this way by itself,
    including ones that appear later ("put any new not git tracked data to shared"), except the
    folders tools make for each copy (`node_modules`, `.venv`, `__pycache__`, `dist`, `build` and
    the like).
  - **add-only**: new files go in, from a thread or from you dropping them in; a file once written
    is never changed, renamed or deleted. Tools that write a temporary file and rename it need a
    writable folder instead.
  - **read-only**: nothing goes in or out, except in a turn that holds the repo alone.
  - An add-only or read-only folder may sit inside a writable one (`films/final4k` inside `films`).
  - On Windows, Windows' own access rules hold add-only and read-only, against Claude's tools,
    scripts and git alike: a plain read-only flag does not, and git following a link would empty
    the folder. The app takes its links out before it deletes a worktree. At the end of every turn
    the app also checks what changed; a turn that broke the rules, or changed `.app/repo.json`
    without the repo to itself, is noted in the thread and not merged until you have written there.

## Into main by itself

When a turn that changed a repo ends, the app, in the background:

1. takes the repo, so no other thread changes it meanwhile;
2. runs the repo's tests on the branch, if it has any (`npm test` in `package.json`, after
   `npm ci`); what the tests leave behind is thrown away, not merged;
3. if they pass, or there are none, merges the branch into main, pushes main and deletes the
   branch;
4. notes in the thread what it did. If the tests failed, the note has the end of their output,
   and the branch stays on GitHub; if main has moved on in a way that clashes, it says so.

For the app's own repo, a merged change reaches the running app with its next self-update,
within ten minutes. If the new version does not start, the self-update goes back.

`"autoMerge": false` in `config.json` turns step 3 off, so merging is your button again.

## The buttons

The repo panel shows the branch, its commits, and every changed file with its diff. Its buttons
do by hand what the app otherwise does by itself:

- **Push and open pull request** pushes the branch and opens GitHub's page for a pull request.
- **Only push** pushes the branch, nothing more. Rarely needed now: the branch is pushed by
  itself when a turn ends. It is there for when that did not get through (offline).
- **Merge into main** (click twice) merges the branch into main, pushes main and deletes the
  branch. If main has moved on in a way that conflicts, it refuses and tells you; ask Claude in
  the thread to bring the branch up to date.

Each push and merge is noted in the thread, so the next brain update knows.

## Renaming and creating repos

Claude can rename a repo, create a new one or change its description, from any thread,
including the questions thread a brain update opens. Only when you ask for it; it cannot delete
a repo. A rename moves the app's copy, updates every thread on that repo, and is noted in the
thread so the next brain update fixes the `repo:` lines and mentions in the vault.

These go through the GitHub API, which needs a token. The app first uses the one git already
has on the machine (Git Credential Manager on Windows, the credential store on the Pi). If that
does not work, make a token and put it in `config.json`:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token.
2. Repository access: All repositories. Permissions: Administration (read and write), Contents
   (read and write), Metadata (read).
3. In `config.json`: `"github": { "owner": "fburgerdev", "token": "github_pat_…" }`. Restart the
   app. `config.json` is never committed.
