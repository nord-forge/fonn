export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function link(text, href, className) {
  const node = el('a', className, text);
  node.href = href;
  return node;
}

export function button(text, action, className = '') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export const number = (value) => new Intl.NumberFormat().format(value);
export function date(value) {
  if (!value) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown date' : parsed.toLocaleString();
}

export function badge(text, tone = '') {
  return el('span', `badge ${tone}`, text);
}

export function pageHeader(section, title, description) {
  const header = el('header', 'page-header');
  header.append(el('p', 'eyebrow', section), el('h1', '', title));
  if (description) header.append(el('p', 'page-description', description));
  return header;
}

export function card(title, description) {
  const section = el('section', 'card');
  section.append(el('h2', '', title));
  if (description) section.append(el('p', 'section-description', description));
  return section;
}

export function empty(message) {
  return el('p', 'empty-state', message);
}

export function warning(message) {
  const node = el('p', 'notice warning', message);
  node.setAttribute('role', 'alert');
  return node;
}

export function loading(target, message = 'Loading…') {
  const node = el('p', 'loading', message);
  node.setAttribute('role', 'status');
  target.append(node);
  target.setAttribute('aria-busy', 'true');
  return () => {
    node.remove();
    target.removeAttribute('aria-busy');
  };
}

// Each section handles its own failure so other available records remain readable.
export async function loadSection(target, task, signal) {
  const done = loading(target);
  try {
    await task();
  } catch (error) {
    if (error.name !== 'AbortError' && !signal?.aborted) target.append(warning(error.message));
  } finally {
    done();
  }
}

export function table(headers, rows, label) {
  const wrapper = el('div', 'table-scroll');
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', label);
  const grid = el('table');
  const caption = el('caption', 'sr-only', label);
  const head = el('thead');
  const headerRow = el('tr');
  for (const name of headers) {
    const cell = el('th', '', name);
    cell.scope = 'col';
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = el('tbody');
  for (const values of rows) {
    const row = el('tr');
    for (const value of values) {
      const cell = el('td');
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value === null || value === undefined ? 'Not set' : String(value);
      row.append(cell);
    }
    body.append(row);
  }
  grid.append(caption, head, body);
  wrapper.append(grid);
  return wrapper;
}

export function fields(entries) {
  const list = el('dl', 'fields');
  for (const [label, value] of entries) {
    const row = el('div');
    const content = el('dd');
    if (value instanceof Node) content.append(value);
    else content.textContent = value === null || value === undefined ? 'Not recorded' : String(value);
    row.append(el('dt', '', label), content);
    list.append(row);
  }
  return list;
}

export function totals(values, compact = false) {
  const list = el('dl', compact ? 'totals compact' : 'totals');
  for (const [key, label] of [
    ['decisions', 'Decisions'], ['filtered', 'Filtered'],
    ['originalCharacters', 'Characters in'], ['deliveredCharacters', 'Characters delivered'],
    ['removedLines', 'Lines removed'], ['observed', 'Observed'], ['unchanged', 'Unchanged'],
  ]) {
    const item = el('div', 'metric');
    item.append(el('dt', '', label), el('dd', '', number(values[key])));
    list.append(item);
  }
  return list;
}

export function code(text) {
  const block = el('pre', 'code-block');
  block.tabIndex = 0;
  block.append(el('code', '', text));
  return block;
}

/** Filter settings come first: the hook uses them. Profile and subagents only apply to fonn claude and fonn codex. */
export const filterSettingKeys = ['filterMode', 'filterLevel'];
export const launchSettingKeys = ['profile', 'subagents'];
export const settingKeys = [...filterSettingKeys, ...launchSettingKeys];
export const sourceLabel = (source) => ({ flag: 'flag', local: 'personal', shared: 'shared', global: 'global', default: 'built-in default' })[source] ?? source;
