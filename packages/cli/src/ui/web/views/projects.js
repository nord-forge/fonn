import { get, projectRoute, send } from '../api.js';
import { badge, card, date, displayPath, el, empty, link, loadSection, number, pageHeader } from '../components.js';
import { confirmDialog, field } from '../forms.js';

/** One row per project, newest first, with its settings files and a link to its rules. */
function projectRow(project, forget) {
  const item = el('li', 'project-row');
  const main = el('div', 'project-row-main');
  main.append(link(project.name, projectRoute(project.root), 'known-project-name'), el('span', 'path', displayPath(project.root)));
  const meta = el('p', 'known-project-meta');
  const facts = [];
  const sessions = project.launches + project.runs;
  if (project.lastUsed) facts.push(`Last used ${date(project.lastUsed)}`);
  if (sessions) facts.push(`${number(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`);
  else facts.push(project.savedAt ? `Settings saved ${date(project.savedAt)}, no sessions yet` : 'No sessions yet');
  meta.append(facts.join(' · '));
  const badges = el('div', 'project-badges');
  if (project.hasSharedSettings) badges.append(badge('Shared settings'));
  if (project.hasLocalSettings) badges.append(badge('Personal settings'));
  const rules = link('Rules', `${projectRoute(project.root)}?tab=rules`, 'project-rules-link');
  rules.setAttribute('aria-label', `Rules for ${project.name}`);
  const links = el('div', 'project-row-actions');
  links.append(rules);
  // Only a project Fonn remembers from a save, with no sessions, can be forgotten. Sessions would bring it back.
  if (project.savedAt && !sessions) {
    const trigger = el('button', 'link-button', 'Forget');
    trigger.type = 'button';
    trigger.setAttribute('aria-label', `Forget ${project.name}`);
    trigger.addEventListener('click', () => confirmDialog({
      title: `Forget ${project.name}?`,
      message: 'It leaves this list. Its settings files and rules stay in the project, and it comes back when an agent works there or you open it again.',
      confirmLabel: 'Forget',
      returnFocus: () => trigger,
      action: () => forget(project),
    }));
    links.append(trigger);
  }
  item.append(main, meta, badges, links);
  return item;
}

export async function projectsView(target, signal) {
  target.append(pageHeader('Projects', 'Projects', 'Each project can have its own settings and filter rules. They only apply in that project. Without them, a project uses your global settings and rules.'));
  const section = card('Your projects');
  target.append(section);
  await loadSection(section, async () => {
    let data = await get('projects', { signal });
    const actions = el('div', 'form-actions projects-actions');
    actions.append(link('Open a project', '#/projects/open', 'button-link primary'));
    const how = el('p', 'section-description', 'A project appears here once an agent works in it with the Fonn hook, or when you save settings or rules for it here.');
    if (!data.projects.length) {
      const start = el('div', 'empty-state');
      start.append(
        el('p', '', 'No projects yet. Until you add project settings, every project uses your global settings and rules.'),
        el('p', '', 'Install the hook for your agent and work as usual: each project shows up after the first command. To set one up before that, open it by its folder.'),
      );
      // The hook is how most projects arrive, so it comes first.
      actions.replaceChildren(link('Install the hook', '#/global/agents', 'button-link primary'), link('Open a project', '#/projects/open', 'button-link'));
      section.append(how, start, actions);
      return;
    }
    const search = field('Find a project');
    search.input.type = 'search';
    search.input.placeholder = 'Name or folder';
    search.input.autocomplete = 'off';
    const count = el('p', 'section-description');
    count.setAttribute('aria-live', 'polite');
    const list = el('ul', 'known-projects');
    let rows = [];
    const build = () => {
      rows = data.projects.map((project) => ({ project, node: projectRow(project, forget), text: `${project.name} ${displayPath(project.root)}`.toLowerCase() }));
    };
    async function forget(project) {
      data = await send('DELETE', `projects/remembered?root=${encodeURIComponent(project.root)}`);
      build();
      show();
      search.input.focus();
    }
    build();
    function show() {
      const query = search.input.value.trim().toLowerCase();
      const visible = rows.filter((row) => !query || row.text.includes(query));
      list.replaceChildren(...visible.map((row) => row.node));
      count.textContent = query ? `${number(visible.length)} of ${number(rows.length)} projects` : `${number(rows.length)} ${rows.length === 1 ? 'project' : 'projects'}`;
    }
    search.input.addEventListener('input', show);
    show();
    section.append(how);
    if (rows.length > 6) section.append(search.node);
    section.append(count, list, actions);
  }, signal);
}
