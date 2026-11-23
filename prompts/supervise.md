SUPERVISE. You watch over one thread of Florian's work app while he is away. Claude has just ended a turn. Decide what happens next. Answer with one JSON object and nothing else.

Claude's last reply (its end):

---
{{reply}}
---

{{trouble}}

{{queued}}

The verdict, one of:

- "goahead": the reply only waits for a go-ahead and holds no decision for Florian. Examples: "say go on when you're back and I'll continue", "try again in a few minutes", "I'll check the render once you tell me", "when you're back, say go on". Claude could simply carry on.
- "needs": the reply asks Florian something only he can decide (which option, whether to start something expensive or risky, a fact only he knows), or reports a problem he has to look at. "Shall I start?" after a plan is "needs".
- "done": the work is finished, or the reply is an answer or report with nothing open for Claude to carry on with.

If a queued message is shown above, also say whether it should run now:

- "run": the queued message still makes sense after this reply. Lean towards this: Florian queued it on purpose and would rather not be asked again. A question in the reply that the queued message answers, or makes moot, is no reason to hold.
- "hold": the reply asks him a real decision the queued message does not settle, reports a failure or a surprise that changes what the queued message means, or the turn went wrong.

The JSON: {"verdict": "goahead" | "needs" | "done", "next": "run" | "hold", "why": "at most twelve words, for Florian"}
