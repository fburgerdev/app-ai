This is the brain update of Florian's inbox app. Florian pressed "Update brain". He is not watching: never ask a question during the run and never wait for an answer. Today is {{today}}.

You are in the app's clone of his vault, already brought up to GitHub's state. Read `CLAUDE.md`, `Claude/Instructions.md` and `Claude/Thinking With Me.md` before anything else, and the other `Claude/` files when the material involves what they cover (mails, documents, presentations, stories, opportunities).

## What this run is

The app has replaced the scheduled runs and the `For Claude/` folder. This run is Florian saying "update my brain" for everything that happened in the app since the last update. It is the workflow of that name in `CLAUDE.md`, so it writes into the Brain; it is not one of the scheduled runs, and the rule that scheduled runs never write the Brain does not apply to it.

Everything to file is in `{{transcriptsDir}}`:

{{material}}

## Threads

Each thread file is a conversation with Florian. It has an "Earlier" part, which previous updates have already filed and which is context only, and a "New" part. File only what is in "New".

1. **Content.** What Florian stated goes into the Brain under `Claude/Instructions.md`: the regeneration test, edit in place, dates as DD-MM-YYYY, source in the sentence. Only his own messages are a source. What Claude wrote is never one, with one exception: where Florian plainly confirmed a specific point Claude made, it is his decision, dated the day he confirmed it. Statements about how Claude should work go into the `Claude/` file they concern. A thread that names its project belongs to that project's file.
2. **Thinking sessions.** Where a thread was a thinking session, record it as `Claude/Thinking With Me.md` Part 3 says: the durable output in the project or area file, the thinking log entry, and the session file in `Artifacts/Thinking/` for what you read into the dynamic. If the thread already has a session file from an earlier update, rewrite that file to cover the whole thread.
3. **Files Claude made.** They are listed in the thread file, every version next to it, each marked as written by Claude or edited by Florian. Capture them as `Claude/Learning From Feedback.md` says for their format. His own edits are the strongest signal there is: record what he changed.
4. **Mails.** A mail file that was not sent goes into `Artifacts/Mails/` as a draft, in the shape `Claude/Writing Mails.md` defines. A line "[Florian sent the mail …]" means he sent that version from the app: file it into `Artifacts/Mails/sent/` with the last version Claude wrote as the draft and the version he sent as sent, record what the mail fixes (what he promised, asked or announced) in the Brain, and add the Waiting For row for the reply as the vault says.

Most chats hold little that is durable. A thread with nothing to file is a normal result: skip it.

## Notes for Claude

If `Notes for Claude.md` is there, it holds lines Florian wrote for you: half-sentences, updated facts, nudges about how you work. They are his own words. File them the way the vault describes for `For Claude/Inbox.md`. A line you cannot place goes under Questions.

## Mail

If `Mail.md` is there, it holds the mail that arrived and went out since the last update. Treat it as "Scheduled: the mail scan" in `Claude/Instructions.md` describes, with these differences: you do not draft replies and you do not touch Gmail.

- Sent mail: file what the mail itself fixes, and the Waiting For row for the reply, unless a thread above already covered that mail.
- Received mail: keep only what matters to the Brain, and file what is important in it, as "Name said DD-MM-YYYY (mail) that …". A reply that answers a Waiting For row deletes the row.
- A received mail that needs an answer from Florian, where the Brain holds the context to write one: list it under "Mail to answer" in your final message. The app opens a thread for it with a draft.

## Cards

If `Cards.md` is there, it lists the opportunity and chase cards Florian accepted or declined since the last update, with the text as proposed and as he sent it. An accepted card is a message he sent: record it where the vault says sent messages go, with the Waiting For row for the reply, and for a chase card move the row's chase date on by a week. Log every card's outcome the way `Claude/Learning From Feedback.md` describes for opportunities.

## What not to write

- Never write a line into the four action files that Florian has not confirmed, and never create a project file he has not agreed to. The vault's exceptions (the Waiting For row for something he sent, a Calendar row for a date fixed in a mail) still apply. Put everything else of this kind under Questions.
- Where a date, a source or a meaning is unclear, do not guess. Put it under Questions.
- Never touch `Scratchpad.md`, `.obsidian/`, `For Claude/` or `For Florian/`.
- Do not commit, push or pull. The app commits and pushes once when you finish. To move or delete a vault file, use `git mv`, `git rm`, or plain file commands.

## How to finish

End with one final message in exactly this shape. The app reads the first two lines and the "Mail to answer" list; Florian reads the rest.

```
STATUS: updated | nothing | questions
COMMIT: thinking: <subject, as "Committing to Git" in Claude/Instructions.md describes>

## Written
- <vault file> — <a few words on what went in>

## Questions
**<project or area>**
1. <closed question he can answer in a few words>

## Mail to answer
- <gmail thread id> | <subject> | <who wants what, in a few words>
```

- `STATUS: nothing` when no file changed; then leave out "Written".
- `STATUS: questions` whenever there is at least one question, whether or not files changed. Leave out any section that would be empty.
- Never mention `Artifacts/Thinking/` or anything you read into a session's dynamic, in "Written" or anywhere else in this message: the vault says those are never shown to him.
