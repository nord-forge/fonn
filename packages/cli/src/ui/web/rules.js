import { badge, button, el, empty, sourceLabel } from './components.js';
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
  });
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
    const actions = el('div', 'form-actions');
    actions.append(button('Try this rule', () => {
      const value = readEntry(entry);
      const errors = ruleErrors([value])[0];
      for (const key of ['name', 'command', 'remove']) entry[key].error(errors[key]);
      if (Object.values(errors).some(Boolean)) card.querySelector('[aria-invalid="true"]')?.focus();
      else openTest(root, value);
    }), confirmAction('Delete rule', 'Remove this rule from the draft? Save the list to apply the change.', async () => {
      entries.splice(entries.indexOf(entry), 1);
      card.remove();
      updateLimit();
      add.focus();
      changed();
    }));
    card.append(heading, name.node, command.node, remove.node, actions);
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
  node.append(list, add, limit);
  initial.forEach(append);
  return { node, read, validate };
}
let editorSequence = 0;
