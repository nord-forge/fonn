#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { ArtifactSlice, FilterMode, PermissionRequest, ProfileName, RunRecord, RunTaskOptions, TaskProfile } from '@nord-forge/fonn-core/contracts';
import { createProfileStore, effortSchema, getDefaultConfigDirectory, modelSchema, providerSchema, resolveProfile, resolveProfileForProvider, taskProfileSchema } from '@nord-forge/fonn-core/profiles';
import { renderRun, runExitCode, terminalText, validateResult } from './render.js';

export interface CliDependencies {
  runTask: (options: RunTaskOptions) => Promise<RunRecord>;
  listRuns: (stateDirectory?: string) => Promise<RunRecord[]>;
  readRun: (taskId: string, stateDirectory?: string) => Promise<RunRecord>;
  readArtifact: (taskId: string, artifactId: string, options: { offset: number; limit: number }, stateDirectory?: string) => Promise<ArtifactSlice>;
  launchClaude: (options: { cwd: string; profile?: ProfileName; filterMode?: FilterMode; stateDirectory?: string; configDirectory?: string; args?: string[] }) => Promise<number>;
  launchCodex: CliDependencies['launchClaude'];
  runNativeHook: (event: unknown, stateDirectory: string, launchId: string) => Promise<unknown>;
  runCodexHook: CliDependencies['runNativeHook'];
  readNativeOutput: (launchId: string, artifactId: string, options: { offset: number; limit: number }, stateDirectory?: string) => Promise<ArtifactSlice>;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  onInterrupt: (handler: () => void) => () => void;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
}

const help = `Fonn — native Claude and Codex launchers, Claude Agent SDK tasks

Usage:
  fonn [--cwd <dir>] [--profile <name>] [--filter <mode>] [--state-dir <path>] [-- <native args>]
  fonn claude [launcher options] [-- <claude args>]
  fonn codex [launcher options] [-- <codex args>]
  fonn --default [claude|codex] [--json]
  fonn profiles [--json]
  fonn help profiles | codex
  fonn run <prompt> [options]
  fonn runs [--state-dir <path>] [--json]
  fonn show <task-id> [--state-dir <path>] [--json]
  fonn output <task-id> <artifact-id> [--offset <n>] [--limit <n>] [--state-dir <path>]
  fonn native-output <launch-id> <artifact-id> [--offset <n>] [--limit <n>] [--state-dir <path>]
  fonn doctor [--json]
  fonn help | --help | --version

Run options:
  --cwd <dir>            Target project directory (default: current directory)
  --profile <name>       Built-in or saved profile (default: configured default, initially opus-medium)
  --budget <dollars>     Positive estimated API stop budget (default: 5; can overshoot)
  --max-turns <n>        Positive integer turn limit (default: 20)
  --filter <mode>        filter | observe | off (default: filter)
  --state-dir <path>     Separate local run and raw-output storage
  --resume <task-id>     Resume an existing task with its saved profile
  --json                Emit one JSON value; diagnostics and permissions use stderr

API-key authentication uses ANTHROPIC_API_KEY and separate API billing.
Use --default claude or --default codex to save the default agent and exit.
Use --default alone to show it. Explicit agent commands or --profile override it for one launch.
With no command, the selected profile or configured default chooses the native provider.
The claude and codex commands use their existing authentication and native controls.
Codex filtering requires review and trust in /hooks; Fonn does not bypass hook trust.
SDK budget, structured JSON, and turn-limit flags belong to run, which supports Claude only.
SDK permission requests require an explicit interactive yes; noninteractive requests are denied.
Artifact reads default to 4000 characters and are limited to 20000 per request.
`;

const profilesHelp = `Fonn profiles — saved provider, model and effort choices

Usage:
  fonn profiles [list] [--json]
  fonn profiles show <name> [--json]
  fonn profiles create <name> [--provider claude|codex] --model <model> --effort <level> [--json]
  fonn profiles edit <name> [--provider claude|codex] [--model <model>] [--effort <level>] [--json]
  fonn profiles delete <name> [--json]
  fonn profiles default [<name>] [--json]
  fonn help profiles | profiles --help

Provider defaults to Claude when creating a profile.
Claude models: opus, sonnet, haiku, or a Claude model ID.
Codex models: gpt-* or o-series model IDs, for example gpt-6.1-sol.
Provider/model pairs are validated for syntax; model availability is not verified.
Effort: low | medium | high | xhigh | max. Model support is not verified.
Edit requires at least one change. Built-in profiles cannot be edited or deleted.
Choose another default before deleting the current default profile.
Configuration: ~/.config/fonn/profiles.json; XDG_CONFIG_HOME and FONN_CONFIG_DIR override it.
Profiles store provider, model and effort only; credentials and permission settings remain separate.
SDK resume retains the saved profile snapshot, even after the profile is edited or deleted.
`;

const codexHelp = `Fonn Codex — ordinary interactive Codex with a saved profile

Usage:
  fonn codex [--cwd <dir>] [--profile <name>] [--filter filter|observe|off] [--state-dir <path>] [-- <codex args>]
  fonn codex --profile codex:sol-medium
  fonn --profile codex:sol-medium
  fonn codex -- --search
  fonn profiles create my-sol --provider codex --model gpt-6.1-sol --effort high

Install and authenticate Codex separately. Existing Codex authentication, permissions,
project settings and terminal controls remain active. No SDK budgets or usage accounting apply.
The default Codex profile is codex:sol-medium when the global default belongs to Claude.
Explicit --profile must name a Codex profile. With no command, the profile selects the provider.
Filtering requires Codex hook support and manual review/trust in /hooks.
New or changed hooks remain inactive until trusted; Fonn does not bypass hook trust.
Filter mode reduces recognized output; observe archives proposals without changing output;
off registers no Fonn hook. Display visibility alone does not imply fewer model tokens.
Original outputs can be recovered with fonn native-output <launch-id> <artifact-id>.
fonn run remains Claude SDK only; a programmatic Codex SDK runtime is not implemented.
`;

interface Parsed { positionals: string[]; flags: Map<string, string | true> }
function parse(args: string[], allowed: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--') { positionals.push(...args.slice(index + 1)); break; }
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const flag = value.slice(2);
    if (!allowed.includes(flag)) throw new Error(`Unknown option ${value}. Use --help for usage.`);
    if (flags.has(flag)) throw new Error(`Option ${value} was supplied more than once.`);
    if (flag === 'json') { flags.set(flag, true); continue; }
    const argument = args[++index];
    if (!argument || argument.startsWith('--')) throw new Error(`Option ${value} requires a value.`);
    flags.set(flag, argument);
  }
  return { positionals, flags };
}
function numeric(value: string | true | undefined, name: string, fallback: number, integer = false, allowZero = false): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0) || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be a ${allowZero ? 'nonnegative' : 'positive'} ${integer ? 'integer' : 'number'}.`);
  }
  return parsed;
}
function argumentCount(parsed: Parsed, count: number, usage: string): void {
  if (parsed.positionals.length !== count) throw new Error(`Expected ${usage}. Use --help for usage.`);
}
function stringFlag(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name) as string | undefined;
}
async function version(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

/** Dispatch is importable and accepts all I/O/runtime seams for offline tests. */
export async function dispatch(args: string[], injected: Partial<CliDependencies> = {}): Promise<number> {
  const env = injected.env ?? process.env;
  const redact = (value: string) => env.ANTHROPIC_API_KEY ? value.split(env.ANTHROPIC_API_KEY).join('[REDACTED]') : value;
  const writeStdout = injected.stdout ?? ((text: string) => process.stdout.write(text));
  const stdout = (value: string) => writeStdout(redact(value));
  const stderr = (value: string) => (injected.stderr ?? (text => process.stderr.write(text)))(terminalText(redact(value)) + (value.endsWith('\n') ? '' : '\n'));
  const json = (value: unknown) => writeStdout(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redact(item) : item) + '\n');
  try {
    // Implicit native launches follow the profile provider; explicit commands pin it.
    const autoLaunch = args.length === 0 || ['--cwd', '--profile', '--filter', '--state-dir', '--'].includes(args[0]!);
    if (autoLaunch) {
      args = ['claude', ...args];
    }
    const command = args[0]!;
    if (command === 'help') {
      if (args.length === 1) { stdout(help); return 0; }
      if (args.length === 2 && args[1] === 'profiles') { stdout(profilesHelp); return 0; }
      if (args.length === 2 && args[1] === 'codex') { stdout(codexHelp); return 0; }
      throw new Error('Expected help [profiles|codex]. Use --help for usage.');
    }
    if (command === 'profiles' && args.length === 2 && args[1] === '--help') { stdout(profilesHelp); return 0; }
    if (command === 'codex' && args.length === 2 && args[1] === '--help') { stdout(codexHelp); return 0; }
    if (command === '--help' || command === '-h' || (args.length === 2 && args[1] === '--help')) { stdout(help); return 0; }
    if (command === '--version') { if (args.length !== 1) throw new Error('--version takes no arguments.'); stdout(await version() + '\n'); return 0; }
    if (command === '--default') {
      const parsed = parse(args.slice(1), ['json']);
      if (parsed.positionals.length > 1) throw new Error('Expected --default [claude|codex] [--json].');
      const name = parsed.positionals[0];
      const provider = name === undefined ? undefined : providerSchema.parse(name);
      const store = createProfileStore(getDefaultConfigDirectory(env));
      const profile = provider === undefined ? await store.get() : await store.setDefaultProvider(provider);
      const result = { provider: profile.provider ?? 'claude', profile: profile.name };
      if (parsed.flags.has('json')) json(result);
      else stdout(`Default agent: ${result.provider} (profile: ${terminalText(result.profile)}).\n`);
      return 0;
    }
    if (command === 'claude' || command === 'codex') {
      const separator = args.indexOf('--');
      const parsed = parse(args.slice(1, separator < 0 ? undefined : separator), ['cwd', 'profile', 'filter', 'state-dir']);
      argumentCount(parsed, 0, `${command} [options] [-- <native args>]`);
      const filterMode = stringFlag(parsed, 'filter') ?? 'filter';
      if (!['filter', 'observe', 'off'].includes(filterMode)) throw new Error('--filter must be filter, observe, or off.');
      const configDirectory = getDefaultConfigDirectory(env);
      const profile = autoLaunch
        ? await resolveProfile(stringFlag(parsed, 'profile'), configDirectory)
        : await resolveProfileForProvider(command, stringFlag(parsed, 'profile'), configDirectory);
      const launch = profile.provider === 'codex'
        ? injected.launchCodex ?? (await import('../native/codex.js')).launchCodex
        : injected.launchClaude ?? (await import('../native/index.js')).launchClaude;
      return await launch({ cwd: resolve(stringFlag(parsed, 'cwd') ?? process.cwd()), profile: profile.name, filterMode: filterMode as FilterMode, stateDirectory: stringFlag(parsed, 'state-dir'), configDirectory, args: separator < 0 ? [] : args.slice(separator + 1) });
    }
    if (command === 'codex-hook') {
      const parsed = parse(args.slice(1), []);
      argumentCount(parsed, 0, 'codex-hook');
      const stateDirectory = env.FONN_CODEX_STATE_DIR;
      const launchId = env.FONN_CODEX_LAUNCH_ID;
      if (!stateDirectory?.trim() || !launchId?.trim()) throw new Error('codex-hook requires FONN_CODEX_STATE_DIR and FONN_CODEX_LAUNCH_ID.');
      const input = await (injected.readStdin ?? readStdin)();
      let event: unknown;
      try { event = JSON.parse(input); } catch { throw new Error('codex-hook requires a JSON event on stdin.'); }
      const hook = injected.runCodexHook ?? (await import('../native/codex.js')).runCodexHook;
      json(await hook(event, stateDirectory, launchId));
      return 0;
    }
    if (command === 'native-hook') {
      const parsed = parse(args.slice(1), ['state-dir', 'launch-id']);
      argumentCount(parsed, 0, 'native-hook --launch-id <id> --state-dir <path>');
      const stateDirectory = stringFlag(parsed, 'state-dir');
      const launchId = stringFlag(parsed, 'launch-id');
      if (!stateDirectory || !launchId) throw new Error('native-hook requires --launch-id and --state-dir.');
      const input = await (injected.readStdin ?? readStdin)();
      let event: unknown;
      try { event = JSON.parse(input); } catch { throw new Error('native-hook requires a JSON event on stdin.'); }
      const hook = injected.runNativeHook ?? (await import('../native/index.js')).runNativeHook;
      json(await hook(event, stateDirectory, launchId));
      return 0;
    }
    if (command === 'profiles') {
      const action = args[1] && !args[1].startsWith('--') ? args[1] : 'list';
      if (!['list', 'show', 'create', 'edit', 'delete', 'default'].includes(action)) throw new Error(`Unknown profiles command ${action}. Use fonn help profiles for usage.`);
      const parsed = parse(args.slice(args[1] === action ? 2 : 1), action === 'create' || action === 'edit' ? ['provider', 'model', 'effort', 'json'] : ['json']);
      if (action === 'default') {
        if (parsed.positionals.length > 1) throw new Error('Expected profiles default [<name>]. Use fonn help profiles for usage.');
      } else argumentCount(parsed, action === 'list' ? 0 : 1, action === 'list' ? 'profiles list' : `profiles ${action} <name>`);
      const store = createProfileStore(getDefaultConfigDirectory(env));
      const renderProfile = (profile: TaskProfile) => `${terminalText(profile.name)} [${terminalText(profile.provider ?? 'claude')}]: ${terminalText(profile.model)}, effort ${terminalText(profile.effort)}`;
      if (action === 'list') {
        const listing = await store.list();
        if (parsed.flags.has('json')) json(listing.profiles);
        else stdout(listing.profiles.map(profile => `${renderProfile(profile)}${profile.name === listing.defaultProfile ? ' (default)' : ''}`).join('\n') + '\n');
        return 0;
      }
      const name = parsed.positionals[0];
      if (action === 'delete') {
        await store.delete(name!);
        if (parsed.flags.has('json')) json({ deleted: name });
        else stdout(`Deleted profile ${terminalText(name!)}.\n`);
        return 0;
      }
      let profile: TaskProfile;
      if (action === 'create') {
        if (!parsed.flags.has('model') || !parsed.flags.has('effort')) throw new Error('profiles create requires --model and --effort.');
        profile = await store.create(taskProfileSchema.parse({ name, ...(parsed.flags.has('provider') ? { provider: providerSchema.parse(stringFlag(parsed, 'provider')) } : {}), model: stringFlag(parsed, 'model'), effort: stringFlag(parsed, 'effort') }));
      } else if (action === 'edit') {
        if (!parsed.flags.has('provider') && !parsed.flags.has('model') && !parsed.flags.has('effort')) throw new Error('profiles edit requires --provider, --model or --effort.');
        profile = await store.edit(name!, {
          ...(parsed.flags.has('provider') ? { provider: providerSchema.parse(stringFlag(parsed, 'provider')) } : {}),
          ...(parsed.flags.has('model') ? { model: modelSchema.parse(stringFlag(parsed, 'model')) } : {}),
          ...(parsed.flags.has('effort') ? { effort: effortSchema.parse(stringFlag(parsed, 'effort')) } : {}),
        });
      } else if (action === 'default' && name !== undefined) profile = await store.setDefault(name);
      else profile = await store.get(name);
      if (parsed.flags.has('json')) json(profile);
      else stdout(`${renderProfile(profile)}${action === 'default' ? ' (default)' : ''}\n`);
      return 0;
    }
    if (command === 'doctor') {
      const parsed = parse(args.slice(1), ['json']);
      argumentCount(parsed, 0, command);
      const nodeVersion = injected.nodeVersion ?? process.versions.node;
      const nodeSupported = Number(nodeVersion.split('.')[0]) >= 22;
      const report = { nodeVersion, nodeSupported, apiKeyPresent: Boolean(env.ANTHROPIC_API_KEY?.trim()), configurationCompatible: nodeSupported, authentication: 'ANTHROPIC_API_KEY only', projectSettings: 'user, project, local and managed settings preserved', networkChecked: false };
      if (parsed.flags.has('json')) json(report);
      else stdout(`Node ${terminalText(nodeVersion)}: ${nodeSupported ? 'supported' : 'unsupported; Node 22+ required'}\nANTHROPIC_API_KEY present: ${report.apiKeyPresent}\nConfiguration compatible: ${report.configurationCompatible}\nAuthentication: ${report.authentication}; separate API billing\nProject settings: ${report.projectSettings}\nOffline check only; credentials and model access were not verified.\n`);
      return nodeSupported && report.apiKeyPresent ? 0 : 1;
    }
    if (command === 'run') {
      const parsed = parse(args.slice(1), ['cwd', 'profile', 'budget', 'max-turns', 'filter', 'state-dir', 'resume', 'json']);
      argumentCount(parsed, 1, 'run <prompt>');
      if (!parsed.positionals[0]!.trim()) throw new Error('The prompt must not be empty.');
      const configDirectory = getDefaultConfigDirectory(env);
      let profile = stringFlag(parsed, 'profile');
      if (!parsed.flags.has('resume')) {
        const selected = await resolveProfile(profile, configDirectory);
        if (selected.provider === 'codex') throw new Error(`fonn run supports Claude SDK profiles only. Use fonn codex --profile ${selected.name} for native Codex, or run with --profile opus-medium.`);
        profile = selected.name;
      }
      const filterMode = stringFlag(parsed, 'filter') ?? 'filter';
      if (!['filter', 'observe', 'off'].includes(filterMode)) throw new Error('--filter must be filter, observe, or off.');
      const budgetUsd = numeric(parsed.flags.get('budget'), '--budget', 5);
      const maxTurns = numeric(parsed.flags.get('max-turns'), '--max-turns', 20, true);
      const abort = new AbortController();
      const onInterrupt = injected.onInterrupt ?? (handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; });
      const detach = onInterrupt(() => { abort.abort(); stderr('Interrupted; saving the task outcome…'); });
      try {
        const interactive = injected.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
        const ask = async (question: string): Promise<string> => {
          if (injected.ask) return injected.ask(question);
          const reader = createInterface({ input: process.stdin, output: process.stderr });
          try { return await reader.question(question, { signal: abort.signal }); } finally { reader.close(); }
        };
        const approveTool = async (request: PermissionRequest): Promise<boolean> => {
          stderr(`Permission request (untrusted tool input): ${request.toolName}\n${JSON.stringify(request.input)}${request.reason ? `\nReason: ${request.reason}` : ''}`);
          if (!interactive) { stderr('Denied: permission requires an interactive terminal.'); return false; }
          const question = 'Allow this tool call? Type yes to approve: ';
          const answer = await ask(question);
          return answer.trim().toLowerCase() === 'yes' && !abort.signal.aborted;
        };
        const answerQuestions: NonNullable<RunTaskOptions['answerQuestions']> = async request => {
          if (!interactive || abort.signal.aborted) { stderr('Question left unresolved: an interactive terminal is required.'); return undefined; }
          const answers: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const question of request.questions) {
            stderr(`Question (untrusted model input): ${question.question}`);
            for (const option of question.options) stderr(`- ${option.label}${option.description ? `: ${option.description}` : ''}`);
            if (question.multiSelect) stderr('Multiple selections may be entered as text.');
            const answer = (await ask('Answer (label or text; blank leaves unresolved): ')).trim();
            if (!answer || answer.length > 10000 || abort.signal.aborted) return undefined;
            answers[question.question] = answer;
          }
          return answers;
        };
        const runTask = injected.runTask ?? (await import('@nord-forge/fonn-core/runtime')).runTask;
        const record = await runTask({ prompt: parsed.positionals[0]!, cwd: resolve(stringFlag(parsed, 'cwd') ?? process.cwd()), profile, budgetUsd, maxTurns, filterMode: filterMode as RunTaskOptions['filterMode'], stateDirectory: stringFlag(parsed, 'state-dir'), configDirectory, resumeTaskId: stringFlag(parsed, 'resume'), signal: abort.signal, approveTool, answerQuestions, onEvent: event => stderr(`${event.type}: ${event.message}`) });
        validateResult(record);
        if (parsed.flags.has('json')) json(record); else stdout(renderRun(record) + '\n');
        return runExitCode(record);
      } finally { detach(); }
    }
    if (command === 'runs' || command === 'show' || command === 'output' || command === 'native-output') {
      const parsed = parse(args.slice(1), command === 'output' || command === 'native-output' ? ['state-dir', 'offset', 'limit'] : ['state-dir', 'json']);
      argumentCount(parsed, command === 'runs' ? 0 : command === 'show' ? 1 : 2, command === 'runs' ? 'runs' : command === 'show' ? 'show <task-id>' : command === 'native-output' ? 'native-output <launch-id> <artifact-id>' : 'output <task-id> <artifact-id>');
      const stateDirectory = stringFlag(parsed, 'state-dir');
      if (command === 'runs') {
        const listRuns = injected.listRuns ?? (await import('@nord-forge/fonn-core/runtime')).listRuns;
        const records = await listRuns(stateDirectory);
        records.forEach(validateResult);
        if (parsed.flags.has('json')) json(records);
        else stdout(records.length ? records.map(record => `${terminalText(record.taskId)}  ${record.status}  ${record.profile.name}  $${record.usage.estimatedCostUsd.toFixed(4)} estimated  ${terminalText(record.startedAt)}`).join('\n') + '\n' : 'No saved runs.\n');
        return 0;
      }
      if (command === 'show') {
        const readRun = injected.readRun ?? (await import('@nord-forge/fonn-core/runtime')).readRun;
        const record = await readRun(parsed.positionals[0]!, stateDirectory);
        validateResult(record);
        if (parsed.flags.has('json')) json(record); else stdout(renderRun(record) + '\n');
        return runExitCode(record);
      }
      const offset = numeric(parsed.flags.get('offset'), '--offset', 0, true, true);
      const limit = numeric(parsed.flags.get('limit'), '--limit', 4000, true);
      if (limit > 20000) throw new Error('--limit must not exceed 20000 characters.');
      const readArtifact = command === 'native-output' ? injected.readNativeOutput ?? (await import('../native/index.js')).readNativeOutput : injected.readArtifact ?? defaultReadArtifact;
      const slice = await readArtifact(parsed.positionals[0]!, parsed.positionals[1]!, { offset, limit }, stateDirectory);
      stdout(terminalText(slice.text) + '\n');
      stderr(`Artifact ${slice.id}: characters ${slice.offset}–${slice.offset + slice.text.length} of ${slice.totalCharacters}${slice.nextOffset !== null ? `; next --offset ${slice.nextOffset}` : ''}`);
      return 0;
    }
    throw new Error(`Unknown command ${command}. Use --help for usage.`);
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += buffer.length;
    if (length > 10_000_000) throw new Error('Hook input exceeds the 10 MB limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function defaultReadArtifact(taskId: string, artifactId: string, options: { offset: number; limit: number }, stateDirectory?: string): Promise<ArtifactSlice> {
  const runtime = await import('@nord-forge/fonn-core/runtime');
  // Loading the record first delegates task-id validation to the runtime.
  await runtime.readRun(taskId, stateDirectory);
  const { createArtifactStore } = await import('@nord-forge/fonn-core/filtering');
  return createArtifactStore(await runtime.getTaskArtifactDirectory(taskId, stateDirectory)).read(artifactId, options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await dispatch(process.argv.slice(2));
}
