import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ArtifactSlice, ToolObservation } from '@nord-forge/fonn-core/contracts';
import { createArtifactStore, createOutputFilter } from '@nord-forge/fonn-core/filtering';
import { captureNativeSession, nativeResumeArguments, printNativeResumeHint, resolveNativeProfile } from './session.js';

const executeFile = promisify(execFile);
import { atomicJson, launchDirectory, privateDirectory, readLaunch, shellQuote } from './storage.js';
import type { LaunchRecord, NativeLaunchOptions } from './storage.js';
export { atomicJson, launchDirectory, privateDirectory, readLaunch, shellQuote } from './storage.js';
export type { LaunchRecord, NativeLaunchOptions } from './storage.js';

function validateArguments(args: string[], resuming: boolean): void {
  const managementCommands = new Set(['agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade']);
  const reserved = new Set([
    '--settings', '--setting-sources', '--safe-mode', '--bare', '--restricted',
    '--model', '--effort', '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions', '--permission-mode', '--cloud', '--environment',
    '--fallback-model', '--agent', '--agents', '--system-prompt', '--system-prompt-file',
    '--desktop', '--bg', '--background',
  ]);
  for (const argument of args) {
    if (resuming && (/^--(?:resume(?:-session-at)?|continue|fork-session|session-id)(?:=|$)/.test(argument) || /^-[cr]/.test(argument))) {
      throw new Error('The native launcher controls resume selection. Remove conflicting Claude resume, continue, fork, or session-id arguments.');
    }
    if (managementCommands.has(argument)) throw new Error('The native launcher controls interactive launches only. Run plain Claude Code for management or cloud subcommands.');
    if (reserved.has(argument.split('=', 1)[0])) {
      throw new Error(`The native launcher controls ${argument.split('=', 1)[0]}. Use launcher profiles and filter options; permission bypass and remote launches are unsupported.`);
    }
  }
}

async function verifyClaude(executable: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await executeFile(executable, ['--version'], { timeout: 10_000, encoding: 'utf8' }));
  } catch {
    throw new Error('Could not run Claude Code. Install the Claude CLI and confirm `claude --version` works.');
  }
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(stdout.trim());
  const version = match?.slice(1).map(Number);
  if (!version || version[0] < 2 || (version[0] === 2 && version[1] < 1) || (version[0] === 2 && version[1] === 1 && version[2] < 319)) {
    throw new Error('Native filtering requires Claude Code 2.1.319 or newer, the version validated for this application.');
  }
}

/** Launches the user's actual CLI, preserving its authentication and permission flow. */
export async function launchClaude(options: NativeLaunchOptions): Promise<number> {
  const mode = z.enum(['filter', 'observe', 'off']).parse(options.filterMode ?? 'filter');
  const args = options.args ?? [];
  validateArguments(args, options.resume !== undefined);
  const resumeArgs = nativeResumeArguments('claude', options.resume);
  const profile = await resolveNativeProfile(options, 'claude');
  const cwd = await realpath(options.cwd);
  if (!(await lstat(cwd)).isDirectory()) throw new Error('The target working directory is not a directory.');
  const executable = options.executable ?? 'claude';
  await verifyClaude(executable);
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
  const record: LaunchRecord = { schemaVersion: 1, launchId, cwd, profile: profile.name, profileSnapshot: profile, filterMode: mode, createdAt: new Date().toISOString(), hookEntrypoint: entrypoint };
  const metadata = path.join(location.directory, 'launch.json');
  await atomicJson(metadata, record);
  const settingsPath = path.join(location.directory, 'settings.json');
  const hookCommand = [process.execPath, entrypoint, 'native-hook', '--launch-id', launchId, '--state-dir', location.root].map(shellQuote).join(' ');
  const settings = {
    // Display-only preference: Ctrl+O still expands the original tool details.
    // It does not reduce model context; --verbose can override it per launch.
    verbose: false,
    viewMode: 'default',
    ...(mode === 'off' ? {} : {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
      },
    }),
  };
  await atomicJson(settingsPath, settings);
  process.stderr.write(`Native Claude launch ${launchId}: ${profile.name}, filtering ${mode}.\n`);
  const child = spawn(executable, ['--settings', settingsPath, '--model', profile.model, '--effort', profile.effort, ...resumeArgs, ...args], { cwd, stdio: 'inherit', env: process.env });
  // A terminal-generated SIGINT already reaches both processes in the same
  // foreground group. Forward only without a terminal, otherwise one Ctrl+C
  // becomes two interrupts in Claude's interactive UI.
  const forwardInterrupt = () => { if (!process.stdin.isTTY) child.kill('SIGINT'); };
  const forwardTermination = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTermination);
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error('Claude Code could not be started.')));
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

/** Internal shell-hook adapter. It changes only a newly returned Bash observation. */
export async function runNativeHook(event: unknown, stateDirectory: string, launchId: string): Promise<unknown> {
  if (typeof event !== 'object' || event === null) return {};
  const input = event as Record<string, unknown>;
  if (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'SessionEnd') {
    try { await captureNativeSession(event, stateDirectory, launchId, 'claude'); }
    catch { /* Lifecycle tracking must not affect the native session. */ }
    return {};
  }
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash') return {};
  const location = await readLaunch(stateDirectory, launchId);
  if (location.record.provider === 'codex' || location.record.profileSnapshot?.provider === 'codex') return {};
  const observation: ToolObservation = {
    toolName: 'Bash', toolInput: input.tool_input, response: input.tool_response,
    sessionId: typeof input.session_id === 'string' ? input.session_id : '',
    toolUseId: typeof input.tool_use_id === 'string' ? input.tool_use_id : '',
    cwd: typeof input.cwd === 'string' ? input.cwd : location.record.cwd,
  };
  const store = createArtifactStore(path.join(location.directory, 'artifacts'));
  const filter = createOutputFilter({
    store, mode: location.record.filterMode,
    recoveryHint: (artifactId) => 'Recover the original tool response with: ' + [process.execPath, location.record.hookEntrypoint, 'native-output', launchId, artifactId, '--state-dir', location.root].map(shellQuote).join(' '),
  });
  const outcome = await filter.apply(observation);
  const metricsDirectory = await privateDirectory(path.join(location.directory, 'filters'), true);
  const eventId = createHash('sha256').update(observation.toolUseId || randomUUID()).digest('hex');
  await atomicJson(path.join(metricsDirectory, `${eventId}.json`), outcome.decision);
  if (outcome.decision.status !== 'filtered') return {};
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: outcome.response } };
}

export async function readNativeOutput(launchId: string, artifactId: string, options?: { offset?: number; limit?: number }, stateDirectory?: string): Promise<ArtifactSlice> {
  const location = await readLaunch(stateDirectory, launchId);
  return createArtifactStore(path.join(location.directory, 'artifacts')).read(artifactId, options);
}
