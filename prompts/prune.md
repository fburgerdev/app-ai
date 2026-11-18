This is one part of a "prune brain" pass that Florian scheduled to run at night on his Raspberry Pi. He is asleep: never ask a question during the run and never wait for an answer. Today is {{today}}.

You are in the app's clone of his vault, already brought up to GitHub's state. Read `CLAUDE.md` and `Claude/Instructions.md` before anything else: "Prune Brain" there is the workflow you are running, and "What a Core file is for", "Stale Information in Core" and "Attribution: who said what" are the rules every edit follows.

## This part

The pass is cut into parts so that each one is saved to GitHub as soon as it is done. This is part {{part}} of {{parts}}: **{{label}}**. The app commits and pushes when you finish; if this part fails, only this part is lost.

Prune these files, and only these. A file in the list that no longer exists was handled by an earlier part: skip it.

{{files}}

{{extra}}

For each file in the list:

1. Outdated (a project that is done, an event that has passed, a resolved to-do): move its lasting lines into the person, organisation, project or area file they belong to, then delete it; the note of a done or dropped project is not deleted but moved to `Archive/Projects/` with `git mv`, as it is. You may write those lines into any file in `Core/`, inside or outside this part's list. Deleting or archiving a note and moving its content happen in this same part, never split across two.
2. Still current: check its form and cut what "What a Core file is for" says to cut (interpretation, appended update blocks, cross-references that describe contents). Edit in place.
3. When you delete or rename a note, fix the index lines and wikilinks that point to it (`People Index`, `Organizations Index`, `Projects Index`, `Learnings Index`, `Campaigns Index`) in this part too, so the vault is consistent after every part.

## What this run does not decide

Florian chose (16-11-2026) that the questions a prune would ask him wait for the morning, as one batch. So:

- **Stale records** ("Stale Information in Core" lists the signals: a `Last contacted:` more than about a month old for an active contact, a "waiting on X" with no movement, a deadline passed with no outcome, a next action overtaken by events): do not change them. Put each under Questions, as a closed question naming the file and the date, grouped by person or project.
- **The four action files** (`Calendar`, `Next Actions`, `Waiting For`, `Someday`): never change them in this run. A line that looks done or overtaken goes under Questions.
- **Anything you would have to guess** (a date, whose view a line is, whether something still holds): leave it, and ask under Questions.
- Never create a project file, folder or area, and never restructure an index.

**Few questions.** After the first night's prune Florian answered about 70 questions and then said (18-11-2026): "i dont want anymore, for the rest just decide yourself, i dont care". So this part asks at most **two** questions: the two whose answer changes the most (a line in an action file he would otherwise act on wrongly, the state of a person or project he is working with right now). Everything else you would have asked is left exactly as it is, without a question and without a mention; the next prune or an ordinary thread meets it again. Two is a ceiling, not a target: most parts need none.

## Tools

- Delete a file with plain `rm "<path>"`, move one with `mv` or `git mv`. Do not use other git commands: the app commits and pushes.
- Write only inside `Core/`, except moving a project note into `Archive/Projects/`. `Threads/` and everything already in `Archive/` are never touched, nor are `Scratchpad.md`, `.obsidian`, `For Claude` and `For Florian` are never touched.
- If a tool is refused, do not try to work around it. Leave that file as it is and say what was refused under Questions.

## How to finish

End with one final message in exactly this shape. The app reads it; Florian reads it in the morning.

```
STATUS: pruned | nothing | questions

## Written
- <vault file> — <deleted / moved into X / cut interpretation / fixed links>

## Questions
**<person, organisation or project>**
1. <closed question he can answer in a few words, with the file and the date it rests on>
```

- At most two questions, as said above.

- `STATUS: nothing` when no file changed; leave out "Written".
- `STATUS: questions` when there is at least one question, whether or not files changed. Leave out any section that would be empty.
- Never mention `Artifacts/Thinking/`.
