#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore, createOutputFilter } from './index.mjs';

const STORE_KEY = /^[0-9a-f]{64}$/;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const PROVIDERS = ['claude', 'codex', 'crush', 'opencode'];
// Crush and OpenCode name the shell tool "bash" and pass its output as one string.
const TEXT_PROVIDERS = ['crush', 'opencode'];
const scriptPath = fileURLToPath(import.meta.url);
const usage = 'Usage: node hook.mjs hook --provider claude|codex|crush|opencode --mode filter|observe|off [--level strict|standard|similar] [--state-dir PATH]\n       node hook.mjs read STORE-KEY ARTIFACT-ID [--state-dir PATH] [--offset N] [--limit N]\nRequires Node 22+. Recovery defaults to 4000 characters, maximum 20000.\n';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function argumentsFor(args) {
  const command = args.shift();
  if (!['hook', 'read'].includes(command)) throw new Error('Invalid command');
  const result = { command };
  if (command === 'read') {
    result.storeKey = args.shift();
    result.artifactId = args.shift();
    if (!STORE_KEY.test(result.storeKey ?? '') || !ARTIFACT_ID.test(result.artifactId ?? '')) throw new Error('Invalid recovery identifiers');
  }
  const allowed = command === 'hook' ? ['--provider', '--mode', '--level', '--state-dir'] : ['--state-dir', '--offset', '--limit'];
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (!allowed.includes(flag) || seen.has(flag)) throw new Error('Invalid or repeated option');
    seen.add(flag);
    const value = args.shift();
    if (!value || value.startsWith('--') || value.includes('\0')) throw new Error('Missing or invalid option value');
    result[flag.slice(2)] = value;
  }
  if (command === 'hook' && (!PROVIDERS.includes(result.provider) || !['filter', 'observe', 'off'].includes(result.mode))) throw new Error('Provider and mode are required');
  if (command === 'hook') {
    result.level ??= 'standard';
    if (!['strict', 'standard', 'similar'].includes(result.level)) throw new Error('Level must be strict, standard or similar');
  }
  for (const [key, fallback, minimum, maximum] of [['offset', 0, 0, Number.MAX_SAFE_INTEGER], ['limit', 4000, 1, 20000]]) {
    const value = result[key];
    if (value !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid read bounds');
    result[key] = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum) throw new Error('Invalid read bounds');
  }
  result.stateDirectory = resolve(result['state-dir'] ?? '.fonn/filtering');
  return result;
}

// Check every component, including existing parents. Do not canonicalize an
// attacker-controlled state path first: that would hide symlinks from this check.
async function checkedDirectory(directory, create) {
  let current = parse(directory).root;
  for (const component of directory.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Unsafe state directory');
  }
  return directory;
}

function guardedStore(stateDirectory, storeKey) {
  const directory = join(stateDirectory, storeKey);
  const store = createArtifactStore(directory);
  async function guard(create) {
    await checkedDirectory(stateDirectory, create);
    await checkedDirectory(directory, create);
  }
  return {
    async save(input) { await guard(true); return store.save(input); },
    async read(id, bounds) { await guard(false); return store.read(id, bounds); },
  };
}

async function inputEvent() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Hook input too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function hook(options) {
  if (options.mode === 'off') return {};
  const event = await inputEvent();
  const text = TEXT_PROVIDERS.includes(options.provider);
  if (!record(event) || event.hook_event_name !== 'PostToolUse') return {};
  if (text ? typeof event.tool_name !== 'string' || event.tool_name.toLowerCase() !== 'bash' || typeof event.tool_response !== 'string' : event.tool_name !== 'Bash') return {};
  if (typeof event.session_id !== 'string' || !event.session_id.trim() || event.session_id.length > 512 || /[\u0000-\u001f\u007f]/.test(event.session_id)) return {};
  if (typeof event.cwd !== 'string' || !isAbsolute(event.cwd) || event.cwd.includes('\0')) return {};
  const cwd = await realpath(event.cwd);
  if (!(await lstat(cwd)).isDirectory()) return {};
  const storeKey = createHash('sha256').update(JSON.stringify([options.provider, cwd, event.session_id])).digest('hex');
  const store = guardedStore(options.stateDirectory, storeKey);
  const recoveryHint = id => [process.execPath, scriptPath, 'read', storeKey, id, '--state-dir', options.stateDirectory].map(quote).join(' ');
  const filter = createOutputFilter({ mode: options.mode, level: options.level, store, recoveryHint });
  const outcome = await filter.apply({ toolName: 'Bash', toolInput: event.tool_input, response: event.tool_response,
    sessionId: event.session_id, toolUseId: typeof event.tool_use_id === 'string' ? event.tool_use_id : '', cwd });
  if (outcome.decision.status !== 'filtered') return {};
  if (text) return { updated_output: outcome.response };
  if (options.provider === 'claude') return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: outcome.response } };
  return { continue: false, stopReason: typeof outcome.response === 'string' ? outcome.response : JSON.stringify(outcome.response) };
}

let options;
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or later is required');
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
  else options = argumentsFor(process.argv.slice(2));
} catch {
  process.stderr.write(`fonn-filter: invalid command.\n${usage}`);
  process.exitCode = 1;
}
if (options) {
  try {
    const output = options.command === 'hook' ? await hook(options) : await guardedStore(options.stateDirectory, options.storeKey).read(options.artifactId, { offset: options.offset, limit: options.limit });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stderr.write(options.command === 'hook' ? 'fonn-filter: hook unavailable; original output retained.\n' : 'fonn-filter: recovery unavailable; check identifiers, state directory and bounds.\n');
    if (options.command === 'hook') process.stdout.write('{}\n');
    else process.exitCode = 1;
  }
}
