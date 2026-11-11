import { get, send } from '../api.js';
import { badge, button, card, el, loadSection, pageHeader, warning } from '../components.js';
import { confirmDialog, feedback } from '../forms.js';
import { hookDiff } from '../hook-diff.js';

export function hookStatusBadge(status) {
  if (status.error) return ['Error', 'stop'];
  if (status.installed) return status.current ? ['Installed', 'ok'] : ['Needs update', 'warn'];
  return status.detected ? ['Not installed', ''] : ['Not detected', ''];
}

function planPreview(plan) {
  const preview = el('div', 'hook-plan');
  const summary = el('ul', 'hook-summary');
  for (const sentence of plan.summary) summary.append(el('li', '', sentence));
  preview.append(summary, el('p', 'path', plan.configPath));
  const lines = hookDiff(plan.before, plan.after);
  if (lines.length) {
    const diff = el('pre', 'hook-diff');
    diff.tabIndex = 0;
    diff.setAttribute('role', 'region');
    diff.setAttribute('aria-label', 'Configuration changes. Plus means added. Minus means removed.');
    const code = el('code');
    for (const line of lines) {
      if (line.kind === 'gap') { code.append(el('span', 'diff-gap', '  … lines without changes\n')); continue; }
      const prefix = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
      code.append(el('span', `diff-${line.kind}`, `${prefix} ${line.text}\n`));
    }
    diff.append(code);
    preview.append(diff);
  } else preview.append(el('p', 'section-description', 'No configuration text changes.'));
  if (plan.files.length) {
    preview.append(el('h3', '', 'Extra files'));
    const files = el('ul', 'hook-files');
    for (const file of plan.files) files.append(el('li', '', `${file.action === 'write' ? 'Write' : 'Remove'}: ${file.path}`));
    preview.append(files);
  }
  return preview;
}

/** "~/.codex/hooks.json" instead of the full home folder. The full path stays in the tooltip. */
export function shortPath(file) {
  return String(file).replace(/^(?:\/Users|\/home)\/[^/]+(?=\/)/, '~');
}

function agentCard(initial, signal, announcement) {
  const section = card(initial.label);
  section.classList.add('agent-card');
  section.tabIndex = -1;

  function render(status) {
    const heading = el('div', 'card-heading');
    heading.append(el('h2', '', status.label), badge(...hookStatusBadge(status)));
    const config = el('p', 'path agent-path', shortPath(status.configPath));
    config.title = status.configPath;
    section.replaceChildren(heading, config);
    if (status.note) section.append(el('p', 'section-description', status.note));
    if (status.error) section.append(warning(status.error));
    const actions = el('div', 'form-actions agent-actions');
    const message = feedback();
    if (!status.error) {
      // An up-to-date hook only needs Remove. Install or Update is the main action otherwise.
      if (!status.current) {
        const label = status.installed ? 'Update' : 'Install';
        const install = button(label, () => review('install', install), 'primary');
        install.setAttribute('aria-label', `${label} ${status.label} hook`);
        actions.append(install);
      }
      if (status.installed) {
        const remove = button('Remove', () => review('uninstall', remove), 'quiet-danger');
        remove.setAttribute('aria-label', `Remove ${status.label} hook`);
        actions.append(remove);
      }
    }
    section.append(actions, message.node);

    async function review(action, trigger) {
      trigger.disabled = true;
      message.show('Loading plan…');
      try {
        let plan = await get(`hooks/${status.agent}/plan`, { query: { action }, signal });
        if (signal.aborted) return;
        message.show();
        const content = el('div');
        content.append(planPreview(plan));
        confirmDialog({
          title: `${action === 'uninstall' ? 'Remove' : trigger.textContent} ${status.label} hook?`,
          message: 'Review these changes before applying them.',
          content,
          confirmLabel: action === 'uninstall' ? 'Remove' : trigger.textContent,
          destructive: action === 'uninstall',
          returnFocus: () => trigger.isConnected ? trigger : section,
          action: async () => {
            signal.throwIfAborted();
            try {
              const updated = await send('POST', `hooks/${status.agent}/apply`, { action, beforeHash: plan.beforeHash, afterHash: plan.afterHash });
              if (signal.aborted) return;
              render(updated);
              announcement.show(`${updated.label} hook ${action === 'uninstall' ? 'removed' : 'installed'}.`);
            } catch (error) {
              if (error.status !== 409) throw error;
              // Keep the dialog open. Confirm now applies the newly reviewed plan.
              let refreshed;
              try {
                refreshed = await get(`hooks/${status.agent}/plan`, { query: { action }, signal });
              } catch (reloadError) {
                throw new Error(`${error.message} ${reloadError.message}`);
              }
              // Someone else already made this change: there is nothing left to confirm.
              if (!refreshed.changes) {
                const statuses = await get('hooks', { signal });
                const current = statuses.find((entry) => entry.agent === status.agent);
                if (current && !signal.aborted) render(current);
                announcement.show(`Nothing to change. The ${status.label} hook is already ${action === 'uninstall' ? 'removed' : 'up to date'}.`);
                return;
              }
              plan = refreshed;
              content.replaceChildren(planPreview(plan));
              throw new Error(error.message);
            }
          },
        });
      } catch (error) {
        if (!signal.aborted) message.show(error.message, true);
      } finally { trigger.disabled = false; }
    }
  }
  render(initial);
  return section;
}

export async function agentsView(target, signal) {
  target.append(pageHeader('Global / Agents', 'Use Fonn with the tools you already have',
    'Install the hook once and keep using claude, codex, Crush, OpenCode or a GUI on top of them.'));
  const announcement = feedback();
  const agents = el('div', 'agent-grid');
  target.append(announcement.node, agents);
  await loadSection(agents, async () => {
    const statuses = await get('hooks', { signal });
    for (const status of statuses) agents.append(agentCard(status, signal, announcement));
  }, signal);
  const explanation = card('How it works');
  explanation.append(el('p', '', 'Hooks run inside your agent. Settings come from the project folder and your global settings. Project rules need your approval. Originals stay recoverable. If the hook fails, output passes through unchanged.'));
  target.append(explanation);
}
