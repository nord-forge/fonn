// Interactive filter visualiser. It runs the compiled core filter (copied into
// filter/ at build time) and maps the real decision onto the visible checks.
import { createOutputFilter } from './filter/index.js';
import { samples } from './samples.js';

const STAGES = [
  { id: 'mode', title: 'Filter mode' },
  { id: 'shape', title: 'Plain shell text' },
  { id: 'fresh', title: 'Not already filtered' },
  { id: 'size', title: 'At least 2,000 characters' },
  { id: 'format', title: 'Recognized format or repeated lines' },
  { id: 'reduce', title: 'Safe reduction exists' },
  { id: 'savings', title: 'Saves at least 256 characters' },
  { id: 'archive', title: 'Original archived' },
  { id: 'deliver', title: 'Delivered to the model' },
];
const STOP_AT = {
  disabled: 'mode', unsupported_response: 'shape', already_filtered: 'fresh', below_minimum_characters: 'size',
  unrecognized_format: 'format', no_safe_reduction: 'reduce', below_minimum_savings: 'savings', archive_or_parse_failed: 'archive',
};
const STEP_MS = 150;
const MAX_LINES = 2000;
const FALLBACK_ID = '3f6c1d2e-8a4b-4c1d-9e2f-5a6b7c8d9e0f';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const visible = (text) => text.replace(/\u001b/g, '␛').replace(/\r(?!\n)/g, '␍');

const root = $('visualiser');
const els = {
  samples: $('sample-list'), blurb: $('sample-blurb'), command: $('command'), stdout: $('stdout'),
  inputCount: $('input-count'), pipeline: $('pipeline'), verdict: $('verdict'), lines: $('lines'),
  showRemoved: $('show-removed'), barIn: $('bar-in'), barOut: $('bar-out'), charsIn: $('chars-in'), charsOut: $('chars-out'),
  meterText: $('meter-text'), archiveEmpty: $('archive-empty'), archiveBody: $('archive-body'), archiveId: $('archive-id'),
  offset: $('offset'), limit: $('limit'), offsetRange: $('offset-range'), recover: $('recover-cmd'), sliceInfo: $('slice-info'),
  slice: $('slice'), replay: $('replay'), live: $('live'),
};

let current = samples[0];
let edited = false;
let runCount = 0;
let archived;
const timers = new Set();

function later(fn, ms) {
  const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
  timers.add(timer);
}
function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

function buildSampleChips() {
  for (const sample of samples) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="sample" value="${sample.id}"><span></span>`;
    label.querySelector('span').textContent = sample.label;
    label.querySelector('input').checked = sample === current;
    els.samples.append(label);
  }
  els.samples.addEventListener('change', (event) => {
    current = samples.find((sample) => sample.id === event.target.value) ?? samples[0];
    loadSample();
  });
}

function buildPipeline() {
  els.pipeline.innerHTML = '<li class="packet" aria-hidden="true"></li>';
  for (const [index, stage] of STAGES.entries()) {
    const li = document.createElement('li');
    li.className = 'stage';
    li.dataset.stage = stage.id;
    li.dataset.state = 'pending';
    li.style.setProperty('--i', index);
    li.innerHTML = '<span class="stage-dot" aria-hidden="true"></span><div><span class="stage-title"></span><span class="stage-state sr-only"></span><span class="stage-detail"></span></div>';
    li.querySelector('.stage-title').textContent = stage.title;
    els.pipeline.append(li);
  }
}

function loadSample() {
  edited = false;
  els.command.value = current.command;
  els.stdout.value = current.stdout;
  els.blurb.textContent = current.blurb;
  run({ animate: true });
}

// Explanations for an unrecognized format. These only label the real
// decision for the reader; the decision itself comes from the filter.
function explainFormat(command, text, level) {
  if (/\u001b|\r(?!\n)/.test(text)) return 'Terminal colour codes or carriage returns. Left alone.';
  const none = level === 'strict' ? 'The strict level skips the generic reduction.' : level === 'similar' ? 'No identical or similar line runs either.' : 'No runs of identical lines either.';
  const trimmed = command.trim();
  if (/[\n\r;&|<>`$'"\\]/.test(trimmed)) return `Pipe, chaining or quote skips the format adapters. ${none}`;
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] === 'php') tokens.shift();
  if (['npx', 'pnpm', 'yarn'].includes(tokens[0])) tokens.shift();
  const tool = (tokens[0] ?? '').split('/').pop();
  const known = ['phpunit', 'pest', 'tsc'].includes(tool) || (tool === 'phpstan' && /^analy[sz]e$/.test(tokens[1] ?? '')) || (tool === 'artisan' && tokens[1] === 'test');
  if (!known) return `No adapter for this command. ${none}`;
  return `The tool's summary markers are missing. ${none}`;
}

function details(decision, mode, command, text, proposed, level) {
  const saved = proposed === undefined ? 0 : decision.originalCharacters - proposed.length;
  return {
    mode: [`mode is ${mode}, level ${level}`, 'mode is off. No reduction is attempted.'],
    shape: ['stdout text', 'Not plain stdout text.'],
    fresh: ['No earlier Fonn footer', 'Already carries a Fonn note.'],
    size: [`${fmt(decision.originalCharacters)} characters`, `Only ${fmt(decision.originalCharacters)} characters.`],
    format: [decision.adapter === 'repeated-lines' ? 'identical line runs found' : decision.adapter === 'similar-lines' ? 'similar line runs found' : `${decision.adapter ?? ''} adapter`, explainFormat(command, text, level)],
    reduce: [`${fmt(decision.removedLines)} lines removable`, 'Nothing safe to remove.'],
    savings: [`${fmt(saved)} characters saved, footer included`, 'The saving would not cover the footer.'],
    archive: [decision.artifactId ? `stored as ${decision.artifactId.slice(0, 8)}` : 'stored', 'Archiving failed, so the original is delivered.'],
  };
}

// Line alignment between original and delivered text. Filtering only removes
// lines and appends Fonn notes, so a single forward pass is enough.
function align(original, delivered) {
  const a = original.split('\n');
  const b = delivered.split('\n');
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const fonnNote = j < b.length && (b[j].startsWith('[fonn:') || (b[j] === '' && (b[j + 1] ?? '').startsWith('[fonn:') && a[i] !== ''));
    if (fonnNote) {
      // A similar-lines note states how many original lines it replaces.
      const omitted = /^\[fonn: similar lines omitted; (\d+) lines/.exec(b[j]);
      rows.push({ kind: 'added', text: b[j++] });
      for (let k = omitted ? Number(omitted[1]) : 0; k > 0 && i < a.length; k--) rows.push({ kind: 'removed', text: a[i++] });
    }
    else if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: 'kept', text: a[i] }); i++; j++; }
    else if (i < a.length) rows.push({ kind: 'removed', text: a[i++] });
    else rows.push({ kind: 'added', text: b[j++] });
  }
  while (rows.length && rows.at(-1).text === '') rows.pop();
  return rows;
}

async function filterOnce(mode, command, stdout, level) {
  let saved;
  const filter = createOutputFilter({
    mode, level,
    store: {
      save: async () => {
        saved = { id: globalThis.crypto?.randomUUID?.() ?? FALLBACK_ID, text: stdout };
        return { id: saved.id };
      },
    },
    recoveryHint: (id) => `Recover the original tool response with: fonn native-output <launch-id> ${id}`,
  });
  const { response, decision } = await filter.apply({
    toolName: 'Bash', toolInput: { command }, response: { stdout, stderr: '' }, sessionId: 'visualiser', toolUseId: 'visualiser',
  });
  return { delivered: response.stdout, decision, saved };
}

async function run({ animate }) {
  const id = ++runCount;
  const mode = root.querySelector('input[name="mode"]:checked')?.value ?? 'filter';
  const command = els.command.value;
  const stdout = els.stdout.value;
  const level = root.querySelector('input[name="level"]:checked')?.value ?? 'standard';
  const result = await filterOnce(mode, command, stdout, level);
  // Observe mode delivers the original. Run filter mode as well so the page can
  // show what observe recorded as a potential reduction.
  const preview = mode === 'observe' && result.decision.status === 'observed' ? await filterOnce('filter', command, stdout, level) : result;
  if (id !== runCount) return;
  clearTimers();
  render({ mode, command, stdout, result, preview, level, animate: animate && !reduceMotion.matches });
}

function render({ mode, command, stdout, result, preview, level, animate }) {
  const { decision } = result;
  const stopId = STOP_AT[decision.reason];
  const stopIndex = stopId ? STAGES.findIndex((stage) => stage.id === stopId) : STAGES.length - 1;
  const proposed = preview.decision.status === 'filtered' ? preview.delivered : undefined;
  const text = details(decision, mode, command, stdout, proposed, level);

  els.inputCount.textContent = `${fmt(stdout.length)} chars`;
  root.classList.toggle('is-animated', animate);
  root.dataset.outcome = decision.status;

  const stages = [...els.pipeline.querySelectorAll('.stage')];
  for (const [index, li] of stages.entries()) {
    const stage = STAGES[index];
    let state = 'skip';
    let detail = 'Not reached';
    if (stage.id === 'deliver') {
      state = 'pass';
      detail = decision.status === 'filtered' ? 'Shortened text plus recovery footer'
        : decision.status === 'observed' ? 'Full output. Observe mode only records the reduction'
          : 'Original output, unchanged';
    } else if (index < stopIndex || (!stopId && index < STAGES.length - 1)) {
      state = 'pass';
      detail = text[stage.id][0];
    } else if (index === stopIndex) {
      state = 'stop';
      detail = text[stage.id][1];
    }
    li.dataset.state = 'pending';
    li.querySelector('.stage-detail').textContent = detail;
    li.querySelector('.stage-state').textContent = state === 'pass' ? 'passed.' : state === 'stop' ? 'stopped here.' : 'skipped.';
    const apply = () => { li.dataset.state = state; };
    if (animate) later(apply, 60 + index * STEP_MS); else apply();
  }

  const packet = els.pipeline.querySelector('.packet');
  const target = stages[stopId ? stopIndex : stages.length - 1];
  packet.style.transitionDuration = animate ? `${(stopIndex + 1) * STEP_MS}ms` : '0ms';
  packet.style.transform = 'translateY(0)';
  packet.dataset.outcome = stopId ? 'stop' : 'pass';
  const move = () => {
    const dot = target.querySelector('.stage-dot').getBoundingClientRect();
    const top = dot.top - els.pipeline.getBoundingClientRect().top + dot.height / 2 - 6;
    packet.style.transform = `translateY(${top}px)`;
  };
  if (animate) { void packet.offsetHeight; later(move, 30); } else move();

  const verdict = decision.status === 'filtered' ? 'Filtered' : decision.status === 'observed' ? 'Observed' : 'Unchanged';
  els.verdict.textContent = verdict;
  els.verdict.dataset.outcome = decision.status;

  renderLines(stdout, preview, decision.status, animate ? 60 + stopIndex * STEP_MS : 0);

  const delivered = decision.deliveredCharacters;
  const original = Math.max(decision.originalCharacters, 1);
  els.charsIn.textContent = fmt(decision.originalCharacters);
  els.charsOut.textContent = fmt(delivered);
  els.barIn.style.width = '100%';
  els.barOut.style.width = `${Math.max(1, Math.round((delivered / original) * 100))}%`;
  els.meterText.textContent = `${fmt(decision.originalCharacters)} characters in, ${fmt(delivered)} delivered.`;

  archived = result.saved && decision.artifactId ? result.saved : undefined;
  renderArchive();

  const name = edited ? 'Edited input' : `${current.label} sample`;
  const removed = preview.decision.status === 'filtered' ? preview.decision.removedLines : 0;
  const summary = decision.status === 'filtered' ? `${fmt(removed)} lines removed.`
    : decision.status === 'observed' ? `${fmt(removed)} lines would be removed. Full output delivered.`
      : `Stopped at ${STAGES[stopIndex].title.toLowerCase()}.`;
  els.live.textContent = `${name}: ${verdict.toLowerCase()}. ${summary}`;
}

function renderLines(stdout, preview, status, delay) {
  const rows = preview.decision.status === 'filtered' ? align(stdout, preview.delivered) : align(stdout, stdout);
  const shown = rows.slice(0, MAX_LINES);
  const fragment = document.createDocumentFragment();
  for (const [index, row] of shown.entries()) {
    // Each run of removed lines gets one summary row, shown when "show removed" is off.
    if (row.kind === 'removed' && shown[index - 1]?.kind !== 'removed' && status === 'filtered') {
      let count = 0;
      while (shown[index + count]?.kind === 'removed') count++;
      const summary = document.createElement('div');
      summary.className = 'line run-summary';
      summary.style.setProperty('--d', `${Math.min(index * 6, 420)}ms`);
      summary.textContent = `${fmt(count)} ${count === 1 ? 'line' : 'lines'} removed`;
      fragment.append(summary);
    }
    const line = document.createElement('div');
    line.className = `line ${row.kind}`;
    if (row.kind !== 'kept' && status === 'observed') line.classList.add('would');
    line.style.setProperty('--d', `${Math.min(index * 6, 420)}ms`);
    line.textContent = visible(row.text) || ' ';
    if (row.kind === 'removed') line.setAttribute('aria-label', `removed: ${row.text}`);
    if (row.kind === 'added') line.setAttribute('aria-label', `${status === 'observed' ? 'would add' : 'added'}: ${row.text}`);
    fragment.append(line);
  }
  if (rows.length > MAX_LINES) {
    const more = document.createElement('div');
    more.className = 'line more';
    more.textContent = `${fmt(rows.length - MAX_LINES)} more lines not drawn`;
    fragment.append(more);
  }
  els.lines.classList.remove('decided');
  els.lines.replaceChildren(fragment);
  if (delay) later(() => els.lines.classList.add('decided'), delay); else els.lines.classList.add('decided');
}

function renderArchive() {
  els.archiveEmpty.hidden = Boolean(archived);
  els.archiveBody.hidden = !archived;
  els.archiveId.textContent = archived ? archived.id : '';
  if (!archived) return;
  const length = archived.text.length;
  const limit = Math.min(20000, Math.max(1, Number.parseInt(els.limit.value, 10) || 4000));
  const offset = Math.min(Math.max(0, Number.parseInt(els.offset.value, 10) || 0), Math.max(0, length - 1));
  els.offsetRange.max = String(Math.max(0, length - 1));
  els.offsetRange.value = String(offset);
  if (String(offset) !== els.offset.value) els.offset.value = String(offset);
  const end = Math.min(length, offset + limit);
  els.recover.textContent = `fonn native-output <launch-id> ${archived.id} --offset ${offset} --limit ${limit}`;
  els.sliceInfo.textContent = `Characters ${fmt(offset)} to ${fmt(end)} of ${fmt(length)}. ${end < length ? `Next offset: ${end}.` : 'End of the original.'} Requests return at most 20,000 characters.`;
  els.slice.textContent = visible(archived.text.slice(offset, end));
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// Keeps the sticky offsets in step with the real top bar and controls heights,
// and marks the controls as stuck so they can show a shadow.
function setupStickyControls() {
  const controls = root.querySelector('.viz-controls');
  const topbar = document.querySelector('.topbar');
  const style = document.documentElement.style;
  let observer;
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  controls.before(sentinel);
  const measure = () => {
    const topbarHeight = Math.round(topbar.getBoundingClientRect().height);
    style.setProperty('--topbar-height', `${topbarHeight}px`);
    style.setProperty('--controls-height', `${Math.round(controls.getBoundingClientRect().height)}px`);
    observer?.disconnect();
    observer = new IntersectionObserver(([entry]) => {
      controls.classList.toggle('is-stuck', !entry.isIntersecting && entry.boundingClientRect.top < topbarHeight);
    }, { rootMargin: `-${topbarHeight + 1}px 0px 0px 0px` });
    observer.observe(sentinel);
  };
  new ResizeObserver(measure).observe(controls);
  new ResizeObserver(measure).observe(topbar);
  measure();
}

function start() {
  buildSampleChips();
  buildPipeline();
  root.hidden = false;
  setupStickyControls();
  const rerun = debounce(() => run({ animate: false }), 220);
  const onEdit = () => {
    edited = true;
    els.blurb.textContent = 'Edited input. Pick a sample to reset it.';
    rerun();
  };
  els.command.addEventListener('input', onEdit);
  els.stdout.addEventListener('input', onEdit);
  root.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => run({ animate: true })));
  els.replay.addEventListener('click', () => run({ animate: true }));
  root.querySelectorAll('input[name="level"]').forEach((input) => input.addEventListener('change', () => run({ animate: true })));
  // Phones start with removed lines collapsed: wrapped 80-column rows are hard to read there.
  els.showRemoved.checked = !window.matchMedia('(max-width: 719px)').matches;
  const applyShowRemoved = () => els.lines.classList.toggle('hide-removed', !els.showRemoved.checked);
  applyShowRemoved();
  els.showRemoved.addEventListener('change', applyShowRemoved);
  els.offset.addEventListener('input', renderArchive);
  els.limit.addEventListener('input', renderArchive);
  els.offsetRange.addEventListener('input', () => { els.offset.value = els.offsetRange.value; renderArchive(); });
  loadSample();
}

try {
  start();
} catch (error) {
  root.hidden = false;
  root.innerHTML = '<p class="note">The visualiser could not start in this browser. The checks are described below.</p>';
  console.error(error);
}
