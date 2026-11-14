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
- **One thread at a time per repo.** A thread holds the repo from when Claude opens it until its
  turn ends. Another thread that wants it waits, and says so in the inbox ("Waiting for
  fburgerdev/app-ai: "Tidy the server code" is working in it"), for up to 20 minutes.
- **Every thread gets a branch of its own**, `claude/<thread name>-<id>`, from the repo's main
  branch. Claude commits there; what it leaves uncommitted is committed for it when the turn
  ends, and the app then pushes the branch to GitHub by itself, so the work is never on one
  computer only (`"autoPush": false` in `config.json` turns that off). Claude itself cannot
  push, switch branches, reset, delete branches or touch the remote: the app blocks those
  commands.
- Shell commands on code (tests, builds, git commits) are allowed only while a thread holds a
  repo, and file writes only inside it. The vault stays read-only as always. (A thread without
  a repo can run scripts in its own artifacts folder, for PDF forms and Word files; see the
  README.)

## What only you do: merging

The repo panel shows the branch, its commits, and every changed file with its diff. Its buttons
are the only way anything reaches main:

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
