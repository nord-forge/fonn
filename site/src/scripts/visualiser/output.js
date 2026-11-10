// Card 3: the character meter and the line-by-line view of what the model
// receives, with removed and added lines marked.
import { alignLines } from './align.js';
import { elements } from './elements.js';
import { formatNumber, showControlCharacters } from './format.js';
import { later } from './timers.js';

const MAX_LINES = 2000;

// Each row fades in a little after the previous one, up to a cap.
const delayFor = (index) => `${Math.min(index * 6, 420)}ms`;

function lineElement(row, index, status) {
  const line = document.createElement('div');
  line.className = `line ${row.kind}`;
  if (row.kind !== 'kept' && status === 'observed') line.classList.add('would');
  line.style.setProperty('--d', delayFor(index));
  line.textContent = showControlCharacters(row.text) || ' ';

  if (row.kind === 'removed') line.setAttribute('aria-label', `removed: ${row.text}`);
  if (row.kind === 'added') line.setAttribute('aria-label', `${status === 'observed' ? 'would add' : 'added'}: ${row.text}`);
  return line;
}

// One summary row per run of removed lines, shown when "show removed" is off.
function runSummary(rows, index) {
  let count = 0;
  while (rows[index + count]?.kind === 'removed') count++;

  const summary = document.createElement('div');
  summary.className = 'line run-summary';
  summary.style.setProperty('--d', delayFor(index));
  summary.textContent = `${formatNumber(count)} ${count === 1 ? 'line' : 'lines'} removed`;
  return summary;
}

export function renderLines({ stdout, preview, status, delay }) {
  const rows = preview.decision.status === 'filtered'
    ? alignLines(stdout, preview.delivered)
    : alignLines(stdout, stdout);
  const shown = rows.slice(0, MAX_LINES);
  const fragment = document.createDocumentFragment();

  shown.forEach((row, index) => {
    const startsRemovedRun = row.kind === 'removed' && shown[index - 1]?.kind !== 'removed';
    if (startsRemovedRun && status === 'filtered') fragment.append(runSummary(shown, index));
    fragment.append(lineElement(row, index, status));
  });

  if (rows.length > MAX_LINES) {
    const more = document.createElement('div');
    more.className = 'line more';
    more.textContent = `${formatNumber(rows.length - MAX_LINES)} more lines not drawn`;
    fragment.append(more);
  }

  // "decided" reveals the removed and added styling, after the checks finish.
  elements.lines.classList.remove('decided');
  elements.lines.replaceChildren(fragment);
  if (delay) later(() => elements.lines.classList.add('decided'), delay);
  else elements.lines.classList.add('decided');
}

export function renderMeter(decision) {
  const original = decision.originalCharacters;
  const delivered = decision.deliveredCharacters;
  const share = Math.max(1, Math.round((delivered / Math.max(original, 1)) * 100));

  elements.charsIn.textContent = formatNumber(original);
  elements.charsOut.textContent = formatNumber(delivered);
  elements.barIn.style.width = '100%';
  elements.barOut.style.width = `${share}%`;
  elements.meterText.textContent = `${formatNumber(original)} characters in, ${formatNumber(delivered)} delivered.`;
}

// Phones start with removed lines collapsed: wrapped 80-column rows are hard
// to read there.
export function setupShowRemoved() {
  const { showRemoved, lines } = elements;
  showRemoved.checked = !window.matchMedia('(max-width: 719px)').matches;
  const apply = () => lines.classList.toggle('hide-removed', !showRemoved.checked);
  apply();
  showRemoved.addEventListener('change', apply);
}
