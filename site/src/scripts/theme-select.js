// Custom theme listbox for the header (components/ThemeSelect.astro).
// Keyboard: Enter, Space or ArrowDown opens it. In the list, arrows, Home and
// End move, Enter or Space picks, Escape closes and returns focus, and Tab
// closes it. A click outside closes it too.
import { currentTheme, onThemeChange, setTheme } from './theme.js';

const LABELS = { dark: 'Dark', light: 'Light', auto: 'Auto' };

class FonnThemeSelect extends HTMLElement {
  connectedCallback() {
    this.button = this.querySelector('.theme-select-button');
    this.menu = this.querySelector('.theme-select-menu');
    this.options = [...this.menu.querySelectorAll('[role="option"]')];
    this.options.forEach((option, index) => { option.id = `theme-option-${index}-${Math.random().toString(36).slice(2, 7)}`; });

    this.show(currentTheme());
    onThemeChange((theme) => this.show(theme));

    this.button.addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
    this.button.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        this.open();
      }
    });
    this.menu.addEventListener('keydown', (event) => this.onMenuKey(event));
    this.menu.addEventListener('click', (event) => {
      const option = event.target.closest('[role="option"]');
      if (option) this.choose(option.dataset.value);
    });
    this.menu.addEventListener('mousemove', (event) => {
      const option = event.target.closest('[role="option"]');
      if (option) this.highlight(this.options.indexOf(option));
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.isOpen() && !this.contains(event.target)) this.close(false);
    });
  }

  isOpen() {
    return !this.menu.hidden;
  }

  // Shows the chosen theme on the button and marks it in the list.
  show(theme) {
    for (const current of this.querySelectorAll('.theme-select-current')) {
      current.hidden = current.dataset.value !== theme;
    }
    for (const option of this.options) {
      option.setAttribute('aria-selected', String(option.dataset.value === theme));
    }
    this.button.setAttribute('aria-label', `Theme: ${LABELS[theme]}`);
  }

  open() {
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    const selected = this.options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
    this.highlight(Math.max(0, selected));
    this.menu.focus();
  }

  close(returnFocus = true) {
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.menu.removeAttribute('aria-activedescendant');
    if (returnFocus) this.button.focus();
  }

  highlight(index) {
    this.active = index;
    this.options.forEach((option, position) => option.classList.toggle('is-active', position === index));
    this.menu.setAttribute('aria-activedescendant', this.options[index].id);
  }

  choose(theme) {
    setTheme(theme);
    this.close();
  }

  onMenuKey(event) {
    const last = this.options.length - 1;
    const moves = { ArrowDown: Math.min(last, this.active + 1), ArrowUp: Math.max(0, this.active - 1), Home: 0, End: last };
    if (event.key in moves) {
      event.preventDefault();
      this.highlight(moves[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.choose(this.options[this.active].dataset.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Tab') {
      this.close(false);
    }
  }
}

customElements.define('fonn-theme-select', FonnThemeSelect);
