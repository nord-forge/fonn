import { get, send } from '../api.js';
import { activitySections } from './activity.js';
import { badge, button, card, code, el, empty, link, loadSection, number, pageHeader, settingKeys, sourceLabel, table, totals, warning } from '../components.js';

import { describeControls, explanations, feedback, field, saving, select, settingValues } from '../forms.js';
import { rulesEditor, rulesList } from '../rules.js';
import { testRoute } from '../test-context.js';

function settingsFile(title, file, scope, project, profiles, onSave, signal) {
  const section = el('section', 'settings-file');
  const header = el('div', 'record-heading');
  header.append(el('h3', '', title), badge(file.exists ? 'Exists' : 'Not present', file.error ? 'warn' : ''));
  section.append(header, el('p', 'path file-path', file.path));
  if (file.error) {
    section.append(warning(file.error), el('p', 'section-description', 'Fix this file on disk before editing it here.'));
    return section;
  }
  const form = el('form');
  const status = feedback();
  const inputs = {};
  for (const key of settingKeys) {
    const input = select(key === 'profile' ? profiles.profiles.map((profile) => profile.name) : settingValues[key], file.settings[key] ?? '', 'Not set');
    const control = field(key, input, explanations[key]);
    inputs[key] = input;
    form.append(control.node);
  }
  form.append(el('h4', 'rules-heading', 'Filter rules'));
  const editor = rulesEditor(file.settings.rules ?? [], { root: project.root, status: status.node, changed: () => status.show() });
  const save = button(`Save ${scope === 'shared' ? 'shared' : 'personal'} settings and rules`, () => {});
  save.type = 'submit';
  form.append(editor.node, save, status.node);
  describeControls(form, status.node);
  form.addEventListener('input', () => status.show());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!editor.validate() || save.disabled) return;
    const settings = {};
    for (const key of settingKeys) if (inputs[key].value) settings[key] = inputs[key].value;
    const rules = editor.read();
    if (rules.length || file.settings.rules !== undefined) settings.rules = rules;
    saving(form, status, async () => {
      const updated = await send('PUT', 'project/settings', { root: project.root, scope, version: file.version, settings });
      if (!signal.aborted) onSave(updated, scope);
    });
  });
  section.append(form);
  return section;
}

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

export async function projectView(target, signal, root) {
  target.append(pageHeader('Projects', 'Project', root));
  const content = el('div');
  const activity = el('div');
  target.append(content, activity);
  await Promise.all([
    loadSection(content, async () => {
      let project;
      let profiles;
      [project, profiles] = await Promise.all([get('project', { query: { root }, signal }), get('profiles', { signal })]);
      if (signal.aborted) return;
      const header = pageHeader('Projects', project.name, project.root);
      header.querySelector('.page-description').classList.add('path');
      header.querySelector('.page-description').title = project.root;
      target.querySelector('.page-header').replaceWith(header);
      document.title = `Fonn · ${project.name}`;
      const effective = el('div');
      const notice = feedback();
      const files = card('Settings files', 'Shared .fonn.json is committed for the team. Personal .fonn/settings.local.json is just for you. Not set inherits a value from the broader settings.');
      files.append(notice.node);
      const fileNodes = {};
      function renderEffective() {
        const settings = card('Effective settings', 'The values Fonn would use for a new launch. Personal settings come from the local settings file.');
        if (project.effective === null) {
          settings.append(warning('Fix the invalid settings file first. Effective settings cannot be resolved until it is valid.'));
        } else {
          settings.append(table(['Setting', 'Value', 'Source'], settingKeys.map((key) => [
            el('code', '', key), project.effective[key].value, badge(sourceLabel(project.effective[key].source)),
          ]), 'Effective project settings'));
          settings.append(el('h3', 'rules-heading', 'Effective rules'), rulesList(project.effective.rules ?? [], true));
          settings.append(rulesApproval());
        }
        settings.append(link('Open test bench for this project', testRoute(project.root), 'section-link'));
        effective.replaceChildren(settings);
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
          box.append(el('h3', 'rules-heading', 'Project rules waiting for approval'));
          box.append(el('p', '', `${pending.length === 1 ? 'This rule comes' : 'These rules come'} from the project files and ${pending.length === 1 ? 'is' : 'are'} not applied yet. Anyone who can commit to the repository can write them, so check what ${pending.length === 1 ? 'it removes' : 'they remove'} before approving.`));
          box.append(rulesList(pending, true), button('Approve these rules', () => change(approval.fingerprint)), status.node);
        }
        async function change(fingerprint) {
          status.show('Saving…');
          try {
            project = await send('PUT', 'project/rules-approval', { root: project.root, fingerprint });
            renderEffective();
            effective.querySelector('.rules-approval button')?.focus();
          } catch (error) {
            status.show(error.message, true);
          }
        }
        return box;
      }
      function renderFile(scope, saved = false) {
        const node = settingsFile(scope === 'shared' ? 'Shared .fonn.json' : 'Personal .fonn/settings.local.json', project[scope], scope, project, profiles, (updated, changedScope) => {
          project = updated;
          renderEffective();
          renderFile(changedScope, true);
          notice.show(updated.warning ?? '');
          notice.node.classList.toggle('notice', Boolean(updated.warning));
          notice.node.classList.toggle('warning', Boolean(updated.warning));
        }, signal);
        if (fileNodes[scope]) fileNodes[scope].replaceWith(node);
        else files.append(node);
        fileNodes[scope] = node;
        if (saved) {
          const status = feedback();
          node.append(status.node);
          status.show('Saved');
          node.querySelector('button[type="submit"]')?.focus();
        }
      }
      renderEffective();
      renderFile('shared');
      renderFile('local');
      const filtering = card('Filter totals', 'All recorded activity for this project. Character counts do not measure tokens or cost.');
      filtering.append(totals(project.totals));
      content.append(effective, files, instructionFiles(project, signal), filtering);
    }, signal),
    activitySections(activity, signal, root),
  ]);
}
