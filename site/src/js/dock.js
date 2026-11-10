// Mobile navigation dock. A floating pill at the bottom of the screen shows
// the current section and scroll progress. Tapping it opens a sheet with the
// page's sections and the site links. CSS shows it below 960px wide; see
// styles/dock.css. Without JavaScript the plain link lists remain.

const DOCK_HTML = `
  <button type="button" class="dock-toggle" aria-expanded="false" aria-controls="dock-sheet">
    <span class="dock-ring" aria-hidden="true"><span></span></span>
    <span class="dock-text">
      <span class="dock-kicker">On this page</span>
      <span class="dock-current"></span>
    </span>
    <svg class="dock-chevron" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
      <path d="M3.5 10 8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
  <div class="dock-backdrop" hidden></div>
  <div class="dock-sheet" id="dock-sheet" role="dialog" aria-modal="true" aria-labelledby="dock-title" hidden>
    <div class="dock-sheet-head">
      <p class="dock-title" id="dock-title">On this page</p>
      <button type="button" class="dock-close">Close</button>
    </div>
    <ol class="dock-sections"></ol>
    <p class="dock-title">Site</p>
    <ul class="dock-links"></ul>
  </div>`;

// Page sections with an id, labelled by aria-label, aria-labelledby or their
// first heading, in that order.
function findSections() {
  return [...document.querySelectorAll('main section[id]')]
    .map((section) => {
      const labelledBy = document.getElementById(section.getAttribute('aria-labelledby') ?? '');
      const label = section.getAttribute('aria-label')
        || labelledBy?.textContent
        || section.querySelector('h2')?.textContent
        || '';
      return { id: section.id, label: label.trim() };
    })
    .filter((section) => section.label);
}

function buildSectionLinks(list, sections) {
  sections.forEach((section, index) => {
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.dataset.section = section.id;

    const number = document.createElement('span');
    number.className = 'dock-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const label = document.createElement('span');
    label.textContent = section.label;
    link.append(number, label);

    const item = document.createElement('li');
    item.append(link);
    list.append(item);
  });
}

// Copies the top bar's site links and GitHub star link into the sheet.
function buildSiteLinks(list, sources) {
  for (const source of sources) {
    const link = document.createElement('a');
    link.href = source.getAttribute('href');
    link.textContent = source.textContent.trim();
    if (source.getAttribute('aria-current') === 'page') link.setAttribute('aria-current', 'page');
    if (source.classList.contains('star')) link.classList.add('dock-star');

    const item = document.createElement('li');
    item.append(link);
    list.append(item);
  }
}

// Open, close, Escape, backdrop and focus handling for the sheet.
function setupSheet(dock) {
  const toggle = dock.querySelector('.dock-toggle');
  const sheet = dock.querySelector('.dock-sheet');
  const backdrop = dock.querySelector('.dock-backdrop');
  const focusable = () => [...sheet.querySelectorAll('a, button')];

  function open() {
    sheet.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => dock.classList.add('is-open'));
    toggle.setAttribute('aria-expanded', 'true');
    const currentLink = sheet.querySelector('[aria-current="location"]');
    (currentLink ?? focusable()[1])?.focus();
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
  dock.querySelector('.dock-close').addEventListener('click', () => close());

  // Following a link closes the sheet; the browser then scrolls to the target.
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

// Keeps the pill's label and the sheet's highlighted link on the section in view.
function trackCurrentSection(dock, sections) {
  const label = dock.querySelector('.dock-current');
  const linkById = new Map([...dock.querySelectorAll('.dock-sections a')].map((link) => [link.dataset.section, link]));
  const visible = new Set();

  function setCurrent(id) {
    const section = sections.find((item) => item.id === id) ?? sections[0];
    label.textContent = section.label;
    for (const [key, link] of linkById) {
      if (key === section.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  setCurrent(sections[0].id);

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    }
    const first = sections.find((section) => visible.has(section.id));
    if (first) setCurrent(first.id);
  }, { rootMargin: '-30% 0px -55% 0px' });

  for (const section of sections) observer.observe(document.getElementById(section.id));
}

// Fills the ring around the pill's icon as the reader scrolls down the page.
function trackScrollProgress(dock) {
  let pending = false;

  function update() {
    pending = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    const progress = max > 0 ? Math.min(1, scrollY / max) : 0;
    dock.style.setProperty('--progress', String(progress));
  }

  window.addEventListener('scroll', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }, { passive: true });

  update();
}

export function setupDock() {
  const sections = findSections();
  const siteLinks = [...document.querySelectorAll('.topnav a, .topbar .star')];
  if (!sections.length || !siteLinks.length) return;

  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.innerHTML = DOCK_HTML;
  buildSectionLinks(dock.querySelector('.dock-sections'), sections);
  buildSiteLinks(dock.querySelector('.dock-links'), siteLinks);
  document.body.append(dock);

  setupSheet(dock);
  trackCurrentSection(dock, sections);
  trackScrollProgress(dock);
}
