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

const CALLOUT = /^\s*\[!(\w+)\][+-]?\s*(.*)$/;
// Inline code that names a vault file becomes a link to it.
const VAULT_PATH = /^(Brain|Claude|Artifacts|Files|For Florian|For Claude)\/[^<>:"|?*]+\.[a-z0-9]{1,5}$/i;

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
    const firstLine = first.innerHTML.split('\n')[0];
    const probe = document.createElement('div');
    probe.innerHTML = firstLine;
    const m = CALLOUT.exec(probe.textContent);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    quote.classList.add('callout', `callout-${kind}`);
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.textContent = m[2] || kind.charAt(0).toUpperCase() + kind.slice(1);
    const rest = first.innerHTML.split('\n').slice(1).join('\n');
    if (rest.trim()) first.innerHTML = rest;
    else first.remove();
    quote.prepend(title);
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

export function renderInto(el, text) {
  const html = marked.parse(String(text || ''));
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
