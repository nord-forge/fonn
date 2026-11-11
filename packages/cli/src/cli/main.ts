#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { ArtifactSlice, FilterLevel, FilterMode, PermissionRequest, ProfileName, ProfileProvider, RunRecord, RunTaskOptions, TaskProfile } from '@nord-forge/fonn-core/contracts';
import { createProfileStore, modelSourceSchema, effortSchema, filterLevelSchema, getDefaultConfigDirectory, modelSchema, profiles as builtInProfiles, providerSchema, resolveProfile, resolveProfileForProvider, taskProfileSchema } from '@nord-forge/fonn-core/profiles';
import { findProjectRoot, LOCAL_SETTINGS_FILE, projectRulesFingerprint, projectSettingsSchema, projectSourcedValues, readProjectSettings, resolveSettings, SETTING_KEYS, SHARED_SETTINGS_FILE, writeProjectSettings, type ProjectSettings, type ResolvedSettings, type SettingKey, type SettingScope } from '@nord-forge/fonn-core/settings';
import { renderRun, runExitCode, terminalText, validateResult } from './render.js';
import type { ChatOptions } from '../agent/chat.js';
import { HOOK_AGENTS, HOOK_AGENT_LABELS, type HookAgent } from '../hooks/contract.js';
import type { HookRuntimeOptions } from '../hooks/command.js';

export interface CliDependencies {
  runTask: (options: RunTaskOptions) => Promise<RunRecord>;
  listRuns: (stateDirectory?: string) => Promise<RunRecord[]>;
  readRun: (taskId: string, stateDirectory?: string) => Promise<RunRecord>;
  readArtifact: (taskId: string, artifactId: string, options: { offset: number; limit: number }, stateDirectory?: string) => Promise<ArtifactSlice>;
  launchClaude: (options: { cwd: string; profile?: ProfileName; filterMode?: FilterMode; filterLevel?: FilterLevel; filterRules?: Array<{ name: string; command: string; remove: string[] }>; subagents?: 'auto' | 'off'; stateDirectory?: string; configDirectory?: string; args?: string[] }) => Promise<number>;
  launchCodex: CliDependencies['launchClaude'];
  runChat: (options: ChatOptions) => Promise<number>;
  runNativeHook: (event: unknown, stateDirectory: string, launchId: string) => Promise<unknown>;
  runCodexHook: CliDependencies['runNativeHook'];
  resumeNativeLaunch: (launchId: string, options: { stateDirectory?: string }) => Promise<number>;
  readNativeOutput: (launchId: string, artifactId: string, options: { offset: number; limit: number }, stateDirectory?: string) => Promise<ArtifactSlice>;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  onInterrupt: (handler: () => void) => () => void;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  /** Directories and command for fonn hooks and fonn hook; tests pass a temporary home. */
  hookOptions: HookRuntimeOptions;
}

const help = `Fonn — native Claude and Codex launchers, Claude Agent SDK tasks

Usage:
  fonn [--cwd <dir>] [--profile <name>] [--filter <mode>] [--filter-level <level>] [--subagents auto|off] [--state-dir <path>] [-- <native args>]
  fonn claude [launcher options] [-- <claude args>]
  fonn codex [launcher options] [-- <codex args>]
  fonn chat [options]                  Small coding agent for open models; see fonn help chat
  fonn --default [claude|codex] [--json]
  fonn --default-filter-level [strict|standard|similar] [--json]
  fonn config [show|get|set|unset] ...   Project settings; see fonn help config
  fonn resume <launch-id> [--state-dir <path>]
  fonn profiles [--json]
  fonn help profiles | codex | chat | resume | config | ui | hooks
  fonn run <prompt> [options]
  fonn runs [--state-dir <path>] [--json]
  fonn show <task-id> [--state-dir <path>] [--json]
  fonn output <task-id> <artifact-id> [--offset <n>] [--limit <n>] [--state-dir <path>]
  fonn native-output <launch-id> <artifact-id> [--offset <n>] [--limit <n>] [--state-dir <path>]
  fonn doctor [--json]
  fonn ui [--port <n>] [--no-open] [--state-dir <path>]   Local web interface for settings, rules and history; see fonn help ui
  fonn records clean --older-than <days> [--dry-run] [--yes]   Delete old launch and hook session records; see fonn help records
  fonn hooks [status|install|uninstall] [--agent <agent>]... [--yes] [--json]   Filter in claude, codex, Crush and OpenCode you start yourself; see fonn help hooks
  fonn hook --agent <agent>            Run by the agent's hook; reads one event on stdin
  fonn help | --help | --version

Run options:
  --cwd <dir>            Target project directory (default: current directory)
  --profile <name>       Built-in or saved profile (default: configured default, initially opus-medium)
  --budget <dollars>     Positive estimated API stop budget (default: 5; can overshoot)
  --max-turns <n>        Positive integer turn limit (default: 20)
  --filter <mode>        filter | observe | off (default: filter)
  --filter-level <level> strict | standard | similar (default: saved level, initially standard)
  --subagents <mode>     Native only: auto | off (default: auto; delegation guidance)
  --state-dir <path>     Separate local run and raw-output storage
  --resume <task-id>     Resume an existing task with its saved profile
  --json                Emit one JSON value; diagnostics and permissions use stderr

API-key authentication uses ANTHROPIC_API_KEY and separate API billing.
Use --default claude or --default codex to save the default agent and exit.
Use --default alone to show it. Explicit agent commands or --profile override it for one launch.
With no command, the selected profile or configured default chooses the native provider.
The claude and codex commands use their existing authentication and native controls.
Codex filtering and delegation guidance require /hooks review/trust; Fonn does not bypass it.
Native auto delegation uses built-in agents with normal permissions; off removes Fonn guidance.
Session-wide filtering also applies to subagent Bash observations, including Haiku.
Filter levels: strict uses format adapters only (PHPUnit, Pest, PHPStan, tsc, pytest, Jest, Vitest).
standard also keeps one copy and a count of 3+ identical adjacent lines from any command.
similar also keeps the first and last of 4+ lines differing only in numbers or IDs.
Lines mentioning errors, failures or warnings are never merged by similarity.
Save a level with --default-filter-level; --filter-level overrides it for one launch or run.
SDK budget, structured JSON, and turn-limit flags belong to run, which supports Claude only.
SDK permission requests require an explicit interactive yes; noninteractive requests are denied.
Artifact reads default to 4000 characters and are limited to 20000 per request.
`;

const profilesHelp = `Fonn profiles — saved provider, model and effort choices

Usage:
  fonn profiles [list] [--json]
  fonn profiles show <name> [--json]
  fonn profiles create <name> [--provider claude|codex] --model <model> --effort <level> [--source <source>] [--json]
  fonn profiles edit <name> [--provider claude|codex] [--model <model>] [--effort <level>] [--source <source>] [--json]
  fonn profiles delete <name> [--json]
  fonn profiles default [<name>] [--json]
  fonn help profiles | profiles --help

Provider defaults to Claude when creating a profile.
Claude models: opus, sonnet, haiku, fable, mythos, or a Claude model ID.
Fonn pins fable/mythos to their 5.2 IDs when saving a profile.
Built-ins: claude:fable-medium and claude:mythos-medium (medium effort).
Fable/Mythos 5.2 needs Claude Code 2.1.321+ and upstream model access.
Mythos requires an eligible verified account; Fonn does not grant access.
Codex models: gpt-* or o-series model IDs, for example gpt-6.1-sol.
--source runs a Codex profile's model somewhere other than OpenAI:
  ollama or lmstudio   a local model through codex --oss, such as qwen3-coder:30b
  provider:<name>      a model provider you configured in ~/.codex/config.toml
  openai               (edit only) go back to OpenAI
With a source, the model is the name that source uses. Credentials stay in Codex.
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
  fonn codex [--cwd <dir>] [--profile <name>] [--filter filter|observe|off] [--filter-level <level>] [--subagents auto|off] [--state-dir <path>] [-- <codex args>]
  fonn codex --profile codex:sol-medium
  fonn --profile codex:sol-medium
  fonn codex -- --search
  fonn profiles create my-sol --provider codex --model gpt-6.1-sol --effort high
  fonn profiles create qwen-local --provider codex --model qwen3-coder:30b --effort medium --source ollama

Install and authenticate Codex separately. Existing Codex authentication, permissions,
project settings and terminal controls remain active. No SDK budgets or usage accounting apply.
The default Codex profile is codex:sol-medium when the global default belongs to Claude.
Explicit --profile must name a Codex profile. With no command, the profile selects the provider.
Filtering and automatic delegation guidance require Codex hook support and manual review/trust in /hooks.
New or changed hooks remain inactive until trusted; Fonn does not bypass hook trust.
Filter mode reduces output at the chosen --filter-level; observe archives proposals without changing output;
off disables output filtering; --filter off --subagents off registers no Fonn hooks.
Subagents default to auto guidance using native agents; off removes that guidance.
Subagent Bash output uses the same filter, subject to hook trust and supported formats.
Display visibility alone does not imply fewer model tokens.
Original outputs can be recovered with fonn native-output <launch-id> <artifact-id>.
fonn run remains Claude SDK only; a programmatic Codex SDK runtime is not implemented.
`;

const configHelp = `Fonn config — project settings for launches and runs

Usage:
  fonn config [show] [--cwd <dir>] [--json]
  fonn config get <key> [--cwd <dir>] [--json]
  fonn config set <key> <value> [--local|--shared|--global] [--cwd <dir>]
  fonn config unset <key> [--local|--shared|--global] [--cwd <dir>]
  fonn config rules [--cwd <dir>] [--json]
  fonn config approve-rules [--cwd <dir>]
  fonn config revoke-rules [--cwd <dir>]

Keys: profile, filterLevel (strict|standard|similar), filterMode (filter|observe|off), subagents (auto|off).
--local (default) writes .fonn/settings.local.json, which is personal and should stay out of Git.
--shared writes .fonn.json at the project root, meant to be committed for the team.
--global saves the value for all projects in ~/.config/fonn/profiles.json.
Precedence: command-line flag, personal file, shared file, global default, built-in default.
The project is the nearest folder with one of these files, otherwise the Git root.
Filter rules in project files only apply after fonn config approve-rules, because
anyone who can commit to a repository can write them. Changed rules need approving again.
Launches print which values came from project files. fonn --default,
fonn --default-filter-level and fonn profiles default remain shortcuts for global values.
`;

const resumeHelp = `Fonn resume — reopen a saved native launch

Usage:
  fonn resume <launch-id> [--state-dir <path>]

Use the command shown when a native Claude or Codex launch exits.
It restores that launch's agent, initial profile, project, filtering and subagent preference.
Legacy launches without a saved subagent preference keep Fonn delegation guidance off.
If hooks recorded a session ID, the provider resumes that session directly.
Otherwise it opens the provider's session picker; Fonn never guesses with --last.
Changed defaults or deleted custom profiles do not replace a saved profile snapshot.
This is separate from fonn run --resume, which resumes a Claude SDK task.
`;

const uiHelp = `Fonn ui: a local web interface for settings, rules and history

Usage:
  fonn ui [--port <n>] [--no-open] [--state-dir <path>]

Change global and project settings, write filter rules and try them on a
test bench, approve project rules, and manage profiles. Also shows native
launches, SDK runs and filter decisions, and can delete a launch's records.
The server listens on 127.0.0.1 only, on a random free port unless --port is given.
Each start creates a new private link. Anyone with that link can use the
interface while it runs, so do not share it.
--no-open prints the link without opening a browser.
--state-dir reads launches and runs from another state folder.
Press Ctrl+C to stop the server.
`;

const recordsHelp = `Fonn records: delete old launch and hook session records

Usage:
  fonn records clean --older-than <days> [--dry-run] [--yes] [--state-dir <path>]

Deletes records, with their archived originals, whose last activity is older
than the given number of days. Records can hold private code, logs or secrets a
command printed, and the global hook keeps one for every hooked session.
It lists what it would delete and asks first. --dry-run only lists. --yes skips
the question; without a terminal, --yes is required. A record that becomes
active before it is deleted is kept. Nothing is deleted automatically.
`;

const hooksHelp = `Fonn hooks: use Fonn's filter in the agents you already start yourself

Usage:
  fonn hooks [status] [--json]
  fonn hooks install [--agent <agent>]... [--yes]
  fonn hooks uninstall [--agent <agent>]... [--yes]
  fonn hook --agent <agent>

Agents: claude (Claude Code), codex (Codex), crush (Crush), opencode (OpenCode).
install adds one hook to the agent's user-level config, so every session gets
Fonn's filter with your global and project settings and approved rules. Without
--agent it uses every agent found on this machine. It shows each change first
and asks before writing it. Without a terminal it needs --yes.
Files: ~/.claude/settings.json, ~/.codex/hooks.json (CODEX_HOME moves it),
~/.config/crush/crushrc, and a plugin file in ~/.config/opencode/plugins/.
Fonn keeps a copy of the original next to the file as <file>.fonn-backup.
uninstall removes only the entries that run fonn hook --agent.
Codex runs the hook only after you review and trust it in /hooks.
Sessions started with fonn claude or fonn codex already filter, so the
global hook leaves them alone. Hook sessions show in fonn ui with their
decisions and originals. Recover an original with fonn native-output.
fonn hooks status warns when a hook points at a missing or older Fonn.
`;

const chatHelp = `Fonn chat: a small coding agent for open models

Usage:
  fonn chat [--profile <name>] [--model <model>] [--source ollama|lmstudio] [--base-url <url>] [--api-key-env <NAME>] [--context <tokens>] [--cwd <dir>] [--filter filter|observe|off] [--filter-level strict|standard|similar] [--state-dir <path>]

Choose --profile or --model. A profile uses its model and local source.
Without --base-url, profiles must belong to Codex with an ollama or lmstudio source.
With --base-url, any profile can supply the model. --source applies to --model only.
--model defaults to the Ollama server. --source lmstudio selects LM Studio.
--base-url overrides the server address. --api-key-env reads only the named variable.
The key is never stored or shown. Context defaults to 32768 estimated tokens.
Project filter settings and approved rules apply. Each session stores originals in <state>/agent/<sessionId>.
Every command and file change asks first. Allow once, remember the exact command or file, or deny.
Commands: /help, /exit, /clear, /context. End a line with a backslash to continue it.
Ctrl+D exits. Ctrl+C cancels a turn. Press Ctrl+C twice at an empty prompt to exit.
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
    if (flag === 'json' || flag === 'shared' || flag === 'local' || flag === 'global' || flag === 'no-open' || flag === 'dry-run' || flag === 'yes') { flags.set(flag, true); continue; }
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
function parseLevel(value: string): FilterLevel {
  const result = filterLevelSchema.safeParse(value);
  if (!result.success) throw new Error('--filter-level must be strict, standard, or similar.');
  return result.data;
}
/** An explicit --filter-level wins; otherwise the saved default applies. */
async function filterLevelFor(parsed: Parsed, filterMode: string, configDirectory: string): Promise<FilterLevel | undefined> {
  const explicit = stringFlag(parsed, 'filter-level');
  if (explicit !== undefined) {
    if (filterMode === 'off') throw new Error('--filter-level has no effect with --filter off. Choose filter or observe.');
    return parseLevel(explicit);
  }
  // SDK resume keeps the task's saved level and must not depend on configuration.
  if (parsed.flags.has('resume')) return undefined;
  return createProfileStore(configDirectory).getDefaultFilterLevel();
}
function stringFlag(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name) as string | undefined;
}

function choice<T extends string>(value: string | undefined, allowed: readonly T[], message: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(message);
  return value as T;
}

interface Choices {
  rules: Array<{ name: string; command: string; remove: string[] }>;
  profile: TaskProfile;
  filterMode: FilterMode;
  filterLevel: FilterLevel;
  subagents: 'auto' | 'off';
  notices: string[];
}

/**
 * Flags first, then the project's .fonn/settings.local.json and .fonn.json,
 * then the global defaults. A project profile for the other agent is ignored
 * for an explicit `fonn claude` or `fonn codex`; a mismatched flag is an error.
 */
async function choicesFor(parsed: Parsed, cwd: string, configDirectory: string, provider: ProfileProvider | undefined, native: boolean): Promise<Choices> {
  const flags: ProjectSettings = {};
  const mode = choice(stringFlag(parsed, 'filter'), ['filter', 'observe', 'off'] as const, '--filter must be filter, observe, or off.');
  if (mode) flags.filterMode = mode;
  if (native) {
    const subagents = choice(stringFlag(parsed, 'subagents'), ['auto', 'off'] as const, '--subagents must be auto or off.');
    if (subagents) flags.subagents = subagents;
  }
  const level = stringFlag(parsed, 'filter-level');
  if (level !== undefined) {
    if (mode === 'off') throw new Error('--filter-level has no effect with --filter off. Choose filter or observe.');
    flags.filterLevel = parseLevel(level);
  }
  const profileFlag = stringFlag(parsed, 'profile');
  if (profileFlag !== undefined) flags.profile = profileFlag;

  const projectRoot = await findProjectRoot(cwd);
  const files = await readProjectSettings(projectRoot);
  const store = createProfileStore(configDirectory);
  const projectRulesApproved = await store.projectRulesApproved(projectRoot, projectRulesFingerprint(projectRoot, files));
  const resolved = resolveSettings({ flags, files, global: await store.getGlobalSettings(), projectRulesApproved });
  const notices: string[] = [];
  const fileFor = (source: string) => source === 'shared' ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE;

  let profile: TaskProfile;
  try {
    profile = await store.get(resolved.profile.value);
  } catch (error) {
    if (resolved.profile.source === 'shared' || resolved.profile.source === 'local') {
      throw new Error(`Profile ${resolved.profile.value} set in ${fileFor(resolved.profile.source)} does not exist. Create it with fonn profiles create, or change the project setting with fonn config.`);
    }
    throw error;
  }
  let ignoredProfile = false;
  if (provider && (profile.provider ?? 'claude') !== provider) {
    if (resolved.profile.source === 'flag') throw new Error(`Profile ${profile.name} belongs to ${profile.provider ?? 'claude'}, not ${provider}. Select a ${provider} profile.`);
    if (resolved.profile.source === 'shared' || resolved.profile.source === 'local') {
      notices.push(`Ignoring profile ${profile.name} from ${fileFor(resolved.profile.source)}: it is a ${profile.provider ?? 'claude'} profile.`);
      ignoredProfile = true;
    }
    profile = await resolveProfileForProvider(provider, undefined, configDirectory);
  }

  const used = projectSourcedValues(resolved)
    .filter((item) => !(item.key === 'profile' && ignoredProfile))
    .filter((item) => native || item.key !== 'subagents');
  if (used.length) notices.push(`Project settings: ${used.map((item) => `${item.key} ${item.value} (${item.file})`).join(', ')}.`);
  if (resolved.unapprovedRules.length) {
    const sources = [...new Set(resolved.unapprovedRules.map((rule) => fileFor(rule.source)))].join(' and ');
    notices.push(`Skipped ${resolved.unapprovedRules.length} filter ${resolved.unapprovedRules.length === 1 ? 'rule' : 'rules'} from ${sources}: not approved for this project. Review them with fonn config rules, then approve with fonn config approve-rules.`);
  }
  if (resolved.rules.length) notices.push(`Filter rules: ${resolved.rules.map((rule) => `${rule.name} (${rule.source === 'global' ? 'global' : fileFor(rule.source)})`).join(', ')}.`);
  const rules = resolved.rules.map(({ name, command, remove }) => ({ name, command, remove }));

  return { rules, profile, filterMode: resolved.filterMode.value, filterLevel: resolved.filterLevel.value, subagents: resolved.subagents.value, notices };
}

const KEY_ALIASES: Record<string, SettingKey> = {
  profile: 'profile',
  filterLevel: 'filterLevel', 'filter-level': 'filterLevel',
  filterMode: 'filterMode', 'filter-mode': 'filterMode', filter: 'filterMode',
  subagents: 'subagents',
};

function settingKey(name: string | undefined): SettingKey {
  const key = name === undefined ? undefined : KEY_ALIASES[name];
  if (!key) throw new Error(`Unknown setting ${name ?? ''}. Use one of: ${SETTING_KEYS.join(', ')}.`);
  return key;
}

function describeSource(source: ResolvedSettings[SettingKey]['source']): string {
  return { flag: 'flag', local: `personal (${LOCAL_SETTINGS_FILE})`, shared: `shared (${SHARED_SETTINGS_FILE})`, global: 'global default', default: 'built-in default' }[source];
}
async function version(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

/** Dispatch is importable and accepts all I/O/runtime seams for offline tests. */
export async function dispatch(args: string[], injected: Partial<CliDependencies> = {}): Promise<number> {
  const env = injected.env ?? process.env;
  let chatApiKey: string | undefined;
  const redact = (value: string) => {
    for (const key of [env.ANTHROPIC_API_KEY, chatApiKey]) if (key) value = value.split(key).join('[REDACTED]');
    return value;
  };
  const writeStdout = injected.stdout ?? ((text: string) => process.stdout.write(text));
  const stdout = (value: string) => writeStdout(redact(value));
  const stderr = (value: string) => (injected.stderr ?? (text => process.stderr.write(text)))(terminalText(redact(value)) + (value.endsWith('\n') ? '' : '\n'));
  const json = (value: unknown) => writeStdout(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redact(item) : item) + '\n');
  try {
    // Implicit native launches follow the profile provider; explicit commands pin it.
    const autoLaunch = args.length === 0 || ['--cwd', '--profile', '--filter', '--filter-level', '--subagents', '--state-dir', '--'].includes(args[0]!);
    if (autoLaunch) {
      args = ['claude', ...args];
    }
    const command = args[0]!;
    if (command === 'help') {
      if (args.length === 1) { stdout(help); return 0; }
      if (args.length === 2 && args[1] === 'profiles') { stdout(profilesHelp); return 0; }
      if (args.length === 2 && args[1] === 'codex') { stdout(codexHelp); return 0; }
      if (args.length === 2 && args[1] === 'chat') { stdout(chatHelp); return 0; }
      if (args.length === 2 && args[1] === 'resume') { stdout(resumeHelp); return 0; }
      if (args.length === 2 && args[1] === 'config') { stdout(configHelp); return 0; }
      if (args.length === 2 && args[1] === 'ui') { stdout(uiHelp); return 0; }
      if (args.length === 2 && args[1] === 'hooks') { stdout(hooksHelp); return 0; }
      if (args.length === 2 && args[1] === 'records') { stdout(recordsHelp); return 0; }
      throw new Error('Expected help [profiles|codex|chat|resume|config|ui|hooks]. Use --help for usage.');
    }
    if (command === 'profiles' && args.length === 2 && args[1] === '--help') { stdout(profilesHelp); return 0; }
    if (command === 'codex' && args.length === 2 && args[1] === '--help') { stdout(codexHelp); return 0; }
    if (command === 'chat' && args.includes('--help')) { stdout(chatHelp); return 0; }
    if (command === 'resume' && args.length === 2 && args[1] === '--help') { stdout(resumeHelp); return 0; }
    if (command === 'ui' && args.length === 2 && args[1] === '--help') { stdout(uiHelp); return 0; }
    if (command === 'hooks' && args.includes('--help')) { stdout(hooksHelp); return 0; }
    if (command === 'hook') {
      // Run by an agent. It fails open: any problem leaves the output unchanged and exits 0.
      let reply = '{}';
      try {
        const agent = args.length === 3 && args[1] === '--agent' && HOOK_AGENTS.includes(args[2] as HookAgent) ? args[2] as HookAgent : undefined;
        if (agent) {
          const input = await (injected.readStdin ?? readStdin)();
          const { runHook } = await import('../hooks/run.js');
          reply = await runHook(agent, input, { ...injected.hookOptions, env });
        } else {
          stderr(`fonn hook: expected --agent ${HOOK_AGENTS.join('|')}. The output is left unchanged.`);
        }
      } catch { /* fail open */ }
      writeStdout(reply + '\n');
      return 0;
    }
    if (command === 'records') {
      if (args.includes('--help') || args.length === 1) { stdout(recordsHelp); return 0; }
      if (args[1] !== 'clean') throw new Error('Expected fonn records clean --older-than <days>. Use fonn help records for usage.');
      const parsed = parse(args.slice(2), ['older-than', 'dry-run', 'yes', 'state-dir']);
      argumentCount(parsed, 0, 'records clean --older-than <days>');
      if (!parsed.flags.has('older-than')) throw new Error('fonn records clean needs --older-than <days>, for example --older-than 30.');
      const days = numeric(parsed.flags.get('older-than'), '--older-than', 30, true);
      const { deleteOldRecords, findOldRecords, formatBytes } = await import('../native/cleanup.js');
      const { getDefaultStateDirectory } = await import('@nord-forge/fonn-core/state');
      const stateDirectory = resolve(stringFlag(parsed, 'state-dir') ?? getDefaultStateDirectory());
      const summary = await findOldRecords(days, stateDirectory);
      if (!summary.records.length) { stdout(`No records older than ${days} days.\n`); return 0; }
      const hooked = summary.records.filter((record) => record.origin === 'hook').length;
      stdout(`${summary.records.length} records older than ${days} days (${hooked} from hook sessions), ${formatBytes(summary.bytes)} with their archived originals.\n`);
      stdout(`Oldest activity ${summary.records[0]!.lastActivity.slice(0, 10)}, newest ${summary.records.at(-1)!.lastActivity.slice(0, 10)}.\n`);
      if (parsed.flags.has('dry-run')) { stdout('Dry run: nothing was deleted.\n'); return 0; }
      if (!parsed.flags.has('yes')) {
        const interactive = injected.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!interactive) throw new Error('fonn records clean deletes records. Run it in a terminal to confirm, or pass --yes.');
        const ask = async (question: string): Promise<string> => {
          if (injected.ask) return injected.ask(question);
          const reader = createInterface({ input: process.stdin, output: process.stdout });
          try { return await reader.question(question); } finally { reader.close(); }
        };
        const answer = (await ask('Delete them? This cannot be undone. [y/N] ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') { stdout('Nothing was deleted.\n'); return 0; }
      }
      const result = await deleteOldRecords(summary, stateDirectory);
      stdout(`Deleted ${result.deleted.length} records.${result.kept.length ? ` Kept ${result.kept.length} that became active meanwhile.` : ''}\n`);
      return 0;
    }
    if (command === 'hooks') {
      const action = ['status', 'install', 'uninstall'].includes(args[1] ?? '') ? args[1] as 'status' | 'install' | 'uninstall' : 'status';
      const rest = args.slice(action === args[1] ? 2 : 1);
      const agents: HookAgent[] = [];
      let yes = false;
      let asJson = false;
      for (let index = 0; index < rest.length; index++) {
        const value = rest[index]!;
        if (value === '--agent' && action !== 'status') {
          const agent = rest[++index];
          if (!agent || !HOOK_AGENTS.includes(agent as HookAgent)) throw new Error(`--agent must be one of: ${HOOK_AGENTS.join(', ')}.`);
          if (!agents.includes(agent as HookAgent)) agents.push(agent as HookAgent);
        } else if (value === '--yes' && action !== 'status') yes = true;
        else if (value === '--json' && action === 'status') asJson = true;
        else throw new Error(`Unexpected ${value}. Use fonn help hooks for usage.`);
      }
      const hooks = await import('../hooks/index.js');
      const options: HookRuntimeOptions = { ...injected.hookOptions, env };
      if (action === 'status') {
        const statuses = await hooks.hookStatus(options);
        if (asJson) json(statuses);
        else {
          const lines: string[] = [];
          for (const status of statuses) {
            const state = status.error ? 'cannot read its config' : status.installed ? (status.current ? 'installed' : 'needs updating') : status.detected ? 'not installed' : 'not installed, agent not found';
            lines.push(`${status.label.padEnd(12)} ${state.padEnd(31)} ${terminalText(status.configPath)}`);
            if (status.error) lines.push(`  ${terminalText(status.error)}`);
            if (status.note) lines.push(`  ${terminalText(status.note)}`);
          }
          stdout(lines.join('\n') + '\n');
        }
        for (const warning of await hooks.hookWarnings(options)) stderr(`Warning: ${warning}`);
        return 0;
      }
      const chosen = agents.length ? agents : (await hooks.hookStatus(options)).filter(status => status.detected).map(status => status.agent);
      if (!chosen.length) throw new Error(`No supported agent was found on this machine. Name one with --agent ${HOOK_AGENTS.join('|')}.`);
      const interactive = injected.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!yes && !interactive) throw new Error(`fonn hooks ${action} changes agent config files. Run it in a terminal to confirm each change, or pass --yes.`);
      const ask = async (question: string): Promise<string> => {
        if (injected.ask) return injected.ask(question);
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try { return await reader.question(question); } finally { reader.close(); }
      };
      const { compactDiff } = await import('../hooks/diff.js');
      const { redactForDisplay } = await import('../hooks/redact.js');
      let failures = 0;
      for (const agent of chosen) {
        const label = HOOK_AGENT_LABELS[agent];
        try {
          const plan = await hooks.planHook(agent, action, options);
          if (!plan.changes) { stdout(`${label}: ${terminalText(plan.summary[0] ?? 'Nothing to change.')}\n`); continue; }
          stdout([`${label}: ${terminalText(plan.configPath)}`, ...plan.summary.map(line => `  ${terminalText(line)}`), terminalText(compactDiff(redactForDisplay(plan.before, agent), redactForDisplay(plan.after, agent))), ''].join('\n') + '\n');
          if (!yes) {
            const answer = (await ask(`${action === 'install' ? 'Install' : 'Remove'} the Fonn hook for ${label}? [y/N] `)).trim().toLowerCase();
            if (answer !== 'y' && answer !== 'yes') { stdout(`${label}: skipped. Nothing was written.\n`); continue; }
          }
          const status = await hooks.applyHookPlan(plan, options);
          stdout(`${label}: ${action === 'install' ? 'installed' : 'removed'}.\n`);
          if (action === 'install' && agent === 'codex') stdout('Codex: open Codex and run /hooks to review and trust the Fonn hook. Codex skips it until you trust it.\n');
          if (status.error) stderr(`${label}: ${status.error}`);
        } catch (error) {
          failures++;
          stderr(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return failures ? 1 : 0;
    }
    if (command === '--help' || command === '-h' || (args.length === 2 && args[1] === '--help')) { stdout(help); return 0; }
    if (command === '--version') { if (args.length !== 1) throw new Error('--version takes no arguments.'); stdout(await version() + '\n'); return 0; }
    if (command === 'resume') {
      const parsed = parse(args.slice(1), ['state-dir']);
      argumentCount(parsed, 1, 'resume <launch-id> [--state-dir <path>]');
      const resume = injected.resumeNativeLaunch ?? (await import('../native/resume.js')).resumeNativeLaunch;
      return await resume(parsed.positionals[0]!, { stateDirectory: stringFlag(parsed, 'state-dir') });
    }
    if (command === '--default-filter-level') {
      const parsed = parse(args.slice(1), ['json']);
      if (parsed.positionals.length > 1) throw new Error('Expected --default-filter-level [strict|standard|similar] [--json].');
      const name = parsed.positionals[0];
      const store = createProfileStore(getDefaultConfigDirectory(env));
      const level = name === undefined ? await store.getDefaultFilterLevel() : await store.setDefaultFilterLevel(parseLevel(name));
      if (parsed.flags.has('json')) json({ filterLevel: level });
      else stdout(`Default filter level: ${level}.\n`);
      return 0;
    }
    if (command === 'config') {
      if (args.length === 2 && args[1] === '--help') { stdout(configHelp); return 0; }
      const action = ['show', 'get', 'set', 'unset', 'rules', 'approve-rules', 'revoke-rules'].includes(args[1] ?? '') ? args[1]! : 'show';
      const parsed = parse(args.slice(action === args[1] ? 2 : 1), ['cwd', 'json', 'local', 'shared', 'global']);
      if (['local', 'shared', 'global'].filter((flag) => parsed.flags.has(flag)).length > 1) throw new Error('Choose one of --local, --shared or --global.');
      const configDirectory = getDefaultConfigDirectory(env);
      const root = await findProjectRoot(resolve(stringFlag(parsed, 'cwd') ?? process.cwd()));
      const files = await readProjectSettings(root);
      const store = createProfileStore(configDirectory);
      const global = await store.getGlobalSettings();
      const fingerprint = projectRulesFingerprint(root, files);

      if (action === 'rules' || action === 'approve-rules' || action === 'revoke-rules') {
        argumentCount(parsed, 0, `config ${action}`);
        if (action === 'revoke-rules') {
          await store.approveProjectRules(root, null);
          stdout(`Project filter rules are no longer approved for ${terminalText(root)}.\n`);
          return 0;
        }
        const approved = await store.projectRulesApproved(root, fingerprint);
        const project = resolveSettings({ files, global: { profile: global.profile }, projectRulesApproved: true }).rules;
        if (parsed.flags.has('json') && action === 'rules') { json({ root, approved: Boolean(fingerprint) && approved, rules: project, global: global.rules ?? [] }); return 0; }
        const describe = (rule: { name: string; command: string; remove: string[]; source?: string }) =>
          `  ${terminalText(rule.name)} (${rule.source === 'shared' ? SHARED_SETTINGS_FILE : rule.source === 'local' ? LOCAL_SETTINGS_FILE : 'global'}): for ${terminalText(rule.command)}, remove lines containing ${rule.remove.map((text) => JSON.stringify(text)).join(', ')}`;
        const lines = [`Project: ${terminalText(root)}`];
        if (global.rules?.length) lines.push('Global rules:', ...global.rules.map(describe));
        if (!fingerprint) lines.push('This project has no filter rules.');
        else lines.push(`Project rules (${approved ? 'approved' : 'not approved, so they are not applied'}):`, ...project.map(describe));
        if (action === 'approve-rules') {
          if (!fingerprint) { stdout(lines.join('\n') + '\n'); return 0; }
          await store.approveProjectRules(root, fingerprint);
          lines.push('Approved these project rules. If the files change, they need approving again.');
        } else if (fingerprint && !approved) {
          lines.push('Approve them with fonn config approve-rules.');
        }
        stdout(lines.join('\n') + '\n');
        return 0;
      }

      if (action === 'show' || action === 'get') {
        argumentCount(parsed, action === 'get' ? 1 : 0, action === 'get' ? 'config get <key>' : 'config [show]');
        const effective = resolveSettings({ files, global, projectRulesApproved: await store.projectRulesApproved(root, fingerprint) });
        if (action === 'get') {
          const key = settingKey(parsed.positionals[0]);
          if (parsed.flags.has('json')) json({ key, ...effective[key] });
          else stdout(`${String(effective[key].value)}\n`);
          return 0;
        }
        if (parsed.flags.has('json')) { json({ root, files, effective }); return 0; }
        const lines = [`Project:  ${terminalText(root)}`,
          `Shared:   ${SHARED_SETTINGS_FILE} ${files.shared.exists ? 'present' : 'not present'}`,
          `Personal: ${LOCAL_SETTINGS_FILE} ${files.local.exists ? 'present' : 'not present'}`,
          `Global:   ${terminalText(join(configDirectory, 'profiles.json'))}`, ''];
        for (const key of SETTING_KEYS) lines.push(`${key.padEnd(12)} ${String(effective[key].value).padEnd(22)} ${describeSource(effective[key].source)}`);
        stdout(lines.join('\n') + '\n');
        return 0;
      }

      argumentCount(parsed, action === 'set' ? 2 : 1, action === 'set' ? 'config set <key> <value>' : 'config unset <key>');
      const key = settingKey(parsed.positionals[0]);
      if (parsed.flags.has('global')) {
        if (action === 'set') {
          const candidate = projectSettingsSchema.safeParse({ [key]: parsed.positionals[1] });
          if (!candidate.success) throw new Error(`Invalid value for ${key}: ${parsed.positionals[1]}.`);
          await store.setGlobalSetting(key, parsed.positionals[1]!);
          stdout(`Set ${key} to ${parsed.positionals[1]} for all projects.\n`);
        } else {
          await store.unsetGlobalSetting(key);
          stdout(key === 'profile' ? 'Reset the global profile to opus-medium.\n' : `Removed the global ${key}; the built-in default applies.\n`);
        }
        return 0;
      }
      const scope: SettingScope = parsed.flags.has('shared') ? 'shared' : 'local';
      const next: ProjectSettings = { ...files[scope].settings };
      if (action === 'set') {
        const candidate = projectSettingsSchema.safeParse({ [key]: parsed.positionals[1] });
        if (!candidate.success) throw new Error(`Invalid value for ${key}: ${parsed.positionals[1]}.`);
        Object.assign(next, candidate.data);
        if (key === 'profile') {
          const known = await store.get(parsed.positionals[1]!).catch(() => undefined);
          if (!known) stderr(`Note: profile ${parsed.positionals[1]} does not exist yet. Launches fail until it is created.`);
          else if (scope === 'shared' && !Object.hasOwn(builtInProfiles, known.name)) {
            stderr(`Note: ${known.name} is a custom profile. Teammates need a profile with the same name.`);
          }
        }
      } else {
        delete next[key];
      }
      const written = await writeProjectSettings(root, scope, next);
      stdout(`${action === 'set' ? `Set ${key} to ${parsed.positionals[1]}` : `Removed ${key}`} in ${terminalText(written)}.\n`);
      if (scope === 'local' && action === 'set') {
        const check = spawnSync('git', ['check-ignore', '-q', written], { cwd: root });
        if (check.status === 1) stderr(`Note: ${LOCAL_SETTINGS_FILE} is not ignored by Git. Add .fonn/ to .gitignore to keep personal settings out of commits.`);
      }
      return 0;
    }
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
    if (command === 'chat') {
      const parsed = parse(args.slice(1), ['profile', 'model', 'source', 'base-url', 'api-key-env', 'context', 'cwd', 'filter', 'filter-level', 'state-dir']);
      argumentCount(parsed, 0, 'chat [options]');
      const keyName = stringFlag(parsed, 'api-key-env');
      if (keyName !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw new Error('--api-key-env must name an environment variable.');
        chatApiKey = env[keyName];
        if (!chatApiKey?.trim()) throw new Error(`Environment variable ${keyName} is empty or unset.`);
      }
      const modelFlag = stringFlag(parsed, 'model');
      if (modelFlag !== undefined && !modelFlag.trim()) throw new Error('--model must not be empty.');
      if (modelFlag !== undefined && parsed.flags.has('profile')) throw new Error('Choose --profile or --model, not both.');
      const source = choice(stringFlag(parsed, 'source'), ['ollama', 'lmstudio'] as const, '--source must be ollama or lmstudio.');
      if (source && modelFlag === undefined) throw new Error('--source requires --model. A profile uses its own source.');
      const { LOCAL_BASE_URLS, DEFAULT_CONTEXT_TOKENS } = await import('@nord-forge/fonn-core/agent');
      const contextTokens = numeric(parsed.flags.get('context'), '--context', DEFAULT_CONTEXT_TOKENS, true);
      if (!Number.isSafeInteger(contextTokens) || contextTokens < 1024) throw new Error('--context must be a whole number of at least 1024 tokens.');
      const cwd = resolve(stringFlag(parsed, 'cwd') ?? process.cwd());
      const chosen = await choicesFor(parsed, cwd, getDefaultConfigDirectory(env), undefined, true);
      const baseUrlFlag = stringFlag(parsed, 'base-url');
      const profile = chosen.profile;
      if (modelFlag === undefined && baseUrlFlag === undefined && (profile.provider !== 'codex' || (profile.source !== 'ollama' && profile.source !== 'lmstudio'))) {
        throw new Error('Chat needs --model, a Codex profile with an ollama or lmstudio source, or --base-url with a profile.');
      }
      const localSource = modelFlag !== undefined ? source ?? 'ollama' : profile.source;
      const baseUrl = baseUrlFlag ?? LOCAL_BASE_URLS[localSource as keyof typeof LOCAL_BASE_URLS];
      let server: URL;
      try { server = new URL(baseUrl); } catch { throw new Error('--base-url must be an HTTP or HTTPS URL.'); }
      if (!['http:', 'https:'].includes(server.protocol)) throw new Error('--base-url must be an HTTP or HTTPS URL.');
      if (server.username || server.password) throw new Error('Use --api-key-env for server credentials.');
      for (const notice of chosen.notices) stderr(notice);
      const chat = injected.runChat ?? (await import('../agent/chat.js')).runChat;
      return await chat({
        model: modelFlag ?? profile.model, baseUrl, ...(chatApiKey === undefined ? {} : { apiKey: chatApiKey }),
        root: await findProjectRoot(cwd), contextTokens,
        filterMode: chosen.filterMode, filterLevel: chosen.filterLevel, ...(chosen.rules.length ? { filterRules: chosen.rules } : {}),
        ...(stringFlag(parsed, 'state-dir') === undefined ? {} : { stateDirectory: resolve(stringFlag(parsed, 'state-dir')!) }),
      });
    }
    if (command === 'claude' || command === 'codex') {
      const separator = args.indexOf('--');
      const parsed = parse(args.slice(1, separator < 0 ? undefined : separator), ['cwd', 'profile', 'filter', 'filter-level', 'subagents', 'state-dir']);
      argumentCount(parsed, 0, `${command} [options] [-- <native args>]`);
      const configDirectory = getDefaultConfigDirectory(env);
      const cwd = resolve(stringFlag(parsed, 'cwd') ?? process.cwd());
      const chosen = await choicesFor(parsed, cwd, configDirectory, autoLaunch ? undefined : command, true);
      for (const notice of chosen.notices) stderr(notice);
      const launch = chosen.profile.provider === 'codex'
        ? injected.launchCodex ?? (await import('../native/codex.js')).launchCodex
        : injected.launchClaude ?? (await import('../native/index.js')).launchClaude;
      return await launch({ cwd, profile: chosen.profile.name, filterMode: chosen.filterMode, filterLevel: chosen.filterLevel, ...(chosen.rules.length ? { filterRules: chosen.rules } : {}), subagents: chosen.subagents, stateDirectory: stringFlag(parsed, 'state-dir'), configDirectory, args: separator < 0 ? [] : args.slice(separator + 1) });
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
      const parsed = parse(args.slice(args[1] === action ? 2 : 1), action === 'create' || action === 'edit' ? ['provider', 'model', 'effort', 'source', 'json'] : ['json']);
      if (action === 'default') {
        if (parsed.positionals.length > 1) throw new Error('Expected profiles default [<name>]. Use fonn help profiles for usage.');
      } else argumentCount(parsed, action === 'list' ? 0 : 1, action === 'list' ? 'profiles list' : `profiles ${action} <name>`);
      const store = createProfileStore(getDefaultConfigDirectory(env));
      const renderProfile = (profile: TaskProfile) => `${terminalText(profile.name)} [${terminalText(profile.provider ?? 'claude')}]: ${terminalText(profile.model)}, effort ${terminalText(profile.effort)}${profile.source ? `, via ${terminalText(profile.source)}` : ''}`;
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
        profile = await store.create(taskProfileSchema.parse({ name, ...(parsed.flags.has('provider') ? { provider: providerSchema.parse(stringFlag(parsed, 'provider')) } : {}), model: stringFlag(parsed, 'model'), effort: stringFlag(parsed, 'effort'), ...(parsed.flags.has('source') ? { source: stringFlag(parsed, 'source') } : {}) }));
      } else if (action === 'edit') {
        if (!['provider', 'model', 'effort', 'source'].some((flag) => parsed.flags.has(flag))) throw new Error('profiles edit requires --provider, --model, --effort or --source.');
        profile = await store.edit(name!, {
          ...(parsed.flags.has('provider') ? { provider: providerSchema.parse(stringFlag(parsed, 'provider')) } : {}),
          ...(parsed.flags.has('model') ? { model: stringFlag(parsed, 'model') } : {}),
          // --source openai goes back to the agent's own service.
          ...(parsed.flags.has('source') ? { source: stringFlag(parsed, 'source') === 'openai' ? null : modelSourceSchema.parse(stringFlag(parsed, 'source')) } : {}),
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
      const parsed = parse(args.slice(1), ['cwd', 'profile', 'budget', 'max-turns', 'filter', 'filter-level', 'state-dir', 'resume', 'json']);
      argumentCount(parsed, 1, 'run <prompt>');
      if (!parsed.positionals[0]!.trim()) throw new Error('The prompt must not be empty.');
      const configDirectory = getDefaultConfigDirectory(env);
      let profile = stringFlag(parsed, 'profile');
      let filterMode: string;
      let filterLevel: FilterLevel | undefined;
      let filterRules: Array<{ name: string; command: string; remove: string[] }> = [];
      if (parsed.flags.has('resume')) {
        // SDK resume keeps the task's saved profile and level and reads no settings files.
        filterMode = stringFlag(parsed, 'filter') ?? 'filter';
        if (!['filter', 'observe', 'off'].includes(filterMode)) throw new Error('--filter must be filter, observe, or off.');
        filterLevel = await filterLevelFor(parsed, filterMode, configDirectory);
      } else {
        const chosen = await choicesFor(parsed, resolve(stringFlag(parsed, 'cwd') ?? process.cwd()), configDirectory, undefined, false);
        if (chosen.profile.provider === 'codex') throw new Error(`fonn run supports Claude SDK profiles only. Use fonn codex --profile ${chosen.profile.name} for native Codex, or run with --profile opus-medium.`);
        for (const notice of chosen.notices) stderr(notice);
        profile = chosen.profile.name;
        filterMode = chosen.filterMode;
        filterLevel = chosen.filterLevel;
        filterRules = chosen.rules;
      }
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
        const record = await runTask({ prompt: parsed.positionals[0]!, cwd: resolve(stringFlag(parsed, 'cwd') ?? process.cwd()), profile, budgetUsd, maxTurns, filterMode: filterMode as RunTaskOptions['filterMode'], ...(filterLevel === undefined ? {} : { filterLevel }), ...(filterRules.length ? { filterRules } : {}), stateDirectory: stringFlag(parsed, 'state-dir'), configDirectory, resumeTaskId: stringFlag(parsed, 'resume'), signal: abort.signal, approveTool, answerQuestions, onEvent: event => stderr(`${event.type}: ${event.message}`) });
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
    if (command === 'ui') {
      const parsed = parse(args.slice(1), ['port', 'no-open', 'state-dir']);
      argumentCount(parsed, 0, 'ui [--port <n>] [--no-open] [--state-dir <path>]');
      const port = numeric(parsed.flags.get('port'), '--port', 0, true, true);
      if (port > 65535) throw new Error('--port must be between 0 and 65535.');
      const { getDefaultStateDirectory } = await import('@nord-forge/fonn-core/state');
      const { startUiServer } = await import('../ui/server.js');
      const server = await startUiServer({ port, configDirectory: getDefaultConfigDirectory(env), stateDirectory: resolve(stringFlag(parsed, 'state-dir') ?? getDefaultStateDirectory()) });
      stdout(`Fonn ui is running at ${server.url}\nPress Ctrl+C to stop.\n`);
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
      if (opener && !parsed.flags.has('no-open')) {
        const { spawn } = await import('node:child_process');
        // A missing browser opener is not fatal; the printed link still works.
        spawn(opener, [server.url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
      }
      const onInterrupt = injected.onInterrupt ?? (handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; });
      await new Promise<void>(done => { const detach = onInterrupt(() => { detach(); done(); }); });
      await server.close();
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
