import { get, send } from '../api.js';
import { button, card, code, el, fields, loadSection, number, pageHeader } from '../components.js';
import { describeControls, feedback, field, select, settingValues } from '../forms.js';
import { rulesList } from '../rules.js';
import { takeTestRule } from '../test-context.js';

export async function testView(target, signal, root) {
  const draft = takeTestRule();
  target.append(pageHeader('Global / Test bench', 'Try the filter', 'Nothing is saved. Try command output with your saved settings or a rule you are editing.'));
  const section = card('Test inputs');
  target.append(section);
  await loadSection(section, async () => {
    const projects = await get('projects', { signal });
    const form = el('form');
    const command = field('Command');
    command.input.placeholder = 'npm run dev';
    command.input.value = draft?.command ?? '';
    const project = field('Project', select(projects.projects.map((entry) => [entry.root, `${entry.name} (${entry.root})`]), root ?? '', 'None / global'));
    const mode = field('Mode override', select(settingValues.filterMode, '', 'Use saved mode'));
    const level = field('Level override', select(settingValues.filterLevel, '', 'Use saved level'));
    const rulePanel = el('section', 'test-rules');
    const ruleStatus = feedback();
    const status = feedback();
    let rulesOverride = draft ? [draft] : undefined;
    let resolving = false;
    let generation = 0;
    const run = button('Run', () => {});
    run.type = 'submit';
    const ruleDescription = el('p', 'section-description');
    const list = el('div');
    const retryRules = button('Reload rules', () => resolveRules());
    retryRules.hidden = true;
    const reset = button('Use saved rules', () => {
      rulesOverride = undefined;
      resolveRules();
    });
    rulePanel.append(el('h3', '', 'Rules that will apply'), ruleDescription, list, reset, retryRules, ruleStatus.node);
    const output = field('Output', el('textarea'), 'Paste up to 200,000 characters of command output.');
    output.input.rows = 20;
    output.input.spellcheck = false;
    output.input.classList.add('test-output-input');
    const result = el('section', 'test-result');
    result.setAttribute('aria-label', 'Delivered output');
    const delivered = el('div');
    const decision = el('div', 'test-decision');
    result.append(el('h3', '', 'Delivered text'), delivered);
    delivered.append(el('p', 'section-description', 'Run the test to see what the model would receive.'));
    const comparison = el('div', 'test-comparison');
    comparison.append(output.node, result);
    const options = el('div', 'form-grid');
    options.append(project.node, mode.node, level.node);
    form.append(command.node, options, rulePanel, comparison, run, status.node, decision);
    describeControls(form, status.node);
    project.input.setAttribute('aria-describedby', `${project.input.getAttribute('aria-describedby')} ${ruleStatus.node.id}`);
    section.append(form);

    function clearResult() {
      decision.replaceChildren();
      delivered.replaceChildren(el('p', 'section-description', 'Run the test to see what the model would receive.'));
      status.show();
    }
    async function resolveRules() {
      const current = ++generation;
      clearResult();
      ruleStatus.show();
      retryRules.hidden = true;
      reset.hidden = rulesOverride === undefined;
      if (rulesOverride !== undefined) {
        ruleDescription.textContent = 'Only this draft rule applies. Saved custom rules are replaced for this test. Built-in filtering still follows the mode and level.';
        list.replaceChildren(rulesList(rulesOverride));
        run.disabled = false;
        resolving = false;
        return;
      }
      resolving = true;
      run.disabled = true;
      ruleDescription.textContent = 'Loading saved rules…';
      list.replaceChildren();
      try {
        const data = project.input.value
          ? await get('project', { query: { root: project.input.value }, signal })
          : await get('settings/global', { signal });
        if (current !== generation || signal.aborted) return;
        if (project.input.value && !data.effective) throw new Error('Fix the invalid project settings before testing this project.');
        const rules = project.input.value ? data.effective.rules ?? [] : data.settings.rules ?? [];
        ruleDescription.textContent = 'Saved custom rules apply along with built-in filtering.';
        list.replaceChildren(rulesList(rules, true));
        resolving = false;
        run.disabled = false;
      } catch (error) {
        if (current !== generation || signal.aborted) return;
        ruleDescription.textContent = 'Rules could not be loaded.';
        ruleStatus.show(error.message, true);
        retryRules.hidden = false;
      }
    }
    project.input.addEventListener('change', resolveRules);
    form.addEventListener('input', () => { clearResult(); command.error(); output.error(); });
    form.addEventListener('change', clearResult);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      command.error(!command.input.value.trim() ? 'Enter the command to test.' : '');
      output.error(output.input.value.length > 200000 ? 'Use at most 200,000 characters.' : '');
      if (!command.input.value.trim()) return command.input.focus();
      if (output.input.value.length > 200000) return output.input.focus();
      if (resolving || run.disabled) return;
      const body = { command: command.input.value, stdout: output.input.value };
      if (project.input.value) body.root = project.input.value;
      if (mode.input.value) body.mode = mode.input.value;
      if (level.input.value) body.level = level.input.value;
      if (rulesOverride !== undefined) body.rules = rulesOverride;
      const controls = [...form.querySelectorAll('input, select, textarea, button')];
      const disabled = controls.map((control) => control.disabled);
      controls.forEach((control) => { control.disabled = true; });
      status.show('Running…');
      decision.replaceChildren();
      try {
        const data = await send('POST', 'filter/test', body);
        if (signal.aborted) return;
        const value = data.decision;
        decision.append(el('h3', '', 'Decision'), fields([
          ['Status', value.status], ['Reason', value.reason], ['Adapter', value.adapter ?? 'None'],
          ['Lines removed', number(value.removedLines)], ['Characters in', number(value.originalCharacters)],
          ['Characters delivered', number(value.deliveredCharacters)], ['Mode', data.mode], ['Level', data.level],
        ]));
        list.replaceChildren(rulesList(data.rules));
        delivered.replaceChildren(code(data.delivered));
        status.show('Test complete. Nothing was saved.');
      } catch (error) {
        if (!signal.aborted) status.show(error.message, true);
      } finally {
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
      }
    });
    await resolveRules();
  }, signal);
}
