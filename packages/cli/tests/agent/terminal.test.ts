import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalRequest } from '@nord-forge/fonn-core/agent';
import { TerminalHost } from '../../src/agent/terminal.js';
import { streams } from './streams.js';

const command: ApprovalRequest = { kind: 'command', summary: 'npm test', detail: 'npm test\n# full command', target: 'npm test' };

for (const [answer, decision] of [['y', { allow: true }], ['a', { allow: true, remember: true }]] as const) {
  test(`approval ${answer} returns the explicit decision`, async () => {
    const io = streams();
    const host = new TerminalHost({ ...io, env: {} });
    try {
      const pending = host.approve(command);
      await io.waitFor('Allow?');
      assert.match(io.text(), /command:\n  npm test\n/);
      assert.match(io.text(), /\[a\]lways for this command/);
      io.input.write(`${answer}\n`);
      assert.deepEqual(await pending, decision);
    } finally { host.close(); }
  });
}

test('denial sends an optional reason to the model, including empty input', async () => {
  for (const answer of ['n', '']) {
    const io = streams();
    const host = new TerminalHost(io);
    try {
      const pending = host.approve(command);
      await io.waitFor('Allow?');
      io.input.write(`${answer}\n`);
      await io.waitFor('Tell the model why (optional):');
      io.input.write(answer ? 'Use the unit tests only\n' : '\n');
      assert.deepEqual(await pending, answer ? { allow: false, reason: 'Use the unit tests only' } : { allow: false });
    } finally { host.close(); }
  }
});

test('details show the diff and ask again before allowing a file change', async () => {
  const io = streams();
  const host = new TerminalHost(io);
  try {
    const pending = host.approve({ kind: 'edit', summary: 'Edit src/app.ts', detail: '--- src/app.ts\n+++ src/app.ts\n-old\n+new', target: '/project/src/app.ts' });
    await io.waitFor('Allow?');
    assert.match(io.text(), /\[a\]lways for this file/);
    io.input.write('d\n');
    await io.waitFor('Allow?', 2);
    assert.match(io.text(), /-old\n\+new/);
    assert.doesNotMatch(io.text(), /\x1b/);
    io.input.write('y\n');
    assert.deepEqual(await pending, { allow: true });
  } finally { host.close(); }
});

test('noninteractive approvals deny without asking', async () => {
  const io = streams(false);
  const host = new TerminalHost(io);
  try {
    assert.deepEqual(await host.approve(command), { allow: false, reason: 'Approvals need an interactive terminal. Run fonn chat in a TTY.' });
    assert.doesNotMatch(io.text(), /Allow\?/);
  } finally { host.close(); }
});

test('closing or cancelling an approval cannot leave an unanswered question', async () => {
  for (const close of [false, true]) {
    const io = streams();
    const host = new TerminalHost(io);
    const pending = host.approve(command);
    await io.waitFor('Allow?');
    if (close) host.close(); else host.cancelQuestion();
    assert.deepEqual(await pending, { allow: false, reason: 'Approval cancelled or terminal closed.' });
    host.close();
  }
});

test('events stream text, preserve failures and show context without ANSI outside a TTY', () => {
  const io = streams(false);
  const host = new TerminalHost(io);
  try {
    host.onEvent({ type: 'reasoning', text: 'Check tests' });
    host.onEvent({ type: 'text', text: 'Hello ' });
    assert.match(io.text(), /Check tests\nHello $/);
    host.onEvent({ type: 'text', text: 'world' });
    host.onEvent({ type: 'tool_start', id: '1', name: 'run_command', summary: 'npm test' });
    host.onEvent({ type: 'tool_end', id: '1', name: 'run_command', ok: true, summary: 'exit code 0', filter: { status: 'filtered', removedLines: 374, originalCharacters: 4120, deliveredCharacters: 380 } });
    host.onEvent({ type: 'tool_start', id: '2', name: 'run_command', summary: 'npm run lint' });
    host.onEvent({ type: 'tool_end', id: '2', name: 'run_command', ok: false, summary: 'exit code 1' });
    host.onEvent({ type: 'context_trimmed', removedMessages: 3 });
    host.onEvent({ type: 'error', message: 'Server failed\nretry\x1b[2J' });
    host.onEvent({ type: 'turn_end', contextTokens: 6246, contextLimit: 32768 });
    assert.match(io.text(), /Hello world\n> npm test\nOK npm test \(exit code 0, 4120 -> 380 chars, filtered\)/);
    assert.match(io.text(), /FAIL npm run lint \(exit code 1\)/);
    assert.match(io.text(), /Context trimmed: shortened 3 older tool outputs/);
    assert.match(io.text(), /Error: Server failed retry\\u001b\[2J/);
    assert.match(io.text(), /context 6\.1k \/ 32k tokens \(estimate\)/);
    assert.doesNotMatch(io.text(), /\x1b/);
  } finally { host.close(); }
});

test('long reasoning collapses and TTY dimming respects NO_COLOR', () => {
  for (const tty of [false, true]) for (const env of [{}, { NO_COLOR: '' }]) {
    const io = streams(false, tty);
    const host = new TerminalHost({ ...io, env });
    try {
      host.onEvent({ type: 'reasoning', text: 'short thought' });
      host.onEvent({ type: 'reasoning', text: 'long thought '.repeat(100) });
      host.onEvent({ type: 'reasoning', text: 'hidden thought' });
      host.onEvent({ type: 'text', text: 'Answer' });
      host.onEvent({ type: 'turn_end', contextTokens: 2000, contextLimit: 32768 });
      assert.match(io.text(), /thinking/);
      assert.doesNotMatch(io.text(), /hidden thought|long thought/);
      if (tty && env.NO_COLOR === undefined) assert.match(io.text(), /\x1b\[2m/);
      else assert.doesNotMatch(io.text(), /\x1b\[2m/);
      if (!tty) assert.match(io.text(), /^thinking\nAnswer\n/);
    } finally { host.close(); }
  }
});

test('TTY details colour added and removed lines', async () => {
  const io = streams(true, true);
  const host = new TerminalHost({ ...io, env: {} });
  try {
    const pending = host.approve({ kind: 'edit', summary: 'Edit a.ts', detail: '-old\n+new', target: '/a.ts' });
    await io.waitFor('Allow?');
    io.input.write('d\n');
    await io.waitFor('Allow?', 2);
    assert.match(io.text(), /\x1b\[31m-old/);
    assert.match(io.text(), /\x1b\[32m\+new/);
    io.input.write('y\n');
    assert.deepEqual(await pending, { allow: true });
  } finally { host.close(); }
});

test('reasoning collapses before it wraps on a narrow terminal', () => {
  const io = streams(false, true);
  io.output.columns = 40;
  const host = new TerminalHost({ ...io, env: {} });
  try {
    host.onEvent({ type: 'reasoning', text: 'A short thought' });
    host.onEvent({ type: 'reasoning', text: ' with more reasoning than fits on this terminal' });
    host.onEvent({ type: 'turn_end', contextTokens: 1000, contextLimit: 32768 });
    assert.match(io.text(), /\r\x1b\[2K\x1b\[2mthinking/);
    assert.doesNotMatch(io.text(), /with more reasoning/);
  } finally { host.close(); }
});

test('a command approval shows every line, so nothing hides behind a harmless first line', async () => {
  const io = streams();
  const host = new TerminalHost(io);
  try {
    const sneaky: ApprovalRequest = { kind: 'command', summary: 'echo hi', detail: 'echo hi\nrm -rf ./build', target: 'echo hi\nrm -rf ./build' };
    const pending = host.approve(sneaky);
    await io.waitFor('Allow?');
    assert.match(io.text(), /  echo hi\n  rm -rf \.\/build\n/);
    io.input.write('n\n');
    await io.waitFor('Tell the model why (optional):');
    io.input.write('\n');
    assert.deepEqual(await pending, { allow: false });
  } finally { host.close(); }
});
