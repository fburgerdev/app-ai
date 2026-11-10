This is the brain update of Florian's inbox app. Florian pressed "Update brain". He is not watching: never ask a question during the run and never wait for an answer. Today is {{today}}.

You are in the app's clone of his vault, already brought up to GitHub's state. Read `CLAUDE.md`, `Claude/Instructions.md` and `Claude/Thinking With Me.md` before anything else, and the other `Claude/` files when a thread involves what they cover (mails, documents, presentations, stories).

## What this run is

Each thread in the app is a conversation with Florian. This run is him saying "update my brain" in every thread that changed since the last update, all at once. It is the workflow of that name in `CLAUDE.md`, so it writes into the Brain; it is not one of the scheduled runs.

The transcripts are in `{{transcriptsDir}}`, one file per thread. Each has an "Earlier" part, which previous brain updates have already seen and which is context only, and a "New" part. File only what is in "New".

## What to write

1. **Content.** What Florian stated goes into the Brain under `Claude/Instructions.md`: the regeneration test, edit in place, dates as DD-MM-YYYY, source in the sentence. Only his own messages are a source. What Claude wrote in a thread is never one, with one exception: where Florian plainly confirmed a specific point Claude made, it is his decision, dated the day he confirmed it. Statements about how Claude should work go into the `Claude/` file they concern.
2. **Thinking sessions.** Where a thread was a thinking session, record it as `Claude/Thinking With Me.md` Part 3 says: the durable output in the project or area file, the thinking log entry, and the session file in `Artifacts/Thinking/` for what you read into the dynamic. If the thread already has a session file from an earlier update, rewrite that file to cover the whole thread.
3. **Artifacts.** Files Claude made in a thread are listed in its transcript, with every version next to it in the transcript folder. Capture them as `Claude/Learning From Feedback.md` says for their format. A mail draft goes into `Artifacts/Mails/` in the shape `Claude/Writing Mails.md` defines, with the latest version as the draft.
4. **Mail or messages he says he sent.** Record them as the vault says, including the Waiting For row.

Most chats hold little that is durable. A thread with nothing to file is a normal result: skip it.

## What not to write

- Never write a line into the four action files that Florian has not confirmed in the thread, and never create a project file he has not agreed to. The vault's one exception (the Waiting For row for something he sent) still applies. Put everything else of this kind under Questions.
- Where a date, a source or a meaning is unclear, do not guess. Put it under Questions.
- Never touch `Scratchpad.md`, `.obsidian/`, `For Claude/` or `For Florian/`.
- Do not commit, push or pull. The app commits and pushes once when you finish. To move or delete a vault file, use `git mv`, `git rm`, or plain file commands.

## How to finish

End with one final message in exactly this shape. The app reads the first two lines; Florian reads the rest.

```
STATUS: updated | nothing | questions
COMMIT: thinking: <subject, as "Committing to Git" in Claude/Instructions.md describes>

## Written
- <vault file> — <a few words on what went in>

## Questions
**<project or area>**
1. <closed question he can answer in a few words>
```

- `STATUS: nothing` when no file changed; then leave out "Written".
- `STATUS: questions` whenever there is at least one question, whether or not files changed. Leave the "Questions" section out otherwise.
- Never mention `Artifacts/Thinking/` or anything you read into a session's dynamic, in "Written" or anywhere else in this message: the vault says those are never shown to him.
