// A bounded line diff. Large replacements use a linear fallback.
export function hookDiff(before, after) {
  const lines = (text) => text === null || text === '' ? [] : text.split('\n');
  const left = lines(before);
  const right = lines(after);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  if (start === left.length && start === right.length) return [];
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
  const a = left.slice(start, left.length - end);
  const b = right.slice(start, right.length - end);
  const diff = left.slice(Math.max(0, start - 2), start).map((text) => ({ kind: 'context', text }));
  if ((a.length + 1) * (b.length + 1) <= 250_000) {
    const widths = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * widths);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * widths + j] = a[i] === b[j]
          ? 1 + lengths[(i + 1) * widths + j + 1]
          : Math.max(lengths[(i + 1) * widths + j], lengths[i * widths + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        diff.push({ kind: 'context', text: a[i++] });
        j++;
      } else if (i < a.length && (j === b.length || lengths[(i + 1) * widths + j] >= lengths[i * widths + j + 1])) {
        diff.push({ kind: 'removed', text: a[i++] });
      } else diff.push({ kind: 'added', text: b[j++] });
    }
  } else {
    for (const text of a) diff.push({ kind: 'removed', text });
    for (const text of b) diff.push({ kind: 'added', text });
  }
  diff.push(...left.slice(left.length - end, left.length - end + Math.min(2, end)).map((text) => ({ kind: 'context', text })));
  // Keep only a little context between separate changes, and mark each
  // place where lines were left out, so two changes never look adjacent.
  const kept = [];
  let skipped = false;
  diff.forEach((line, index) => {
    const near = line.kind !== 'context' || diff.slice(Math.max(0, index - 2), index + 3).some((nearby) => nearby.kind !== 'context');
    if (!near) { skipped = true; return; }
    if (skipped && kept.length) kept.push({ kind: 'gap', text: '…' });
    skipped = false;
    kept.push(line);
  });
  return kept;
}
