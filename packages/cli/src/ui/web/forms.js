import { button, el } from './components.js';

let sequence = 0;
export const explanations = {
  profile: 'The agent, model and effort used for new launches.',
  filterLevel: 'How far Fonn trims output: strict, standard or similar.',
  filterMode: 'Filter trims output, observe measures it, and off leaves it alone.',
  subagents: 'Auto adds delegation guidance. Off leaves that guidance out.',
};
export const settingValues = {
  filterLevel: ['strict', 'standard', 'similar'],
  filterMode: ['filter', 'observe', 'off'],
  subagents: ['auto', 'off'],
};

export function select(values, value = '', placeholder) {
  const input = el('select');
  const entries = placeholder === undefined ? [...values] : [['', placeholder], ...values];
  // Keep a saved value visible if a custom profile has since been removed.
  if (value && !values.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === value)) entries.push(value);
  for (const entry of entries) {
    const [key, label] = Array.isArray(entry) ? entry : [entry, entry];
    const option = el('option', '', label);
    option.value = key;
    input.append(option);
  }
  input.value = value;
  return input;
}

export function field(label, input = el('input'), hint = '') {
  const node = el('div', 'form-field');
  input.id = `field-${++sequence}`;
  const title = el('label', '', label);
  title.htmlFor = input.id;
  const error = el('p', 'field-error');
  error.id = `${input.id}-error`;
  error.setAttribute('aria-live', 'polite');
  const help = el('p', 'field-hint', hint);
  help.id = `${input.id}-hint`;
  help.hidden = !hint;
  input.setAttribute('aria-describedby', `${help.id} ${error.id}`);
  node.append(title, help, input, error);
  return {
    node, input,
    error(message = '') {
      error.textContent = message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

export function feedback() {
  const node = el('p', 'form-feedback');
  node.id = `feedback-${++sequence}`;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  let timer;
  return {
    node,
    show(message = '', error = false) {
      clearTimeout(timer);
      node.textContent = message;
      node.classList.toggle('field-error', error);
      if (message === 'Saved') timer = setTimeout(() => { node.textContent = ''; }, 3000);
    },
  };
}

export function describeControls(node, message) {
  for (const input of node.querySelectorAll('input, select, textarea, button')) {
    const ids = new Set((input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean));
    ids.add(message.id);
    input.setAttribute('aria-describedby', [...ids].join(' '));
  }
}

// Disable a form while its write is pending. Never change saved state before it succeeds.
export async function saving(form, status, action) {
  const controls = [...form.querySelectorAll('input, select, textarea, button')];
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  status.show('Saving…');
  try {
    await action();
  } catch (error) {
    status.show(error.message, true);
  } finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
  }
}

export function confirmAction(label, explanation, action) {
  const node = el('div', 'confirm-action');
  const prompt = el('div', 'confirm-panel');
  prompt.hidden = true;
  const status = feedback();
  const open = button(label, () => {
    prompt.hidden = false;
    open.hidden = true;
    yes.focus();
  }, 'danger');
  const yes = button('Yes, delete', () => saving(node, status, async () => {
    await action();
  }), 'danger');
  const cancel = button('Cancel', () => {
    prompt.hidden = true;
    open.hidden = false;
    status.show();
    open.focus();
  });
  const actions = el('div', 'form-actions');
  actions.append(yes, cancel);
  prompt.append(el('p', '', explanation), actions);
  node.append(open, prompt, status.node);
  describeControls(node, status.node);
  return node;
}
