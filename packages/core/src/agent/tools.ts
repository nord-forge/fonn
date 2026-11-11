import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ArtifactStore, FilterRule, OutputFilter } from '../contracts.js';
import { createArtifactStore, createOutputFilter } from '../filtering/index.js';
import type { AgentHost, ApprovalRequest, FilterSummary, ToolCall, ToolDefinition } from './contract.js';

export const MAX_CAPTURE_BYTES = 1024 * 1024;
export const ORIGINAL_SLICE_CHARACTERS = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_SECONDS = 3_600;
const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2_000;
const MAX_READ_CHARACTERS = 60_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_DETAIL_CHARACTERS = 8_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const pathText = z.string().min(1).max(4_096).refine((value) => !value.includes('\0'), 'Paths cannot contain NUL characters.');
const argumentSchemas = {
  run_command: z.object({ command: z.string().min(1).max(100_000), timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional() }).strict(),
  read_file: z.object({ path: pathText, offset_line: z.number().int().min(1).optional(), max_lines: z.number().int().min(1).max(MAX_READ_LINES).optional() }).strict(),
  list_files: z.object({ path: pathText.optional() }).strict(),
  write_file: z.object({ path: pathText, content: z.string() }).strict(),
  edit_file: z.object({ path: pathText, old_text: z.string().min(1), new_text: z.string() }).strict(),
  read_original: z.object({ id: z.string().regex(ID_PATTERN, 'Use the archive id from the shortened output note.'), offset: z.number().int().min(0).optional() }).strict(),
};
export type ToolName = keyof typeof argumentSchemas;

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

/** The six tools offered to the model. Descriptions stay short to keep the first request small. */
export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'run_command',
    description: 'Run a shell command in the project root and return its combined output and exit code. Long output may be shortened.',
    parameters: object({
      command: { type: 'string', description: 'The command, run with /bin/sh -c.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: 'Time limit. Defaults to 120.' },
    }, ['command']),
  },
  {
    name: 'read_file',
    description: 'Read lines from a text file.',
    parameters: object({
      path: { type: 'string', description: 'File path, relative to the project root or absolute.' },
      offset_line: { type: 'integer', minimum: 1, description: 'First line to read, starting at 1.' },
      max_lines: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: `How many lines. Defaults to ${DEFAULT_READ_LINES}.` },
    }, ['path']),
  },
  {
    name: 'list_files',
    description: 'List the entries of a folder. Folders end with a slash.',
    parameters: object({ path: { type: 'string', description: 'Folder path. Defaults to the project root.' } }, []),
  },
  {
    name: 'write_file',
    description: 'Create a file or replace all of its content.',
    parameters: object({ path: { type: 'string' }, content: { type: 'string', description: 'The complete new content.' } }, ['path', 'content']),
  },
  {
    name: 'edit_file',
    description: 'Replace one exact piece of text in a file. old_text must occur exactly once.',
    parameters: object({
      path: { type: 'string' },
      old_text: { type: 'string', description: 'Text copied exactly from the file, with enough lines to be unique.' },
      new_text: { type: 'string', description: 'The replacement text.' },
    }, ['path', 'old_text', 'new_text']),
  },
  {
    name: 'read_original',
    description: 'Read the full original of shortened command output, in slices of up to 20000 characters.',
    parameters: object({
      id: { type: 'string', description: 'The archive id from the shortened output note.' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset. Use the next offset from the previous slice.' },
    }, ['id']),
  },
];

export interface ToolOutcome {
  ok: boolean;
  /** What the model sees. */
  content: string;
  /** One line for the terminal. */
  summary: string;
  filter?: FilterSummary;
  cancelled?: boolean;
}

export interface ToolRunnerOptions {
  root: string;
  host: AgentHost;
  stateDirectory: string;
  sessionId: string;
  filterMode: 'filter' | 'observe' | 'off';
  filterLevel: 'strict' | 'standard' | 'similar';
  filterRules: FilterRule[];
  commandTimeoutMs?: number;
  /** Most characters of command output given to the model in one result. */
  maxDeliveredCharacters?: number;
  /** Ask before every read and listing, for a model server that is not on this machine. */
  confirmReads?: boolean;
}

// Files that usually hold secrets. Reading one always asks, on any server,
// because its contents end up in the conversation. Templates such as
// .env.example are ordinary files.
const SECRET_NAMES = /^(?:\.env(?:\.(?!example$|sample$|template$|dist$)[^/]+)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|env)|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|keystore|jks|kdbx))$/i;
const SECRET_FOLDERS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gcloud']);

/** True for paths that usually hold credentials, such as .env or a private key. */
export function looksSecret(file: string): boolean {
  const parts = file.split(path.sep).filter(Boolean);
  if (parts.some((part, index) => SECRET_FOLDERS.has(part) || SECRET_FOLDERS.has(`${part}/${parts[index + 1] ?? ''}`))) return true;
  return SECRET_NAMES.test(parts.at(-1) ?? '');
}

export interface ToolRunner {
  /** A short label for tool_start, from the raw arguments. */
  describe(call: ToolCall): string;
  run(call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome>;
}

class ToolError extends Error {}

const failure = (content: string, summary = content): ToolOutcome => ({ ok: false, content: `Error: ${content}`, summary });
const lineCount = (text: string) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);
const isInside = (root: string, target: string) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[... ${text.length - limit} more characters not shown]` : text;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | 'aborted'> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/** Resolves the real path of a target that may not exist yet, through its nearest existing ancestor. */
async function realTarget(absolute: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** A small unified diff of one replacement, for the approval prompt. */
export function editDiff(display: string, before: string, after: string): string {
  const context = 2;
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let first = 0;
  while (first < oldLines.length && first < newLines.length && oldLines[first] === newLines[first]) first++;
  let tail = 0;
  while (tail < oldLines.length - first && tail < newLines.length - first && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const leading = oldLines.slice(Math.max(0, first - context), first);
  const removed = oldLines.slice(first, oldLines.length - tail);
  const added = newLines.slice(first, newLines.length - tail);
  const trailing = oldLines.slice(oldLines.length - tail, oldLines.length - tail + context);
  const start = first - leading.length + 1;
  const lines = [
    `--- a/${display}`, `+++ b/${display}`,
    `@@ -${start},${leading.length + removed.length + trailing.length} +${start},${leading.length + added.length + trailing.length} @@`,
    ...leading.map((line) => ` ${line}`), ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ...trailing.map((line) => ` ${line}`),
  ];
  return truncate(lines.join('\n'), MAX_DETAIL_CHARACTERS);
}

interface CommandResult { output: Buffer; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; truncated: boolean; cancelled: boolean }

function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // A separate process group lets a timeout stop the command and its children.
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let fallback: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer) => {
      if (truncated) return;
      const room = MAX_CAPTURE_BYTES - bytes;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        bytes = MAX_CAPTURE_BYTES;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const killGroup = (which: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, which); }
      catch { try { child.kill(which); } catch { /* Already gone. */ } }
    };
    const stop = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output: Buffer.concat(chunks), exitCode, signal: exitSignal, timedOut, truncated, cancelled });
    };
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', finish);
    // A background process outside the group can hold the pipes open. Stop waiting soon after exit.
    child.once('exit', (code, exitSignal) => {
      fallback = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, exitSignal);
      }, 2_000);
      fallback.unref();
    });
    if (signal?.aborted) onAbort();
  });
}

function summarize(decision: { status: FilterSummary['status']; removedLines: number; originalCharacters: number }, delivered: number): FilterSummary {
  return { status: decision.status, removedLines: decision.removedLines, originalCharacters: decision.originalCharacters, deliveredCharacters: delivered };
}

export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const rootPromise = realpath(options.root);
  const store: ArtifactStore = createArtifactStore(path.join(options.stateDirectory, 'artifacts'));
  // The archive ids this agent wrote. read_original reads only these.
  const archived = new Set<string>();
  const rememberedCommands = new Set<string>();
  const rememberedPaths = new Set<string>();
  const rememberedReads = new Set<string>();
  const recovery = (id: string) => `[fonn: output shortened. Call read_original with {"id":"${id}"} to read the full original.]`;
  const filter: OutputFilter = createOutputFilter({
    store, mode: options.filterMode, level: options.filterLevel, rules: options.filterRules,
    recoveryHint: (id) => `the read_original tool, {"id":"${id}"}`,
  });
  const maxDelivered = options.maxDeliveredCharacters ?? 40_000;

  async function approve(request: ApprovalRequest, remembered: Set<string> | undefined, signal: AbortSignal | undefined): Promise<true | ToolOutcome> {
    if (remembered?.has(request.target)) return true;
    const decision = await abortable(options.host.approve(request), signal);
    if (decision === 'aborted') return { ok: false, content: 'cancelled', summary: 'Cancelled', cancelled: true };
    if (decision.allow) {
      if (decision.remember && remembered) remembered.add(request.target);
      return true;
    }
    const reason = typeof decision.reason === 'string' && decision.reason.trim() ? ` Their reason: ${decision.reason.trim()}` : ' They gave no reason.';
    return { ok: false, content: `The user declined this ${request.kind === 'command' ? 'command' : request.kind === 'read' ? 'read' : 'change'}.${reason}`, summary: 'Declined' };
  }

  /** Resolves a path and its real location. Outside the root needs a read approval. */
  async function locate(input: string) {
    const root = await rootPromise;
    const absolute = path.resolve(root, input);
    const real = await realTarget(absolute);
    const inside = isInside(root, absolute) && isInside(root, real);
    const display = inside ? path.relative(root, real) || '.' : real;
    return { root, absolute, real, inside, display };
  }

  async function readAccess(input: string, verb: string, signal: AbortSignal | undefined) {
    const place = await locate(input);
    if (!place.inside) {
      const via = place.real !== place.absolute ? ` (through a link from ${place.absolute})` : '';
      const allowed = await approve({ kind: 'read', summary: `${verb} ${place.real}${via}, outside the project`, detail: place.real, target: place.real }, undefined, signal);
      if (allowed !== true) return allowed;
      return place;
    }
    // A secret always asks. With a server elsewhere every read asks, and
    // "always" covers that exact path for the rest of the session.
    const secret = looksSecret(place.real);
    if (secret || options.confirmReads) {
      const why = secret ? ', which may hold secrets' : '';
      const where = options.confirmReads ? ' Its contents go to the model server.' : '';
      const allowed = await approve({ kind: 'read', summary: `${verb} ${place.display}${why}`, detail: `${place.real}${where}`, target: place.real }, rememberedReads, signal);
      if (allowed !== true) return allowed;
    }
    return place;
  }

  async function readText(file: string): Promise<string> {
    const info = await stat(file);
    if (info.isDirectory()) throw new ToolError(`${file} is a folder. Use list_files.`);
    if (!info.isFile()) throw new ToolError(`${file} is not a regular file.`);
    if (info.size > MAX_FILE_BYTES) throw new ToolError(`${file} is larger than 10 MB. Use run_command with head, tail or grep.`);
    const buffer = await readFile(file);
    if (buffer.subarray(0, 8_192).includes(0)) throw new ToolError(`${file} looks like a binary file.`);
    return buffer.toString('utf8');
  }

  const tools: { [K in ToolName]: (args: z.infer<typeof argumentSchemas[K]>, call: ToolCall, signal: AbortSignal | undefined) => Promise<ToolOutcome> } = {
    async run_command(args, call, signal) {
      const allowed = await approve({ kind: 'command', summary: args.command.split('\n')[0]!.slice(0, 200), detail: args.command, target: args.command }, rememberedCommands, signal);
      if (allowed !== true) return allowed;
      const root = await rootPromise;
      const timeoutMs = args.timeout_seconds !== undefined ? args.timeout_seconds * 1_000 : options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await runShell(args.command, root, timeoutMs, signal);
      if (result.cancelled) return { ok: false, content: 'cancelled', summary: 'Cancelled', cancelled: true };
      let merged = result.output.toString('utf8');
      if (result.truncated) merged += `\n[fonn: output truncated after ${MAX_CAPTURE_BYTES} bytes]\n`;
      // The same observation shape the native Bash hooks filter.
      const outcome = await filter.apply({
        toolName: 'Bash', toolInput: { command: args.command }, response: { stdout: merged, stderr: '' },
        sessionId: options.sessionId, toolUseId: call.id, cwd: root,
      });
      if (outcome.decision.artifactId) archived.add(outcome.decision.artifactId);
      const response = outcome.response as { stdout?: unknown };
      let text = typeof response?.stdout === 'string' ? response.stdout : merged;
      const id = outcome.decision.artifactId;
      if (id && outcome.decision.status === 'filtered') {
        text = text.replace(`[fonn: full original tool response archived as ${id}; recover with the read_original tool, {"id":"${id}"}.]`, recovery(id));
      }
      if (text.length > maxDelivered) {
        // Too large for a small context. Keep the start and end and archive the whole output.
        let archiveId = id;
        if (!archiveId) {
          try {
            archiveId = (await store.save({ toolName: 'Bash', sessionId: options.sessionId, toolUseId: call.id, response: { stdout: merged, stderr: '' } })).id;
            archived.add(archiveId);
          } catch { archiveId = undefined; }
        }
        const half = Math.floor(maxDelivered / 2);
        const note = archiveId ? recovery(archiveId) : '[fonn: the full output could not be archived]';
        text = `${text.slice(0, half)}\n[fonn: ${text.length - 2 * half} characters omitted from the middle]\n${text.slice(-half)}\n${note}\n`;
      }
      const status = result.timedOut ? `timed out after ${Number((timeoutMs / 1_000).toFixed(1))} seconds; the command was stopped` : result.exitCode !== null ? `exit code ${result.exitCode}` : `stopped by signal ${result.signal ?? 'unknown'}`;
      const content = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${status}`;
      const ok = !result.timedOut && result.exitCode === 0;
      const decision = outcome.decision;
      return { ok, content, summary: status, filter: summarize(decision, text.length) };
    },

    async read_file(args, _call, signal) {
      const place = await readAccess(args.path, 'Read', signal);
      if (!('real' in place)) return place;
      const text = await readText(place.real);
      const lines = text.split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const start = args.offset_line ?? 1;
      if (text && start > lines.length) return failure(`${place.display} has ${lines.length} lines; offset_line ${start} is past the end.`);
      let selected = lines.slice(start - 1, start - 1 + (args.max_lines ?? DEFAULT_READ_LINES));
      let body = selected.join('\n');
      if (body.length > MAX_READ_CHARACTERS) {
        let size = 0;
        const kept: string[] = [];
        for (const line of selected) {
          if (size + line.length + 1 > MAX_READ_CHARACTERS && kept.length) break;
          kept.push(line.length > MAX_READ_CHARACTERS ? line.slice(0, MAX_READ_CHARACTERS) : line);
          size += line.length + 1;
        }
        selected = kept;
        body = selected.join('\n');
      }
      const end = start + selected.length - 1;
      const header = text ? `${place.display}: lines ${start}-${end} of ${lines.length}` : `${place.display}: empty file`;
      const more = end < lines.length ? `\n[more lines follow; continue with offset_line ${end + 1}]` : '';
      return { ok: true, content: `${header}\n${body}${more}`, summary: text ? `lines ${start}-${end} of ${lines.length}` : 'empty file' };
    },

    async list_files(args, _call, signal) {
      const place = await readAccess(args.path ?? '.', 'List', signal);
      if (!('real' in place)) return place;
      const entries = await readdir(place.real, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOTDIR') throw new ToolError(`${place.display} is a file. Use read_file.`);
        throw error;
      });
      const names = entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.isSymbolicLink() ? `${entry.name}@` : entry.name).sort();
      const shown = names.slice(0, MAX_LIST_ENTRIES);
      const more = names.length > shown.length ? `\n[${names.length - shown.length} more entries not shown]` : '';
      return { ok: true, content: `${place.display}:\n${shown.join('\n')}${more}`, summary: `${names.length} entries` };
    },

    async write_file(args, _call, signal) {
      const place = await locate(args.path);
      const exists = await stat(place.real).then((info) => {
        if (info.isDirectory()) throw new ToolError(`${place.display} is a folder.`);
        return true;
      }, () => false);
      const where = place.inside ? place.display : `${place.real}, outside the project`;
      const allowed = await approve({
        kind: 'write', summary: `${exists ? 'Replace' : 'Create'} ${where} (${lineCount(args.content)} lines)`,
        detail: truncate(args.content, MAX_DETAIL_CHARACTERS), target: place.real,
      }, rememberedPaths, signal);
      if (allowed !== true) return allowed;
      await mkdir(path.dirname(place.real), { recursive: true });
      await writeFile(place.real, args.content, 'utf8');
      return { ok: true, content: `${exists ? 'Replaced' : 'Created'} ${place.display} (${lineCount(args.content)} lines).`, summary: `${exists ? 'Replaced' : 'Created'} ${place.display}` };
    },

    async edit_file(args, _call, signal) {
      const place = await locate(args.path);
      const content = await readText(place.real).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolError(`${place.display} does not exist. Use write_file to create it.`);
        throw error;
      });
      const index = content.indexOf(args.old_text);
      if (index < 0) return failure(`old_text was not found in ${place.display}. Read the file and copy the text exactly, including spaces and indentation.`, 'old_text not found');
      let count = 0;
      for (let at = index; at >= 0; at = content.indexOf(args.old_text, at + 1)) count++;
      if (count > 1) return failure(`old_text occurs ${count} times in ${place.display}. Include more surrounding lines so it occurs exactly once.`, `old_text occurs ${count} times`);
      if (args.old_text === args.new_text) return failure('old_text and new_text are the same. Nothing to change.', 'no change');
      const updated = content.slice(0, index) + args.new_text + content.slice(index + args.old_text.length);
      const where = place.inside ? place.display : `${place.real}, outside the project`;
      const allowed = await approve({
        kind: 'edit', summary: `Edit ${where}`, detail: editDiff(place.display, content, updated), target: place.real,
      }, rememberedPaths, signal);
      if (allowed !== true) return allowed;
      // Read again so a change made while the user decided is not overwritten.
      const current = await readText(place.real);
      if (current !== content) return failure(`${place.display} changed while waiting for approval. Read it again and retry.`, 'file changed');
      await writeFile(place.real, updated, 'utf8');
      return { ok: true, content: `Edited ${place.display}.`, summary: `Edited ${place.display}` };
    },

    async read_original(args) {
      if (!archived.has(args.id)) return failure(`No shortened output with id ${args.id} exists in this session.`, 'unknown archive id');
      const slice = await store.read(args.id, { offset: args.offset ?? 0, limit: ORIGINAL_SLICE_CHARACTERS }).catch((error: unknown) => {
        if (error instanceof Error && /offset exceeds/i.test(error.message)) throw new ToolError('offset is past the end of the original.');
        throw error;
      });
      const next = slice.nextOffset === null ? '[end of original]' : `[more follows; call read_original with offset ${slice.nextOffset}]`;
      return {
        ok: true,
        content: `Original ${slice.id}, characters ${slice.offset}-${slice.offset + slice.text.length} of ${slice.totalCharacters} (JSON of the command output):\n${slice.text}\n${next}`,
        summary: `characters ${slice.offset}-${slice.offset + slice.text.length} of ${slice.totalCharacters}`,
      };
    },
  };

  function parse(call: ToolCall): { name: ToolName; args: unknown } | ToolOutcome {
    if (!Object.hasOwn(argumentSchemas, call.name)) {
      return failure(`unknown tool "${call.name}". Use one of: ${Object.keys(argumentSchemas).join(', ')}.`, `unknown tool ${call.name}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(call.arguments.trim() || '{}'); }
    catch { return failure(`the arguments for ${call.name} are not valid JSON. Send one JSON object that matches the tool schema.`, 'invalid JSON arguments'); }
    const name = call.name as ToolName;
    const parsed = argumentSchemas[name].safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
      return failure(`invalid arguments for ${name}: ${problems}`, 'invalid arguments');
    }
    return { name, args: parsed.data };
  }

  return {
    describe(call) {
      let args: Record<string, unknown> = {};
      try { const parsed: unknown = JSON.parse(call.arguments); if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>; }
      catch { /* Described from the name only. */ }
      const text = (value: unknown) => (typeof value === 'string' ? value.split('\n')[0]!.slice(0, 200) : '');
      switch (call.name) {
        case 'run_command': return text(args.command) || 'run a command';
        case 'read_file': return `Read ${text(args.path)}`.trim();
        case 'list_files': return `List ${text(args.path) || '.'}`;
        case 'write_file': return `Write ${text(args.path)}`.trim();
        case 'edit_file': return `Edit ${text(args.path)}`.trim();
        case 'read_original': return `Read original ${text(args.id)}`.trim();
        default: return call.name || 'unknown tool';
      }
    },
    async run(call, signal) {
      if (signal?.aborted) return { ok: false, content: 'cancelled', summary: 'Cancelled', cancelled: true };
      const parsed = parse(call);
      if (!('name' in parsed)) return parsed;
      try {
        // Each tool's schema was checked by parse above.
        const tool = tools[parsed.name] as (args: unknown, call: ToolCall, signal: AbortSignal | undefined) => Promise<ToolOutcome>;
        return await tool(parsed.args, call, signal);
      } catch (error) {
        if (signal?.aborted) return { ok: false, content: 'cancelled', summary: 'Cancelled', cancelled: true };
        if (error instanceof ToolError) return failure(error.message);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return failure('that file or folder does not exist.', 'not found');
        if (code === 'EACCES' || code === 'EPERM') return failure('permission denied.', 'permission denied');
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
