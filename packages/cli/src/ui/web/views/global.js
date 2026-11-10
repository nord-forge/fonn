import { get, send } from '../api.js';
import { button, card, code, el, empty, fields, link, loadSection, number, pageHeader, settingKeys } from '../components.js';

import { describeControls, explanations, feedback, field, saving, select, settingValues } from '../forms.js';
import { rulesEditor } from '../rules.js';

export { profilesView } from './profiles.js';

export async function overviewView(target, signal) {
  target.append(pageHeader('Global / Overview', 'Your Fonn, at a glance', 'Settings, profiles, and sessions from this machine.'));
  const overview = el('div', 'overview-section');
  const settings = card('Global settings', 'Saved defaults for all projects. Project settings and launch flags can override these values.');
  target.append(overview, settings);
  await Promise.all([
    loadSection(overview, async () => {
      const data = await get('overview', { signal });
      const metrics = el('dl', 'overview-metrics');
      for (const [key, label] of [['profiles', 'Profiles'], ['projects', 'Projects'], ['launches', 'Launches'], ['runs', 'SDK runs']]) {
        const item = el('div', 'overview-metric');
        item.append(el('dt', '', label), el('dd', '', number(data.counts[key])));
        metrics.append(item);
      }
      const environment = card('Environment');
      environment.append(fields([
        ['Fonn version', data.version], ['Node version', data.node], ['Platform', data.platform],
        ['Config folder', data.configDirectory], ['State folder', data.stateDirectory],
      ]));
      overview.append(metrics, environment);
    }, signal),
    loadSection(settings, async () => {
      const [data, profiles] = await Promise.all([get('settings/global', { signal }), get('profiles', { signal })]);
      settings.append(el('p', 'path file-path', data.file));
      for (const key of settingKeys) {
        const form = el('form', 'setting-row');
        const input = select(key === 'profile' ? profiles.profiles.map((profile) => profile.name) : settingValues[key], data.settings[key] ?? '', key === 'profile' ? undefined : 'Use built-in default');
        const control = field(key, input, explanations[key]);
        const status = feedback();
        let saved = input.value;
        const save = button('Save', () => {});
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
        settings.append(form);
      }
      settings.append(link('Edit global filter rules', '#/global/rules', 'section-link'));
      const details = el('details', 'instructions-details');
      details.append(el('summary', '', 'Instructions Fonn adds'));
      details.append(el('p', 'section-description', 'Added at session start when subagents is auto.'));
      details.append(data.delegationGuidance ? code(data.delegationGuidance) : empty('No added instructions.'));
      settings.append(details);
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
      const save = button('Save rules', () => {});
      save.type = 'submit';
      form.append(el('p', 'path file-path', resource.file), editor.node, save, status.node);
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
