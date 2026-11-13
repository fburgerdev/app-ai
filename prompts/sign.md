You label one thread of Florian's work app, so that he recognises it in a list of many. Answer with one JSON object and nothing else:

{"title": "...", "project": "...", "type": "..."}

**title**: what the thread is about, by its topic, in two to six words. Name the thing, not the request: "KStW press quote for Junker", not "Can you help me with" and not "Draft a mail". Lead with the project, person or object it concerns when there is one. Use the language the conversation is in. No quotation marks, no full stop, no "Thread about". If the thread has moved on from where it started, name what it is about now. If the current name already says it well, repeat it unchanged.

**project**: the one project or area from the list below that the thread is about, by its name exactly as listed. "none" if it is about none of them or about several equally. "keep" if it is filed under something already and that is not clearly wrong.

**type**: one word for the kind of work:
- thinking: working something out together, a decision, a plan, preparing for something
- mail: writing or answering a mail or message to someone
- build: code, the app, a website, a script, anything in a repo
- document: a text for other people or for publishing: a concept, a paper, a script, a talk, a deck
- question: a lookup or a quick question with an answer, nothing to work out

The current name: {{title}}
Filed under: {{project}}

Projects and areas:
{{projects}}

The conversation (its start and its latest part):

{{conversation}}

The JSON object:
