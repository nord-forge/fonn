// Progressive enhancement shared by both pages: tabs, copy buttons and the
// "on this page" highlight. Without JavaScript every panel stays readable.
const live = document.getElementById('live');
const announce = (message) => {
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = message; });
};

function setupTabs(container, index) {
  const panels = [...container.children].filter((child) => child.dataset.tabLabel);
  if (panels.length < 2) return;
  const list = document.createElement('div');
  list.className = 'tablist';
  list.setAttribute('role', 'tablist');
  const tabs = panels.map((panel, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.id = `tab-${index}-${i}`;
    tab.textContent = panel.dataset.tabLabel;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    list.append(tab);
    return tab;
  });
  const select = (next, focus = false) => {
    tabs.forEach((tab, i) => {
      const active = i === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[i].hidden = !active;
    });
    if (focus) tabs[next].focus();
  };
  list.addEventListener('click', (event) => {
    const i = tabs.indexOf(event.target.closest('.tab'));
    if (i >= 0) select(i);
  });
  list.addEventListener('keydown', (event) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    select((keys[event.key] + tabs.length) % tabs.length, true);
  });
  container.prepend(list);
  container.classList.add('tabs-ready');
  // Open the panel named in the URL hash, if any.
  const fromHash = panels.findIndex((panel) => `#${panel.id}` === location.hash);
  select(fromHash >= 0 ? fromHash : 0);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy command failed');
}

function setupCopy(pre) {
  const code = pre.querySelector('code');
  if (!code) return;
  const wrap = document.createElement('div');
  wrap.className = 'cmd-wrap';
  pre.replaceWith(wrap);
  wrap.append(pre);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', pre.classList.contains('prompt') ? 'Copy setup prompt' : 'Copy command');
  let reset;
  button.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      await copyText(code.textContent);
      button.textContent = 'Copied';
      button.dataset.state = 'ok';
      announce('Copied to clipboard.');
    } catch {
      button.textContent = 'Copy failed';
      button.dataset.state = 'error';
      announce('Copy failed. Select the text and copy it manually.');
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    reset = setTimeout(() => { button.textContent = 'Copy'; delete button.dataset.state; }, 2200);
  });
  wrap.append(button);
}

function setupToc() {
  const links = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (!links.length || !('IntersectionObserver' in window)) return;
  const byId = new Map(links.map((link) => [link.getAttribute('href').slice(1), link]));
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id);
    const first = [...byId.keys()].find((id) => visible.has(id));
    if (!first) return;
    for (const [id, link] of byId) {
      if (id === first) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    }
  }, { rootMargin: '-80px 0px -55% 0px' });
  for (const id of byId.keys()) {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  }
}

document.querySelectorAll('[data-tabs]').forEach(setupTabs);
document.querySelectorAll('pre.cmd').forEach(setupCopy);
setupToc();

// Links to a panel inside a tab group (for example #install-homebrew) select it.
window.addEventListener('hashchange', () => {
  const panel = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  const tab = panel?.dataset.tabLabel && document.getElementById(panel.getAttribute('aria-labelledby'));
  tab?.click();
});
