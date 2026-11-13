class QuickNavigation extends HTMLElement {
  connectedCallback() {
    const panel = this.querySelector<HTMLElement>('.quick-navigation')!;
    const close = this.querySelector<HTMLButtonElement>('[data-quick-close]')!;
    const search = this.querySelector<HTMLButtonElement>('[data-quick-search]')!;
    const searchTrigger = document.querySelector<HTMLButtonElement>('site-search [data-open-modal]');
    const exit = () => document.querySelector<HTMLElement>('header a[href]')?.focus();

    // Splash/custom pages can have headings without a Starlight table of contents.
    const sections = this.querySelector<HTMLElement>('.quick-navigation-sections')!;
    if (sections.hidden) {
      const list = sections.querySelector('ul')!;
      for (const heading of document.querySelectorAll<HTMLElement>('main h2[id]')) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${heading.id}`;
        link.textContent = heading.textContent;
        item.append(link);
        list.append(item);
      }
      sections.hidden = list.children.length === 0;
    }

    close.hidden = false;
    search.hidden = !searchTrigger;
    close.addEventListener('click', exit);
    search.addEventListener('click', (event) => {
      // Starlight listens for outside clicks once search opens. Keep this
      // original click from bubbling up and immediately closing the dialog.
      event.stopPropagation();
      // Focus the real trigger first so closing search returns to the header.
      if (!searchTrigger || searchTrigger.disabled) return;
      searchTrigger.focus();
      searchTrigger.click();
    });
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exit();
    });
    panel.addEventListener('click', (event) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link) return;
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      // Move keyboard focus as well as scrolling, so Tab continues in the content.
      const needsTabIndex = !target.hasAttribute('tabindex');
      if (needsTabIndex) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      if (needsTabIndex) target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    });
  }
}

customElements.define('fonn-quick-navigation', QuickNavigation);
