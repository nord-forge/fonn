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

function buildSampleChips() {
  for (const sample of samples) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="sample" value="${sample.id}"><span></span>`;
    label.querySelector('span').textContent = sample.label;
    label.querySelector('input').checked = sample === currentSample;
    elements.samples.append(label);
  }

  elements.samples.addEventListener('change', (event) => {
    currentSample = samples.find((sample) => sample.id === event.target.value) ?? samples[0];
    loadSample();
  });
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
  buildSampleChips();
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
