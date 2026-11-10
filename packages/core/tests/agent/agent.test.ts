import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgent, MAX_TOOL_ROUNDS, OMITTED_OUTPUT } from '../../src/agent/index.js';
import type { AgentEvent, AgentHost, ApprovalDecision, ChatMessage, ModelClient, ModelReply, ModelRequest } from '../../src/agent/index.js';

type Step = (request: ModelRequest, onEvent: Parameters<ModelClient['complete']>[1]) => ModelReply | Promise<ModelReply>;

function scripted(steps: Step[]) {
  const requests: ChatMessage[][] = [];
  const client: ModelClient = {
    model: 'fake-model',
    async complete(request, onEvent) {
      requests.push(request.messages.map((message) => ({ ...message })));
      const step = steps.shift();
      if (!step) throw new Error('no scripted reply left');
      return step(request, onEvent);
    },
  };
  return { client, requests };
}
const say = (text: string): Step => (_request, onEvent) => { onEvent({ type: 'text', text }); return { message: { role: 'assistant', content: text }, usage: { promptTokens: 10, completionTokens: 2 } }; };
const callTool = (name: string, args: string, id = `call_${name}`): Step => () => ({ message: { role: 'assistant', content: '', tool_calls: [{ id, name, arguments: args }] }, usage: { promptTokens: 20, completionTokens: 3 } });

async function setup(decide: () => ApprovalDecision = () => ({ allow: true })) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'fonn-agent-loop-')));
  const root = join(base, 'project');
  await mkdir(root);
  const events: AgentEvent[] = [];
  const host: AgentHost = { async approve() { return decide(); }, onEvent(event) { events.push(event); } };
  return { base, root, stateDirectory: join(base, 'state'), events, host };
}

function assertConsistent(messages: readonly ChatMessage[]) {
  const answered = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  for (const message of messages) for (const call of message.tool_calls ?? []) assert.ok(answered.has(call.id), `call ${call.id} has a result`);
}

test('calls tools, sends results back, answers, and records the session', async () => {
  const { root, stateDirectory, events, host } = await setup();
  await writeFile(join(root, 'notes.txt'), 'hello from the file\n');
  const { client, requests } = scripted([callTool('read_file', '{"path":"notes.txt"}'), say('The file says hello.')]);
  const agent = createAgent({ client, host, root, stateDirectory });
  await agent.send('What is in notes.txt?');
  const messages = agent.messages();
  assert.equal(messages[0]!.role, 'system');
  assert.match(messages[0]!.content, new RegExp(root.replace(/[/\\.]/g, '\\$&')));
  assert.match(messages[0]!.content, /read_original/);
  assert.ok(messages[0]!.content.length / 4 < 600);
  assert.deepEqual(messages.slice(1).map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[3]!.tool_call_id, 'call_read_file');
  assert.match(messages[3]!.content, /hello from the file/);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.at(-1)!.role, 'tool');
  assert.deepEqual(events.map((event) => event.type), ['tool_start', 'tool_end', 'text', 'turn_end']);
  const end = events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.deepEqual(end.usage, { promptTokens: 30, completionTokens: 5 });
  assert.equal(end.contextLimit, 32_768);
  assert.ok(end.contextTokens > 0);
  const record = JSON.parse(await readFile(join(stateDirectory, 'session.json'), 'utf8'));
  assert.equal(record.sessionId, agent.sessionId);
  assert.equal(record.model, 'fake-model');
  assert.equal(record.root, root);
  assert.equal(record.filterMode, 'filter');
  assert.equal(record.filterLevel, 'standard');
  assert.equal(record.messageCount, 5);
  assert.equal(record.toolCalls, 1);
  assert.doesNotMatch(JSON.stringify(record), /notes\.txt|hello/);
  assert.deepEqual((await readdir(stateDirectory)).filter((name) => name.endsWith('.tmp')), []);
});

test('invalid tool JSON and unknown tools become error results, not exceptions', async () => {
  const { root, stateDirectory, events, host } = await setup();
  const { client } = scripted([callTool('read_file', '{"path":'), callTool('format_disk', '{}'), say('Sorry.')]);
  const agent = createAgent({ client, host, root, stateDirectory });
  await agent.send('go');
  const tools = agent.messages().filter((message) => message.role === 'tool');
  assert.match(tools[0]!.content, /not valid JSON/);
  assert.match(tools[1]!.content, /unknown tool "format_disk"/);
  assert.deepEqual(events.filter((event) => event.type === 'tool_end').map((event) => (event as { ok: boolean }).ok), [false, false]);
});

test('a denied write goes back to the model with the reason', async () => {
  const { root, stateDirectory, host } = await setup(() => ({ allow: false, reason: 'use a different name' }));
  const { client } = scripted([callTool('write_file', '{"path":"x.txt","content":"x"}'), say('OK.')]);
  const agent = createAgent({ client, host, root, stateDirectory });
  await agent.send('write it');
  assert.equal(agent.messages()[3]!.content, 'The user declined this change. Their reason: use a different name');
  await assert.rejects(readFile(join(root, 'x.txt')));
});

test('stops after 25 tool rounds with an error event', async () => {
  const { root, stateDirectory, events, host } = await setup();
  const { client, requests } = scripted(Array.from({ length: 40 }, (_, index) => callTool('list_files', '{}', `c${index}`)));
  const agent = createAgent({ client, host, root, stateDirectory });
  await agent.send('loop forever');
  assert.equal(requests.length, MAX_TOOL_ROUNDS);
  const error = events.find((event) => event.type === 'error') as { message: string } | undefined;
  assert.match(error!.message, /25 rounds/);
  assert.equal(events.at(-1)!.type, 'turn_end');
  assertConsistent(agent.messages());
});

test('abort while a command runs leaves every tool call answered', async () => {
  const { root, stateDirectory, host } = await setup();
  const controller = new AbortController();
  const { client } = scripted([() => ({
    message: { role: 'assistant', content: '', tool_calls: [
      { id: 'slow', name: 'run_command', arguments: '{"command":"sleep 5"}' },
      { id: 'later', name: 'list_files', arguments: '{}' },
    ] },
  })]);
  const agent = createAgent({ client, host, root, stateDirectory });
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  await agent.send('run it', controller.signal);
  assert.ok(Date.now() - started < 4_000);
  const tools = agent.messages().filter((message) => message.role === 'tool');
  assert.deepEqual(tools.map((message) => [message.tool_call_id, message.content]), [['slow', 'cancelled'], ['later', 'cancelled']]);
  assertConsistent(agent.messages());
});

test('abort during the model request keeps history consistent', async () => {
  const { root, stateDirectory, events, host } = await setup();
  const controller = new AbortController();
  const { client } = scripted([(request) => new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    controller.abort();
  })]);
  const agent = createAgent({ client, host, root, stateDirectory });
  await agent.send('hello', controller.signal);
  assert.deepEqual(agent.messages().map((message) => message.role), ['system', 'user']);
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(events.at(-1)!.type, 'turn_end');
});

test('old tool output is trimmed when the context is nearly full', async () => {
  const { root, stateDirectory, events, host } = await setup();
  await writeFile(join(root, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(40));
  const { client, requests } = scripted([
    callTool('read_file', '{"path":"big.txt"}', 'r1'), say('first'),
    callTool('read_file', '{"path":"big.txt"}', 'r2'), say('second'),
    callTool('read_file', '{"path":"big.txt"}', 'r3'), say('third'),
  ]);
  const agent = createAgent({ client, host, root, stateDirectory, contextTokens: 3_000 });
  await agent.send('one');
  await agent.send('two');
  await agent.send('three');
  const trimmed = events.filter((event) => event.type === 'context_trimmed');
  assert.ok(trimmed.length >= 1);
  const tools = agent.messages().filter((message) => message.role === 'tool');
  assert.equal(tools[0]!.content, OMITTED_OUTPUT);
  assert.notEqual(tools.at(-1)!.content, OMITTED_OUTPUT);
  assert.notEqual(agent.messages()[0]!.content, OMITTED_OUTPUT);
  // The request sent after trimming already carries the shortened history.
  assert.ok(requests.some((messages) => messages.some((message) => message.content === OMITTED_OUTPUT)));
  assertConsistent(agent.messages());
});
