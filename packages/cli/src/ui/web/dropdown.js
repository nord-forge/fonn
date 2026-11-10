// The UI's dropdown: a button that opens a listbox, styled like the docs
// site's theme menu. It stands in for a native <select>: callers read and set
// `.value`, listen for `change` and `input`, and can disable or focus it.
//
// Keyboard: ArrowDown, ArrowUp, Enter or Space opens it. In the list, the
// arrows, Home and End move, typing a letter jumps to the next match, Enter or
// Space picks, Escape closes and returns focus, and Tab closes it. A click
// outside closes it too. The list sits in the top layer (popover), so cards
// and dialogs never clip it.
import { el } from './components.js';

let sequence = 0;
const svg = (path, size) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', path);
  for (const [name, value] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) line.setAttribute(name, value);
  node.append(line);
  return node;
};

/**
 * values: strings, or [value, label] pairs. placeholder adds a first option
 * with the value ''. A saved value missing from the list is kept visible.
 */
export function dropdown(values, value = '', placeholder) {
  const id = ++sequence;
  const entries = (placeholder === undefined ? [...values] : [['', placeholder], ...values])
    .map((entry) => (Array.isArray(entry) ? entry : [entry, entry]));
  if (value && !entries.some(([key]) => key === value)) entries.push([value, value]);

  const button = el('button', 'dropdown');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const label = el('span', 'dropdown-label');
  const chevron = svg('M4 6l4 4 4-4', 12);
  chevron.classList.add('dropdown-chevron');
  button.append(label, chevron);

  const menu = el('ul', 'dropdown-menu');
  menu.id = `dropdown-${id}`;
  menu.setAttribute('role', 'listbox');
  menu.tabIndex = -1;
  menu.popover = 'auto';
  button.setAttribute('aria-controls', menu.id);
  const options = entries.map(([key, text], index) => {
    const option = el('li', '', '');
    option.id = `dropdown-${id}-option-${index}`;
    option.setAttribute('role', 'option');
    option.dataset.value = key;
    const check = svg('M3 8.5 6.4 12 13 4.5', 14);
    check.classList.add('dropdown-check');
    option.append(el('span', 'dropdown-option-text', text), check);
    menu.append(option);
    return option;
  });

  let current = entries.some(([key]) => key === value) ? value : entries[0]?.[0] ?? '';
  let active = 0;
  function show() {
    const index = Math.max(0, entries.findIndex(([key]) => key === current));
    label.textContent = entries[index]?.[1] ?? '';
    label.classList.toggle('is-placeholder', placeholder !== undefined && current === '');
    options.forEach((option, position) => option.setAttribute('aria-selected', String(position === index)));
  }
  Object.defineProperty(button, 'value', {
    get: () => current,
    set: (next) => { current = entries.some(([key]) => key === String(next)) ? String(next) : entries[0]?.[0] ?? ''; show(); },
  });
  show();

  const isOpen = () => menu.matches(':popover-open');
  function place() {
    const box = button.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const upward = below < 180 && above > below;
    menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8))}px`;
    menu.style.width = `${box.width}px`;
    menu.style.maxHeight = `${Math.max(120, Math.min(320, upward ? above : below))}px`;
    menu.style.top = upward ? '' : `${box.bottom + 6}px`;
    menu.style.bottom = upward ? `${window.innerHeight - box.top + 6}px` : '';
  }
  function highlight(index) {
    active = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((option, position) => option.classList.toggle('is-active', position === active));
    menu.setAttribute('aria-activedescendant', options[active].id);
    options[active].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    if (button.disabled || isOpen()) return;
    // The list lives next to its button, so it goes away with the page.
    if (!menu.isConnected) button.after(menu);
    const name = button.id && document.querySelector(`label[for="${CSS.escape(button.id)}"]`)?.textContent;
    if (name) menu.setAttribute('aria-label', name);
    place();
    menu.showPopover();
    button.setAttribute('aria-expanded', 'true');
    highlight(Math.max(0, entries.findIndex(([key]) => key === current)));
    menu.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside, true);
  }
  function close(returnFocus = true) {
    if (isOpen()) menu.hidePopover();
    if (returnFocus) button.focus();
  }
  function choose(index) {
    const next = entries[index][0];
    const changed = next !== current;
    current = next;
    show();
    close();
    if (changed) {
      button.dispatchEvent(new Event('input', { bubbles: true }));
      button.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  // Light dismiss (outside click, Escape) also ends here.
  menu.addEventListener('toggle', (event) => {
    if (event.newState === 'open') return;
    button.setAttribute('aria-expanded', 'false');
    menu.removeAttribute('aria-activedescendant');
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('pointerdown', outside, true);
  });

  // Popovers close on outside clicks by themselves; this also covers a click
  // that lands on the page itself rather than another element.
  // Added only while the list is open, so closed dropdowns hold no listeners.
  function outside(event) { if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) close(false); }
  button.addEventListener('click', () => (isOpen() ? close() : open()));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) choose(options.indexOf(option));
  });
  menu.addEventListener('mousemove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option && options.indexOf(option) !== active) highlight(options.indexOf(option));
  });
  menu.addEventListener('keydown', (event) => {
    const last = options.length - 1;
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: last, PageDown: active + 8, PageUp: active - 8 };
    if (event.key in moves) {
      event.preventDefault();
      highlight(moves[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Type-ahead: the next option starting with that letter.
      const letter = event.key.toLowerCase();
      for (let step = 1; step <= options.length; step++) {
        const index = (active + step) % options.length;
        if (entries[index][1].toLowerCase().startsWith(letter)) { highlight(index); break; }
      }
    }
  });
  return button;
}
