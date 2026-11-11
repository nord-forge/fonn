import { get, send } from '../api.js';
import { button, card, code, displayPath, el, empty, fields, filterSettingKeys, launchSettingKeys, link, loadSection, number, pageHeader } from '../components.js';

import { describeControls, explanations, feedback, field, saving, select, settingValues } from '../forms.js';
import { rulesEditor } from '../rules.js';

export { profilesView } from './profiles.js';

export async function overviewView(target, signal) {
  target.append(pageHeader('Global / Overview', 'Your Fonn, at a glance', 'Hooks, filter settings and sessions on this machine.'));
  const overview = el('div', 'overview-section');
  const settings = card('Global settings', 'Saved defaults for all projects. Project settings and launch flags can override these values.');
  const environment = card('Environment');
  target.append(overview, settings, environment);
  await Promise.all([
    loadSection(overview, async () => {
      const [data, hooks, global] = await Promise.all([get('overview', { signal }), get('hooks', { signal }), get('settings/global', { signal })]);
      const metrics = el('div', 'overview-metrics');
      const installed = hooks.filter((status) => status.installed).length;
      for (const [label, value, href] of [
        ['Hooks installed', `${number(installed)} of ${number(hooks.length)}`, '#/global/agents'],
        ['Global filter rules', number((global.settings.rules ?? []).length), '#/global/rules'],
        ['Sessions', number(data.counts.launches), '#/global/activity'],
        ['Projects', number(data.counts.projects), '#/projects/open'],
      ]) {
        const item = el('a', 'overview-metric metric-link');
        item.href = href;
        item.append(el('span', 'metric-label', label), el('span', 'metric-value', value));
        metrics.append(item);
      }
      overview.append(metrics);
      environment.append(fields([
        ['Fonn version', data.version], ['Node version', data.node], ['Platform', data.platform],
        ['Config folder', displayPath(data.configDirectory)], ['State folder', displayPath(data.stateDirectory)],
      ]));
    }, signal),
    loadSection(settings, async () => {
      const [data, profiles] = await Promise.all([get('settings/global', { signal }), get('profiles', { signal })]);
      settings.append(el('p', 'path file-path', displayPath(data.file)));
      const settingForm = (key) => {
        const form = el('form', 'setting-row');
        const input = select(key === 'profile' ? profiles.profiles.map((profile) => profile.name) : settingValues[key], data.settings[key] ?? '', key === 'profile' ? undefined : 'Use built-in default');
        const control = field(key, input, explanations[key]);
        const status = feedback();
        let saved = input.value;
        const save = button('Save', () => {}, 'primary');
        save.type = 'submit';
        save.hidden = true;
        input.addEventListener('change', () => { save.hidden = input.value === saved; status.show(); });
        const actions = el('div', 'form-actions');
        actions.append(save, status.node);
        form.append(control.node, actions);
        describeControls(form, status.node);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (input.value === saved || save.disabled) return;
          saving(form, status, async () => {
            const updated = await send('PUT', 'settings/global', { key, value: input.value || null });
            if (signal.aborted) return;
            input.value = updated.settings[key] ?? '';
            saved = input.value;
            save.hidden = true;
            status.show('Saved');
            input.disabled = false;
            input.focus();
          });
        });
        return form;
      };
      for (const key of filterSettingKeys) settings.append(settingForm(key));
      settings.append(link('Edit global filter rules', '#/global/rules', 'section-link'));
      // Hooks do not use these. They only apply when Fonn starts the agent.
      const launch = el('details', 'launch-settings instructions-details');
      launch.append(el('summary', '', 'Launch settings'));
      launch.append(el('p', 'section-description', 'Only used when Fonn starts the agent, with fonn claude or fonn codex. Hooks ignore them.'));
      for (const key of launchSettingKeys) launch.append(settingForm(key));
      const instructions = el('details', 'instructions-details');
      instructions.append(el('summary', '', 'Instructions Fonn adds'));
      instructions.append(el('p', 'section-description', 'Added at session start when subagents is auto.'));
      instructions.append(data.delegationGuidance ? code(data.delegationGuidance) : empty('No added instructions.'));
      launch.append(instructions);
      settings.append(launch);
    }, signal),
  ]);
}

export async function globalRulesView(target, signal) {
  target.append(pageHeader('Global / Rules', 'Filter rules', 'These rules apply to all projects. A project rule with the same name replaces a global rule.'));
  const section = card('Global rules');
  target.append(section);
  await loadSection(section, async () => {
    const data = await get('settings/global', { signal });
    function render(resource, saved = false) {
      const form = el('form');
      const status = feedback();
      const editor = rulesEditor(resource.settings.rules ?? [], { status: status.node, changed: () => status.show() });
      const save = button('Save rules', () => {}, 'primary');
      save.type = 'submit';
      const actions = el('div', 'form-actions');
      actions.append(save, status.node);
      form.append(el('p', 'path file-path', displayPath(resource.file)), editor.node, actions);
      describeControls(form, status.node);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!editor.validate() || save.disabled) return;
        saving(form, status, async () => {
          const updated = await send('PUT', 'settings/global/rules', { rules: editor.read() });
          if (!signal.aborted) render(updated, true);
        });
      });
      section.replaceChildren(el('h2', '', 'Global rules'), form);
      if (saved) { status.show('Saved'); save.focus(); }
    }
    render(data);
  }, signal);
}
