// Card 4: the archived original and the bounded recovery slice.
import { elements } from './elements.js';
import { formatNumber, showControlCharacters } from './format.js';

const DEFAULT_LIMIT = 4000;
const MAX_LIMIT = 20000;

let archived;

function readNumber(input, fallback) {
  return Number.parseInt(input.value, 10) || fallback;
}

export function renderArchive() {
  elements.archiveEmpty.hidden = Boolean(archived);
  elements.archiveBody.hidden = !archived;
  elements.archiveId.textContent = archived ? archived.id : '';
  if (!archived) return;

  const length = archived.text.length;
  const lastOffset = Math.max(0, length - 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, readNumber(elements.limit, DEFAULT_LIMIT)));
  const offset = Math.min(Math.max(0, readNumber(elements.offset, 0)), lastOffset);
  const end = Math.min(length, offset + limit);

  elements.offsetRange.max = String(lastOffset);
  elements.offsetRange.value = String(offset);
  if (String(offset) !== elements.offset.value) elements.offset.value = String(offset);

  const next = end < length ? `Next offset: ${end}.` : 'End of the original.';
  elements.recoverCommand.textContent = `fonn native-output <launch-id> ${archived.id} --offset ${offset} --limit ${limit}`;
  elements.sliceInfo.textContent = `Characters ${formatNumber(offset)} to ${formatNumber(end)} of ${formatNumber(length)}. ${next} Requests return at most 20,000 characters.`;
  elements.slice.textContent = showControlCharacters(archived.text.slice(offset, end));
}

// Called after each filter run with the archived original, if there is one.
export function setArchived(value) {
  archived = value;
  renderArchive();
}

export function setupArchiveControls() {
  elements.offset.addEventListener('input', renderArchive);
  elements.limit.addEventListener('input', renderArchive);
  elements.offsetRange.addEventListener('input', () => {
    elements.offset.value = elements.offsetRange.value;
    renderArchive();
  });
}
