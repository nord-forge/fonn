import { get, projectRoute, SESSION_EXPIRED } from './api.js';
import { button, displayPath, el, link, number, pageHeader, setHome, warning } from './components.js';
import { overviewView, profilesView, globalRulesView } from './views/global.js';
import { agentsView } from './views/agents.js';
import { activityView } from './views/activity.js';
import { projectView } from './views/project.js';
import { launchView } from './views/launch.js';

import { testView } from './views/test.js';
import { openProjectView } from './views/open-project.js';

const main = document.querySelector('#main');
const sidebar = document.querySelector('#sidebar');
const menuToggle = document.querySelector('#menu-toggle');
let controller;
let sessionExpired = false;

function closeMenu(returnFocus = false) {
  sidebar.classList.remove('is-open');
  menuToggle.setAttribute('aria-expanded', 'false');
  if (returnFocus) menuToggle.focus();
}

menuToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('is-open');
  menuToggle.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('is-open')) closeMenu(true);
});
sidebar.addEventListener('click', (event) => {
  const anchor = event.target.closest('a');
  if (anchor) {
    closeMenu();
    if (anchor.getAttribute('href') === window.location.hash) main.focus();
  }
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  closeMenu();
  main.focus();
});

function updateNavigation() {
  for (const item of sidebar.querySelectorAll('nav a')) {
    if (item.getAttribute('href') === window.location.hash.split('?')[0]) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

async function loadProjects() {
  const target = document.querySelector('#project-navigation');
  try {
    const data = await get('projects');
    if (sessionExpired) return;
    document.querySelector('#project-count').textContent = number(data.projects.length);
    if (!data.projects.length) {
      target.replaceChildren(el('p', 'nav-note', 'Launch fonn in a project and it appears here'));
      return;
    }
    const list = el('ul', 'nav-list project-nav');
    for (const project of data.projects) {
      const item = el('li');
      const anchor = link('', projectRoute(project.root));
      anchor.title = displayPath(project.root);
      // The bidi marks keep a right-to-left ellipsis from moving the leading slash.
      anchor.append(el('span', 'project-name', project.name), el('span', 'project-path', `\u200e${displayPath(project.root)}\u200e`));
      item.append(anchor);
      list.append(item);
    }
    target.replaceChildren(list);
    updateNavigation();
  } catch (error) {
    if (sessionExpired) return;
    target.replaceChildren(el('p', 'nav-note', error.message), button('Try again', loadProjects, 'nav-retry'));
  }
}

function parseRoute(hash) {
  if (hash === '#/global/agents') return { title: 'Agents', view: agentsView };
  if (hash === '#/global') return { title: 'Overview', view: overviewView };
  if (hash === '#/global/rules') return { title: 'Rules', view: globalRulesView };
  if (hash === '#/test' || hash.startsWith('#/test?')) return { title: 'Test bench', view: testView, id: new URLSearchParams(hash.split('?')[1]).get('root') || undefined };
  if (hash === '#/global/profiles') return { title: 'Profiles', view: profilesView };
  if (hash === '#/global/activity') return { title: 'Activity', view: activityView };
  if (hash === '#/projects/open') return { title: 'Open a project', view: openProjectView };
  // A project page may carry its tab, as in #/project/<root>?tab=rules.
  const match = /^#\/(project|launch)\/([^/?]+)(?:\?[a-z=&]*)?$/.exec(hash);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2]);
    if (!id) return null;
    return { title: match[1] === 'project' ? 'Project' : 'Launch details', view: match[1] === 'project' ? projectView : launchView, id };
  } catch {
    return null;
  }
}

async function render(focus = true) {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  closeMenu();
  updateNavigation();
  const page = el('div', 'page');
  main.replaceChildren(page);
  if (focus) {
    main.focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  if (sessionExpired) {
    document.title = 'Fonn · Session expired';
    page.append(pageHeader('Local session', 'Session expired', 'Restart fonn ui and open the new URL printed in your terminal.'));
    return;
  }
  const route = parseRoute(window.location.hash);
  if (!route) {
    document.title = 'Fonn · Page not found';
    page.append(pageHeader('Fonn', 'Page not found', 'This address does not match a Fonn page.'), link('Back to overview', '#/global'));
    return;
  }
  document.title = `Fonn · ${route.title}`;
  try {
    await route.view(page, signal, route.id);
  } catch (error) {
    if (error.name !== 'AbortError' && !signal.aborted) page.append(warning(error.message));
  }
}

window.addEventListener('fonn:session-expired', () => {
  if (sessionExpired) return;
  sessionExpired = true;
  const banner = document.querySelector('#session-message');
  banner.textContent = SESSION_EXPIRED;
  banner.hidden = false;
  document.querySelector('#project-navigation').replaceChildren(el('p', 'nav-note', SESSION_EXPIRED));
  render();
});
window.addEventListener('hashchange', () => render());
if (!window.location.hash) {
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/global/agents`);
}
// The home folder shows as ~ in paths. Without it, paths show in full.
get('session').then((session) => setHome(session.home), () => {}).finally(() => {
  render(false);
  loadProjects();
});
