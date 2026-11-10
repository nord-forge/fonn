// Mobile navigation dock for the Starlight site. A floating pill at the bottom
// of the screen shows the current section and scroll progress. Tapping it
// opens a sheet with the page's sections, the docs navigation, a theme switch
// and the GitHub link. styles/dock.css shows it below 50rem, where Starlight's
// own sidebar and table of contents are hidden.
//
// Data comes from the #dock-data JSON that components/Head.astro writes.
import { currentTheme, onThemeChange, setTheme } from './theme.js';

const THEMES = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const CHEVRON = '<svg class="dock-chevron" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 10 8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function readData() {
  const element = document.getElementById('dock-data');
  if (!element) return undefined;
  try {
    return JSON.parse(element.textContent);
  } catch {
    return undefined;
  }
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function buildToggle(data) {
  const toggle = createElement('button', 'dock-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'dock-sheet');
  toggle.innerHTML = '<span class="dock-ring" aria-hidden="true"><span></span></span>';

  const text = createElement('span', 'dock-text');
  text.append(
    createElement('span', 'dock-kicker', data.sections.length ? 'On this page' : 'Menu'),
    createElement('span', 'dock-current', data.sections[0]?.label ?? data.title),
  );
  toggle.append(text);
  toggle.insertAdjacentHTML('beforeend', CHEVRON);
  return toggle;
}

function buildSectionList(sections) {
  const list = createElement('ol', 'dock-sections');
  sections.forEach((section, index) => {
    const link = createElement('a');
    link.href = `#${section.id}`;
    link.dataset.section = section.id;
    link.append(
      createElement('span', 'dock-number', String(index + 1).padStart(2, '0')),
      createElement('span', '', section.label),
    );
    const item = createElement('li');
    item.append(link);
    list.append(item);
  });
  return list;
}

function buildNavigation(groups) {
  const nav = createElement('nav', 'dock-nav');
  nav.setAttribute('aria-label', 'Docs');
  for (const group of groups) {
    if (group.label) nav.append(createElement('p', 'dock-group', group.label));
    const list = createElement('ul', 'dock-links');
    for (const entry of group.links) {
      const link = createElement('a', '', entry.label);
      link.href = entry.href;
      if (entry.current) link.setAttribute('aria-current', 'page');
      const item = createElement('li');
      item.append(link);
      list.append(item);
    }
    nav.append(list);
  }
  return nav;
}

function buildFooter(github) {
  const footer = createElement('div', 'dock-footer');

  const themes = createElement('fieldset', 'dock-theme');
  themes.append(createElement('legend', 'sr-only', 'Theme'));
  const selected = currentTheme();
  for (const theme of THEMES) {
    const label = createElement('label');
    const input = createElement('input');
    input.type = 'radio';
    input.name = 'dock-theme';
    input.value = theme.value;
    input.checked = theme.value === selected;
    input.addEventListener('change', () => setTheme(theme.value));
    label.append(input, createElement('span', '', theme.label));
    themes.append(label);
  }

  // The GitHub mark with "Star" keeps this on one row with the theme switch,
  // even on a 360px screen. Screen readers hear the full label.
  // Stay in step when the header switcher changes the theme.
  onThemeChange((value) => {
    for (const input of themes.querySelectorAll('input')) input.checked = input.value === value;
  });

  const star = createElement('a', 'dock-star');
  star.href = github;
  star.setAttribute('aria-label', 'Star on GitHub');
  star.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg><span>Star</span>';
  footer.append(themes, star);
  return footer;
}

function buildSheet(data) {
  const sheet = createElement('div', 'dock-sheet');
  sheet.id = 'dock-sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Navigation');

  const head = createElement('div', 'dock-sheet-head');
  head.append(createElement('p', 'dock-title', data.sections.length ? 'On this page' : 'Docs'));
  const close = createElement('button', 'dock-close', 'Close');
  close.type = 'button';
  head.append(close);
  sheet.append(head);

  if (data.sections.length) {
    sheet.append(buildSectionList(data.sections), createElement('p', 'dock-title', 'Docs'));
  }
  sheet.append(buildNavigation(data.navigation), buildFooter(data.github));
  return sheet;
}

// Open, close, Escape, backdrop and focus handling.
function setupSheet(dock) {
  const toggle = dock.querySelector('.dock-toggle');
  const sheet = dock.querySelector('.dock-sheet');
  const backdrop = dock.querySelector('.dock-backdrop');
  const focusable = () => [...sheet.querySelectorAll('a, button, input')].filter((element) => !element.closest('[hidden]'));

  function open() {
    sheet.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => dock.classList.add('is-open'));
    toggle.setAttribute('aria-expanded', 'true');
    const current = sheet.querySelector('.dock-sections [aria-current]') ?? sheet.querySelector('.dock-links [aria-current]');
    (current ?? focusable()[1])?.focus();
  }

  function close(returnFocus = true) {
    dock.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    const hide = () => {
      sheet.hidden = true;
      backdrop.hidden = true;
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) hide();
    else sheet.addEventListener('transitionend', hide, { once: true });
    if (returnFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => {
    if (dock.classList.contains('is-open')) close();
    else open();
  });
  backdrop.addEventListener('click', () => close());
  sheet.querySelector('.dock-close').addEventListener('click', () => close());

  // Following a link closes the sheet; the browser then navigates.
  sheet.addEventListener('click', (event) => {
    if (event.target.closest('a')) close(false);
  });

  // Escape closes the sheet, and Tab stays inside it while it is open.
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

// Updates the pill label, the highlighted section and the progress ring.
function trackScroll(dock, data) {
  const label = dock.querySelector('.dock-current');
  const links = new Map([...dock.querySelectorAll('.dock-sections a')].map((link) => [link.dataset.section, link]));
  const headings = data.sections.map((section) => document.getElementById(section.id)).filter(Boolean);
  let pending = false;

  function update() {
    pending = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    dock.style.setProperty('--progress', String(max > 0 ? Math.min(1, scrollY / max) : 0));

    if (!headings.length) return;
    // The current section is the last heading above the upper third of the screen.
    const line = innerHeight * 0.35;
    const current = headings.filter((heading) => heading.getBoundingClientRect().top < line).at(-1) ?? headings[0];
    const section = data.sections.find((item) => item.id === current.id);
    label.textContent = section.label;
    for (const [id, link] of links) {
      if (id === current.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  window.addEventListener('scroll', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

function setupDock() {
  const data = readData();
  if (!data) return;

  const dock = createElement('div', 'dock');
  const backdrop = createElement('div', 'dock-backdrop');
  backdrop.hidden = true;
  dock.append(buildToggle(data), backdrop, buildSheet(data));
  document.body.append(dock);

  setupSheet(dock);
  trackScroll(dock, data);
}

setupDock();
