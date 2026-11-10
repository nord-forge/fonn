// Contract for `fonn chat`, Fonn's own small coding agent for open models.
// The core side (packages/core/src/agent/) implements the model client, the
// tools and the loop. The terminal side (packages/cli/src/agent/) implements
// AgentHost: it shows events and asks the user for approvals. Both sides code
// against these shapes only. See docs/agent.md for the design.
//
// Rules that hold everywhere:
// - Running a command, writing a file and editing a file always ask the user
//   through AgentHost.approve. There is no flag, mode or setting that skips
//   it. "Remember" only covers the exact same command, or writes to the exact
//   same file, for the rest of the session.
// - Reading inside the project root needs no approval. Reading outside it,
//   or through a symlink that leaves it, asks.
// - Command output goes through Fonn's output filter before the model sees
//   it. Originals are archived and the model can read them back in bounded
//   slices with the read_original tool.
// - Credentials are read from an environment variable named by the user and
//   never stored, logged or shown.

/** One message in the OpenAI-compatible chat format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant only: the tool calls it made. */
  tool_calls?: ToolCall[];
  /** Tool only: which call this answers. */
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, as the model produced it. May be invalid; tools must cope. */
  arguments: string;
}

/** A tool as offered to the model (OpenAI function tool). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Streamed pieces of one model reply. */
export type ModelEvent =
  | { type: 'text'; text: string }
  /** Thinking text, for models that send it (reasoning or reasoning_content). It is shown, never sent back. */
  | { type: 'reasoning'; text: string };

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelReply {
  message: ChatMessage;
  usage?: Usage;
}

/** Talks to one model. createOpenAICompatibleClient implements it; tests pass a fake. */
export interface ModelClient {
  readonly model: string;
  complete(request: ModelRequest, onEvent: (event: ModelEvent) => void): Promise<ModelReply>;
}

export interface ModelClientOptions {
  /** For example http://localhost:11434/v1 for Ollama or http://localhost:1234/v1 for LM Studio. */
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token when set. Read from the environment by the caller, never stored. */
  apiKey?: string;
  /** Injected in tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

/** Where the built-in local servers listen. */
export const LOCAL_BASE_URLS: Readonly<Record<'ollama' | 'lmstudio', string>> = Object.freeze({
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
});

export type ApprovalKind = 'command' | 'write' | 'edit' | 'read';

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** One line, for example the command or "Write src/app.ts (12 lines)". */
  summary: string;
  /** The full command, the new file content, or a unified diff for an edit. Shown on request. */
  detail: string;
  /** Absolute path for file actions, the command text for commands. */
  target: string;
}

export type ApprovalDecision =
  | { allow: true; remember?: boolean }
  /** The optional reason goes back to the model, so it can try something else. */
  | { allow: false; reason?: string };

export interface FilterSummary {
  status: 'filtered' | 'observed' | 'unchanged';
  removedLines: number;
  originalCharacters: number;
  deliveredCharacters: number;
}

/** Everything the terminal shows. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; summary: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string; filter?: FilterSummary }
  | { type: 'turn_end'; usage?: Usage; contextTokens: number; contextLimit: number }
  /** Older tool output was shortened to stay within the context. */
  | { type: 'context_trimmed'; removedMessages: number }
  | { type: 'error'; message: string };

/** The terminal (or a test) implements this. */
export interface AgentHost {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  onEvent(event: AgentEvent): void;
}

export interface AgentOptions {
  client: ModelClient;
  host: AgentHost;
  /** Absolute project root. Commands run here; reads inside it need no approval. */
  root: string;
  /** Where this session's archived originals and record go. */
  stateDirectory: string;
  filterMode?: 'filter' | 'observe' | 'off';
  filterLevel?: 'strict' | 'standard' | 'similar';
  filterRules?: Array<{ name: string; command: string; remove: string[] }>;
  /** Rough token budget for the conversation. Defaults to 32768. */
  contextTokens?: number;
  /** Per command. Defaults to 120 seconds. */
  commandTimeoutMs?: number;
}

export interface Agent {
  readonly sessionId: string;
  /** Runs one user turn to completion: model replies and tool calls until the model answers without tools. */
  send(text: string, signal?: AbortSignal): Promise<void>;
  /** The conversation so far, system prompt included. */
  messages(): readonly ChatMessage[];
}
