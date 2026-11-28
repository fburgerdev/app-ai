// Turns Markdown into the reading view: coloured structure, highlighted code, maths,
// Obsidian wikilinks and callouts. Everything Claude writes passes through DOMPurify
// before it reaches the page.

import { Marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import hljs from '/vendor/highlight/es/highlight.min.js';
import katex from '/vendor/katex/katex.mjs';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// [[Note]] and [[Note|shown text]]
const wikilink = {
  name: 'wikilink',
  level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (!m) return undefined;
    return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() };
  },
  renderer(token) {
    return `<a class="wikilink" href="#" data-wiki="${escapeHtml(token.target)}">${escapeHtml(token.label)}</a>`;
  },
};

// $$ … $$ on its own lines
const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start(src) { return src.indexOf('$$'); },
  tokenizer(src) {
    const m = /^\$\$\s*\n?([\s\S]+?)\n?\s*\$\$(?:\n|$)/.exec(src) || /^\\\[\s*\n?([\s\S]+?)\n?\s*\\\](?:\n|$)/.exec(src);
    if (!m) return undefined;
    return { type: 'mathBlock', raw: m[0], tex: m[1].trim() };
  },
  renderer(token) {
    return `<div class="math math-block" data-tex="${escapeHtml(token.tex)}" data-display="1">${escapeHtml(token.tex)}</div>`;
  },
};

// $ … $ inline. A dollar sign followed by a space, or one that closes before a digit,
// is money, not maths.
const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    const a = src.indexOf('$');
    const b = src.indexOf('\\(');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  },
  tokenizer(src) {
    const m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src) || /^\\\((.+?)\\\)/.exec(src);
    if (!m) return undefined;
    return { type: 'mathInline', raw: m[0], tex: m[1].trim() };
  },
  renderer(token) {
    return `<span class="math" data-tex="${escapeHtml(token.tex)}">${escapeHtml(token.tex)}</span>`;
  },
};

const marked = new Marked({
  gfm: true,
  breaks: true, // a single line break stays a line break, as in a mail
  extensions: [wikilink, mathBlock, mathInline],
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let body;
      try {
        body = language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text);
      } catch {
        body = escapeHtml(text);
      }
      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
      return `<div class="code-block">${label}<button class="code-copy" type="button">Copy</button><pre><code class="hljs">${body}</code></pre></div>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    table(token) {
      const cell = (c, tag) => {
        const align = c.align ? ` style="text-align:${c.align}"` : '';
        return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
      };
      const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
      const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('');
      return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

const CALLOUT = /^\s*\[!(\w+)\]([+-]?)\s*(.*)$/;

// The blocks of a reply (Florian, 23-11-2026, three more 28-11-2026): what Claude did,
// where a thinking session stands, his own points mirrored back, a briefing, what Claude
// found, what Claude makes of it, what is his to do, and lines for him to confirm.
// Claude writes them as callouts, `> [!move]`, so in `Threads/` and on GitHub they still
// read as plain quotes.
const BLOCK_ALIAS = { you: 'move', yourmove: 'move', mytake: 'take', sofar: 'yours', briefing: 'brief' };
const BLOCK_TITLE = { move: 'Your move', take: 'My take', found: 'Found', done: 'Done', confirm: 'To confirm', stage: 'Stage', yours: 'So far', brief: 'Briefing' };

// A line to confirm, as its text: its own words, without a list nested under it.
function lineText(li) {
  const copy = li.cloneNode(true);
  for (const sub of copy.querySelectorAll('ul, ol, .confirm-btns')) sub.remove();
  return copy.textContent.replace(/\s+/g, ' ').trim().slice(0, 400);
}

// The short name of a question or line, for the row over the reply box: its bold words if
// it has any, else how it starts.
function shortOf(el, line) {
  const bold = el.querySelector('strong')?.textContent.replace(/\s+/g, ' ').trim();
  const s = (bold || line).replace(/[?:.,\s]+$/, '');
  const name = s.charAt(0).toUpperCase() + s.slice(1);
  return name.length > 46 ? `${name.slice(0, 45).trim()}…` : name;
}

function answerButtons(options) {
  const btns = document.createElement('span');
  btns.className = 'confirm-btns';
  for (const [answer, label, cls] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `confirm-btn${cls ? ` ${cls}` : ''}`;
    b.dataset.answer = answer;
    b.textContent = label;
    btns.append(b);
  }
  return btns;
}

// The answers Claude offers, at the very end of a question: "Merge it now? [Yes] [No]".
// Takes them off the text and returns them; null when there are none.
const OPTIONS = /(?:\s*\[[^[\]\n]{1,60}\]){2,}\s*$/;
function takeOptions(el) {
  const own = [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.matches('ul, ol, p')));
  while (own.length && own.at(-1).nodeType === 3 && !own.at(-1).data.trim()) own.pop();
  const last = own.at(-1);
  const m = last?.nodeType === 3 ? OPTIONS.exec(last.data) : null;
  if (!m) return null;
  last.data = last.data.slice(0, m.index);
  let end = last;
  while (end && ((end.nodeType === 3 && !end.data.trim()) || end.nodeName === 'BR')) {
    const before = end.previousSibling;
    end.remove();
    end = before;
  }
  return [...m[0].matchAll(/\[([^[\]]+)\]/g)].map((x) => x[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const isNo = (label) => /^(no|not|nein|don't|leave|skip)\b/i.test(label);

// Questions in "Your move" that offer answers get them as buttons (Florian, 24-11-2026).
// The pick goes out with his next message; the app wires the buttons (app.js).
function askLines(quote) {
  let group = '';
  for (const el of [...quote.querySelectorAll('p, li')]) {
    if (el.matches('p') && el.parentElement === quote) {
      const strong = el.querySelector('strong');
      if (strong && strong.textContent.trim() === el.textContent.trim()) { group = strong.textContent.replace(/[:\s]+$/, '').trim(); continue; }
    }
    const options = takeOptions(el);
    if (!options || options.length < 2) continue;
    // The answers may stand in a paragraph of their own, under the question.
    let row = el;
    if (!lineText(el)) {
      const above = el.previousElementSibling;
      if (!above?.matches('p') || above.classList.contains('callout-title')) continue;
      row = above;
      el.remove();
    }
    const line = lineText(row);
    if (!line) continue;
    const short = shortOf(row, line);
    const text = document.createElement('span');
    text.className = 'ask-text';
    text.append(...[...row.childNodes].filter((n) => !(n.nodeType === 1 && n.matches('ul, ol, p'))));
    const inner = document.createElement('div');
    inner.className = 'ask-row';
    inner.append(text, answerButtons(options.map((o, i) => [o, o, i && isNo(o) ? 'confirm-no' : ''])));
    let holder = row;
    if (row.matches('p')) { holder = document.createElement('div'); row.replaceWith(holder); }
    holder.classList.add('ask-line');
    holder.prepend(inner);
    Object.assign(holder.dataset, { line, short });
    if (group) holder.dataset.group = group;
  }
}

// From three yes-or-no lines on, one button says Yes to all of them.
function yesToAll(quote, title) {
  const lines = [...quote.querySelectorAll('.ask-line, .confirm-line')].filter((l) => /^(yes|ja)\b/i.test(l.querySelector('.confirm-btn')?.textContent || ''));
  if (lines.length < 3) return;
  for (const l of lines) l.dataset.yes = l.querySelector('.confirm-btn').dataset.answer;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'confirm-btn confirm-all';
  b.textContent = 'Yes to all';
  title.append(b);
}

// Each item of a confirm block gets a Yes and a No. The project it sits under is the
// bold line above its list, if there is one. The app wires the buttons (app.js).
function confirmLines(quote) {
  let group = '';
  for (const child of [...quote.children]) {
    if (child.matches('p')) {
      const strong = child.querySelector('strong');
      if (strong && strong.textContent.trim() === child.textContent.trim()) group = strong.textContent.replace(/[:\s]+$/, '').trim();
      continue;
    }
    if (!child.matches('ul, ol')) continue;
    for (const li of child.querySelectorAll(':scope > li')) {
      takeOptions(li.querySelector(':scope > p:last-of-type') || li); // the two buttons are here anyway
      const line = lineText(li);
      if (!line) continue;
      li.classList.add('confirm-line');
      li.dataset.short = shortOf(li, line);
      li.dataset.line = line;
      if (group) li.dataset.group = group;
      li.append(answerButtons([['yes', 'Yes', 'confirm-yes'], ['no', 'No', 'confirm-no']]));
    }
  }
}

// "Done" folds to its title line; what is under it opens on a click. Written `[!done]+`
// it starts open (the bullets of a build report).
function foldDone(quote, title, open) {
  const det = document.createElement('details');
  det.className = quote.className;
  if (open) det.open = true;
  const sum = document.createElement('summary');
  const lab = document.createElement('span');
  lab.className = 'callout-title';
  lab.textContent = 'Done';
  sum.append(lab);
  const hintText = title.replace(/^done\s*[·:—-]?\s*/i, '').trim();
  if (hintText) {
    const hint = document.createElement('span');
    hint.className = 'done-hint';
    hint.textContent = hintText;
    sum.append(hint);
  }
  det.append(sum);
  const body = document.createElement('div');
  body.className = 'done-body';
  body.append(...quote.childNodes);
  if (!body.textContent.trim()) det.classList.add('is-empty');
  else det.append(body);
  quote.replaceWith(det);
}
// Inline code that names a vault file becomes a link to it.
const VAULT_PATH = /^(Core|Brain|Threads|Archive|Claude|Artifacts|Files|For Florian|For Claude)\/[^<>:"|?*]+\.[a-z0-9]{1,5}$/i;

function decorate(root) {
  // Maths
  for (const el of root.querySelectorAll('.math')) {
    try {
      katex.render(el.dataset.tex, el, { displayMode: Boolean(el.dataset.display), throwOnError: false, output: 'html' });
    } catch {
      el.classList.add('math-error');
    }
  }
  // Obsidian callouts: > [!note] Title
  for (const quote of root.querySelectorAll('blockquote')) {
    const first = quote.querySelector(':scope > p');
    if (!first) continue;
    // Marked writes a line break inside a paragraph as <br>, with or without a newline.
    const lines = first.innerHTML.split(/<br\s*\/?>\n?|\n/);
    const firstLine = lines[0];
    const probe = document.createElement('div');
    probe.innerHTML = firstLine;
    const m = CALLOUT.exec(probe.textContent);
    if (!m) continue;
    const raw = m[1].toLowerCase();
    const kind = BLOCK_ALIAS[raw] || raw;
    quote.classList.add('callout', `callout-${kind}`);
    if (BLOCK_TITLE[kind]) quote.classList.add('block');
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.textContent = m[3] || BLOCK_TITLE[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
    const rest = lines.slice(1).join('<br>');
    if (rest.trim()) first.innerHTML = rest;
    else first.remove();
    if (kind === 'done') { foldDone(quote, m[3] || '', m[2] === '+'); continue; }
    quote.prepend(title);
    if (kind === 'confirm') confirmLines(quote);
    if (kind === 'move') askLines(quote);
    if (kind === 'confirm' || kind === 'move') yesToAll(quote, title);
  }
  // Vault paths
  for (const code of root.querySelectorAll(':not(pre) > code')) {
    const text = code.textContent.trim();
    if (!VAULT_PATH.test(text)) continue;
    const a = document.createElement('a');
    a.className = 'wikilink wikilink-path';
    a.href = '#';
    a.dataset.wiki = text;
    code.replaceWith(a);
    a.append(code);
  }
  // Task list items
  for (const box of root.querySelectorAll('li > input[type="checkbox"]')) {
    box.closest('li').classList.add('task');
  }
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer');
});

export function renderMarkdown(text) {
  const el = document.createElement('div');
  el.className = 'md';
  renderInto(el, text);
  return el;
}

// Inside a quote, a numbered line right under a line of text ("**Project**" then
// "2. the line") would be read as part of that paragraph, since only a list starting at 1
// may interrupt one. A quote line is put between them, so the lines stay a list.
function listsInQuotes(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const prev = out.at(-1);
    if (/^>\s*\d+[.)]\s/.test(line) && prev !== undefined && /^>\s*\S/.test(prev)
      && !/^>\s*(\d+[.)]|[-*+])\s/.test(prev) && !/^>\s*\[!\w+\]/.test(prev)) out.push('>');
    out.push(line);
  }
  return out.join('\n');
}

export function renderInto(el, text) {
  const html = marked.parse(listsInQuotes(text));
  el.innerHTML = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-wiki', 'data-tex', 'data-display'],
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
  });
  decorate(el);
}

export function highlightPlain(text, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { js: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', json: 'json', css: 'css', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql', csv: '' };
  const language = map[ext] ?? ext;
  const pre = document.createElement('pre');
  pre.className = 'plain-file';
  const code = document.createElement('code');
  code.className = 'hljs';
  try {
    if (language && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    else code.textContent = text;
  } catch {
    code.textContent = text;
  }
  pre.append(code);
  return pre;
}

export { escapeHtml };
