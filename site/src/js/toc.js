// Highlights the "On this page" sidebar link for the section in view.

export function setupToc() {
  const links = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (!links.length || !('IntersectionObserver' in window)) return;

  const linkById = new Map(links.map((link) => [link.getAttribute('href').slice(1), link]));
  const visible = new Set();

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    }

    const current = [...linkById.keys()].find((id) => visible.has(id));
    if (!current) return;

    for (const [id, link] of linkById) {
      if (id === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }, { rootMargin: '-80px 0px -55% 0px' });

  for (const id of linkById.keys()) {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  }
}
