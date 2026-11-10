// Mobile navigation dock for the Starlight site. A floating pill at the bottom
// of the screen shows the current section and scroll progress. Tapping it
// opens a sheet with the page's sections, the docs navigation, a theme switch
// and the GitHub link. styles/dock.css shows it below 50rem, where Starlight's
// own sidebar and table of contents are hidden.
//
// Data comes from the #dock-data JSON that components/Head.astro writes.

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

function currentTheme() {
  try {
    return localStorage.getItem('starlight-theme') || 'auto';
  } catch {
    return 'auto';
  }
}

// Same storage and attribute as Starlight's own theme select, which it then
// updates too, so both stay in step.
function applyTheme(value) {
  try {
    if (value === 'auto') localStorage.removeItem('starlight-theme');
    else localStorage.setItem('starlight-theme', value);
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const resolved = value === 'auto' ? (prefersLight ? 'light' : 'dark') : value;
  document.documentElement.dataset.theme = resolved;
  window.StarlightThemeProvider?.updatePickers(value);
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
    input.addEventListener('change', () => applyTheme(theme.value));
    label.append(input, createElement('span', '', theme.label));
    themes.append(label);
  }

  // A star icon with "Star" keeps this on one row with the theme switch,
  // even on a 360px screen. Screen readers hear the full label.
  const star = createElement('a', 'dock-star');
  star.href = github;
  star.setAttribute('aria-label', 'Star on GitHub');
  star.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .67.42l1.88 3.8 4.2.61a.75.75 0 0 1 .41 1.28l-3.04 2.96.72 4.18a.75.75 0 0 1-1.09.8L8 12.33l-3.75 1.97a.75.75 0 0 1-1.09-.8l.72-4.18L.84 6.36a.75.75 0 0 1 .41-1.28l4.2-.61L7.33.67A.75.75 0 0 1 8 .25Z"/></svg><span>Star</span>';
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
