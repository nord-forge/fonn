import { get, send } from '../api.js';
import { activitySections } from './activity.js';
import { badge, button, card, code, el, empty, link, loadSection, number, pageHeader, settingKeys, sourceLabel, totals, warning } from '../components.js';

import { describeControls, explanations, feedback, field, saving, select as select_, settingValues } from '../forms.js';
import { rulesEditor, rulesList } from '../rules.js';
import { testRoute } from '../test-context.js';

function instructionFiles(project, signal) {
  const section = card('Instruction files', 'Read the instructions in this project.');
  const list = el('ul', 'file-list');
  const panel = el('section', 'reader-panel');
  panel.id = 'instruction-reader';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Instruction file contents');
  let request = 0;
  let activeButton;

  function close() {
    request += 1;
    panel.hidden = true;
    panel.replaceChildren();
    if (activeButton) {
      activeButton.setAttribute('aria-expanded', 'false');
      activeButton.focus();
    }
  }

  async function open(file, trigger) {
    const current = ++request;
    if (activeButton) activeButton.setAttribute('aria-expanded', 'false');
    activeButton = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    const heading = el('h3', 'mono', file.name);
    heading.tabIndex = -1;
    const header = el('div', 'reader-heading');
    header.append(heading, button('Close', close));
    const content = el('div');
    panel.replaceChildren(header, content);
    heading.focus();
    await loadSection(content, async () => {
      const data = await get('project/instructions', { query: { root: project.root, name: file.name }, signal });
      if (current !== request || signal.aborted) return;
      if (data.truncated) content.append(warning('Truncated. This panel shows the first part of the file.'));
      content.append(data.text ? code(data.text) : empty('This file is empty.'));
    }, signal);
  }

  for (const file of project.instructions) {
    const item = el('li', 'file-item');
    const label = el('div');
    label.append(el('span', 'mono file-name', file.name));
    label.append(el('span', 'muted file-size', file.exists ? `${number(file.bytes)} bytes` : 'Not present'));
    item.append(label);
    if (file.exists) {
      const trigger = button('Open file', () => open(file, trigger));
      trigger.setAttribute('aria-label', `Open ${file.name}`);
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', panel.id);
      item.append(trigger);
    }
    list.append(item);
  }
  section.append(project.instructions.length ? list : empty('No instruction files found.'), panel);
  return section;
}

const LABELS = { profile: 'Profile', filterLevel: 'Filter level', filterMode: 'Filter mode', subagents: 'Subagents' };
const SCOPES = [['local', 'Personal', 'Just for you, in .fonn/settings.local.json.'], ['shared', 'Shared', 'For everyone, in .fonn.json. Commit it with the project.']];
const TABS = [['overview', 'Overview'], ['settings', 'Settings'], ['rules', 'Rules'], ['instructions', 'Instructions'], ['activity', 'Activity']];

/** Personal or shared: which file the editors write. */
function scopeSwitch(scope, onChange) {
  const group = el('fieldset', 'choice-group scope-switch');
  group.append(el('legend', '', 'Save to'));
  for (const [key, label] of SCOPES) {
    const option = el('label', 'choice');
    const input = el('input');
    input.type = 'radio';
    input.name = `scope-${Math.random().toString(36).slice(2, 7)}`;
    input.value = key;
    input.checked = key === scope;
    input.addEventListener('change', () => onChange(key));
    option.append(input, label);
    group.append(option);
  }
  return group;
}

function fileNote(file, scope) {
  const note = el('div', 'file-note');
  const description = el('p', 'section-description', SCOPES.find(([key]) => key === scope)[2]);
  description.title = file.path;
  note.append(description);
  if (file.error) note.append(warning(`${file.error} Fix this file on disk before editing it here.`));
  return note;
}

export async function projectView(target, signal, root) {
  target.append(pageHeader('Projects', 'Project', root));
  const content = el('div');
  target.append(content);
  await loadSection(content, async () => {
    let [project, profiles] = await Promise.all([get('project', { query: { root }, signal }), get('profiles', { signal })]);
    if (signal.aborted) return;
    const header = pageHeader('Projects', project.name, project.root);
    const where = header.querySelector('.page-description');
    where.classList.add('path', 'one-line-path');
    where.title = project.root;
    // The bidi marks keep a right-to-left ellipsis from moving the leading slash.
    where.textContent = `\u200e${project.root}\u200e`;
    target.querySelector('.page-header').replaceWith(header);
    document.title = `Fonn · ${project.name}`;

    let scope = 'local';
    const initialTab = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab');
    let tab = TABS.some(([key]) => key === initialTab) ? initialTab : 'overview';
    const alert = el('div');
    const notice = feedback();
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Project sections');
    const panel = el('section', 'tab-panel');
    panel.id = 'project-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.tabIndex = 0;
    const tabButtons = TABS.map(([key, label]) => {
      const tabButton = button(label, () => select(key, true), 'tab');
      tabButton.id = `project-tab-${key}`;
      tabButton.setAttribute('role', 'tab');
      tabButton.setAttribute('aria-controls', panel.id);
      tabs.append(tabButton);
      return tabButton;
    });
    // Arrow keys move between tabs, as in the ARIA tabs pattern.
    tabs.addEventListener('keydown', (event) => {
      const index = TABS.findIndex(([key]) => key === tab);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const wrapped = (next + TABS.length) % TABS.length;
      select(TABS[wrapped][0], true);
      tabButtons[wrapped].focus();
    });
    content.append(alert, tabs, notice.node, panel);

    function select(key, user = false) {
      tab = key;
      tabButtons.forEach((tabButton, index) => {
        const selected = TABS[index][0] === key;
        tabButton.setAttribute('aria-selected', String(selected));
        tabButton.tabIndex = selected ? 0 : -1;
      });
      panel.setAttribute('aria-labelledby', `project-tab-${key}`);
      // Keep the tab in the address without a new navigation.
      if (user) history.replaceState(null, '', `${window.location.pathname}${window.location.search}${window.location.hash.split('?')[0]}?tab=${key}`);
      render();
    }

    function update(updated, message = '') {
      project = updated;
      renderAlert();
      render();
      notice.show(updated.warning ?? message);
      notice.node.classList.toggle('notice', Boolean(updated.warning));
      notice.node.classList.toggle('warning', Boolean(updated.warning));
    }

    function renderAlert() {
      const pending = project.effective?.unapprovedRules ?? [];
      if (!pending.length) return alert.replaceChildren();
      const box = el('div', 'notice warning project-alert');
      box.append(el('p', '', `${pending.length === 1 ? 'A rule from the project files is' : `${pending.length} rules from the project files are`} waiting for your approval and not applied yet.`));
      box.append(button('Review rules', () => { select('rules', true); tabButtons[2].focus(); }));
      alert.replaceChildren(box);
    }

    function render() {
      const views = { overview, settings, rules, instructions: () => [instructionFiles(project, signal)], activity };
      panel.replaceChildren(...views[tab]());
    }

    function overview() {
      const summary = card('How Fonn runs here', 'What a new launch in this project uses, and where each value comes from.');
      if (!project.effective) {
        summary.append(warning('A settings file is invalid, so Fonn cannot tell what a launch would use. Open Settings to see which one.'));
        return [summary];
      }
      const grid = el('dl', 'summary-grid');
      for (const key of settingKeys) {
        const item = el('div', 'summary-item');
        const value = el('dd');
        value.append(el('span', 'summary-value', project.effective[key].value), badge(sourceLabel(project.effective[key].source)));
        item.append(el('dt', '', LABELS[key]), value);
        grid.append(item);
      }
      const applied = project.effective.rules.length;
      const pending = project.effective.unapprovedRules.length;
      const rulesLine = el('p', 'summary-line');
      rulesLine.append(`${applied === 0 ? 'No filter rules apply' : `${applied} filter ${applied === 1 ? 'rule applies' : 'rules apply'}`}${pending ? `, ${pending} waiting for approval` : ''}. `);
      rulesLine.append(button('Manage rules', () => { select('rules', true); tabButtons[2].focus(); }, 'link-button'));
      const saved = project.totals.originalCharacters - project.totals.deliveredCharacters;
      const metrics = el('dl', 'summary-metrics');
      for (const [label, value] of [['Characters saved', saved], ['Lines removed', project.totals.removedLines], ['Commands filtered', project.totals.filtered]]) {
        const item = el('div');
        item.append(el('dt', '', label), el('dd', '', number(value)));
        metrics.append(item);
      }
      const actions = el('div', 'form-actions');
      actions.append(button('Change settings', () => { select('settings', true); tabButtons[1].focus(); }, 'primary'), link('Try the filter on this project', testRoute(project.root), 'section-link'));
      summary.append(grid, rulesLine, metrics, el('p', 'field-hint', 'Characters, not tokens or cost.'), actions);
      return [summary];
    }

    function settings() {
      const file = project[scope];
      const section = card('Settings', 'Choose a value to override it for this project. Not set keeps the value from your global settings or Fonn\'s default.');
      section.append(scopeSwitch(scope, (next) => { scope = next; render(); }), fileNote(file, scope));
      if (file.error) return [section];
      const form = el('form', 'settings-form');
      const status = feedback();
      const inputs = {};
      for (const key of settingKeys) {
        const row = el('div', 'setting-line');
        const input = select_(key === 'profile' ? profiles.profiles.map((profile) => profile.name) : settingValues[key], file.settings[key] ?? '', 'Not set');
        const control = field(LABELS[key], input, explanations[key]);
        const now = project.effective?.[key];
        if (now) {
          const current = el('p', 'setting-now');
          current.append('Now ', el('strong', '', now.value), ' ', badge(sourceLabel(now.source)));
          control.node.append(current);
        }
        inputs[key] = input;
        row.append(control.node);
        form.append(row);
      }
      const save = button(`Save ${scope === 'shared' ? 'shared' : 'personal'} settings`, () => {}, 'primary');
      save.type = 'submit';
      const actions = el('div', 'form-actions');
      actions.append(save, status.node);
      form.append(actions);
      describeControls(form, status.node);
      form.addEventListener('input', () => status.show());
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (save.disabled) return;
        // Rules live in the same file; keep them as they are.
        const values = {};
        for (const key of settingKeys) if (inputs[key].value) values[key] = inputs[key].value;
        if (file.settings.rules !== undefined) values.rules = file.settings.rules;
        saving(form, status, async () => {
          const updated = await send('PUT', 'project/settings', { root: project.root, scope, version: file.version, settings: values });
          if (!signal.aborted) update(updated, 'Saved.');
        });
      });
      section.append(form);
      return [section];
    }

    function rules() {
      const parts = [];
      const applied = card('Rules that apply', 'Global rules, plus approved rules from this project. A rule with the same name in a more specific file wins.');
      applied.append(project.effective ? rulesList(project.effective.rules, true) : warning('A settings file is invalid, so the rules cannot be resolved.'));
      if (project.effective) applied.append(rulesApproval());
      parts.push(applied);
      const file = project[scope];
      const editing = card('Edit project rules');
      editing.append(scopeSwitch(scope, (next) => { scope = next; render(); }), fileNote(file, scope));
      if (!file.error) {
        const status = feedback();
        const editor = rulesEditor(file.settings.rules ?? [], { root: project.root, status: status.node, changed: () => status.show() });
        const form = el('form');
        const save = button(`Save ${scope === 'shared' ? 'shared' : 'personal'} rules`, () => {}, 'primary');
        save.type = 'submit';
        const actions = el('div', 'form-actions');
        actions.append(save, status.node);
        form.append(editor.node, actions);
        describeControls(form, status.node);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!editor.validate() || save.disabled) return;
          const { rules: _old, ...values } = file.settings;
          const next = editor.read();
          saving(form, status, async () => {
            const updated = await send('PUT', 'project/settings', { root: project.root, scope, version: file.version, settings: next.length ? { ...values, rules: next } : values });
            if (!signal.aborted) update(updated, 'Saved.');
          });
        });
        editing.append(form);
      }
      parts.push(editing);
      return parts;
    }

    // Project files can be written by anyone who can commit, so their rules
    // only apply once approved. The server refuses a stale fingerprint.
    function rulesApproval() {
      const approval = project.rulesApproval;
      const box = el('div', 'rules-approval');
      if (!approval?.fingerprint) return box;
      const status = feedback();
      if (approval.approved) {
        box.append(el('p', 'section-description', 'You approved this project\'s rules. If someone changes them, new launches skip them until you approve again. Running and resumed launches keep the rules they started with.'));
        box.append(button('Withdraw approval', () => change(null)), status.node);
      } else {
        const pending = project.effective.unapprovedRules ?? [];
        box.classList.add('notice', 'warning');
        box.append(el('h3', 'rules-heading', 'Waiting for your approval'));
        box.append(el('p', '', `${pending.length === 1 ? 'This rule comes' : 'These rules come'} from the project files and ${pending.length === 1 ? 'is' : 'are'} not applied yet. Anyone who can commit to the repository can write them, so check what ${pending.length === 1 ? 'it removes' : 'they remove'} before approving.`));
        box.append(rulesList(pending, true), button('Approve these rules', () => change(approval.fingerprint), 'primary'), status.node);
      }
      async function change(fingerprint) {
        status.show('Saving…');
        try {
          update(await send('PUT', 'project/rules-approval', { root: project.root, fingerprint }));
          panel.querySelector('.rules-approval button')?.focus();
        } catch (error) {
          status.show(error.message, true);
        }
      }
      return box;
    }

    function activity() {
      const filtering = card('Filter totals', 'All recorded activity for this project. Character counts do not measure tokens or cost.');
      filtering.append(totals(project.totals));
      const records = el('div');
      activitySections(records, signal, project.root);
      return [filtering, records];
    }

    renderAlert();
    select(tab);
  }, signal);
}
