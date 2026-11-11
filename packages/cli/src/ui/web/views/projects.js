import { get, projectRoute, send } from '../api.js';
import { badge, button, card, date, displayPath, el, empty, link, loadSection, number, pageHeader } from '../components.js';
import { confirmDialog } from '../forms.js';

/** A card per project: its name and folder, when it was used, its settings files, and buttons to open it or its rules. */
function projectCard(project, forget) {
  const item = el('li', 'project-card');
  const heading = el('h2', 'project-card-name');
  heading.append(link(project.name, projectRoute(project.root)));
  // The bidi marks keep the right-to-left ellipsis from moving the leading ~ to the end.
  const folder = el('p', 'path project-card-path', `\u200e${displayPath(project.root)}\u200e`);
  folder.title = displayPath(project.root);
  const sessions = project.launches + project.runs;
  const meta = el('p', 'known-project-meta');
  if (sessions) meta.append(`${number(sessions)} ${sessions === 1 ? 'session' : 'sessions'}${project.lastUsed ? `, last ${date(project.lastUsed)}` : ''}`);
  else meta.append(project.savedAt ? `No sessions yet. Settings saved ${date(project.savedAt)}.` : 'No sessions yet.');
  const badges = el('div', 'project-badges');
  if (project.hasSharedSettings) badges.append(badge('Shared settings'));
  if (project.hasLocalSettings) badges.append(badge('Personal settings'));
  if (!project.hasSharedSettings && !project.hasLocalSettings) badges.append(badge('Global settings'));
  const actions = el('div', 'form-actions project-card-actions');
  const open = link('Open', projectRoute(project.root), 'button-link primary');
  open.setAttribute('aria-label', `Open ${project.name}`);
  const rules = link('Rules', `${projectRoute(project.root)}?tab=rules`, 'button-link');
  rules.setAttribute('aria-label', `Rules for ${project.name}`);
  actions.append(open, rules);
  // Only a project Fonn remembers from a save, with no sessions, can be forgotten. Sessions would bring it back.
  if (project.savedAt && !sessions) {
    const trigger = button('Forget', () => confirmDialog({
      title: `Forget ${project.name}?`,
      message: 'It leaves this list. Its settings files and rules stay in the project, and it comes back when an agent works there or you open it again.',
      confirmLabel: 'Forget',
      returnFocus: () => trigger,
      action: () => forget(project),
    }), 'quiet-danger');
    trigger.setAttribute('aria-label', `Forget ${project.name}`);
    actions.append(trigger);
  }
  item.append(heading, folder, meta, badges, actions);
  return item;
}

export async function projectsView(target, signal) {
  target.append(pageHeader('Projects', 'Projects', 'A project shows up once an agent works in it. Without its own settings and rules, it uses your global ones.'));
  const content = el('div', 'projects-page');
  target.append(content);
  await loadSection(content, async () => {
    let data = await get('projects', { signal });
    const how = el('p', 'section-description', 'A project appears here once an agent works in it with the Fonn hook, or when you save settings or rules for it here.');
    if (!data.projects.length) {
      const section = card('No projects yet');
      const start = el('div', 'empty-state');
      start.append(
        el('p', '', 'Until you add project settings, every project uses your global settings and rules.'),
        el('p', '', 'Install the hook for your agent and work as usual: each project shows up after the first command. To set one up before that, open it by its folder.'),
      );
      const actions = el('div', 'form-actions projects-actions');
      // The hook is how most projects arrive, so it comes first.
      actions.append(link('Install the hook', '#/global/agents', 'button-link primary'), link('Open a project', '#/projects/open', 'button-link'));
      section.append(how, start, actions);
      content.append(section);
      return;
    }
    const toolbar = el('div', 'projects-toolbar');
    const search = el('input', 'projects-search');
    search.type = 'search';
    search.placeholder = 'Search projects by name or folder';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search projects');
    toolbar.append(search, link('Open a project', '#/projects/open', 'button-link'));
    const count = el('p', 'section-description projects-count');
    count.setAttribute('aria-live', 'polite');
    const grid = el('ul', 'project-grid');
    const none = empty('No project matches that search.');
    let cards = [];
    const build = () => {
      cards = data.projects.map((project) => ({ node: projectCard(project, forget), text: `${project.name} ${displayPath(project.root)} ${project.root}`.toLowerCase() }));
    };
    async function forget(project) {
      data = await send('DELETE', `projects/remembered?root=${encodeURIComponent(project.root)}`);
      build();
      show();
      search.focus();
    }
    function show() {
      const query = search.value.trim().toLowerCase();
      const visible = cards.filter((entry) => !query || entry.text.includes(query));
      grid.replaceChildren(...visible.map((entry) => entry.node));
      none.hidden = visible.length > 0;
      count.textContent = query ? `${number(visible.length)} of ${number(cards.length)} projects` : `${number(cards.length)} ${cards.length === 1 ? 'project' : 'projects'}`;
    }
    search.addEventListener('input', show);
    // Escape clears the search, so the full list is one key away.
    search.addEventListener('keydown', (event) => { if (event.key === 'Escape' && search.value) { search.value = ''; show(); } });
    build();
    show();
    content.append(toolbar, count, grid, none);
  }, signal);
}
