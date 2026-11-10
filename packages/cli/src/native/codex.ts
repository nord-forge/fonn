import type { TaskProfile } from '@nord-forge/fonn-core';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ToolObservation } from '@nord-forge/fonn-core/contracts';
import { createArtifactStore, createOutputFilter } from '@nord-forge/fonn-core/filtering';
import { nativeDelegationContext } from './delegation.js';
import { captureNativeSession, nativeResumeArguments, printNativeResumeHint, resolveNativeProfile } from './session.js';
import { atomicJson, launchDirectory, privateDirectory, readLaunch, shellQuote } from './storage.js';
import type { LaunchRecord, NativeLaunchOptions } from './storage.js';

const executeFile = promisify(execFile);

function validateArguments(args: string[]): string[] {
  const switches = new Set(['--help', '-h', '--version', '-V', '--no-alt-screen', '--no-daemon', '--strict-config', '--search']);
  const commands = new Set(['exec', 'e', 'review', 'login', 'logout', 'auth', 'mcp', 'mcp-server', 'app-server', 'app', 'completion', 'sandbox', 'debug', 'apply', 'a', 'resume', 'fork', 'cloud', 'features', 'help', 'update', 'upgrade', 'doctor', 'models', 'run', 'serve', 'agents', 'remote-control', 'exec-server', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive']);
  const flags: string[] = [];
  let prompt: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (switches.has(argument)) { flags.push(argument); continue; }
    if (argument === '--image' || argument === '-i') {
      const value = args[++index];
      if (!value || value.startsWith('-') || value.includes('\0')) throw new Error('The native Codex launcher requires a value after --image or -i.');
      flags.push(argument, value);
      continue;
    }
    // Deny unknown flags, including attached short options, so future config,
    // authentication, policy, or hook-trust options cannot bypass this boundary.
    if (!argument || argument.includes('\0') || argument.startsWith('-') || commands.has(argument) || prompt !== undefined) {
      throw new Error('The native Codex launcher controls model, configuration, hooks, and interactive launches. Pass one quoted prompt and supported display/image options; use plain Codex for other commands.');
    }
    prompt = argument;
  }
  // A prompt can never become a current or future Codex management subcommand.
  return prompt === undefined ? flags : [...flags, '--', prompt];
}

async function verifyCodex(executable: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await executeFile(executable, ['--version'], { timeout: 10_000, encoding: 'utf8' }));
  } catch {
    throw new Error('Could not run Codex. Install the Codex CLI and confirm `codex --version` works.');
  }
  const version = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(stdout.trim())?.slice(1).map(Number);
  if (!version || (version[0] === 0 && version[1] < 167)) {
    throw new Error('Native Codex filtering requires Codex CLI 0.167.0 or newer, the version validated for this application.');
  }
}

/**
 * Codex arguments for where the model runs. Local models use Codex's own
 * --oss support; a named provider must exist in the user's Codex config,
 * which keeps its credentials. Fonn never adds or reads provider keys.
 */
export function sourceArguments(source: TaskProfile['source']): string[] {
  if (source === undefined) return [];
  if (source === 'ollama' || source === 'lmstudio') return ['--oss', '--local-provider', source];
  return ['-c', `model_provider=${JSON.stringify(source.slice('provider:'.length))}`];
}

/** Starts the user's actual Codex with its existing auth, settings, and permission flow. */
export async function launchCodex(options: NativeLaunchOptions): Promise<number> {
  const mode = z.enum(['filter', 'observe', 'off']).parse(options.filterMode ?? 'filter');
  const subagents = z.enum(['auto', 'off']).parse(options.subagents ?? 'auto');
  const level = z.enum(['strict', 'standard', 'similar']).parse(options.filterLevel ?? 'standard');
  const args = validateArguments(options.args ?? []);
  const resumeArgs = nativeResumeArguments('codex', options.resume);
  const profile = await resolveNativeProfile(options, 'codex');
  const cwd = await realpath(options.cwd);
  if (!(await lstat(cwd)).isDirectory()) throw new Error('The target working directory is not a directory.');
  const executable = options.executable ?? 'codex';
  await verifyCodex(executable);
  const compiled = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  const developmentBuild = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
  let entrypoint = options.hookEntrypoint;
  if (!entrypoint) {
    try { await access(compiled); entrypoint = compiled; }
    catch { entrypoint = developmentBuild; }
  }
  try { await access(entrypoint); }
  catch { throw new Error('Build fonn first with `npm run build` so the native hook entrypoint exists.'); }
  entrypoint = path.resolve(entrypoint);
  const launchId = randomUUID();
  const location = await launchDirectory(options.stateDirectory, launchId, true);
  const record: LaunchRecord = { schemaVersion: 1, launchId, provider: 'codex', cwd, profile: profile.name, profileSnapshot: profile, filterMode: mode, filterLevel: level, ...(options.filterRules?.length ? { filterRules: options.filterRules } : {}), subagents, createdAt: new Date().toISOString(), hookEntrypoint: entrypoint };
  const metadata = path.join(location.directory, 'launch.json');
  await atomicJson(metadata, record);
  const launchArgs = [...sourceArguments(profile.source), '--model', profile.model, '-c', `model_reasoning_effort=${JSON.stringify(profile.effort)}`];
  if (mode !== 'off' || subagents === 'auto') {
    // Keep the exact definitions stable so normal /hooks trust can be reused.
    // Codex merges hooks from active layers; do not rewrite user/project files.
    const command = [process.execPath, entrypoint, 'codex-hook'].map(shellQuote).join(' ');
    if (mode !== 'off') launchArgs.push('-c', `hooks.PostToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
    launchArgs.push('-c', `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
    if (mode !== 'off') {
      launchArgs.push('-c', `hooks.SessionEnd=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
      launchArgs.push('-c', `hooks.SubagentStart=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
    }
    process.stderr.write('Fonn hooks require normal Codex /hooks review and trust; managed policy may disable hooks.\n');
  }
  process.stderr.write(`Native Codex launch ${launchId}: ${profile.name}, filtering ${mode}, subagents ${subagents}.\n`);
  const child = spawn(executable, [...launchArgs, ...resumeArgs, ...args], {
    cwd, stdio: 'inherit',
    env: { ...process.env, FONN_CODEX_LAUNCH_ID: launchId, FONN_CODEX_STATE_DIR: location.root },
  });
  // TTY SIGINT already reaches the foreground group; avoid a duplicate interrupt.
  const forwardInterrupt = () => { if (!process.stdin.isTTY) child.kill('SIGINT'); };
  const forwardTermination = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTermination);
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error('Codex could not be started.')));
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTermination);
  }
  const finished = { ...record, finishedAt: new Date().toISOString(), exitCode };
  await atomicJson(metadata, finished);
  try { await printNativeResumeHint(finished, location.root, args, exitCode); }
  catch { /* Resume guidance must never replace the native process exit status. */ }
  return exitCode;
}

/** Internal adapter for the documented Codex PostToolUse JSON contract. */
export async function runCodexHook(event: unknown, stateDirectory: string, launchId: string): Promise<unknown> {
  if (typeof event !== 'object' || event === null) return {};
  const input = event as Record<string, unknown>;
  if (input.hook_event_name === 'SubagentStart') {
    try { return await nativeDelegationContext(event, stateDirectory, launchId, 'codex'); }
    catch { return {}; }
  }
  if (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'SessionEnd') {
    try { await captureNativeSession(event, stateDirectory, launchId, 'codex'); }
    catch { /* Lifecycle tracking must not affect the native session. */ }
    if (input.hook_event_name === 'SessionStart') {
      try { return await nativeDelegationContext(event, stateDirectory, launchId, 'codex'); }
      catch { /* Delegation guidance must not affect the native session. */ }
    }
    return {};
  }
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash') return {};
  const location = await readLaunch(stateDirectory, launchId);
  if (location.record.provider !== 'codex') return {};
  const observation: ToolObservation = {
    toolName: 'Bash', toolInput: input.tool_input, response: input.tool_response,
    sessionId: typeof input.session_id === 'string' ? input.session_id : '',
    toolUseId: typeof input.tool_use_id === 'string' ? input.tool_use_id : '',
    cwd: typeof input.cwd === 'string' ? input.cwd : location.record.cwd,
  };
  const filter = createOutputFilter({
    store: createArtifactStore(path.join(location.directory, 'artifacts')), mode: location.record.filterMode, level: location.record.filterLevel ?? 'strict', rules: location.record.filterRules ?? [],
    recoveryHint: artifactId => 'Recover the original tool response with: ' + [process.execPath, location.record.hookEntrypoint, 'native-output', launchId, artifactId, '--state-dir', location.root].map(shellQuote).join(' '),
  });
  // Unknown/structured responses and unrecognized command output pass through.
  const outcome = await filter.apply(observation);
  const metricsDirectory = await privateDirectory(path.join(location.directory, 'filters'), true);
  const eventId = createHash('sha256').update(observation.toolUseId || randomUUID()).digest('hex');
  await atomicJson(path.join(metricsDirectory, `${eventId}.json`), outcome.decision);
  if (outcome.decision.status !== 'filtered') return {};
  // Unlike decision:block, continue:false does not reject a nested code-mode
  // tool promise. stopReason replaces only the model-facing tool observation.
  // Serialize a stdout record whole to retain stderr, exit status, and metadata.
  return { continue: false, stopReason: typeof outcome.response === 'string' ? outcome.response : JSON.stringify(outcome.response) };
}
