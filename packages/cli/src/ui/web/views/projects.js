import { get, projectRoute } from '../api.js';
import { badge, card, date, displayPath, el, empty, link, loadSection, number, pageHeader } from '../components.js';
import { field } from '../forms.js';

/** One row per project, newest first, with its settings files and a link to its rules. */
function projectRow(project) {
  const item = el('li', 'project-row');
  const main = el('div', 'project-row-main');
  main.append(link(project.name, projectRoute(project.root), 'known-project-name'), el('span', 'path', displayPath(project.root)));
  const meta = el('p', 'known-project-meta');
  const facts = [];
  if (project.lastUsed) facts.push(`Last used ${date(project.lastUsed)}`);
  facts.push(`${number(project.launches)} ${project.launches === 1 ? 'session' : 'sessions'}`);
  meta.append(facts.join(' · '));
  const badges = el('div', 'project-badges');
  if (project.hasSharedSettings) badges.append(badge('Shared settings'));
  if (project.hasLocalSettings) badges.append(badge('Personal settings'));
  const rules = link('Rules', `${projectRoute(project.root)}?tab=rules`, 'project-rules-link');
  rules.setAttribute('aria-label', `Rules for ${project.name}`);
  item.append(main, meta, badges, rules);
  return item;
}

export async function projectsView(target, signal) {
  target.append(pageHeader('Projects', 'Projects', 'Each project can have its own settings and filter rules. They only apply in that project.'));
  const section = card('Your projects');
  target.append(section);
  await loadSection(section, async () => {
    const data = await get('projects', { signal });
    const actions = el('div', 'form-actions projects-actions');
    actions.append(link('Open a project', '#/projects/open', 'button-link primary'));
    if (!data.projects.length) {
      section.append(empty('None yet. Launch an agent in a project with the hook installed, or open one by its folder.'), actions);
      return;
    }
    const search = field('Find a project');
    search.input.type = 'search';
    search.input.placeholder = 'Name or folder';
    search.input.autocomplete = 'off';
    const count = el('p', 'section-description');
    count.setAttribute('aria-live', 'polite');
    const list = el('ul', 'known-projects');
    const rows = data.projects.map((project) => ({ project, node: projectRow(project), text: `${project.name} ${displayPath(project.root)}`.toLowerCase() }));
    function show() {
      const query = search.input.value.trim().toLowerCase();
      const visible = rows.filter((row) => !query || row.text.includes(query));
      list.replaceChildren(...visible.map((row) => row.node));
      count.textContent = query ? `${number(visible.length)} of ${number(rows.length)} projects` : `${number(rows.length)} ${rows.length === 1 ? 'project' : 'projects'}`;
    }
    search.input.addEventListener('input', show);
    show();
    if (rows.length > 6) section.append(search.node);
    section.append(count, list, actions);
  }, signal);
}
