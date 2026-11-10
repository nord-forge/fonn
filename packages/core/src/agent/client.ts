import { randomUUID } from 'node:crypto';
import type { ChatMessage, ModelClient, ModelClientOptions, ModelEvent, ModelReply, ModelRequest, ToolCall, Usage } from './contract.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const MAX_ERROR_CHARACTERS = 500;

interface PartialCall { id: string; name: string; arguments: string }

/** The base URL without credentials or a query, safe to show in an error. */
function displayUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return 'the model server';
  }
}

function isLocal(baseUrl: string): boolean {
  try { return LOCAL_HOSTS.has(new URL(baseUrl).hostname); }
  catch { return false; }
}

function redact(text: string, apiKey: string | undefined): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

function serverMessage(body: string): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') message = error;
    else if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') message = (error as Record<string, string>).message;
    else if (typeof parsed.message === 'string') message = parsed.message;
    else if (typeof parsed.detail === 'string') message = parsed.detail;
  } catch { /* Not JSON. Use the plain text. */ }
  return message.length > MAX_ERROR_CHARACTERS ? `${message.slice(0, MAX_ERROR_CHARACTERS)}...` : message;
}

function abortError(): Error {
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Collects streamed chat completion chunks into one assistant message. */
class ReplyBuilder {
  content = '';
  usage: Usage | undefined;
  readonly calls: PartialCall[] = [];
  constructor(private readonly onEvent: (event: ModelEvent) => void) {}

  chunk(chunk: Record<string, unknown>): void {
    if (chunk.error !== undefined) throw new Error(`The model server reported an error: ${serverMessage(JSON.stringify(chunk))}`);
    this.readUsage(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
    for (const choice of choices) {
      // Streaming servers send delta. A server that ignores stream sends message.
      const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
      if (!delta || typeof delta !== 'object') continue;
      const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning) this.onEvent({ type: 'reasoning', text: reasoning });
      if (typeof delta.content === 'string' && delta.content) {
        this.content += delta.content;
        this.onEvent({ type: 'text', text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) this.toolCall(call as Record<string, unknown>);
    }
  }

  private readUsage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const usage = value as Record<string, unknown>;
    const prompt = usage.prompt_tokens;
    const completion = usage.completion_tokens;
    if (typeof prompt === 'number' || typeof completion === 'number') {
      this.usage = { promptTokens: typeof prompt === 'number' ? prompt : 0, completionTokens: typeof completion === 'number' ? completion : 0 };
    }
  }

  private toolCall(delta: Record<string, unknown>): void {
    const fn = (delta.function ?? {}) as Record<string, unknown>;
    const id = typeof delta.id === 'string' && delta.id ? delta.id : undefined;
    let index: number;
    if (typeof delta.index === 'number' && Number.isSafeInteger(delta.index) && delta.index >= 0) {
      index = delta.index;
      // Some servers send every complete call with index 0. A new id means a new call.
      const existing = this.calls[index];
      if (existing && id && existing.id && existing.id !== id) index = this.calls.length;
    } else if (id) {
      const found = this.calls.findIndex((call) => call.id === id);
      index = found >= 0 ? found : this.calls.length;
    } else {
      index = Math.max(this.calls.length - 1, 0);
    }
    const call = this.calls[index] ??= { id: '', name: '', arguments: '' };
    if (id && !call.id) call.id = id;
    if (typeof fn.name === 'string') call.name += fn.name;
    // Ollama may send the whole call at once, sometimes with arguments as an object.
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === 'object') call.arguments += JSON.stringify(fn.arguments);
  }

  finish(): ModelReply {
    const toolCalls: ToolCall[] = this.calls.filter(Boolean).map((call) => ({
      id: call.id || `call_${randomUUID()}`, name: call.name, arguments: call.arguments || '{}',
    }));
    const message: ChatMessage = { role: 'assistant', content: this.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    return { message, ...(this.usage ? { usage: this.usage } : {}) };
  }
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.tool_calls?.length) {
    return {
      role: 'assistant', content: message.content || null,
      tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    };
  }
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id };
  return { role: message.role, content: message.content };
}

async function readStream(body: ReadableStream<Uint8Array>, builder: ReplyBuilder, signal: AbortSignal | undefined): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const line = (raw: string) => {
    const text = raw.replace(/\r$/, '');
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data); }
    catch { throw new Error('The model server sent a stream chunk that is not valid JSON.'); }
    if (parsed && typeof parsed === 'object') builder.chunk(parsed as Record<string, unknown>);
  };
  try {
    while (!done) {
      if (signal?.aborted) throw abortError();
      const { value, done: ended } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (!done && buffer) line(buffer);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!done) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}

/** A streaming client for Ollama, LM Studio and other OpenAI-compatible chat servers. */
export function createOpenAICompatibleClient(options: ModelClientOptions): ModelClient {
  if (typeof options.baseUrl !== 'string' || !/^https?:\/\//i.test(options.baseUrl)) throw new Error('The model base URL must start with http:// or https://.');
  if (typeof options.model !== 'string' || !options.model.trim()) throw new Error('A model name is required.');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const where = displayUrl(options.baseUrl);

  async function post(request: ModelRequest, includeUsage: boolean): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const body = {
      model: options.model,
      messages: request.messages.map(wireMessage),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    };
    try {
      return await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal });
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      if (isLocal(options.baseUrl)) throw new Error(`Could not connect to ${where}. Check that Ollama or LM Studio is running and serving on that address.`);
      const reason = error instanceof Error ? redact(error.message, options.apiKey) : 'unknown error';
      throw new Error(`Could not connect to ${where}: ${reason}`);
    }
  }

  return {
    model: options.model,
    async complete(request, onEvent) {
      if (request.signal?.aborted) throw abortError();
      let response = await post(request, true);
      if (response.status === 400) {
        // Some servers reject stream_options instead of ignoring it. Try once without.
        const text = await response.text().catch(() => '');
        if (/stream_options/i.test(text)) response = await post(request, false);
        else throw new Error(`The model server returned 400: ${redact(serverMessage(text), options.apiKey) || 'Bad Request'}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const message = redact(serverMessage(text), options.apiKey) || response.statusText || 'no message';
        throw new Error(`The model server returned ${response.status}: ${message}`);
      }
      const builder = new ReplyBuilder(onEvent);
      const type = response.headers.get('content-type') ?? '';
      try {
        if (type.includes('application/json')) {
          // The server ignored stream: true and sent one complete reply.
          const parsed = await response.json() as Record<string, unknown>;
          builder.chunk(parsed);
        } else if (response.body) {
          await readStream(response.body, builder, request.signal);
        }
      } catch (error) {
        if (request.signal?.aborted) throw abortError();
        if (error instanceof Error) throw new Error(redact(error.message, options.apiKey));
        throw error;
      }
      return builder.finish();
    },
  };
}
