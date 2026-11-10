import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentOptions, ChatMessage } from '@nord-forge/fonn-core/agent';
import { runChat, type ChatDependencies, type ChatOptions } from '../../src/agent/chat.js';
import { streams } from './streams.js';

const options: ChatOptions = { model: 'fixture-model', baseUrl: 'http://localhost:11434/v1', root: '/fixture/project', stateDirectory: '/fixture/state', filterMode: 'observe', filterLevel: 'strict', contextTokens: 8192, filterRules: [{ name: 'noise', command: 'npm test', remove: ['heartbeat'] }] };
const fakeClient: NonNullable<ChatDependencies['createClient']> = ({ model }) => ({ model, complete: async () => { throw new Error('The test must not call a model'); } });

test('chat runs multiline turns, commands, reset and resolved error events offline', async () => {
  const io = streams();
  const agents: AgentOptions[] = [];
  const turns: string[] = [];
  const run = runChat(options, {
    ...io, env: {}, onInterrupt: () => () => {}, createClient: fakeClient,
    createAgent: settings => {
      agents.push(settings);
      const messages: ChatMessage[] = [{ role: 'system', content: 'fixture instructions' }];
      return {
        sessionId: `fixture-${agents.length}`, messages: () => messages,
        send: async text => {
          turns.push(text);
          messages.push({ role: 'user', content: text });
          settings.host.onEvent({ type: 'error', message: 'Fixture model failed' });
          settings.host.onEvent({ type: 'turn_end', contextTokens: 500, contextLimit: 8192 });
        },
      };
    },
  });
  await io.waitFor('› ');
  assert.match(io.text(), /Model: fixture-model\nServer: http:\/\/localhost:11434\/v1\nProject: \/fixture\/project\nFilter: observe, level strict/);
  assert.match(io.text(), /Every command and file change asks first/);
  io.input.write('/help\n');
  await io.waitFor('› ', 2);
  assert.match(io.text(), /\/clear  Start a new conversation/);
  io.input.write('first line\\\n');
  await io.waitFor('... ');
  io.input.write('second line\n');
  await io.waitFor('› ', 3);
  assert.deepEqual(turns, ['first line\nsecond line']);
  assert.match(io.text(), /Error: Fixture model failed/);
  io.input.write('/context\n');
  await io.waitFor('› ', 4);
  assert.match(io.text(), /context .* \/ 8k tokens \(estimate\)/);
  io.input.write('/clear\n');
  await io.waitFor('› ', 5);
  assert.equal(agents.length, 2);
  assert.notEqual(agents[0]!.stateDirectory, agents[1]!.stateDirectory);
  for (const settings of agents) {
    assert.equal(settings.root, options.root);
    assert.equal(settings.filterMode, 'observe');
    assert.equal(settings.filterLevel, 'strict');
    assert.deepEqual(settings.filterRules, options.filterRules);
    assert.equal(settings.contextTokens, 8192);
    assert.ok(settings.stateDirectory.startsWith(join(options.stateDirectory!, 'agent') + '/'));
  }
  io.input.write('/exit\n');
  assert.equal(await run, 0);
  assert.doesNotMatch(io.text(), /\x1b/);
});

test('Ctrl+C aborts a turn and two empty prompt interrupts exit and detach', async () => {
  const io = streams();
  let interrupt: (() => void) | undefined;
  let detached = false;
  let signal: AbortSignal | undefined;
  const run = runChat(options, {
    ...io, createClient: fakeClient,
    onInterrupt: handler => { interrupt = handler; return () => { detached = true; }; },
    createAgent: settings => ({
      sessionId: 'fixture', messages: () => [],
      send: async (_text, incoming) => {
        signal = incoming;
        settings.host.onEvent({ type: 'text', text: 'Working' });
        await new Promise<void>(resolve => incoming!.addEventListener('abort', () => resolve(), { once: true }));
      },
    }),
  });
  await io.waitFor('› ');
  io.input.write('start\n');
  await io.waitFor('Working');
  interrupt!();
  await io.waitFor('› ', 2);
  assert.equal(signal?.aborted, true);
  assert.match(io.text(), /Turn cancelled/);
  interrupt!();
  await io.waitFor('› ', 3);
  assert.match(io.text(), /Press Ctrl\+C again to exit/);
  interrupt!();
  assert.equal(await run, 0);
  assert.equal(detached, true);
});

test('Ctrl+C dismisses an approval before the next prompt', async () => {
  const io = streams();
  let interrupt: (() => void) | undefined;
  const run = runChat(options, {
    ...io, createClient: fakeClient,
    onInterrupt: handler => { interrupt = handler; return () => {}; },
    createAgent: settings => ({
      sessionId: 'fixture', messages: () => [],
      send: async () => {
        const decision = await settings.host.approve({ kind: 'command', summary: 'npm test', detail: 'npm test', target: 'npm test' });
        assert.equal(decision.allow, false);
      },
    }),
  });
  await io.waitFor('› ');
  io.input.write('test\n');
  await io.waitFor('Allow?');
  interrupt!();
  await io.waitFor('› ', 2);
  io.input.write('/exit\n');
  assert.equal(await run, 0);
});

test('Ctrl+D closes a pending prompt and the client key is absent from the header', async () => {
  const io = streams();
  const apiKey = 'fixture-secret';
  const run = runChat({ ...options, baseUrl: 'https://example.invalid/v1?secret=fixture-secret', apiKey }, {
    ...io, onInterrupt: () => () => {},
    createClient: settings => { assert.equal(settings.apiKey, apiKey); return fakeClient(settings); },
    createAgent: () => ({ sessionId: 'fixture', messages: () => [], send: async () => {} }),
  });
  await io.waitFor('› ');
  io.input.end();
  assert.equal(await run, 0);
  assert.match(io.text(), /Server: https:\/\/example.invalid\/v1\n/);
  assert.doesNotMatch(io.text(), /fixture-secret/);
});

test('TTY Ctrl+C clears typed input before the two empty prompt interrupts', async () => {
  const io = streams(true, true);
  const run = runChat(options, {
    ...io, env: {}, createClient: fakeClient, onInterrupt: () => () => {},
    createAgent: () => ({ sessionId: 'fixture', messages: () => [], send: async () => { throw new Error('must not send cancelled input'); } }),
  });
  await io.waitFor('› ');
  io.input.write('unfinished');
  io.input.write('\x03');
  await io.waitFor('Input cancelled.');
  // Let the aborted question settle and the next prompt become active.
  await new Promise<void>(resolve => setImmediate(resolve));
  io.input.write('\x03');
  await io.waitFor('Press Ctrl+C again to exit.');
  await new Promise<void>(resolve => setImmediate(resolve));
  io.input.write('\x03');
  assert.equal(await run, 0);
  assert.doesNotMatch(io.text(), /must not send/);
});

test('the real core loop renders a resolved model failure and stores only session metadata', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-chat-loop-'));
  const io = streams();
  try {
    const run = runChat({ ...options, root: directory, stateDirectory: directory, apiKey: 'fixture-key' }, {
      ...io, onInterrupt: () => () => {},
      createClient: ({ model }) => ({ model, complete: async () => { throw new Error('Fixture model unavailable'); } }),
    });
    await io.waitFor('› ');
    io.input.write('Hello fixture\n');
    await io.waitFor('› ', 2);
    assert.match(io.text(), /Error: Fixture model unavailable/);
    assert.match(io.text(), /context .* \/ 8k tokens/);
    io.input.write('/exit\n');
    assert.equal(await run, 0);
    const sessions = await readdir(join(directory, 'agent'));
    assert.equal(sessions.length, 1);
    const record = await readFile(join(directory, 'agent', sessions[0]!, 'session.json'), 'utf8');
    assert.equal(JSON.parse(record).userMessages, 1);
    assert.doesNotMatch(record + io.text(), /fixture-key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
