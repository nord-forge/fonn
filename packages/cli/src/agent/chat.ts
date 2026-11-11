import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createAgent, createOpenAICompatibleClient, DEFAULT_CONTEXT_TOKENS, estimateTokens, toolDefinitions, type AgentOptions, type ModelClientOptions } from '@nord-forge/fonn-core/agent';
import { getDefaultStateDirectory } from '@nord-forge/fonn-core/state';
import { contextStatus, TerminalHost, type TerminalOptions } from './terminal.js';

export interface ChatOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  root: string;
  contextTokens?: number;
  filterMode?: AgentOptions['filterMode'];
  filterLevel?: AgentOptions['filterLevel'];
  filterRules?: AgentOptions['filterRules'];
  /** Fonn's state root. Each conversation gets its own agent subdirectory. */
  stateDirectory?: string;
}

export interface ChatDependencies extends TerminalOptions {
  createClient?: (options: ModelClientOptions) => ReturnType<typeof createOpenAICompatibleClient>;
  createAgent?: (options: AgentOptions) => ReturnType<typeof createAgent>;
  onInterrupt?: (handler: () => void) => () => void;
}

const commands = '/help  Show commands\n/exit  Exit (also Ctrl+D)\n/clear  Start a new conversation\n/context  Show the context estimate';

/**
 * True when the server runs on this machine. Anything else receives every
 * file the model reads, so reads then ask first.
 */
export function isLocalServer(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function serverAddress(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** Runs only the terminal session. Model and agent factories are replaceable offline. */
export async function runChat(options: ChatOptions, dependencies: ChatDependencies = {}): Promise<number> {
  const client = (dependencies.createClient ?? createOpenAICompatibleClient)({ model: options.model, baseUrl: options.baseUrl, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
  const host = new TerminalHost(dependencies);
  const contextLimit = options.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  let active: AbortController | undefined;
  let exit = false;
  let interruptedEmpty = false;
  let multiline: string[] = [];
  let detach = () => {};
  const interrupt = () => {
    if (active) {
      active.abort();
      host.cancelQuestion();
      return;
    }
    const empty = host.readline.line.length === 0 && multiline.length === 0;
    if (empty && interruptedEmpty) { exit = true; host.close(); return; }
    interruptedEmpty = empty;
    multiline = [];
    host.readline.write('', { ctrl: true, name: 'u' });
    host.cancelQuestion();
    host.line(empty ? 'Press Ctrl+C again to exit.' : 'Input cancelled.');
  };
  const local = isLocalServer(options.baseUrl);
  const newAgent = () => (dependencies.createAgent ?? createAgent)({
    client, host, root: options.root, confirmReads: !local,
    // Core owns Agent.sessionId. This directory ID is allocated before construction.
    stateDirectory: join(resolve(options.stateDirectory ?? getDefaultStateDirectory()), 'agent', randomUUID()),
    contextTokens: contextLimit, filterMode: options.filterMode, filterLevel: options.filterLevel, filterRules: options.filterRules,
  });
  try {
    let agent = newAgent();
    let contextTokens = estimateTokens(agent.messages(), JSON.stringify(toolDefinitions).length);
    host.line(`Fonn chat\nModel: ${options.model}\nServer: ${serverAddress(options.baseUrl)}\nProject: ${options.root}\nFilter: ${options.filterMode ?? 'filter'}, level ${options.filterLevel ?? 'standard'}\nEvery command and file change asks first. Session approvals can remember an exact command or file.\n${local ? 'Files that may hold secrets, such as .env, ask before they are read.' : 'This server is not on this machine, so every file read asks first: what the model reads is sent there.'}\nType /help for commands.`);
    host.readline.on('SIGINT', interrupt);
    const onInterrupt = dependencies.onInterrupt ?? (handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; });
    detach = onInterrupt(interrupt);
    host.readline.once('close', () => active?.abort());
    while (!exit && !host.closed) {
      const line = await host.question(multiline.length ? '... ' : '› ');
      if (line === undefined) { if (host.closed) break; continue; }
      interruptedEmpty = false;
      if (line.endsWith('\\')) { multiline.push(line.slice(0, -1)); continue; }
      const text = [...multiline, line].join('\n');
      multiline = [];
      if (!text.trim()) continue;
      switch (text.trim()) {
        case '/exit': exit = true; continue;
        case '/help': host.line(commands); continue;
        case '/clear': {
          agent = newAgent();
          contextTokens = estimateTokens(agent.messages(), JSON.stringify(toolDefinitions).length);
          host.line('Conversation cleared. Session approvals reset.');
          continue;
        }
        case '/context': host.line(contextStatus(contextTokens, contextLimit)); continue;
      }
      if (text.trim().startsWith('/')) { host.line('Unknown command. Type /help for commands.'); continue; }
      active = new AbortController();
      try {
        await agent.send(text, active.signal);
        // send resolves after error events too. TerminalHost renders those events.
        contextTokens = estimateTokens(agent.messages(), JSON.stringify(toolDefinitions).length);
        if (active.signal.aborted && !host.closed) host.line('Turn cancelled.');
      } catch (error) {
        host.onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        active = undefined;
      }
    }
    return 0;
  } finally {
    detach();
    host.readline.off('SIGINT', interrupt);
    host.close();
  }
}
