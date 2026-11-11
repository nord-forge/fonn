import { get, send, projectRoute } from '../api.js';
import { badge, button, card, code, date, displayPath, el, empty, fields, link, loadSection, number, pageHeader, totals, warning } from '../components.js';

import { confirmAction, confirmDialog } from '../forms.js';

function artifactReader(launchId, signal) {
  const panel = el('section', 'reader-panel artifact-reader');
  panel.id = 'artifact-reader';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Original output');
  let generation = 0;
  let activeButton;

  function close() {
    generation += 1;
    panel.hidden = true;
    panel.replaceChildren();
    activeButton?.setAttribute('aria-expanded', 'false');
    activeButton?.focus();
  }

  async function open(artifactId, trigger) {
    const current = ++generation;
    activeButton?.setAttribute('aria-expanded', 'false');
    activeButton = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    const heading = el('h3', '', 'Original output');
    heading.tabIndex = -1;
    const header = el('div', 'reader-heading');
    header.append(heading, button('Close', close));
    const range = el('p', 'reader-range');
    range.setAttribute('role', 'status');
    const output = code('');
    output.setAttribute('aria-label', 'Original output text');
    output.hidden = true;
    const feedback = el('div');
    let nextOffset = 0;
    let startOffset = 0;
    let received = false;
    let loadedText = '';
    const more = button('Load more', loadMore);
    more.hidden = true;
    panel.replaceChildren(header, el('p', 'path', artifactId), range, output, feedback, more);
    heading.focus();

    async function loadMore() {
      if (more.disabled || nextOffset === null || current !== generation || signal.aborted) return;
      more.disabled = true;
      feedback.replaceChildren();
      range.textContent = received ? 'Loading more characters…' : 'Loading original output…';
      try {
        const data = await get(`launches/${encodeURIComponent(launchId)}/artifacts/${encodeURIComponent(artifactId)}`, {
          query: { offset: nextOffset, limit: 4000 }, signal,
        });
        if (current !== generation || signal.aborted) return;
        if (!received) startOffset = data.offset;
        received = true;
        output.hidden = false;
        output.querySelector('code').append(document.createTextNode(data.text));
        loadedText += data.text;
        const end = data.offset + data.text.length;
        range.textContent = data.totalCharacters === 0
          ? 'Characters 0 to 0 of 0. This original is empty.'
          : `Characters ${number(startOffset + 1)} to ${number(end)} of ${number(data.totalCharacters)}`;
        nextOffset = data.nextOffset;
        more.textContent = 'Load more';
        more.hidden = nextOffset === null;
        if (nextOffset === null && startOffset === 0) showReadable(loadedText);
        if (more.hidden && document.activeElement === more) {
          range.tabIndex = -1;
          range.focus();
        }
      } catch (error) {
        if (current !== generation || signal.aborted || error.name === 'AbortError') return;
        range.textContent = received ? 'Could not load more characters. The output already loaded is shown below.' : 'Original output could not be loaded.';
        feedback.append(warning(error.message));
        more.textContent = 'Try again';
        more.hidden = false;
      } finally {
        more.disabled = false;
      }
    }

    // The archive stores the whole tool response as JSON. Once all of it is
    // loaded, show the command output as text, with the stored JSON a click away.
    function showReadable(text) {
      let response;
      try {
        response = JSON.parse(text);
      } catch {
        return;
      }
      if (!response || typeof response.stdout !== 'string') return;
      const readable = el('div', 'reader-readable');
      readable.append(el('p', 'reader-label', 'Command output'), code(response.stdout));
      if (typeof response.stderr === 'string' && response.stderr) {
        readable.append(el('p', 'reader-label', 'Error output'), code(response.stderr));
      }
      output.hidden = true;
      let raw = false;
      const toggle = button('Show raw JSON', () => {
        raw = !raw;
        output.hidden = !raw;
        readable.hidden = raw;
        toggle.textContent = raw ? 'Show command output' : 'Show raw JSON';
        toggle.setAttribute('aria-pressed', String(raw));
      });
      toggle.setAttribute('aria-pressed', 'false');
      output.before(readable);
      feedback.before(toggle);
    }

    await loadMore();
  }

  return { panel, open };
}

export async function launchView(target, signal, launchId) {
  target.append(pageHeader('Activity / Launch', 'Launch details', launchId));
  const content = el('div');
  target.append(content);
  await loadSection(content, async () => {
    const data = await get(`launches/${encodeURIComponent(launchId)}`, { signal });
    const launch = data.launch;
    const hooked = launch.origin === 'hook';
    const metadata = card(hooked ? 'Hook session' : 'Launch');
    if (hooked) metadata.append(el('p', 'section-description', 'Recorded by Fonn\'s hook inside the agent. It sees each command, not when the session ends.'));
    metadata.append(fields([
      ['Launch ID', launch.launchId], ['Agent', launch.providerLabel], ['Profile', launch.profile ?? 'no profile'],
      ['Model', launch.model ?? 'Agent default'], ['Project', link(displayPath(launch.projectRoot), projectRoute(launch.projectRoot), 'path')],
      ['Working folder', displayPath(launch.cwd)], ['Started', date(launch.createdAt)], ['Finished', date(launch.finishedAt)],
      ['Exit code', launch.exitCode === null ? 'Not recorded' : number(launch.exitCode)],
      ['Filter mode', launch.filterMode], ['Filter level', launch.filterLevel], ['Subagents', launch.subagents],
    ]));
    const filtering = card('Filter totals', 'Characters are output counts, not tokens or savings.');
    filtering.append(totals(launch.totals));
    const decisions = card('Decisions', 'Each recorded tool observation and what Fonn delivered.');
    const reader = artifactReader(launch.launchId, signal);
    content.append(metadata, filtering, decisions);
    if (!data.decisions.length) decisions.append(empty('No filter decisions recorded for this launch.'));
    else {
      const list = el('ol', 'decision-list');
      data.decisions.forEach((decision, index) => {
        const item = el('li', 'decision');
        const header = el('div', 'record-heading');
        header.append(el('h3', '', `Observation ${number(index + 1)}`), badge(decision.status, decision.status === 'filtered' ? 'accent' : ''));
        item.append(header, el('p', 'decision-reason', decision.reason), fields([
          ['Adapter', decision.adapter ?? 'None recorded'], ['Characters in', number(decision.originalCharacters)],
          ['Characters delivered', number(decision.deliveredCharacters)], ['Lines removed', number(decision.removedLines)],
        ]));
        if (decision.artifactId) {
          const trigger = button('View original', () => reader.open(decision.artifactId, trigger));
          trigger.setAttribute('aria-label', `View original for observation ${number(index + 1)}`);
          trigger.setAttribute('aria-expanded', 'false');
          trigger.setAttribute('aria-controls', reader.panel.id);
          item.append(trigger);
        }
        list.append(item);
      });
      decisions.append(list);
    }
    decisions.append(reader.panel);
    const cleanup = card('Clean up records');
    const remove = async (query = '') => {
      const result = await send('DELETE', `launches/${encodeURIComponent(launch.launchId)}${query}`);
      if (!signal.aborted && result.deleted === launch.launchId) window.location.hash = '#/global/activity';
    };
    // Deleting a hook session's records is safe while it is open: its next
    // command simply starts a new record.
    const trigger = confirmAction(hooked ? "Delete this session's records" : "Delete this launch's records", hooked
      ? "This removes the filter records and archived originals of this hook session from this machine. If the session is still open, its next command starts a new record. This cannot be undone."
      : "This removes this launch's filter records and archived originals from this machine. This cannot be undone.", async () => {
      try {
        await remove();
      } catch (error) {
        if (error.status !== 409) throw error;
        // No recorded finish: it may still be running, so ask once more.
        confirmDialog({ title: 'This launch may still be running', message: `${error.message} Its hook will lose its records if it is.`, confirmLabel: 'Delete anyway', action: () => remove('?confirm=running'), returnFocus: trigger });
      }
    }, { title: hooked ? "Delete this session's records?" : "Delete this launch's records?" });
    cleanup.append(trigger);
    content.append(cleanup);
  }, signal);
}
