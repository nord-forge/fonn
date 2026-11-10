// Turns [data-tabs] containers into accessible tabs. Each child with a
// data-tab-label becomes a panel. Without JavaScript all panels stay visible.

function createTabs(container, groupIndex) {
  const panels = [...container.children].filter((child) => child.dataset.tabLabel);
  if (panels.length < 2) return;

  const list = document.createElement('div');
  list.className = 'tablist';
  list.setAttribute('role', 'tablist');

  const tabs = panels.map((panel, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.id = `tab-${groupIndex}-${index}`;
    tab.textContent = panel.dataset.tabLabel;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);

    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;

    list.append(tab);
    return tab;
  });

  function select(next, moveFocus = false) {
    tabs.forEach((tab, index) => {
      const active = index === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
    });
    if (moveFocus) tabs[next].focus();
  }

  list.addEventListener('click', (event) => {
    const index = tabs.indexOf(event.target.closest('.tab'));
    if (index >= 0) select(index);
  });

  // Arrow keys, Home and End move between tabs, as the ARIA pattern expects.
  list.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const targets = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault();
    select((targets[event.key] + tabs.length) % tabs.length, true);
  });

  container.prepend(list);
  container.classList.add('tabs-ready');

  // Open the panel named in the URL hash, if any.
  const fromHash = panels.findIndex((panel) => `#${panel.id}` === location.hash);
  select(fromHash >= 0 ? fromHash : 0);
}

export function setupTabs() {
  document.querySelectorAll('[data-tabs]').forEach(createTabs);

  // A link to a panel inside a tab group, such as #install-homebrew, selects it.
  window.addEventListener('hashchange', () => {
    if (location.hash.length < 2) return;
    const panel = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!panel?.dataset.tabLabel) return;
    document.getElementById(panel.getAttribute('aria-labelledby'))?.click();
  });
}
