import { get, launchRoute, projectRoute } from '../api.js';
import { badge, card, date, el, empty, fields, link, loadSection, pageHeader, totals } from '../components.js';

function launchCard(launch) {
  const item = el('li', 'record');
  const header = el('div', 'record-heading');
  // Project, agent and profile are easier to scan than the launch ID.
  const project = launch.projectRoot.split('/').filter(Boolean).pop() ?? launch.projectRoot;
  const title = el('h3');
  title.append(link(`${project} · ${launch.provider} · ${launch.profile}`, launchRoute(launch.launchId)));
  const state = launch.exitCode !== null
    ? badge(`Exit ${launch.exitCode}`, launch.exitCode === 0 ? 'ok' : 'stop')
    : badge(launch.finishedAt ? 'Exit not recorded' : 'No finish recorded');
  header.append(title, state);
  const meta = el('p', 'record-meta', `${date(launch.createdAt)} · `);
  meta.append(el('span', 'mono', launch.launchId));
  item.append(header, meta);
  item.append(link(launch.projectRoot, projectRoute(launch.projectRoot), 'path record-path'));
  item.append(fields([
    ['Model', launch.model ?? 'Agent default'], ['Filter mode', launch.filterMode],
    ['Filter level', launch.filterLevel], ['Subagents', launch.subagents],
  ]), totals(launch.totals, true));
  return item;
}

function runCard(run) {
  const item = el('li', 'record');
  const header = el('div', 'record-heading');
  header.append(el('h3', 'mono', run.taskId), badge(run.status, run.status === 'succeeded' ? 'ok' : 'warn'));
  item.append(header, el('p', 'record-meta', `${run.profile} · ${date(run.startedAt)}`));
  item.append(link(run.projectRoot, projectRoute(run.projectRoot), 'path record-path'));
  item.append(fields([
    ['Finished', date(run.finishedAt)], ['Working folder', run.cwd], ['Filter mode', run.filterMode],
    ['Filter level', run.filterLevel ?? 'Not recorded'],
    ['Estimated API cost (USD)', new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(run.estimatedCostUsd)],
  ]), totals(run.totals, true));
  return item;
}

export async function activitySections(target, signal, root) {
  const query = root === undefined ? {} : { root };
  const launches = card('Recent launches', 'Native Claude and Codex sessions. Up to 200 recent records.');
  const runs = card('SDK runs', 'Structured tasks. API costs are estimates. Up to 200 recent records.');
  target.append(launches, runs);
  await Promise.all([
    loadSection(launches, async () => {
      const data = await get('launches', { signal, query });
      if (!data.launches.length) return launches.append(empty('No launches recorded yet. Launch fonn in a project to see its activity.'));
      const list = el('ul', 'record-list');
      const sorted = [...data.launches].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      for (const launch of sorted) list.append(launchCard(launch));
      launches.append(list);
    }, signal),
    loadSection(runs, async () => {
      const data = await get('runs', { signal, query });
      if (!data.runs.length) return runs.append(empty('No SDK runs recorded yet. Run a structured task with fonn run to see it here.'));
      const list = el('ul', 'record-list');
      const sorted = [...data.runs].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
      for (const run of sorted) list.append(runCard(run));
      runs.append(list);
    }, signal),
  ]);
}

export async function activityView(target, signal) {
  target.append(pageHeader('Global / Activity', 'Activity', 'Recent sessions and the output Fonn delivered. Counts are characters, not tokens.'));
  await activitySections(target, signal);
}
