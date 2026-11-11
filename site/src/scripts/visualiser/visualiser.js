// Entry point for the interactive filter visualiser on how-it-works.html.
//
// Each run sends the observation through the real compiled filter, then
// updates four cards: the observation, the checks, what the model receives,
// and the archive. In observe mode the filter delivers the original, so a
// second run in filter mode shows what observe recorded as a reduction.
import { setArchived, setupArchiveControls } from './archive.js';
import { elements, root, selectedValue } from './elements.js';
import { runFilter } from './filter.js';
import { debounce, formatNumber } from './format.js';
import { renderLines, renderMeter, setupShowRemoved } from './output.js';
import { buildPipeline, renderPipeline, STEP_MS } from './pipeline.js';
import { samples } from './samples.js';
import { STAGES } from './stages.js';
import { setupStickyControls } from './sticky.js';
import { cancelAll } from './timers.js';

const EDIT_DELAY_MS = 220;
const VERDICTS = { filtered: 'Filtered', observed: 'Observed', unchanged: 'Unchanged' };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let currentSample = samples[0];
let edited = false;
let runCount = 0;

// The sample picker is a listbox in the site's dropdown style, like the theme
// switcher. Enter, Space or the arrows open it; arrows, Home and End move,
// Enter or Space picks, Escape closes and Tab leaves. A click outside closes it.
function buildSampleSelect() {
  const { samples: menu, sampleButton: button, sampleCurrent: current } = elements;
  const check = '<svg class="theme-select-check" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5 6.4 12 13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  const options = samples.map((sample, index) => {
    const option = document.createElement('li');
    option.id = `sample-option-${index}`;
    option.setAttribute('role', 'option');
    option.dataset.value = sample.id;
    option.innerHTML = `<span aria-hidden="true"></span><span></span>${check}`;
    option.children[1].textContent = sample.label;
    menu.append(option);
    return option;
  });
  let active = 0;
  const isOpen = () => !menu.hidden;
  function show() {
    current.textContent = currentSample.label;
    options.forEach((option) => option.setAttribute('aria-selected', String(option.dataset.value === currentSample.id)));
  }
  function highlight(index) {
    active = index;
    options.forEach((option, position) => option.classList.toggle('is-active', position === index));
    menu.setAttribute('aria-activedescendant', options[index].id);
    options[index].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    highlight(Math.max(0, samples.indexOf(currentSample)));
    menu.focus();
  }
  function close(returnFocus = true) {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    menu.removeAttribute('aria-activedescendant');
    if (returnFocus) button.focus();
  }
  function choose(id) {
    const next = samples.find((sample) => sample.id === id) ?? samples[0];
    close();
    if (next === currentSample) return;
    currentSample = next;
    show();
    loadSample();
  }
  button.addEventListener('click', () => (isOpen() ? close() : open()));
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
  });
  menu.addEventListener('keydown', (event) => {
    const last = options.length - 1;
    const moves = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last };
    if (event.key in moves) { event.preventDefault(); highlight(moves[event.key]); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(options[active].dataset.value); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(false);
  });
  menu.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) choose(option.dataset.value);
  });
  menu.addEventListener('mousemove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) highlight(options.indexOf(option));
  });
  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && !button.parentElement.contains(event.target)) close(false);
  });
  show();
}

function loadSample() {
  edited = false;
  elements.command.value = currentSample.command;
  elements.stdout.value = currentSample.stdout;
  elements.blurb.textContent = currentSample.blurb;
  run({ animate: true });
}

function announceResult(status, stop, removedLines) {
  const name = edited ? 'Edited input' : `${currentSample.label} sample`;
  let summary = `Stopped at ${STAGES[stop.index].title.toLowerCase()}.`;
  if (status === 'filtered') summary = `${formatNumber(removedLines)} lines removed.`;
  if (status === 'observed') summary = `${formatNumber(removedLines)} lines would be removed. Full output delivered.`;
  elements.live.textContent = `${name}: ${VERDICTS[status].toLowerCase()}. ${summary}`;
}

function render({ input, result, preview, animate }) {
  const { decision } = result;
  root.classList.toggle('is-animated', animate);
  root.dataset.outcome = decision.status;
  elements.inputCount.textContent = `${formatNumber(input.stdout.length)} chars`;
  elements.verdict.textContent = VERDICTS[decision.status];
  elements.verdict.dataset.outcome = decision.status;

  const stop = renderPipeline({ ...input, result, preview, animate });
  renderLines({
    stdout: input.stdout,
    preview,
    status: decision.status,
    delay: animate ? 60 + stop.index * STEP_MS : 0,
  });
  renderMeter(decision);
  setArchived(decision.artifactId ? result.archived : undefined);

  const removedLines = preview.decision.status === 'filtered' ? preview.decision.removedLines : 0;
  announceResult(decision.status, stop, removedLines);
}

async function run({ animate }) {
  const id = ++runCount;
  const input = {
    mode: selectedValue('mode', 'filter'),
    level: selectedValue('level', 'standard'),
    command: elements.command.value,
    stdout: elements.stdout.value,
  };

  const result = await runFilter(input);
  const preview = input.mode === 'observe' && result.decision.status === 'observed'
    ? await runFilter({ ...input, mode: 'filter' })
    : result;

  // A newer run started while this one was waiting; let that one render.
  if (id !== runCount) return;
  cancelAll();
  render({ input, result, preview, animate: animate && !reducedMotion.matches });
}

function setupEditing() {
  const rerun = debounce(() => run({ animate: false }), EDIT_DELAY_MS);
  const onEdit = () => {
    edited = true;
    elements.blurb.textContent = 'Edited input. Pick a sample to reset it.';
    rerun();
  };
  elements.command.addEventListener('input', onEdit);
  elements.stdout.addEventListener('input', onEdit);
}

function setupRunControls() {
  for (const input of root.querySelectorAll('input[name="mode"], input[name="level"]')) {
    input.addEventListener('change', () => run({ animate: true }));
  }
  elements.replay.addEventListener('click', () => run({ animate: true }));
}

function start() {
  buildSampleSelect();
  buildPipeline();
  root.hidden = false;
  setupStickyControls();
  setupEditing();
  setupRunControls();
  setupShowRemoved();
  setupArchiveControls();
  loadSample();
}

try {
  start();
} catch (error) {
  root.hidden = false;
  root.innerHTML = '<p class="note">The visualiser could not start in this browser. The checks are described below.</p>';
  console.error(error);
}
