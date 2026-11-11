import { get, launchRoute, projectRoute, send } from '../api.js';
import { badge, button, card, date, el, empty, fields, link, loadSection, pageHeader, totals } from '../components.js';
import { confirmDialog, feedback, field, select } from '../forms.js';

const size = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Delete old records on request. Nothing here runs on its own. */
function cleanupCard(onDone) {
  const section = card('Clean up old records', 'Fonn keeps the full original of every output it shortens, in every hooked session and launch. They can hold private code, logs or printed secrets. Delete the ones you no longer need.');
  const days = select([['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['180', '180 days']], '30');
  const control = field('Not used for more than', days);
  const status = feedback();
  const trigger = button('Delete old records…', async () => {
    trigger.disabled = true;
    status.show('Counting…');
    try {
      const olderThanDays = Number(days.value);
      const counted = await send('POST', 'records/cleanup', { olderThanDays, confirm: false });
      if (!counted.records) { status.show(`No records unused for more than ${olderThanDays} days.`); return; }
      status.show();
      confirmDialog({
        title: `Delete ${counted.records} old ${counted.records === 1 ? 'record' : 'records'}?`,
        message: `${counted.records} ${counted.records === 1 ? 'record' : 'records'} (${counted.hookSessions} from hook sessions) not used for more than ${olderThanDays} days, ${size(counted.bytes)} with their archived originals. Records that become active meanwhile are kept. This cannot be undone.`,
        confirmLabel: 'Delete',
        returnFocus: trigger,
        action: async () => {
          const result = await send('POST', 'records/cleanup', { olderThanDays, confirm: true });
          status.show(`Deleted ${result.deleted} ${result.deleted === 1 ? 'record' : 'records'}.${result.kept ? ` Kept ${result.kept} that became active.` : ''}`);
          onDone();
        },
      });
    } catch (error) {
      status.show(error.message, true);
    } finally {
      trigger.disabled = false;
    }
  }, 'danger');
  const actions = el('div', 'form-actions');
  actions.append(trigger, status.node);
  section.append(control.node, actions);
  return section;
}

function launchCard(launch) {
  const item = el('li', 'record');
  const header = el('div', 'record-heading');
  // Project, agent and profile are easier to scan than the launch ID.
  const project = launch.projectRoot.split('/').filter(Boolean).pop() ?? launch.projectRoot;
  const title = el('h3');
  title.append(link(`${project} · ${launch.providerLabel} · ${launch.profile ?? 'no profile'}`, launchRoute(launch.launchId)));
  // A hook sees commands, not the session's end, so it never records a finish.
  const state = launch.origin === 'hook' ? badge('Hook session', 'accent')
    : launch.exitCode !== null
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
  const launches = card('Recent launches', 'Native launches and agent hook sessions. Up to 200 recent records.');
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
  const records = el('div');
  const load = () => { records.replaceChildren(); return activitySections(records, signal); };
  target.append(records, cleanupCard(() => { load(); }));
  await load();
}
