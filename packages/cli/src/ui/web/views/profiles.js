import { get, send } from '../api.js';
import { badge, button, card, el, fields, loadSection, pageHeader } from '../components.js';
import { confirmAction, describeControls, feedback, field, saving, select } from '../forms.js';

function profileForm(profile, onSave, cancel) {
  const form = el('form', 'profile-form');
  const name = field('Name');
  name.input.value = profile?.name ?? '';
  name.input.autocomplete = 'off';
  const provider = field('Agent', select(['claude', 'codex'], profile?.provider ?? 'claude'));
  const model = field('Model', el('input'), 'Claude: opus, sonnet, haiku, fable, mythos or a claude-* ID. Codex: a gpt-* ID.');
  model.input.value = profile?.model ?? '';
  const effort = field('Effort', select(['low', 'medium', 'high', 'xhigh', 'max'], profile?.effort ?? 'medium'));
  const status = feedback();
  const save = button(profile ? 'Save profile' : 'Create profile', () => {});
  save.type = 'submit';
  if (!profile) form.append(name.node);
  form.append(provider.node, model.node, effort.node);
  const actions = el('div', 'form-actions');
  actions.append(save, button('Cancel', cancel));
  form.append(actions, status.node);
  describeControls(form, status.node);
  form.addEventListener('input', () => { status.show(); name.error(); model.error(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const invalidName = !profile && !/^[a-z0-9-]{1,48}$/.test(name.input.value);
    name.error(invalidName ? 'Use 1 to 48 lowercase letters, digits or hyphens.' : '');
    model.error(!model.input.value.trim() ? 'Enter a model.' : '');
    if (invalidName) return name.input.focus();
    if (!model.input.value.trim()) return model.input.focus();
    if (save.disabled) return;
    saving(form, status, async () => {
      const body = { provider: provider.input.value, model: model.input.value, effort: effort.input.value };
      if (!profile) body.name = name.input.value;
      const resource = await send(profile ? 'PUT' : 'POST', profile ? `profiles/${encodeURIComponent(profile.name)}` : 'profiles', body);
      onSave(resource);
    });
  });
  return form;
}

export async function profilesView(target, signal) {
  target.append(pageHeader('Global / Profiles', 'Profiles', 'The agent, model and effort choices available to Fonn.'));
  const section = card('Available profiles');
  target.append(section);
  await loadSection(section, async () => {
    const data = await get('profiles', { signal });
    function render(resource, saved = false) {
      if (signal.aborted) return;
      const status = feedback();
      const newArea = el('div');
      const create = button('New profile', () => {
        create.hidden = true;
        const form = profileForm(null, (updated) => render(updated, true), () => { newArea.replaceChildren(); create.hidden = false; create.focus(); });
        newArea.replaceChildren(form);
        form.querySelector('input').focus();
      });
      section.replaceChildren(el('h2', '', 'Available profiles'), el('p', 'section-description', `Default profile: ${resource.defaultProfile}`), status.node, create, newArea);
      for (const profile of resource.profiles) {
        const item = el('section', 'profile-card');
        const heading = el('div', 'record-heading');
        const labels = el('div', 'badges');
        if (profile.builtIn) labels.append(badge('Built-in'));
        if (profile.isDefault) labels.append(badge('Default', 'accent'));
        heading.append(el('h3', '', profile.name), labels);
        item.append(heading, fields([['Agent', profile.provider], ['Model', profile.model], ['Effort', profile.effort]]));
        const actions = el('div', 'form-actions');
        const rowStatus = feedback();
        if (!profile.isDefault) {
          actions.append(button('Make default', () => saving(actions, rowStatus, async () => {
            const updated = await send('PUT', 'settings/global', { key: 'profile', value: profile.name });
            // The settings response owns the default; all other profile data stays as returned by the profiles endpoint.
            render({ ...resource, defaultProfile: updated.settings.profile, profiles: resource.profiles.map((entry) => ({ ...entry, isDefault: entry.name === updated.settings.profile })) }, true);
          })));
        }
        if (!profile.builtIn) {
          const editor = el('div');
          const edit = button('Edit', () => {
            edit.hidden = true;
            const form = profileForm(profile, (updated) => render(updated, true), () => { editor.replaceChildren(); edit.hidden = false; edit.focus(); });
            editor.replaceChildren(form);
            form.querySelector('select').focus();
          });
          actions.append(edit, confirmAction('Delete', `Delete profile "${profile.name}"? Existing launch records keep their saved profile.`, async () => {
            const updated = await send('DELETE', `profiles/${encodeURIComponent(profile.name)}`);
            render(updated, true);
          }));
          item.append(editor);
        }
        actions.append(rowStatus.node);
        describeControls(actions, rowStatus.node);
        item.append(actions);
        section.append(item);
      }
      if (saved) { status.show('Saved'); create.focus(); }
    }
    render(data);
  }, signal);
}
