// Copy buttons for command blocks (pre.cmd). The button shows an icon and a
// label; on phones only the icon shows until a copy succeeds or fails.
import { announce } from './announce.js';

const RESET_AFTER_MS = 2200;

const ICONS = {
  idle: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.2"/>',
  ok: '<path d="M3 8.5 6.4 12 13 4.5"/>',
  error: '<path d="M4 4l8 8M12 4l-8 8"/>',
};

const LABELS = {
  idle: 'Copy',
  ok: 'Copied',
  error: 'Copy failed',
};

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for insecure contexts and older browsers.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('The copy command failed');
}

function setState(button, state) {
  button.querySelector('svg').innerHTML = ICONS[state];
  button.querySelector('.copy-label').textContent = LABELS[state];
  if (state === 'idle') delete button.dataset.state;
  else button.dataset.state = state;
}

// Selects the text so a reader can copy it by hand after a failure.
function selectContents(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}

function addCopyButton(pre) {
  const code = pre.querySelector('code');
  if (!code) return;

  const wrap = document.createElement('div');
  wrap.className = 'cmd-wrap';
  pre.replaceWith(wrap);
  wrap.append(pre);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></svg><span class="copy-label"></span>';
  button.setAttribute('aria-label', pre.classList.contains('prompt') ? 'Copy setup prompt' : 'Copy command');
  setState(button, 'idle');

  let resetTimer;
  button.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    try {
      await copyText(code.textContent);
      setState(button, 'ok');
      announce('Copied to clipboard.');
    } catch {
      setState(button, 'error');
      announce('Copy failed. Select the text and copy it manually.');
      selectContents(code);
    }
    resetTimer = setTimeout(() => setState(button, 'idle'), RESET_AFTER_MS);
  });

  wrap.append(button);
}

export function setupCopyButtons() {
  document.querySelectorAll('pre.cmd').forEach(addCopyButton);
}
