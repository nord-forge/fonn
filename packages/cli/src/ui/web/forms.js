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

// One shared modal dialog for confirmations. A native <dialog> traps focus,
// closes on Escape and leaves the page layout alone.
let confirmation;
function confirmationDialog() {
  if (confirmation) return confirmation;
  const dialog = el('dialog', 'confirm-dialog');
  const title = el('h2', 'confirm-title');
  title.id = 'confirm-title';
  const message = el('p', 'confirm-message');
  message.id = 'confirm-message';
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.setAttribute('aria-describedby', message.id);
  const status = feedback();
  const cancel = button('Cancel', () => dialog.close());
  const confirm = button('Delete', () => {}, 'danger');
  const actions = el('div', 'form-actions confirm-actions');
  actions.append(cancel, confirm);
  dialog.append(title, message, status.node, actions);
  document.body.append(dialog);
  confirmation = { dialog, title, message, status, cancel, confirm, busy: false, current: undefined };
  // Escape while a change is being saved would hide its outcome.
  dialog.addEventListener('cancel', (event) => { if (confirmation.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    const returnFocus = confirmation.current?.returnFocus;
    confirmation.current = undefined;
    // The browser restores its own focus after this event; go after it.
    setTimeout(() => { if (returnFocus?.isConnected) returnFocus.focus(); }, 0);
  });
  confirm.addEventListener('click', async () => {
    const current = confirmation.current;
    if (!current || confirmation.busy) return;
    confirmation.busy = true;
    confirm.disabled = true;
    cancel.disabled = true;
    status.show('Working…');
    try {
      await current.action();
      if (confirmation.current === current) dialog.close();
    } catch (error) {
      status.show(error.message, true);
    } finally {
      confirmation.busy = false;
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });
  return confirmation;
}

/**
 * Asks before a destructive change. `action` runs on confirm; when it throws,
 * the dialog stays open with the message. Focus returns to `returnFocus`.
 */
export function confirmDialog({ title, message, confirmLabel = 'Delete', action, returnFocus }) {
  const dialog = confirmationDialog();
  dialog.current = { action, returnFocus: returnFocus ?? document.activeElement };
  dialog.title.textContent = title;
  dialog.message.textContent = message;
  dialog.confirm.textContent = confirmLabel;
  dialog.status.show();
  if (!dialog.dialog.open) dialog.dialog.showModal();
  // Cancel is the safe default for a destructive choice.
  dialog.cancel.focus();
}

/** A button that opens the confirmation dialog. */
export function confirmAction(label, explanation, action, { title = label, confirmLabel = 'Delete' } = {}) {
  const trigger = button(label, () => confirmDialog({ title, message: explanation, confirmLabel, action, returnFocus: trigger }), 'danger');
  return trigger;
}
