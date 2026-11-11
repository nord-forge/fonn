// A small line diff for showing a hook plan in the terminal.

/** Lines removed start with "-", added with "+", and one line of context with a space. */
export function compactDiff(before: string | null, after: string | null, context = 1): string {
  const a = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === null ? [] : after.replace(/\n$/, '').split('\n');
  if (before === '') a.length = 0;
  if (after === '') b.length = 0;
  // Configs are small. Past this size a full table costs too much, so show every line.
  if (a.length * b.length > 4_000_000) return [...a.map(line => '- ' + line), ...b.map(line => '+ ' + line)].join('\n');
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: Array<{ mark: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ mark: ' ', text: a[i]! }); i++; j++; }
    else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) { lines.push({ mark: '-', text: a[i]! }); i++; }
    else { lines.push({ mark: '+', text: b[j]! }); j++; }
  }
  const keep = lines.map((line, index) => line.mark !== ' ' || lines.slice(Math.max(0, index - context), index + context + 1).some(near => near.mark !== ' '));
  const output: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (keep[index]) { output.push(`${line.mark} ${line.text}`); skipped = false; }
    else if (!skipped) { output.push('  ...'); skipped = true; }
  });
  return output.join('\n');
}
