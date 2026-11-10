// Mobile navigation: a floating pill at the bottom of the screen that shows the
// current section and scroll progress. Tapping it opens a sheet with the page's
// sections and the site links. Shown below 960px wide; see styles/dock.css.
const sections = [...document.querySelectorAll('main section[id]')]
  .map((section) => {
    const labelledBy = document.getElementById(section.getAttribute('aria-labelledby') ?? '');
    const label = section.getAttribute('aria-label') || labelledBy?.textContent || section.querySelector('h2')?.textContent || '';
    return { id: section.id, label: label.trim() };
  })
  .filter((section) => section.label);
const siteLinks = [...document.querySelectorAll('.topnav a, .topbar .star')];

if (sections.length && siteLinks.length) {
  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.innerHTML = `
    <button type="button" class="dock-toggle" aria-expanded="false" aria-controls="dock-sheet">
      <span class="dock-ring" aria-hidden="true"><span></span></span>
      <span class="dock-text">
        <span class="dock-kicker">On this page</span>
        <span class="dock-current"></span>
      </span>
      <svg class="dock-chevron" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 10 8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
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

  const toggle = dock.querySelector('.dock-toggle');
  const sheet = dock.querySelector('.dock-sheet');
  const backdrop = dock.querySelector('.dock-backdrop');
  const current = dock.querySelector('.dock-current');
  const list = dock.querySelector('.dock-sections');

  for (const [index, section] of sections.entries()) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.dataset.section = section.id;
    link.innerHTML = '<span class="dock-number"></span><span></span>';
    link.firstChild.textContent = String(index + 1).padStart(2, '0');
    link.lastChild.textContent = section.label;
    item.append(link);
    list.append(item);
  }
  for (const source of siteLinks) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = source.getAttribute('href');
    link.textContent = source.textContent.trim();
    if (source.getAttribute('aria-current') === 'page') link.setAttribute('aria-current', 'page');
    if (source.classList.contains('star')) link.classList.add('dock-star');
    item.append(link);
    dock.querySelector('.dock-links').append(item);
  }
  document.body.append(dock);

  const focusable = () => [...sheet.querySelectorAll('a, button')];
  const open = () => {
    sheet.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => dock.classList.add('is-open'));
    toggle.setAttribute('aria-expanded', 'true');
    (sheet.querySelector('[aria-current="location"]') ?? focusable()[1])?.focus();
  };
  const close = (returnFocus = true) => {
    dock.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    const done = () => { sheet.hidden = true; backdrop.hidden = true; };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else sheet.addEventListener('transitionend', done, { once: true });
    if (returnFocus) toggle.focus();
  };

  toggle.addEventListener('click', () => (dock.classList.contains('is-open') ? close() : open()));
  backdrop.addEventListener('click', () => close());
  dock.querySelector('.dock-close').addEventListener('click', () => close());
  // Following a link closes the sheet; the browser then scrolls to the target.
  sheet.addEventListener('click', (event) => { if (event.target.closest('a')) close(false); });
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  // Track the section in view and how far down the page the reader is.
  const links = new Map([...list.querySelectorAll('a')].map((link) => [link.dataset.section, link]));
  const visible = new Set();
  const setCurrent = (id) => {
    const section = sections.find((item) => item.id === id) ?? sections[0];
    current.textContent = section.label;
    for (const [key, link] of links) {
      if (key === section.id) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    }
  };
  setCurrent(sections[0].id);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id);
    const first = sections.find((section) => visible.has(section.id));
    if (first) setCurrent(first.id);
  }, { rootMargin: '-30% 0px -55% 0px' });
  for (const section of sections) observer.observe(document.getElementById(section.id));

  let pending = false;
  const progress = () => {
    pending = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    dock.style.setProperty('--progress', String(max > 0 ? Math.min(1, scrollY / max) : 0));
  };
  window.addEventListener('scroll', () => { if (!pending) { pending = true; requestAnimationFrame(progress); } }, { passive: true });
  progress();
}
