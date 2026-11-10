// Keeps the sticky offsets in step with Starlight's header and the controls
// heights, and marks the controls as stuck so they can show a shadow. CSS
// reads --topbar-height and --controls-height; see styles/visualiser.css.
import { root } from './elements.js';

export function setupStickyControls() {
  const controls = root.querySelector('.viz-controls');
  const topbar = document.querySelector('header.header');
  const style = document.documentElement.style;

  // An empty element just above the controls: once it leaves the area below
  // the top bar, the controls are stuck.
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  controls.before(sentinel);

  let observer;

  function measure() {
    const topbarHeight = Math.round(topbar.getBoundingClientRect().height);
    style.setProperty('--topbar-height', `${topbarHeight}px`);
    style.setProperty('--controls-height', `${Math.round(controls.getBoundingClientRect().height)}px`);

    observer?.disconnect();
    observer = new IntersectionObserver(([entry]) => {
      const stuck = !entry.isIntersecting && entry.boundingClientRect.top < topbarHeight;
      controls.classList.toggle('is-stuck', stuck);
    }, { rootMargin: `-${topbarHeight + 1}px 0px 0px 0px` });
    observer.observe(sentinel);
  }

  new ResizeObserver(measure).observe(controls);
  new ResizeObserver(measure).observe(topbar);
  measure();
}
