import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Agent, AgentOptions, ChatMessage, ToolCall, Usage } from './contract.js';
import { createToolRunner, toolDefinitions } from './tools.js';

export const MAX_TOOL_ROUNDS = 25;
export const DEFAULT_CONTEXT_TOKENS = 32_768;
export const OMITTED_OUTPUT = '[earlier output omitted to save context]';
const TRIM_START = 0.85;
const TRIM_TARGET = 0.7;

/** A rough token estimate: characters divided by four. */
export function estimateTokens(messages: readonly ChatMessage[], extraCharacters = 0): number {
  let characters = extraCharacters;
  for (const message of messages) {
    characters += message.content.length + 8;
    for (const call of message.tool_calls ?? []) characters += call.name.length + call.arguments.length + call.id.length + 16;
  }
  return Math.ceil(characters / 4);
}

export function systemPrompt(root: string): string {
  return [
    `You are Fonn, a small coding agent. You work in the project at ${root}.`,
    'You help the user read, change and run the code in that project.',
    '',
    'Tools:',
    '- run_command: run a shell command in the project root.',
    '- read_file: read lines of a file.',
    '- list_files: list a folder.',
    '- write_file: create or replace a file.',
    '- edit_file: replace one exact piece of text in a file.',
    '- read_original: read the full original of shortened command output.',
    '',
    'The user approves each command, write and edit as you call it. So call tools directly. Do not ask for permission in text.',
    'If the user declines, read their reason and adjust.',
    '',
    'Read a file before you edit it. Prefer small edits with edit_file over rewriting whole files.',
    'Copy old_text exactly, with enough lines to occur only once.',
    'Relative paths start at the project root.',
    '',
    'Long command output may be shortened. A note then gives an archive id. Call read_original with that id to read the full text.',
    '',
    'Keep answers short and concrete. When you finish, say what you changed and how you checked it.',
  ].join('\n');
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let pending = true;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    pending = false;
  } finally {
    if (pending) await unlink(temporary).catch(() => undefined);
  }
}

export function createAgent(options: AgentOptions): Agent {
  if (!path.isAbsolute(options.root)) throw new Error('The project root must be an absolute path.');
  if (!path.isAbsolute(options.stateDirectory)) throw new Error('The state directory must be an absolute path.');
  const contextLimit = options.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  if (!Number.isSafeInteger(contextLimit) || contextLimit < 1_024) throw new Error('The context limit must be a whole number of at least 1024 tokens.');
  const timeout = options.commandTimeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) throw new Error('The command timeout must be a positive number of milliseconds.');

  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const filterMode = options.filterMode ?? 'filter';
  const filterLevel = options.filterLevel ?? 'standard';
  const filterRules = options.filterRules ?? [];
  const host = options.host;
  const history: ChatMessage[] = [{ role: 'system', content: systemPrompt(options.root) }];
  const toolCharacters = JSON.stringify(toolDefinitions).length;
  const runner = createToolRunner({
    root: options.root, host, stateDirectory: options.stateDirectory, sessionId,
    filterMode, filterLevel, filterRules, commandTimeoutMs: timeout, confirmReads: options.confirmReads ?? false,
    // One command result may use up to a quarter of the context.
    maxDeliveredCharacters: Math.min(40_000, Math.max(4_000, contextLimit)),
  });
  let busy = false;
  let toolCallCount = 0;
  let recordFailed = false;

  async function saveRecord(): Promise<void> {
    try {
      await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(path.join(options.stateDirectory, 'session.json'), {
        schemaVersion: 1, sessionId, model: options.client.model, root: options.root, createdAt, updatedAt: new Date().toISOString(),
        filterMode, filterLevel, ...(filterRules.length ? { filterRules } : {}),
        messageCount: history.length, userMessages: history.filter((message) => message.role === 'user').length, toolCalls: toolCallCount,
      });
    } catch (error) {
      // The record is bookkeeping. Report a failure once and keep the chat going.
      if (!recordFailed) host.onEvent({ type: 'error', message: `Could not save the session record: ${error instanceof Error ? error.message : String(error)}` });
      recordFailed = true;
    }
  }

  /** Shortens the oldest tool output, outside the latest round, when the context is nearly full. */
  function trimContext(): void {
    if (estimateTokens(history, toolCharacters) <= contextLimit * TRIM_START) return;
    let lastUser = -1;
    let lastAssistant = -1;
    for (let index = history.length - 1; index > 0; index--) {
      if (lastAssistant < 0 && history[index]!.role === 'assistant') lastAssistant = index;
      if (history[index]!.role === 'user') { lastUser = index; break; }
    }
    const protectedFrom = Math.max(lastUser, lastAssistant);
    let removed = 0;
    for (let index = 1; index < history.length && estimateTokens(history, toolCharacters) > contextLimit * TRIM_TARGET; index++) {
      const message = history[index]!;
      if (index >= protectedFrom) continue;
      if (message.role !== 'tool' || message.content === OMITTED_OUTPUT) continue;
      history[index] = { ...message, content: OMITTED_OUTPUT };
      removed++;
    }
    if (removed) host.onEvent({ type: 'context_trimmed', removedMessages: removed });
  }

  function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
    if (!next) return total;
    return { promptTokens: (total?.promptTokens ?? 0) + next.promptTokens, completionTokens: (total?.completionTokens ?? 0) + next.completionTokens };
  }

  function cancelRemaining(calls: ToolCall[]): void {
    for (const call of calls) history.push({ role: 'tool', tool_call_id: call.id, content: 'cancelled' });
  }

  async function turn(text: string, signal: AbortSignal | undefined): Promise<void> {
    history.push({ role: 'user', content: text });
    let usage: Usage | undefined;
    const endTurn = () => host.onEvent({ type: 'turn_end', ...(usage ? { usage } : {}), contextTokens: estimateTokens(history, toolCharacters), contextLimit });
    for (let round = 0; ; round++) {
      if (signal?.aborted) return endTurn();
      if (round >= MAX_TOOL_ROUNDS) {
        host.onEvent({ type: 'error', message: `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls. Send a message to continue.` });
        return endTurn();
      }
      trimContext();
      let reply;
      try {
        reply = await options.client.complete({ messages: history.map((message) => ({ ...message })), tools: toolDefinitions, signal }, (event) => {
          if (!signal?.aborted) host.onEvent(event);
        });
      } catch (error) {
        if (!signal?.aborted) host.onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        return endTurn();
      }
      usage = addUsage(usage, reply.usage);
      const calls = (reply.message.tool_calls ?? []).map((call, index) => ({
        id: typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID()}_${index}`,
        name: typeof call.name === 'string' ? call.name : '',
        arguments: typeof call.arguments === 'string' ? call.arguments : '',
      }));
      // Reasoning is shown, never sent back, so only content and calls are kept.
      history.push({ role: 'assistant', content: typeof reply.message.content === 'string' ? reply.message.content : '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) return endTurn();
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!;
        if (signal?.aborted) { cancelRemaining(calls.slice(index)); return endTurn(); }
        toolCallCount++;
        host.onEvent({ type: 'tool_start', id: call.id, name: call.name, summary: runner.describe(call) });
        const outcome = await runner.run(call, signal);
        history.push({ role: 'tool', tool_call_id: call.id, content: outcome.cancelled ? 'cancelled' : outcome.content });
        host.onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: outcome.ok, summary: outcome.summary, ...(outcome.filter ? { filter: outcome.filter } : {}) });
        if (outcome.cancelled || signal?.aborted) { cancelRemaining(calls.slice(index + 1)); return endTurn(); }
      }
    }
  }

  return {
    sessionId,
    async send(text, signal) {
      if (busy) throw new Error('The agent is already answering. Wait for the turn to finish.');
      if (typeof text !== 'string' || !text.trim()) throw new Error('The message is empty.');
      busy = true;
      try {
        if (history.length === 1) await saveRecord();
        await turn(text, signal);
      } finally {
        await saveRecord();
        busy = false;
      }
    },
    messages() {
      return history.map((message) => Object.freeze({ ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call })) } : {}) }));
    },
  };
}
