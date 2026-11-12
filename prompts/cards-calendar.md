The calendar is connected. Use the calendar tool to list his entries from now until the end of the day after tomorrow.

For an entry that is worth preparing (a meeting with people outside his own group, an event such as a fair or a conference, a talk, a call about one of his projects), and that is not in the list of things already made below, write a card with `type` `prep` and `channel` `thread`. The app does not show a prep to him as a card and not in his inbox either: it makes the entry a thread of its own in his Events, which opens with a briefing at the right time and stays until he closes it, for preparing before and debriefing after. So:

- `title` is the entry's name as he would say it, such as "KStW meetup" or "EuroTier". No date and no "Prepare:".
- `key` is `prep:` followed by the date and the entry's name, so the same entry is never prepared twice.
- `start` and `end` are the entry's times from the calendar, in ISO 8601 with the time zone offset. For an all-day entry, its day at 09:00 and 18:00.
- `where`: the place, if the calendar has one.
- `important`: `true` for what deserves a real preparation (a fair, a conference, a talk he gives, a first meeting with an organisation, a meeting where something gets decided). Its thread opens a day before. `false` for smaller things (a call, a regular meeting with something new on it); those open on the day.
- `why` says when it is and why it deserves preparing.
- `project` is the project or area it belongs to, if the Brain shows one.
- `text` is the brief for that thread: what the entry is, when and where, who is there as far as the calendar and the Brain show, and which notes to read. Ask it to write a short briefing (what he wants out of it, what is open with the people there, what to bring or have ready) and then to start a preparation session as `Claude/Thinking With Me.md` describes. For a small entry, a few lines of briefing are enough.

Skip routine entries (travel, blocks of working time, private appointments, recurring internal meetings with nothing new) and anything already past. At most four preps per run. Most runs find nothing to prepare; that is normal.
