import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatibleClient, LOCAL_BASE_URLS } from '../../src/agent/index.js';
import type { ModelEvent } from '../../src/agent/index.js';

function sse(parts: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const request = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }] };

test('posts the chat request and streams text, reasoning, split tool calls and usage', async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    // Chunks split mid-line and mid-JSON to check the buffering.
    const body = data({ choices: [{ delta: { reasoning: 'thinking ' } }] })
      + data({ choices: [{ delta: { reasoning_content: 'more' } }] })
      + data({ choices: [{ delta: { content: 'Hel' } }] })
      + data({ choices: [{ delta: { content: 'lo' } }] })
      + data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_', arguments: '{"pa' } }] } }] })
      + data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] } }] })
      + data({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'list_files', arguments: '{}' } }] } }] })
      + data({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })
      + 'data: [DONE]\n\n';
    return sse([body.slice(0, 37), body.slice(37, 200), body.slice(200)]);
  }) as unknown as typeof globalThis.fetch;
  const client = createOpenAICompatibleClient({ baseUrl: 'http://localhost:11434/v1/', model: 'qwen', apiKey: 'secret-key', fetch });
  const events: ModelEvent[] = [];
  const reply = await client.complete(request, (event) => events.push(event));
  assert.equal(sent?.url, 'http://localhost:11434/v1/chat/completions');
  const body = JSON.parse(String(sent?.init.body));
  assert.equal(body.model, 'qwen');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }]);
  assert.equal((sent?.init.headers as Record<string, string>).authorization, 'Bearer secret-key');
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'thinking ' }, { type: 'reasoning', text: 'more' },
    { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' },
  ]);
  assert.equal(reply.message.content, 'Hello');
  assert.deepEqual(reply.message.tool_calls, [
    { id: 'call_a', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { id: 'call_b', name: 'list_files', arguments: '{}' },
  ]);
  assert.deepEqual(reply.usage, { promptTokens: 12, completionTokens: 5 });
});

test('handles a whole tool call in one chunk, object arguments and a server that ignores stream_options', async () => {
  const fetch = (async () => sse([
    data({ choices: [{ delta: { role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'x1', function: { name: 'run_command', arguments: { command: 'ls' } } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x2', function: { name: 'list_files', arguments: '{}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ])) as unknown as typeof globalThis.fetch;
  const reply = await createOpenAICompatibleClient({ baseUrl: LOCAL_BASE_URLS.ollama, model: 'm', fetch }).complete(request, () => undefined);
  assert.deepEqual(reply.message.tool_calls, [
    { id: 'x1', name: 'run_command', arguments: '{"command":"ls"}' },
    { id: 'x2', name: 'list_files', arguments: '{}' },
  ]);
  assert.equal(reply.usage, undefined);
});

test('reads a plain JSON reply from a server that ignores stream', async () => {
  const fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
  const reply = await createOpenAICompatibleClient({ baseUrl: LOCAL_BASE_URLS.lmstudio, model: 'm', fetch }).complete(request, () => undefined);
  assert.equal(reply.message.content, 'done');
  assert.deepEqual(reply.usage, { promptTokens: 3, completionTokens: 1 });
});

test('retries once without stream_options when the server rejects it', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: 'unknown field stream_options' } }), { status: 400 });
    return sse([data({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']);
  }) as unknown as typeof globalThis.fetch;
  const reply = await createOpenAICompatibleClient({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', fetch }).complete(request, () => undefined);
  assert.equal(reply.message.content, 'ok');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.stream_options, undefined);
});

test('a non-2xx reply gives the status and server message, never the api key', async () => {
  const fetch = (async () => new Response(JSON.stringify({ error: { message: 'model "nope" not found for key sk-secret' } }), { status: 404 })) as unknown as typeof globalThis.fetch;
  const client = createOpenAICompatibleClient({ baseUrl: 'https://api.example.test/v1', model: 'nope', apiKey: 'sk-secret', fetch });
  await assert.rejects(client.complete(request, () => undefined), (error: Error) => {
    assert.match(error.message, /404/);
    assert.match(error.message, /model "nope" not found/);
    assert.doesNotMatch(error.message, /sk-secret/);
    return true;
  });
});

test('a refused connection to a local server says to check Ollama or LM Studio', async () => {
  const fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;
  await assert.rejects(createOpenAICompatibleClient({ baseUrl: 'http://localhost:11434/v1', model: 'm', fetch }).complete(request, () => undefined), /Ollama or LM Studio is running/);
  await assert.rejects(createOpenAICompatibleClient({ baseUrl: 'https://user:pw@remote.example.test/v1', model: 'm', fetch }).complete(request, () => undefined), (error: Error) => {
    assert.match(error.message, /Could not connect to https:\/\/remote\.example\.test\/v1: fetch failed/);
    assert.doesNotMatch(error.message, /pw/);
    return true;
  });
});

test('abort stops reading the stream', async () => {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  const fetch = (async (_url: string, init: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(data({ choices: [{ delta: { content: 'partial' } }] })));
        // Never closes. Only the abort can end it.
        init.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch;
  const events: ModelEvent[] = [];
  const pending = createOpenAICompatibleClient({ baseUrl: LOCAL_BASE_URLS.ollama, model: 'm', fetch }).complete({ ...request, signal: controller.signal }, (event) => {
    events.push(event);
    controller.abort();
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(events, [{ type: 'text', text: 'partial' }]);
});
