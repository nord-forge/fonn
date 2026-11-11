// Fades the edges of rows that scroll sideways, but only the edges with more
// content beyond them. Each row gets data-fade-start and data-fade-end, which
// styles/theme.css turns into a mask. Rows that fit get no fade at all.
//
// Covers Starlight's tab bars and the visualiser's sample and option rows.

const SELECTOR = '.tablist-wrapper, .viz-options';
const EDGE = 2;

function update(row) {
  const max = row.scrollWidth - row.clientWidth;
  row.dataset.fadeStart = String(row.scrollLeft > EDGE);
  row.dataset.fadeEnd = String(row.scrollLeft < max - EDGE);
}

function updateAll() {
  document.querySelectorAll(SELECTOR).forEach(update);
}

function watch(row) {
  if (row.dataset.fadeWatched) return;
  row.dataset.fadeWatched = 'true';
  row.addEventListener('scroll', () => update(row), { passive: true });
  // Content can change after load, for example when the visualiser adds its sample buttons.
  new ResizeObserver(() => update(row)).observe(row);
  new MutationObserver(() => update(row)).observe(row, { childList: true, subtree: true });
  update(row);
}

function setup() {
  document.querySelectorAll(SELECTOR).forEach(watch);
}

setup();
window.addEventListener('load', () => {
  setup();
  updateAll();
});
window.addEventListener('resize', updateAll, { passive: true });
