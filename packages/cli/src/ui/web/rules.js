import { send } from './api.js';
import { badge, button, el, empty, number, sourceLabel } from './components.js';
import { confirmAction, describeControls, field } from './forms.js';
import { openTest } from './test-context.js';

export const ruleExplanation = 'A rule removes lines that contain some text, for commands that start with a given command. Lines about errors, failures, warnings or security, such as vulnerabilities and deprecations, are always kept. Project rules only apply after you approve them. Originals stay recoverable.';

export function ruleErrors(rules) {
  const names = new Map();
  for (const rule of rules) names.set(rule.name.trim(), (names.get(rule.name.trim()) ?? 0) + 1);
  return rules.map((rule) => ({
    name: !rule.name.trim() || rule.name.trim().length > 60 ? 'Use a name of 1 to 60 characters.' : names.get(rule.name.trim()) > 1 ? 'Each rule needs a unique name in this file.' : '',
    command: !rule.command.trim() || rule.command.trim().length > 200 || /[\r\n\0]/.test(rule.command) ? 'Use one command line of 1 to 200 characters.' : '',
    remove: rule.remove.length < 1 || rule.remove.length > 20 ? 'Enter 1 to 20 texts, one per line.' : rule.remove.some((text) => text.length < 3 || text.length > 200 || /[\r\n\0]/.test(text)) ? 'Each line needs 3 to 200 characters. Remove empty lines.' : '',
  }));
}

export function rulesList(rules, sources = false) {
  if (!rules.length) return empty('No custom rules. Built-in filtering still follows the mode and level.');
  const list = el('ul', 'rules-list');
  for (const rule of rules) {
    const item = el('li', 'rule-summary');
    const heading = el('div', 'record-heading');
    heading.append(el('strong', '', rule.name));
    if (sources && rule.source) heading.append(badge(sourceLabel(rule.source)));
    item.append(heading, el('p', 'section-description', 'When the command starts with'), el('code', '', rule.command));
    const texts = el('ul');
    for (const text of rule.remove) texts.append(el('li', 'mono', text));
    item.append(el('p', 'section-description', 'Remove lines containing'), texts);
    list.append(item);
  }
  return list;
}

const SAMPLE_LINES = 400;

/**
 * The text Fonn suggests for a line you mark: its first stretch of words
 * without numbers, IDs or times, so "Waiting for database (attempt 3/10)"
 * becomes "Waiting for database (attempt". Rules match plain text, never
 * patterns, so one text covers every line that only differs in numbers.
 */
export function suggestText(line) {
  const clean = String(line).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
  const parts = clean.split(/\b[0-9a-f]*\d[0-9a-f]*\b|\d+/i).map((part) => part.trim().replace(/^[^\w(]+|[^\w)]+$/g, '').trim());
  // The first stretch with words, after any leading timestamp or counter.
  const best = parts.find((part) => part.length >= 3 && /[a-z]{2}/i.test(part));
  return (best ?? clean).slice(0, 200);
}

/** Lines of a sample, without the trailing empty line and without colour codes. */
export function sampleLines(text) {
  const lines = String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Paste what the command printed, click the lines to drop, and see what the
 * model would get. Clicking a line adds or removes its text in the rule.
 * The preview runs the real filter on the server, so lines Fonn always
 * keeps, such as errors and warnings, show as kept.
 */
function sampleBuilder(entry, root, changed) {
  const details = el('details', 'rule-sample');
  details.append(el('summary', '', 'Build from sample output'));
  const sample = field('Sample output', el('textarea'), 'Paste what the command printed. Then click each line the model does not need.');
  sample.input.rows = 6;
  sample.input.spellcheck = false;
  const summary = el('p', 'section-description sample-summary');
  summary.setAttribute('aria-live', 'polite');
  const list = el('ol', 'sample-lines');
  details.append(sample.node, summary, list);
  let lines = [];
  let kept = new Set();
  let short = false;
  let timer;
  let controller;
  const texts = () => entry.remove.input.value.split(/\r?\n/).filter((text) => text.trim());
  const covered = (line, all = texts()) => all.some((text) => line.includes(text));
  function setTexts(next) {
    entry.remove.input.value = next.join('\n');
    entry.remove.error();
    changed();
    refresh();
  }
  function toggle(line) {
    const all = texts();
    if (covered(line, all)) setTexts(all.filter((text) => !line.includes(text)));
    else if (all.length < 20) setTexts([...all, suggestText(line)]);
    else summary.textContent = 'A rule holds at most 20 texts. Remove one first.';
  }
  function draw() {
    const all = texts();
    list.replaceChildren();
    let removed = 0;
    let protectedCount = 0;
    lines.slice(0, SAMPLE_LINES).forEach((line, index) => {
      const item = el('li');
      const hit = line.trim() !== '' && covered(line, all);
      const stays = hit && kept.has(index);
      if (hit && !stays) removed++;
      if (stays) protectedCount++;
      const choice = el('button', `sample-line${hit ? (stays ? ' is-kept' : ' is-removed') : ''}`, line || ' ');
      choice.type = 'button';
      choice.setAttribute('aria-pressed', String(hit));
      choice.title = stays ? 'Fonn always keeps this line' : hit ? 'Removed. Click to keep it' : 'Click to remove lines like this';
      choice.disabled = line.trim() === '';
      choice.addEventListener('click', () => toggle(line));
      item.append(choice);
      if (stays) item.append(badge('Always kept', 'warn'));
      list.append(item);
    });
    if (!lines.length) summary.textContent = '';
    else {
      const parts = [`Removes ${number(removed)} of ${number(lines.length)} lines.`];
      if (protectedCount) parts.push(`${number(protectedCount)} ${protectedCount === 1 ? 'line stays because it reports' : 'lines stay because they report'} a problem.`);
      if (removed && short) parts.push('Fonn only shortens output over 2,000 characters, so output as short as this sample reaches the model unchanged.');
      if (lines.length > SAMPLE_LINES) parts.push(`Showing the first ${number(SAMPLE_LINES)}.`);
      summary.textContent = parts.join(' ');
    }
  }
  // Ask the real filter which marked lines stay. Debounced and cancelled, so typing stays quick.
  function refresh() {
    draw();
    clearTimeout(timer);
    controller?.abort();
    const all = texts();
    const command = entry.command.input.value.trim();
    if (!lines.length || !all.length || !command) { kept = new Set(); return; }
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const rule = { name: entry.name.input.value.trim() || 'Sample', command, remove: all.filter((text) => text.length >= 3).slice(0, 20) };
        if (!rule.remove.length) return;
        const result = await send('POST', 'filter/test', { command, stdout: lines.join('\n'), root, mode: 'filter', level: 'strict', rules: [rule], anySize: true }, { signal: controller.signal });
        const delivered = new Map();
        for (const line of result.delivered.split('\n')) delivered.set(line, (delivered.get(line) ?? 0) + 1);
        const next = new Set();
        for (const line of lines) {
          if (covered(line, all)) continue;
          const count = delivered.get(line);
          if (count) delivered.set(line, count - 1);
        }
        lines.forEach((line, index) => {
          if (!covered(line, all)) return;
          const count = delivered.get(line);
          if (count) { next.add(index); delivered.set(line, count - 1); }
        });
        kept = next;
        short = lines.join('\n').length < 2000;
        draw();
      } catch (error) {
        if (error.name !== 'AbortError') summary.textContent = 'The preview could not run. The rule still saves as usual.';
      }
    }, 250);
  }
  sample.input.addEventListener('input', () => { lines = sampleLines(sample.input.value); refresh(); });
  entry.remove.input.addEventListener('input', refresh);
  entry.command.input.addEventListener('input', refresh);
  return details;
}

// The caller owns the form and save action, so project settings and rules share one write.
export function rulesEditor(initial = [], { root, status, changed = () => {} } = {}) {
  const node = el('div', 'rules-editor');
  node.append(el('p', 'section-description', ruleExplanation));
  const list = el('div', 'rule-cards');
  const limit = el('p', 'field-error');
  limit.id = `rule-limit-${++editorSequence}`;
  limit.setAttribute('aria-live', 'polite');
  const entries = [];
  const add = button('Add rule', () => {
    if (entries.length >= 50) { limit.textContent = 'Use at most 50 rules per file.'; return; }
    const entry = append({ name: '', command: '', remove: [] });
    entry.name.input.focus();
    changed();
  }, 'secondary add-rule');
  add.setAttribute('aria-describedby', limit.id);
  function updateLimit() {
    add.disabled = entries.length >= 50;
    limit.textContent = entries.length >= 50 ? 'Use at most 50 rules per file. Delete a rule to add another.' : '';
  }
  function append(rule) {
    const card = el('section', 'rule-card');
    const heading = el('h4', '', 'Filter rule');
    const name = field('Name');
    const command = field('When the command starts with');
    command.input.placeholder = 'npm run dev';
    const remove = field('Remove lines containing', el('textarea'), 'One text per line.');
    remove.input.placeholder = 'Waiting for database';
    remove.input.rows = 4;
    name.input.value = rule.name;
    command.input.value = rule.command;
    remove.input.value = rule.remove.join('\n');
    const entry = { card, name, command, remove };
    const builder = sampleBuilder(entry, root, changed);
    if (!rule.remove.length) builder.open = true;
    const actions = el('div', 'form-actions');
    actions.append(button('Try this rule', () => {
      const value = readEntry(entry);
      const errors = ruleErrors([value])[0];
      for (const key of ['name', 'command', 'remove']) entry[key].error(errors[key]);
      if (Object.values(errors).some(Boolean)) card.querySelector('[aria-invalid="true"]')?.focus();
      else openTest(root, value);
    }), confirmAction('Delete rule', 'It leaves the list now. Nothing changes until you save the list.', async () => {
      entries.splice(entries.indexOf(entry), 1);
      card.remove();
      updateLimit();
      add.focus();
      changed();
    }, { title: 'Remove this rule?', confirmLabel: 'Remove' }));
    card.append(heading, name.node, command.node, builder, remove.node, actions);
    if (status) describeControls(card, status);
    card.addEventListener('input', () => {
      name.error(); command.error(); remove.error();
      changed();
    });
    entries.push(entry);
    list.append(card);
    updateLimit();
    return entry;
  }
  const readEntry = (entry) => ({ name: entry.name.input.value.trim(), command: entry.command.input.value.trim(), remove: entry.remove.input.value === '' ? [] : entry.remove.input.value.split(/\r?\n/) });
  const read = () => entries.map(readEntry);
  function validate() {
    const errors = ruleErrors(read());
    errors.forEach((error, index) => {
      for (const key of ['name', 'command', 'remove']) entries[index][key].error(error[key]);
    });
    const valid = entries.length <= 50 && errors.every((error) => !Object.values(error).some(Boolean));
    if (!valid) node.querySelector('[aria-invalid="true"]')?.focus();
    return valid;
  }
  node.append(list, limit);
  initial.forEach(append);
  // The caller puts Add rule next to its save button.
  return { node, read, validate, add };
}
let editorSequence = 0;
