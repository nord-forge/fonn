import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { AgentEvent, AgentHost, ApprovalDecision, ApprovalRequest } from '@nord-forge/fonn-core/agent';
import { terminalText } from '../cli/render.js';

export interface TerminalOptions {
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean; columns?: number };
  env?: NodeJS.ProcessEnv;
}

export function contextStatus(tokens: number, limit: number): string {
  const compact = (value: number) => value < 1024 ? String(value) : `${Number((value / 1024).toFixed(1))}k`;
  return `context ${compact(tokens)} / ${compact(limit)} tokens (estimate)`;
}

const REASONING_LIMIT = 160;

/** Owns one readline interface, shared by the prompt and approval questions. */
export class TerminalHost implements AgentHost {
  readonly readline: Interface;
  readonly interactive: boolean;
  private readonly output: Writable;
  private readonly tty: boolean;
  private readonly color: boolean;
  private readonly reasoningLimit: number;
  private readonly ended = new AbortController();
  private questionAbort?: AbortController;
  private partialLine = false;
  private reasoning = '';
  private thinking = false;
  private readonly tools = new Map<string, string>();

  constructor(options: TerminalOptions = {}) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    this.output = output;
    this.interactive = input.isTTY === true;
    this.tty = output.isTTY === true;
    this.color = this.tty && (options.env ?? process.env).NO_COLOR === undefined;
    this.reasoningLimit = this.tty ? Math.max(1, Math.min(REASONING_LIMIT, (output.columns ?? 80) - 1)) : REASONING_LIMIT;
    this.readline = createInterface({ input, output, terminal: this.interactive && this.tty });
    this.readline.once('close', () => this.ended.abort());
  }

  get closed(): boolean { return this.ended.signal.aborted; }

  private dim(text: string): string { return this.color ? `\x1b[2m${text}\x1b[22m` : text; }

  private write(text: string): void { this.output.write(text); }

  private finishStream(): void {
    if (this.reasoning || this.thinking) {
      if (!this.tty) this.write(`${this.dim(this.thinking ? 'thinking' : this.reasoning)}\n`);
      else this.write('\n');
      this.reasoning = '';
      this.thinking = false;
      this.partialLine = false;
    }
    if (this.partialLine) this.write('\n');
    this.partialLine = false;
  }

  line(text: string, dim = false): void {
    this.finishStream();
    const safe = terminalText(text);
    this.write(`${dim ? this.dim(safe) : safe}\n`);
  }

  async question(prompt: string): Promise<string | undefined> {
    this.finishStream();
    if (this.closed) return undefined;
    const abort = new AbortController();
    this.questionAbort = abort;
    try {
      return await this.readline.question(prompt, { signal: AbortSignal.any([abort.signal, this.ended.signal]) });
    } catch (error) {
      if (abort.signal.aborted || this.closed) return undefined;
      throw error;
    } finally {
      if (this.questionAbort === abort) this.questionAbort = undefined;
    }
  }

  cancelQuestion(): void { this.questionAbort?.abort(); }

  close(): void {
    this.cancelQuestion();
    this.finishStream();
    this.readline.close();
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    // A command is shown in full, every line, so nothing hides behind a short
    // first line. Files show their summary, with the content behind [d].
    if (request.kind === 'command') {
      this.line('command:');
      for (const part of request.detail.split('\n')) this.line(`  ${part}`);
    } else {
      this.line(`${request.kind}: ${request.summary.replace(/[\r\n]+/g, ' ')}`);
    }
    if (!this.interactive) return { allow: false, reason: 'Approvals need an interactive terminal. Run fonn chat in a TTY.' };
    const target = request.kind === 'command' ? 'command' : 'file';
    for (;;) {
      const answer = await this.question(`Allow? [y]es once, [a]lways for this ${target}, [n]o, [d]etails `);
      if (answer === undefined) return { allow: false, reason: 'Approval cancelled or terminal closed.' };
      switch (answer.trim().toLowerCase()) {
        case 'y': case 'yes': return { allow: true };
        case 'a': case 'always': return { allow: true, remember: true };
        case 'd': case 'details': {
          for (const line of terminalText(request.detail).split('\n')) {
            const code = line.startsWith('+') ? 32 : line.startsWith('-') ? 31 : undefined;
            this.write(`${this.color && code ? `\x1b[${code}m${line}\x1b[39m` : line}\n`);
          }
          break;
        }
        case '': case 'n': case 'no': {
          const reason = (await this.question('Tell the model why (optional): '))?.trim();
          return { allow: false, ...(reason ? { reason } : {}) };
        }
        default: this.line('Choose y, a, n or d. Empty input means no.');
      }
    }
  }

  onEvent(event: AgentEvent): void {
    if (event.type === 'reasoning') {
      if (this.thinking) return;
      if (this.partialLine) { this.write('\n'); this.partialLine = false; }
      const text = terminalText(event.text).replace(/[\r\n]+/g, ' ');
      const previous = this.reasoning.length;
      this.reasoning = (this.reasoning + text).slice(0, this.reasoningLimit + 1);
      if (this.reasoning.length > this.reasoningLimit) {
        this.thinking = true;
        if (this.tty) this.write(`\r\x1b[2K${this.dim('thinking')}`);
      } else if (this.tty) {
        this.write(this.dim(this.reasoning.slice(previous)));
      }
      return;
    }
    if (event.type === 'text') {
      // Finish reasoning without breaking up streamed answer chunks.
      if (this.reasoning || this.thinking) this.finishStream();
      const text = terminalText(event.text);
      this.write(text);
      if (text) this.partialLine = !text.endsWith('\n');
      return;
    }
    switch (event.type) {
      case 'tool_start': {
        const summary = event.summary.replace(/[\r\n]+/g, ' ');
        this.tools.set(event.id, summary);
        this.line(`${this.tty ? '›' : '>'} ${summary}`);
        break;
      }
      case 'tool_end': {
        const label = this.tools.get(event.id) ?? event.name;
        this.tools.delete(event.id);
        const filter = event.filter;
        const arrow = this.tty ? '→' : '->';
        const filtered = filter ? `, ${filter.originalCharacters} ${arrow} ${filter.deliveredCharacters} chars, ${filter.status}` : '';
        const mark = event.ok ? (this.tty ? '✓' : 'OK') : (this.tty ? '✗' : 'FAIL');
        this.line(`${mark} ${label} (${event.summary.replace(/[\r\n]+/g, ' ')}${filtered})`);
        break;
      }
      case 'context_trimmed': this.line(`Context trimmed: shortened ${event.removedMessages} older tool outputs.`); break;
      case 'error': this.line(`Error: ${event.message.replace(/[\r\n]+/g, ' ')}`); break;
      case 'turn_end': this.line(contextStatus(event.contextTokens, event.contextLimit), true); break;
    }
  }
}
