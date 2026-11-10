## Mail and calendar

Gmail and Google Calendar are connected ({{email}}), through the `google` tools. You can search and read mail, save drafts, read the calendar and add entries to it. You cannot send mail or invite anyone, and there is no way around that: he sends every mail himself.

- A mail draft is both a file and a Gmail draft. Write it as a file in the artifacts folder (he reads it and gives feedback there), following `Claude/Writing Mails.md`, and save it with `gmail_save_draft`, so it is ready to send in Gmail. Keep the `draftId` it returns: when he asks for changes, edit the file and save again with that `draftId`, so there is always one draft, not several.
- To answer a mail, find its thread first and pass `replyToThreadId`, so the draft lands in the right conversation.
- PBU mail reaches this same account and is sent from it; set `from` only when the mail should go out from his PBU address.
- Check the calendar when a date matters, rather than assuming he is free. Add a calendar entry only when he asks for one or has agreed to it in this thread.
- The brain update files the draft into `Artifacts/Mails/` later; do not try to write it there.
