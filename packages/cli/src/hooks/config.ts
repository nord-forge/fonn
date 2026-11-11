// Reads and changes the user-level config of each agent for Fonn's global
// hook. Every change is a plan first. A plan only adds, updates or removes
// the entry that runs `fonn hook --agent <agent>` and leaves the rest alone.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOOK_AGENT_LABELS, HOOK_AGENTS, type HookAgent, type HookPlan, type HookStatus } from './contract.js';
import { baseCommand, brokenCommand, hookArguments, hookOwnership, isFonnHookCommand, mentionsFonnHook, shellCommand, shellWords, type HookRuntimeOptions } from './command.js';
import { OPENCODE_PLUGIN_MARKER, opencodePlugin, opencodePluginCommand } from './opencode.js';

/** Thrown by applyHookPlan when the file changed after the plan was made. */
export class HookConflictError extends Error {
  constructor(file: string) {
    super(`${file} changed after the plan was made. Review the new plan before writing.`);
    this.name = 'HookConflictError';
  }
}

/** A config file that Fonn cannot read safely. Fonn refuses to write it. */
export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookConfigError';
  }
}

const TIMEOUT_SECONDS = 5;
const CODEX_TRUST = 'Codex runs the hook only after you review and trust it in /hooks.';

interface Paths {
  configPath: string;
  /** Folders whose presence means the agent is set up on this machine. */
  folder: string;
  /** Codex only: config.toml in the same layer, which Fonn only reads. */
  codexToml?: string;
}

function agentPaths(agent: HookAgent, options: HookRuntimeOptions): Paths {
  const home = options.home ?? os.homedir();
  const env = options.home === undefined ? options.env ?? process.env : {};
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  switch (agent) {
    case 'claude': {
      const folder = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
      return { configPath: path.join(folder, 'settings.json'), folder };
    }
    case 'codex': {
      const folder = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
      return { configPath: path.join(folder, 'hooks.json'), folder, codexToml: path.join(folder, 'config.toml') };
    }
    case 'crush': {
      const folder = path.join(xdg, 'crush');
      return { configPath: path.join(folder, 'crushrc'), folder };
    }
    case 'opencode': {
      const folder = path.join(xdg, 'opencode');
      return { configPath: path.join(folder, 'plugins', 'fonn-hook.js'), folder };
    }
  }
}

function checkAgent(agent: string): HookAgent {
  if (!HOOK_AGENTS.includes(agent as HookAgent)) throw new Error(`Unknown agent ${agent}. Use one of: ${HOOK_AGENTS.join(', ')}.`);
  return agent as HookAgent;
}

async function readText(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new HookConfigError(`${file} is not a regular file.`);
    if (info.size > 4 * 1024 * 1024) throw new HookConfigError(`${file} is larger than 4 MB.`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function pathOnPath(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const folder of (env.PATH ?? '').split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder)) continue;
    try { await access(path.join(folder, name), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

async function isDirectory(folder: string): Promise<boolean> {
  try { return (await stat(folder)).isDirectory(); } catch { return false; }
}

// JSON configs: Claude's settings.json and Codex's hooks.json.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseJsonConfig(text: string | null, file: string): Json {
  if (text === null || !text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HookConfigError(`${file} is not valid JSON. Fix it first; Fonn does not change a file it cannot read.`); }
  if (!isObject(value)) throw new HookConfigError(`${file} must hold a JSON object.`);
  if (value.hooks !== undefined && !isObject(value.hooks)) throw new HookConfigError(`"hooks" in ${file} must be an object.`);
  const groups = isObject(value.hooks) ? value.hooks.PostToolUse : undefined;
  if (groups !== undefined) {
    if (!Array.isArray(groups)) throw new HookConfigError(`"hooks.PostToolUse" in ${file} must be a list.`);
    for (const group of groups) {
      if (!isObject(group) || (group.hooks !== undefined && !Array.isArray(group.hooks))) throw new HookConfigError(`An entry in "hooks.PostToolUse" in ${file} has an unexpected shape.`);
    }
  }
  return value;
}

function jsonIndent(text: string | null): string {
  const match = text ? /^([ \t]+)\S/m.exec(text) : null;
  return match ? match[1]! : '  ';
}

function serialize(value: Json, original: string | null): string {
  return JSON.stringify(value, null, jsonIndent(original)) + '\n';
}

interface JsonEntry { group: Json; hook: Json }

function jsonEntries(config: Json, agent: HookAgent): JsonEntry[] {
  const groups = isObject(config.hooks) && Array.isArray(config.hooks.PostToolUse) ? config.hooks.PostToolUse as Json[] : [];
  return groups.flatMap(group => (Array.isArray(group.hooks) ? group.hooks : [])
    .filter((hook): hook is Json => isObject(hook) && isFonnHookCommand(hook.command, agent))
    .map(hook => ({ group, hook })));
}

/** Removes Fonn's entries, and any group or list that only held them. */
function withoutJsonEntries(config: Json, agent: HookAgent, keep?: Json): Json {
  if (!isObject(config.hooks) || !Array.isArray(config.hooks.PostToolUse)) return config;
  const groups = (config.hooks.PostToolUse as Json[]).flatMap(group => {
    if (!Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter(hook => hook === keep || !(isObject(hook) && isFonnHookCommand(hook.command, agent)));
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  const hooks: Json = { ...config.hooks };
  if (groups.length) hooks.PostToolUse = groups; else delete hooks.PostToolUse;
  const next: Json = { ...config };
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}

function sameEntry(hook: Json, command: string): boolean {
  return Object.keys(hook).length === 3 && hook.type === 'command' && hook.command === command && hook.timeout === TIMEOUT_SECONDS;
}

function jsonPlan(agent: HookAgent, before: string | null, file: string, command: string, action: HookPlan['action']): { after: string | null; summary: string[] } {
  const config = parseJsonConfig(before, file);
  const entries = jsonEntries(config, agent);
  const label = HOOK_AGENT_LABELS[agent];
  if (action === 'uninstall') {
    if (!entries.length) return { after: before, summary: [`${label} has no Fonn hook in ${file}. Nothing to remove.`] };
    return { after: serialize(withoutJsonEntries(config, agent), before), summary: [`Remove the Fonn hook from ${file}.`, 'Other hooks and settings stay as they are.'] };
  }
  const desired = { type: 'command', command, timeout: TIMEOUT_SECONDS };
  if (entries.length === 1 && entries[0]!.group.matcher === 'Bash' && sameEntry(entries[0]!.hook, command)) {
    return { after: before, summary: [`${label} already runs this Fonn hook. Nothing to change.`] };
  }
  const inPlace = entries.find(entry => entry.group.matcher === 'Bash');
  let next: Json;
  if (inPlace) {
    // Update the entry where it is, so its position among other hooks stays the same.
    const cleaned = withoutJsonEntries(config, agent, inPlace.hook);
    const hooks = cleaned.hooks as Json;
    hooks.PostToolUse = (hooks.PostToolUse as Json[]).map(group => Array.isArray(group.hooks) && group.hooks.includes(inPlace.hook)
      ? { ...group, hooks: (group.hooks as unknown[]).map(hook => hook === inPlace.hook ? desired : hook) }
      : group);
    next = cleaned;
  } else {
    next = withoutJsonEntries(config, agent);
    const hooks: Json = isObject(next.hooks) ? { ...next.hooks } : {};
    hooks.PostToolUse = [...(Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []), { matcher: 'Bash', hooks: [desired] }];
    next = { ...next, hooks };
  }
  const summary = entries.length
    ? [`Update the Fonn hook in ${file} to run this Fonn installation.`]
    : [`Add one PostToolUse hook for Bash to ${file} that runs Fonn's filter.`];
  summary.push(before === null ? 'The file does not exist yet, so Fonn creates it.' : 'Other hooks and settings stay as they are.');
  if (agent === 'codex') summary.push(CODEX_TRUST);
  return { after: serialize(next, before), summary };
}

// Crush's crushrc is a Bash script. Fonn adds one line with a marker comment
// above it, and only ever changes that exact line. A Fonn command in any other
// form, such as sharing a line or inside a block, is left for the user to move.

const CRUSH_MARKER = '# Added by fonn hooks install. fonn hooks uninstall removes it.';
const CRUSH_LINE = /^hook add PostToolUse --name fonn --matcher '\^bash\$' --command "((?:[^"\\]|\\.)*)" --timeout 5$/;

function bashDoubleQuoted(value: string): string {
  return '"' + value.replace(/[\\"$`]/g, match => '\\' + match) + '"';
}

function crushLine(command: string): string {
  return `hook add PostToolUse --name fonn --matcher '^bash$' --command ${bashDoubleQuoted(command)} --timeout ${TIMEOUT_SECONDS}`;
}

const NEEDS_BASH = 'Fonn needs Bash to check crushrc safely. Install Bash, or change the file by hand.';

/** Runs `bash -n`, which reads the script without running it. Without Bash, Fonn refuses to touch crushrc. */
function bashParses(text: string, bash: string): boolean {
  const result = spawnSync(bash, ['-n'], { input: text, encoding: 'utf8', timeout: 5000 });
  if (result.error) throw new HookConfigError(NEEDS_BASH);
  return result.status === 0;
}

function checkBash(text: string, file: string, bash: string): void {
  if (text.includes('\0')) throw new HookConfigError(`${file} contains a NUL byte.`);
  if (!bashParses(text, bash)) throw new HookConfigError(`${file} is not a valid crushrc script. Fix it first; Fonn does not change a file it cannot read.`);
}

/**
 * True when the text before a line ends at the top level of the script. A
 * stray `fi` is then a syntax error. Inside a heredoc it would be plain text,
 * and inside an open block or quote the text before already fails.
 */
function topLevelAfter(prefix: string, bash: string): boolean {
  return bashParses(prefix, bash) && !bashParses(prefix + '\nfi\n', bash);
}

function crushCommand(text: string): string | undefined {
  const match = /--command\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(text);
  if (!match) return undefined;
  return match[1] !== undefined ? match[1].replace(/\\([\\"$`])/g, '$1') : match[2];
}

function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

interface CrushScan { entries: Array<{ line: number; command: string }>; lookalikes: number }

function scanCrush(lines: string[], file: string, bash: string): CrushScan {
  const scan: CrushScan = { entries: [], lookalikes: 0 };
  const byHand = `${file} runs fonn hook --agent crush in a form Fonn did not write, for example sharing a line or inside a block. Remove it by hand, then run fonn hooks again.`;
  lines.forEach((line, index) => {
    const exact = CRUSH_LINE.exec(line);
    const command = exact ? exact[1]!.replace(/\\([\\"$`])/g, '$1') : undefined;
    if (command !== undefined && isFonnHookCommand(command, 'crush')) {
      const continued = index > 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(lines[index - 1]!);
      if (continued || !topLevelAfter(lines.slice(0, index).join('\n') + '\n', bash)) throw new HookConfigError(byHand);
      scan.entries.push({ line: index, command });
      return;
    }
    if (!mentionsFonnHook(line, 'crush') || line.trim().startsWith('#')) return;
    // A different program that happens to take `hook --agent crush` is left alone.
    const other = crushCommand(line);
    if (other === undefined || isFonnHookCommand(other, 'crush')) throw new HookConfigError(byHand);
    scan.lookalikes++;
  });
  return scan;
}

function crushPlan(before: string | null, file: string, command: string, action: HookPlan['action'], bash: string): { after: string | null; summary: string[] } {
  // Every Crush change needs Bash to check the result, so check for it first.
  checkBash(before ?? '', file, bash);
  const lines = splitLines(before);
  const { entries } = scanCrush(lines, file, bash);
  const drop = new Set<number>();
  const remove = (line: number) => {
    drop.add(line);
    const marker = line > 0 && lines[line - 1] === CRUSH_MARKER;
    if (marker) drop.add(line - 1);
    const first = marker ? line - 1 : line;
    // Install put one blank line before a line it added at the end; take it back out.
    if (first > 0 && lines[first - 1] === '' && line + 1 >= lines.length) drop.add(first - 1);
  };
  const join = (result: Array<string | undefined>) => {
    const kept = result.filter((item): item is string => item !== undefined);
    return kept.length ? kept.join('\n') + '\n' : '';
  };
  if (action === 'uninstall') {
    if (!entries.length) return { after: before, summary: [`Crush has no Fonn hook in ${file}. Nothing to remove.`] };
    for (const entry of entries) remove(entry.line);
    const after = join(lines.map((line, index) => drop.has(index) ? undefined : line));
    checkBash(after, file, bash);
    return { after, summary: [`Remove the Fonn hook line from ${file}.`, 'Other lines stay as they are.'] };
  }
  const line = crushLine(command);
  if (entries.length === 1 && lines[entries[0]!.line] === line && entries[0]!.line > 0 && lines[entries[0]!.line - 1] === CRUSH_MARKER) {
    return { after: before, summary: ['Crush already runs this Fonn hook. Nothing to change.'] };
  }
  let after: string;
  if (entries.length) {
    const [keep, ...others] = entries;
    for (const entry of others) remove(entry.line);
    const result: Array<string | undefined> = lines.map((item, index) => drop.has(index) ? undefined : item);
    result[keep!.line] = (keep!.line > 0 && lines[keep!.line - 1] === CRUSH_MARKER ? '' : CRUSH_MARKER + '\n') + line;
    after = join(result);
  } else {
    const base = before ?? '';
    const separator = !base ? '' : base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    after = base + separator + CRUSH_MARKER + '\n' + line + '\n';
  }
  checkBash(after, file, bash);
  return {
    after,
    summary: [
      entries.length ? `Update the Fonn hook line in ${file} to run this Fonn installation.` : `Add one PostToolUse hook for the bash tool to the end of ${file}.`,
      before === null ? 'The file does not exist yet, so Fonn creates it.' : 'Other lines stay as they are.',
    ],
  };
}

// OpenCode: Fonn's own plugin file in the global plugin folder.

function opencodeOwned(text: string | null, file: string, symlink: boolean): boolean {
  if (text === null && !symlink) return false;
  // A link here was put by someone else, even when it points at a Fonn plugin.
  if (symlink) throw new HookConfigError(`${file} is a symbolic link that Fonn did not write. Remove the link first.`);
  if (!text!.startsWith(OPENCODE_PLUGIN_MARKER)) throw new HookConfigError(`${file} exists and was not written by Fonn. Move it away first.`);
  return true;
}

function opencodePlan(before: string | null, file: string, argv: string[], action: HookPlan['action'], symlink: boolean): { after: string | null; summary: string[] } {
  if (action === 'uninstall' && symlink && before?.startsWith(OPENCODE_PLUGIN_MARKER)) {
    return { after: null, summary: [`Remove the link ${file}. The file it points at stays.`, 'Other plugins stay as they are.'] };
  }
  const owned = opencodeOwned(before, file, symlink);
  if (action === 'uninstall') {
    if (!owned) return { after: before, summary: [`OpenCode has no Fonn plugin at ${file}. Nothing to remove.`] };
    return { after: null, summary: [`Remove Fonn's plugin file ${file}.`, 'Other plugins stay as they are.'] };
  }
  const after = opencodePlugin(argv);
  if (before === after) return { after: before, summary: ['OpenCode already loads this Fonn plugin. Nothing to change.'] };
  return {
    after,
    summary: [owned ? `Update Fonn's plugin file ${file} to run this Fonn installation.` : `Add a plugin file ${file} that runs Fonn's filter on bash output.`, 'Other plugins and OpenCode settings stay as they are.'],
  };
}

// Shared status, plan and apply.

/** What a config path was when it was read: missing, a file, or a link to a file. */
interface FileIdentity { exists: boolean; symlink: boolean; dev: number; ino: number; target: string | null; targetDev: number; targetIno: number }

async function identity(file: string): Promise<FileIdentity> {
  const link = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!link) return { exists: false, symlink: false, dev: 0, ino: 0, target: null, targetDev: 0, targetIno: 0 };
  const target = link.isSymbolicLink() ? await realpath(file).catch(() => null) : file;
  const info = target ? await stat(target).catch(() => undefined) : undefined;
  return { exists: true, symlink: link.isSymbolicLink(), dev: link.dev, ino: link.ino, target, targetDev: info?.dev ?? 0, targetIno: info?.ino ?? 0 };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.exists === b.exists && a.symlink === b.symlink && a.dev === b.dev && a.ino === b.ino && a.target === b.target && a.targetDev === b.targetDev && a.targetIno === b.targetIno;
}

/** The file identity each plan was made against. Plans rebuilt elsewhere are checked from apply time on. */
const planIdentities = new WeakMap<HookPlan, FileIdentity>();

async function commandFor(agent: HookAgent, options: HookRuntimeOptions) {
  const base = await baseCommand(options);
  const argv = [...base.argv, ...hookArguments(agent)];
  return { argv, command: shellCommand(argv), versionedNode: base.versionedNode };
}

/** The commands of the Fonn entries currently installed, as words when they can be read. */
function installedCommands(agent: HookAgent, text: string | null, file: string, symlink: boolean, bash: string): Array<string[] | undefined> {
  if (text === null) return [];
  if (agent === 'opencode') return opencodeOwned(text, file, symlink) ? [opencodePluginCommand(text)] : [];
  if (agent === 'crush') {
    checkBash(text, file, bash);
    return scanCrush(splitLines(text), file, bash).entries.map(entry => shellWords(entry.command));
  }
  return jsonEntries(parseJsonConfig(text, file), agent).map(entry => typeof entry.hook.command === 'string' ? shellWords(entry.hook.command) : undefined);
}

/** Hooks that mention `hook --agent <agent>` but are not a complete Fonn command. Fonn leaves them alone. */
function lookalikeCount(agent: HookAgent, text: string | null, file: string, bash: string): number {
  if (text === null || agent === 'opencode') return 0;
  if (agent === 'crush') return scanCrush(splitLines(text), file, bash).lookalikes;
  const config = parseJsonConfig(text, file);
  const groups = isObject(config.hooks) && Array.isArray(config.hooks.PostToolUse) ? config.hooks.PostToolUse as Json[] : [];
  return groups.flatMap(group => Array.isArray(group.hooks) ? group.hooks : []).filter(hook => isObject(hook) && hookOwnership(hook.command, agent) === 'lookalike').length;
}

type Problem = 'broken' | 'stale';
const problems = new WeakMap<HookStatus, Problem>();

const PROBLEM_TEXT: Record<Problem, string> = {
  broken: 'the Fonn hook runs a program that no longer exists, so it does nothing',
  stale: 'the Fonn hook points at another Fonn installation',
};

async function statusFor(agent: HookAgent, options: HookRuntimeOptions): Promise<HookStatus> {
  const paths = agentPaths(agent, options);
  const label = HOOK_AGENT_LABELS[agent];
  const env = options.env ?? process.env;
  const which = options.which ?? ((name: string) => pathOnPath(name, env));
  const detected = await which(agent).catch(() => false) || await isDirectory(paths.folder);
  const status: HookStatus = { agent, label, configPath: paths.configPath, detected, installed: false, current: false };
  try {
    const found = await identity(paths.configPath);
    const text = await readText(paths.configPath);
    const wanted = await commandFor(agent, options);
    const bash = options.bash ?? 'bash';
    const plan = planFor(agent, 'install', paths, text, wanted, found.symlink, bash);
    const commands = installedCommands(agent, text, paths.configPath, found.symlink, bash);
    status.installed = commands.length > 0;
    status.current = status.installed && plan.after === text;
    const notes: string[] = [];
    if (status.installed && !status.current) {
      let broken = false;
      for (const argv of commands) if (await brokenCommand(argv)) broken = true;
      problems.set(status, broken ? 'broken' : 'stale');
      notes.push(broken
        ? 'The Fonn hook runs a program that no longer exists, so it does nothing. Run fonn hooks install to repair it.'
        : 'The Fonn hook points at another Fonn installation. Run fonn hooks install to update it.');
    }
    if (status.current && wanted.versionedNode) notes.push('Its Node path changes when Node is updated. Run fonn hooks install again after a Node update.');
    if (lookalikeCount(agent, text, paths.configPath, bash)) notes.push('A hook that looks like Fonn\'s but is not managed by Fonn stays as it is.');
    if (agent === 'codex') {
      notes.push(CODEX_TRUST);
      const toml = paths.codexToml ? await readText(paths.codexToml).catch(() => null) : null;
      if (toml !== null && mentionsFonnHook(toml, 'codex')) notes.push('config.toml also has a Fonn hook. Fonn only manages hooks.json, so remove that one by hand.');
    }
    if (notes.length) status.note = notes.join(' ');
  } catch (error) {
    status.error = error instanceof HookConfigError ? error.message : `${paths.configPath} could not be read.`;
  }
  return status;
}

function planFor(agent: HookAgent, action: HookPlan['action'], paths: Paths, before: string | null, wanted: { argv: string[]; command: string }, symlink: boolean, bash: string): HookPlan {
  const result = agent === 'opencode' ? opencodePlan(before, paths.configPath, wanted.argv, action, symlink)
    : agent === 'crush' ? crushPlan(before, paths.configPath, wanted.command, action, bash)
      : jsonPlan(agent, before, paths.configPath, wanted.command, action);
  const changes = result.after !== before;
  return {
    agent, action, configPath: paths.configPath, changes, before, after: result.after, summary: result.summary,
    files: [],
  };
}

export async function hookStatus(options: HookRuntimeOptions = {}): Promise<HookStatus[]> {
  return Promise.all(HOOK_AGENTS.map(agent => statusFor(agent, options)));
}

export async function planHook(agent: HookAgent, action: HookPlan['action'], options: HookRuntimeOptions = {}): Promise<HookPlan> {
  checkAgent(agent);
  if (action !== 'install' && action !== 'uninstall') throw new Error('The action must be install or uninstall.');
  const paths = agentPaths(agent, options);
  const found = await identity(paths.configPath);
  const before = await readText(paths.configPath);
  const wanted = await commandFor(agent, options);
  if (action === 'install' && !options.command?.length) {
    const script = wanted.argv.find(word => word.endsWith('.js'));
    if (script && await brokenCommand([script])) throw new Error('Build fonn first with `npm run build` so the hook entrypoint exists.');
  }
  const plan = planFor(agent, action, paths, before, wanted, found.symlink, options.bash ?? 'bash');
  planIdentities.set(plan, found);
  return plan;
}

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * True when a lock was left behind: its process is gone, or it is older
 * than ten minutes. A lock that cannot be read is judged by its age.
 */
async function staleLock(lockPath: string, info: { mtimeMs: number }): Promise<boolean> {
  let owner: { pid?: unknown; createdAt?: unknown } = {};
  try {
    const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { owner = JSON.parse((await handle.read(Buffer.alloc(4096), 0, 4096, 0)).buffer.toString('utf8').replace(/\0+$/, '')) as typeof owner; }
    finally { await handle.close(); }
  } catch { owner = {}; }
  const created = typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : NaN;
  if (Date.now() - (Number.isFinite(created) ? created : info.mtimeMs) > STALE_LOCK_MS) return true;
  if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
  }
  return false;
}

/** Serialises Fonn's writers of one config file, like the profile store's lock. */
async function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lockPath = path.join(path.dirname(file), `.${path.basename(file)}.fonn-lock`);
  const busy = () => new Error(`Another Fonn change to ${file} is in progress: ${lockPath}. Retry after it finishes.`);
  let lock;
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? busy() : error;
      const found = await lstat(lockPath).catch(() => undefined);
      if (!found) continue;
      if (found.isSymbolicLink() || !found.isFile() || !(await staleLock(lockPath, found))) throw busy();
      // Remove the stale lock only if it is still the same file.
      const again = await lstat(lockPath).catch(() => undefined);
      if (again && again.dev === found.dev && again.ino === found.ino) await unlink(lockPath);
    }
  }
  const lockInfo = await lock.stat();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await work();
  } finally {
    await lock.close();
    const current = await lstat(lockPath).catch(() => undefined);
    if (current && !current.isSymbolicLink() && current.dev === lockInfo.dev && current.ino === lockInfo.ino) await unlink(lockPath);
  }
}

/**
 * A stable string for the file a plan was made against: whether it was
 * missing, a file or a link, its device and inode, and for a link the real
 * path and the target's device and inode. Two plans for the same path give
 * different strings when the file was replaced or a link retargeted between
 * them. A plan not made by planHook gives 'unknown'.
 */
export function planIdentity(plan: HookPlan): string {
  const found = planIdentities.get(plan);
  if (!found) return 'unknown';
  if (!found.exists) return 'missing';
  return JSON.stringify([found.symlink ? 'link' : 'file', found.dev, found.ino, found.target, found.targetDev, found.targetIno]);
}

export async function applyHookPlan(plan: HookPlan, options: HookRuntimeOptions = {}): Promise<HookStatus> {
  const agent = checkAgent(plan.agent);
  const paths = agentPaths(agent, options);
  if (plan.configPath !== paths.configPath) throw new Error('The plan is for a different file than this agent uses.');
  const file = paths.configPath;
  if (plan.changes) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withLock(file, async () => {
      const expected = planIdentities.get(plan) ?? await identity(file);
      // Refuse when the content or the file itself changed since the plan.
      const unchanged = async () => sameIdentity(expected, await identity(file)) && await readText(file) === plan.before;
      if (!(await unchanged())) throw new HookConflictError(file);
      if (plan.after === null) {
        // Remove the path itself. For a link that is the link, never its target.
        await options.beforeCommit?.();
        if (!(await unchanged())) throw new HookConflictError(file);
        if (expected.exists) await unlink(file);
        return;
      }
      // Write through a symlinked config, such as one kept in a dotfiles folder.
      const target = expected.symlink ? expected.target! : file;
      if (expected.symlink && agent === 'opencode') throw new HookConflictError(file);
      const mode = expected.exists ? (await stat(target)).mode & 0o777 : 0o600;
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (plan.before !== null && agent !== 'opencode') {
        // Keep the user's original once. Later changes never replace it.
        try { await writeFile(`${target}.fonn-backup`, plan.before, { mode, flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      await writeFile(temporary, plan.after, { mode, flag: 'wx' });
      try {
        await options.beforeCommit?.();
        if (!(await unchanged())) throw new HookConflictError(file);
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  } else if (await readText(file) !== plan.before) {
    throw new HookConflictError(file);
  }
  return statusFor(agent, options);
}

/** One line per installed hook that is broken or points at another Fonn. Cheap enough for every start. */
export async function hookWarnings(options: HookRuntimeOptions = {}): Promise<string[]> {
  const statuses = await hookStatus(options);
  return statuses.flatMap(status => {
    const problem = problems.get(status);
    return problem ? [`${status.label}: ${PROBLEM_TEXT[problem]}. Run fonn hooks install --agent ${status.agent}.`] : [];
  });
}
