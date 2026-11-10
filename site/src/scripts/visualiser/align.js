// Lines up the original output with what the model receives, row by row, so
// the output pane can mark kept, removed and added lines.
//
// Filtering only removes lines and adds Fonn notes, so one forward pass is
// enough. A similar-lines note states how many original lines it replaces,
// which keeps the alignment right even when the kept last line also appears
// earlier in the run.

const SIMILAR_NOTE = /^\[fonn: similar lines omitted; (\d+) lines/;

function isFonnNote(delivered, index, originalLine) {
  const line = delivered[index];
  if (line === undefined) return false;
  if (line.startsWith('[fonn:')) return true;
  // The recovery footer is preceded by an empty line of its own.
  return line === '' && (delivered[index + 1] ?? '').startsWith('[fonn:') && originalLine !== '';
}

export function alignLines(original, delivered) {
  const a = original.split('\n');
  const b = delivered.split('\n');
  const rows = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (isFonnNote(b, j, a[i])) {
      const omitted = SIMILAR_NOTE.exec(b[j]);
      rows.push({ kind: 'added', text: b[j++] });
      for (let remaining = omitted ? Number(omitted[1]) : 0; remaining > 0 && i < a.length; remaining--) {
        rows.push({ kind: 'removed', text: a[i++] });
      }
    } else if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: 'kept', text: a[i] });
      i++;
      j++;
    } else if (i < a.length) {
      rows.push({ kind: 'removed', text: a[i++] });
    } else {
      rows.push({ kind: 'added', text: b[j++] });
    }
  }

  // Trailing empty rows add nothing to the picture.
  while (rows.length && rows.at(-1).text === '') rows.pop();
  return rows;
}
