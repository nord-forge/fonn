import { get, send } from '../api.js';
import { badge, button, card, el, empty, loadSection, pageHeader } from '../components.js';
import { confirmAction, describeControls, feedback, field, saving, select } from '../forms.js';

const AGENTS = [['claude', 'Claude'], ['codex', 'Codex']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

const agentLabel = (provider) => AGENTS.find(([key]) => key === provider)?.[1] ?? provider;
const effortLabel = (effort) => `${EFFORTS.find(([key]) => key === effort)?.[1] ?? effort} effort`;

/** "Claude · claude-opus-5-5 · Medium effort" with the model in code type. */
function summary(profile) {
  const line = el('p', 'profile-meta');
  line.append(`${agentLabel(profile.provider)} · `, el('code', '', profile.model), ` · ${effortLabel(profile.effort)}`);
  return line;
}

// A name built from the model and effort, such as "sonnet-high".
function suggestName(model, effort) {
  const base = model.trim().toLowerCase().replace(/^claude-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base ? `${base}-${effort}` : '';
}

/**
 * Create, copy or edit. `profile` is the one being edited; `start` prefills a
 * new profile, for example from a built-in one.
 */
function profileForm({ profile, start, models, onSave, cancel }) {
  const editing = Boolean(profile);
  const initial = profile ?? start ?? { provider: 'claude', model: '', effort: 'medium' };
  const form = el('form', 'profile-form');
  form.append(el('h3', '', editing ? `Edit ${profile.name}` : start ? `New profile from ${start.name}` : 'New profile'));

  const agents = el('fieldset', 'choice-group');
  agents.append(el('legend', '', 'Agent'));
  const radios = AGENTS.map(([key, label]) => {
    const option = el('label', 'choice');
    const input = el('input');
    input.type = 'radio';
    input.name = 'agent';
    input.value = key;
    input.checked = initial.provider === key;
    option.append(input, label);
    agents.append(option);
    return input;
  });
  const agent = () => radios.find((input) => input.checked)?.value ?? 'claude';

  const model = field('Model', el('input'), '');
  model.input.value = initial.model;
  model.input.autocomplete = 'off';
  model.input.spellcheck = false;
  const list = el('datalist');
  list.id = `${model.input.id}-models`;
  model.input.setAttribute('list', list.id);
  model.node.append(list);
  const hint = model.node.querySelector('.field-hint');
  function showModels() {
    const choices = agent() === 'claude' ? CLAUDE_MODELS : models.codex;
    list.replaceChildren(...choices.map((value) => { const option = el('option'); option.value = value; return option; }));
    hint.textContent = agent() === 'claude'
      ? 'An alias such as opus, sonnet or haiku, or a full claude-* model ID.'
      : `A Codex model ID${models.codex.length ? `, such as ${models.codex[0]}` : ''}.`;
    hint.hidden = false;
  }

  const effort = field('Effort', select(EFFORTS, initial.effort), 'Higher effort thinks longer and costs more.');
  const name = field('Name', el('input'), 'Lowercase letters, digits and hyphens. Filled in for you until you change it.');
  name.input.autocomplete = 'off';
  name.input.spellcheck = false;
  let nameTouched = false;
  const fillName = () => { if (!nameTouched) name.input.value = suggestName(model.input.value, effort.input.value); };
  fillName();
  name.input.addEventListener('input', () => { nameTouched = name.input.value !== ''; });

  const grid = el('div', 'profile-form-grid');
  grid.append(model.node, effort.node);
  form.append(agents, grid);
  if (!editing) form.append(name.node);

  const status = feedback();
  const save = button(editing ? 'Save changes' : 'Create profile', () => {}, 'primary');
  save.type = 'submit';
  const actions = el('div', 'form-actions');
  actions.append(save, button('Cancel', cancel));
  form.append(actions, status.node);
  describeControls(form, status.node);
  showModels();

  for (const radio of radios) radio.addEventListener('change', () => { showModels(); if (!editing) { model.input.value = ''; fillName(); } });
  model.input.addEventListener('input', fillName);
  effort.input.addEventListener('change', fillName);
  form.addEventListener('input', () => { status.show(); name.error(); model.error(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const invalidName = !editing && !/^[a-z0-9-]{1,48}$/.test(name.input.value);
    const missingModel = !model.input.value.trim();
    name.error(invalidName ? 'Use 1 to 48 lowercase letters, digits or hyphens.' : '');
    model.error(missingModel ? 'Enter a model.' : '');
    if (missingModel) return model.input.focus();
    if (invalidName) return name.input.focus();
    if (save.disabled) return;
    saving(form, status, async () => {
      const body = { provider: agent(), model: model.input.value.trim(), effort: effort.input.value };
      if (!editing) body.name = name.input.value;
      const resource = await send(editing ? 'PUT' : 'POST', editing ? `profiles/${encodeURIComponent(profile.name)}` : 'profiles', body);
      onSave(resource, editing ? profile.name : body.name);
    });
  });
  return form;
}

export async function profilesView(target, signal) {
  target.append(pageHeader('Global / Profiles', 'Profiles', 'A profile picks the agent, model and effort for a launch. Fonn uses the default unless a project setting or a flag picks another.'));
  const content = el('div', 'profiles');
  target.append(content);
  await loadSection(content, async () => {
    const initial = await get('profiles', { signal });
    const status = feedback();

    function render(resource, message = '', focusName = '') {
      if (signal.aborted) return;
      const models = { codex: [...new Set(resource.profiles.filter((p) => p.builtIn && p.provider === 'codex').map((p) => p.model))] };
      const current = resource.profiles.find((profile) => profile.name === resource.defaultProfile);

      // The default, first: it is what a plain `fonn` launch uses.
      const defaults = card('Default profile');
      const chosen = el('div', 'default-profile');
      if (current) chosen.append(el('p', 'default-name', current.name), summary(current));
      else chosen.append(el('p', 'default-name', resource.defaultProfile));
      defaults.append(chosen, el('p', 'section-description', 'To change it, choose Use as default on any profile below.'), status.node);

      function row(profile) {
        const item = el('li', 'profile-row');
        item.dataset.profile = profile.name;
        const info = el('div', 'profile-info');
        const title = el('p', 'profile-name');
        title.append(profile.name);
        if (profile.isDefault) title.append(' ', badge('Default', 'accent'));
        info.append(title, summary(profile));
        const actions = el('div', 'row-actions');
        const rowStatus = feedback();
        if (!profile.isDefault) {
          actions.append(button('Use as default', () => saving(actions, rowStatus, async () => {
            const updated = await send('PUT', 'settings/global', { key: 'profile', value: profile.name });
            const name = updated.settings.profile;
            render({ ...resource, defaultProfile: name, profiles: resource.profiles.map((entry) => ({ ...entry, isDefault: entry.name === name })) }, `${name} is now the default.`, name);
          })));
        }
        if (profile.builtIn) {
          actions.append(button('Copy', () => openForm({ start: profile })));
        } else {
          actions.append(button('Edit', () => {
            const form = profileForm({
              profile, models,
              onSave: (updated, name) => render(updated, `Saved ${name}.`, name),
              cancel: () => { form.replaceWith(item); item.querySelector('button')?.focus(); },
            });
            item.replaceWith(form);
            form.querySelector('input:checked')?.focus();
          }));
          if (!profile.isDefault) {
            actions.append(confirmAction('Delete', `Delete ${profile.name}? Launches that already used it keep their saved copy.`, async () => {
              render(await send('DELETE', `profiles/${encodeURIComponent(profile.name)}`), `Deleted ${profile.name}.`);
            }));
          }
        }
        actions.append(rowStatus.node);
        describeControls(actions, rowStatus.node);
        item.append(info, actions);
        return item;
      }

      // Your own profiles, with the form opening above the list.
      const own = card('Your profiles');
      const heading = el('div', 'card-heading');
      const create = button('New profile', () => openForm({}), 'primary');
      heading.append(own.querySelector('h2'), create);
      own.prepend(heading);
      const formArea = el('div');
      const custom = resource.profiles.filter((profile) => !profile.builtIn);
      const list = el('ul', 'profile-list');
      list.append(...custom.map(row));
      own.append(formArea, custom.length ? list : empty('No profiles of your own yet. Create one, or copy a built-in profile to change its model or effort.'));

      function openForm({ start }) {
        create.hidden = true;
        const form = profileForm({
          start, models,
          onSave: (updated, name) => render(updated, `Created ${name}.`, name),
          cancel: () => { formArea.replaceChildren(); create.hidden = false; create.focus(); },
        });
        formArea.replaceChildren(form);
        own.scrollIntoView({ block: 'start', behavior: 'smooth' });
        // A copy already has an agent, so start at the model.
        form.querySelector(start ? '.form-field input' : 'input[name="agent"]:checked')?.focus();
      }

      // Built-ins, grouped by agent.
      const builtIn = card('Built-in profiles', 'Ready to use and always available. They cannot be changed, so copy one to make your own version.');
      for (const [key, label] of AGENTS) {
        const group = resource.profiles.filter((profile) => profile.builtIn && profile.provider === key);
        if (!group.length) continue;
        const groupList = el('ul', 'profile-list');
        groupList.append(...group.map(row));
        builtIn.append(el('h3', 'profile-group', label), groupList);
      }

      content.replaceChildren(defaults, own, builtIn);
      if (message) status.show(message);
      const focus = focusName && content.querySelector(`[data-profile="${CSS.escape(focusName)}"] .profile-name`);
      if (focus) { focus.tabIndex = -1; focus.focus(); }
    }

    render(initial);
  }, signal);
}
