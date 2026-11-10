// What changed between two versions of a text, word by word.

function tokens(text) {
  return String(text).match(/\s+|[^\s\w]|[\wÀ-ɏ]+/g) || [];
}

// Longest common subsequence over tokens, then a walk back to mark each token as kept,
// added or removed. Falls back to whole lines when a text is very long.
export function diffWords(before, after) {
  let a = tokens(before);
  let b = tokens(after);
  if (a.length * b.length > 9_000_000) {
    a = String(before).split(/(?<=\n)/);
    b = String(after).split(/(?<=\n)/);
  }
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out.at(-1);
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { push('removed', a[i]); i += 1; }
    else { push('added', b[j]); j += 1; }
  }
  while (i < n) { push('removed', a[i]); i += 1; }
  while (j < m) { push('added', b[j]); j += 1; }
  return coalesce(out);
}

// "old new old new" word by word is hard to read. Where changes are separated only by
// spaces, show them as one removed phrase followed by one added phrase.
function coalesce(parts) {
  const out = [];
  let k = 0;
  while (k < parts.length) {
    if (parts[k].type === 'same') { out.push(parts[k]); k += 1; continue; }
    let removed = '';
    let added = '';
    let end = k;
    while (end < parts.length) {
      const part = parts[end];
      if (part.type === 'removed') removed += part.text;
      else if (part.type === 'added') added += part.text;
      else if (/^[ \t]+$/.test(part.text) && end + 1 < parts.length && parts[end + 1].type !== 'same') {
        removed += part.text;
        added += part.text;
      } else break;
      end += 1;
    }
    if (removed) out.push({ type: 'removed', text: removed });
    if (added) out.push({ type: 'added', text: added });
    k = end;
  }
  return out;
}

export function renderDiff(before, after) {
  const el = document.createElement('div');
  el.className = 'diff';
  for (const part of diffWords(before, after)) {
    if (part.type === 'same') el.append(part.text);
    else {
      const span = document.createElement(part.type === 'added' ? 'ins' : 'del');
      span.textContent = part.text;
      el.append(span);
    }
  }
  return el;
}
