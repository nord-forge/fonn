// The global hook itself: `fonn hook --agent <agent>` reads one event on
// stdin, filters a shell command's output, records the decision like a
// native launch, and replies in the agent's own shape. It fails open.
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolObservation } from '@nord-forge/fonn-core/contracts';
import { createArtifactStore, createOutputFilter } from '@nord-forge/fonn-core/filtering';
import { createProfileStore, getDefaultConfigDirectory } from '@nord-forge/fonn-core/profiles';
import { findProjectRoot, projectRulesFingerprint, readProjectSettings, resolveSettings } from '@nord-forge/fonn-core/settings';
import { HOOK_AGENTS, type HookAgent } from './contract.js';
import { baseCommand, type HookRuntimeOptions } from './command.js';
import { atomicJson, launchDirectory, privateDirectory, readStoredLaunch, shellQuote, type HookLaunchRecord } from '../native/storage.js';

const NO_CHANGE = '{}';
/**
 * Set by `fonn claude` and `fonn codex`. That agent's session already runs
 * Fonn's launch hook. Another agent started inside it inherits the variable,
 * so each marker only covers its own agent.
 */
export const LAUNCH_MARKERS: Readonly<Partial<Record<HookAgent, string>>> = Object.freeze({ claude: 'FONN_CLAUDE_LAUNCH_ID', codex: 'FONN_CODEX_LAUNCH_ID' });

/** A stable UUID for one agent session, so each session is one record. */
export function hookSessionId(agent: HookAgent, sessionId: string): string {
  const hex = createHash('sha256').update(`fonn-hook\0${agent}\0${sessionId}`).digest('hex');
  const variant = (8 | (parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Creates launch.json once. Two hooks of one session may race; the first record wins. */
async function ensureRecord(directory: string, record: HookLaunchRecord): Promise<void> {
  const file = path.join(directory, 'launch.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { await link(temporary, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await unlink(temporary).catch(() => undefined); }
}

async function handle(agent: HookAgent, input: string, options: HookRuntimeOptions): Promise<string> {
  if (!HOOK_AGENTS.includes(agent)) return NO_CHANGE;
  const env = options.env ?? process.env;
  const marker = LAUNCH_MARKERS[agent];
  if (marker && env[marker]) return NO_CHANGE;
  const event: unknown = JSON.parse(input);
  if (!isObject(event) || event.hook_event_name !== 'PostToolUse') return NO_CHANGE;
  const text = agent === 'crush' || agent === 'opencode';
  // Claude and Codex call the shell tool Bash; Crush and OpenCode call it bash and pass one string.
  if (text ? event.tool_name !== 'bash' || typeof event.tool_response !== 'string' : event.tool_name !== 'Bash') return NO_CHANGE;
  if (!validSessionId(event.session_id)) return NO_CHANGE;
  if (typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd) || event.cwd.includes('\0')) return NO_CHANGE;
  const cwd = await realpath(event.cwd);
  if (!(await lstat(cwd)).isDirectory()) return NO_CHANGE;

  // The same settings a native launch in this folder would use.
  const root = await findProjectRoot(cwd);
  const files = await readProjectSettings(root);
  const store = createProfileStore(options.configDirectory ?? getDefaultConfigDirectory(env));
  const projectRulesApproved = await store.projectRulesApproved(root, projectRulesFingerprint(root, files));
  const settings = resolveSettings({ files, global: await store.getGlobalSettings(), projectRulesApproved });
  const mode = settings.filterMode.value;
  if (mode === 'off') return NO_CHANGE;
  const level = settings.filterLevel.value;
  const rules = settings.rules.map(({ name, command, remove }) => ({ name, command, remove }));

  const launchId = hookSessionId(agent, event.session_id);
  const location = await launchDirectory(options.stateDirectory, launchId, true);
  await ensureRecord(location.directory, {
    schemaVersion: 1, launchId, origin: 'hook', provider: agent, agentSessionId: event.session_id, cwd,
    filterMode: mode, filterLevel: level, ...(rules.length ? { filterRules: rules } : {}), createdAt: new Date().toISOString(),
  });
  const { record } = await readStoredLaunch(location.root, launchId);
  if (!('origin' in record) || record.provider !== agent || record.agentSessionId !== event.session_id) return NO_CHANGE;

  const recovery = (await baseCommand(options)).argv;
  const observation: ToolObservation = {
    toolName: 'Bash', toolInput: event.tool_input, response: event.tool_response,
    sessionId: event.session_id, toolUseId: typeof event.tool_use_id === 'string' ? event.tool_use_id : '', cwd,
  };
  const filter = createOutputFilter({
    store: createArtifactStore(path.join(location.directory, 'artifacts')), mode, level, rules,
    recoveryHint: artifactId => [...recovery, 'native-output', launchId, artifactId, '--state-dir', location.root].map(shellQuote).join(' '),
  });
  const outcome = await filter.apply(observation);
  const decisions = await privateDirectory(path.join(location.directory, 'filters'), true);
  const eventId = createHash('sha256').update(observation.toolUseId || randomUUID()).digest('hex');
  await atomicJson(path.join(decisions, `${eventId}.json`), outcome.decision);
  if (outcome.decision.status !== 'filtered') return NO_CHANGE;
  if (text) return JSON.stringify({ updated_output: outcome.response });
  if (agent === 'claude') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: outcome.response } });
  // Codex replaces the tool result with stopReason when continue is false, as Fonn's native Codex hook does.
  return JSON.stringify({ continue: false, stopReason: typeof outcome.response === 'string' ? outcome.response : JSON.stringify(outcome.response) });
}

/** Never throws. Any error leaves the output unchanged. */
export async function runHook(agent: HookAgent, input: string, options: HookRuntimeOptions = {}): Promise<string> {
  try { return await handle(agent, input, options); }
  catch { return NO_CHANGE; }
}
