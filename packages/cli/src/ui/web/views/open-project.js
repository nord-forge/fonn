import { get, projectRoute, send } from '../api.js';
import { button, card, date, displayPath, el, empty, link, loadSection, pageHeader } from '../components.js';
import { describeControls, feedback, field } from '../forms.js';

const absolute = (value) => value.startsWith('/') || value.startsWith('\\\\') || /^[a-z]:[\\/]/i.test(value);

export async function openProjectView(target, signal) {
  target.append(pageHeader('Projects', 'Open a project', 'Change the settings, rules and instructions of any project on this machine, including ones Fonn has not run in yet.'));

  const section = card('Open by path', 'Any Git repository root, or a folder that already has a Fonn settings file. A path inside a repository opens its root.');
  const form = el('form', 'open-project-form');
  const path = field('Project folder', el('input'), 'An absolute path, such as /Users/you/code/my-app.');
  path.input.placeholder = '/path/to/project';
  path.input.autocomplete = 'off';
  path.input.spellcheck = false;
  const status = feedback();
  const open = button('Open project', () => {}, 'primary');
  open.type = 'submit';
  const actions = el('div', 'form-actions');
  // Shown only when this system has a folder dialog the server can open.
  const choose = button('Choose folder…', () => pick());
  choose.hidden = true;
  actions.append(open, choose);
  form.append(path.node, actions, status.node);
  describeControls(form, status.node);
  section.append(form);
  form.addEventListener('input', () => { path.error(); status.show(); });
  async function pick() {
    if (choose.disabled) return;
    choose.disabled = true;
    open.disabled = true;
    status.show('A folder dialog is open. If you cannot see it, look behind this browser window.');
    try {
      const { path: chosen } = await send('POST', 'pick-folder', {});
      if (!chosen) { status.show('No folder chosen.'); return; }
      path.input.value = chosen;
      open.disabled = false;
      form.requestSubmit();
    } catch (error) {
      status.show(error.message, true);
    } finally {
      choose.disabled = false;
      open.disabled = false;
    }
  }
  get('pick-folder', { signal }).then((info) => {
    choose.hidden = !info.supported;
    if (info.supported) path.node.querySelector('.field-hint').textContent = 'An absolute path, such as /Users/you/code/my-app. Or use Choose folder to pick it in a dialog.';
  }).catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (open.disabled) return;
    const root = path.input.value.trim();
    if (!absolute(root)) {
      path.error('Enter an absolute path, starting with /.');
      path.input.focus();
      return;
    }
    open.disabled = true;
    status.show('Opening…');
    try {
      const project = await get('project', { query: { root }, signal });
      window.location.hash = projectRoute(project.root);
    } catch (error) {
      if (error.name === 'AbortError') return;
      status.show(error.status === 404 ? 'Fonn cannot open that folder. It must exist and be a Git repository, or already have a .fonn.json or .fonn/settings.local.json file.' : error.message, true);
      path.input.focus();
    } finally {
      open.disabled = false;
    }
  });

  const known = card('Projects Fonn knows', 'Folders where you launched Fonn or ran a task.');
  target.append(section, known);
  path.input.focus();
  await loadSection(known, async () => {
    const data = await get('projects', { signal });
    if (!data.projects.length) {
      known.append(empty('None yet. Launch fonn in a project and it appears here.'));
      return;
    }
    const list = el('ul', 'known-projects');
    for (const project of data.projects) {
      const item = el('li');
      const anchor = link(project.name, projectRoute(project.root), 'known-project-name');
      const meta = el('p', 'known-project-meta');
      meta.append(el('span', 'path', displayPath(project.root)));
      if (project.lastUsed) meta.append(` · last used ${date(project.lastUsed)}`);
      item.append(anchor, meta);
      list.append(item);
    }
    known.append(list);
  }, signal);
}
