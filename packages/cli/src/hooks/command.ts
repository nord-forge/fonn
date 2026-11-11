// Builds the command an agent runs for Fonn's global hook, and checks an
// installed command. The command must keep working from GUI apps without
// PATH, and after `brew upgrade` or a Node update, because a hook that fails
// open would otherwise stop filtering without any message.
import { access, realpath } from 'node:fs/promises';
import { constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookAgent, HookOptions } from './contract.js';
import { shellQuote } from '../native/storage.js';

/** Options that only tests and the CLI pass. The public shape stays HookOptions. */
export interface HookRuntimeOptions extends HookOptions {
  /** Defaults to process.env. Only read when `home` is not given. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.execPath. */
  execPath?: string;
  /** Defaults to this installation's built main.js. */
  entrypoint?: string;
  /** Homebrew prefixes to look in for stable links. Defaults to /opt/homebrew and /usr/local. */
  brewPrefixes?: string[];
  /** Tests only: the Bash used to check crushrc. Defaults to bash on PATH. */
  bash?: string;
  /** Tests only: runs inside applyHookPlan just before the final check and the rename. */
  beforeCommit?: () => Promise<void>;
  /** Tests only: runs right after the rename, before Fonn reads the file back. */
  afterCommit?: () => Promise<void>;
  /** Tests only: writes the temporary file, so a failing disk can be simulated. */
  writeTemporary?: (handle: import('node:fs/promises').FileHandle, content: string) => Promise<void>;
}

export interface BaseCommand {
  /** The program and arguments before `hook --agent <agent>`. */
  argv: string[];
  /** True when the Node path changes with each Node update. */
  versionedNode: boolean;
}

const DEFAULT_BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
// Node version managers and Homebrew's Cellar keep each version in its own folder.
const VERSIONED_NODE = /\/(?:\.nvm\/versions|Cellar|\.volta\/tools|fnm\/node-versions|\.fnm\/node-versions|\.asdf\/installs|mise\/installs|\.nodenv\/versions|\.nodebrew\/node|n\/versions)\//;

async function exists(file: string): Promise<boolean> {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

async function real(file: string): Promise<string | undefined> {
  try { return await realpath(file); } catch { return undefined; }
}

/** The built CLI entrypoint of this installation, as the native launchers find it. */
async function defaultEntrypoint(): Promise<string> {
  const compiled = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  if (await exists(compiled)) return compiled;
  return fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
}

/**
 * The stable command for this installation. A Homebrew install uses the
 * `<prefix>/bin/fonn` link, which Homebrew moves to each new version. Other
 * installs use Node and the absolute main.js, preferring a stable Node link
 * that resolves to the running Node binary.
 */
export async function baseCommand(options: HookRuntimeOptions = {}): Promise<BaseCommand> {
  if (options.command?.length) return { argv: [...options.command], versionedNode: false };
  const entrypoint = path.resolve(options.entrypoint ?? await defaultEntrypoint());
  const realEntry = await real(entrypoint) ?? entrypoint;
  const cask = /^(.*)\/Caskroom\/fonn\//.exec(realEntry);
  if (cask) {
    const link = path.join(cask[1]!, 'bin', 'fonn');
    const target = await real(link);
    if (target?.startsWith(path.join(cask[1]!, 'Caskroom', 'fonn') + path.sep)) return { argv: [link], versionedNode: false };
  }
  const execPath = options.execPath ?? process.execPath;
  const realExec = await real(execPath) ?? execPath;
  const prefixes = [...(options.brewPrefixes ?? DEFAULT_BREW_PREFIXES)];
  if (cask && !prefixes.includes(cask[1]!)) prefixes.unshift(cask[1]!);
  const candidates = [...prefixes.flatMap(prefix => [path.join(prefix, 'opt', 'node', 'bin', 'node'), path.join(prefix, 'bin', 'node')]), '/usr/local/bin/node'];
  for (const candidate of candidates) {
    if (candidate !== execPath && await real(candidate) === realExec) return { argv: [candidate, realEntry], versionedNode: false };
  }
  return { argv: [execPath, realEntry], versionedNode: VERSIONED_NODE.test(execPath) };
}

export function hookArguments(agent: HookAgent): string[] {
  return ['hook', '--agent', agent];
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

/** Loosely mentions `hook --agent <agent>`. Only used to find lookalikes to report, never to change. */
export function mentionsFonnHook(command: unknown, agent: HookAgent): boolean {
  if (typeof command !== 'string') return false;
  return new RegExp(`(?:^|[\\s'"])hook['"]?\\s+['"]?--agent['"]?\\s+['"]?${agent}(?=[^\\w-]|$)`).test(command);
}

/**
 * True only for a complete Fonn invocation and nothing else:
 * [<path named fonn>, hook, --agent, <agent>] or
 * [<node binary>, <path ending in /cli/main.js>, hook, --agent, <agent>].
 */
export function isFonnHookCommand(command: unknown, agent: HookAgent): boolean {
  if (typeof command !== 'string') return false;
  const words = shellWords(command);
  if (!words) return false;
  const tail = (from: number) => words.length === from + 3 && words[from] === 'hook' && words[from + 1] === '--agent' && words[from + 2] === agent;
  if (words.length === 4) return path.basename(words[0]!) === 'fonn' && tail(1);
  if (words.length === 5) return /^node(?:js)?(?:\.exe)?$/.test(path.basename(words[0]!)) && fonnEntrypoint(words[1]!) && tail(2);
  return false;
}

/**
 * True for Fonn's built CLI: packages/cli/dist/cli/main.js whose package is
 * @nord-forge/fonn-cli (or that no longer exists, a stale Fonn hook), or a
 * dist/cli/main.js whose package is fonn or @nord-forge/fonn-cli. Anything
 * it cannot read counts as not Fonn's.
 */
function fonnEntrypoint(script: string): boolean {
  if (!path.isAbsolute(script)) return false;
  const canonical = script.endsWith('/packages/cli/dist/cli/main.js');
  if (!canonical && !script.endsWith('/dist/cli/main.js')) return false;
  // A canonical path whose checkout is gone is a stale Fonn hook: it cannot
  // run anything, and treating it as Fonn's lets uninstall clean it up.
  if (canonical && !existsSync(script)) return true;
  const manifest = path.join(path.dirname(path.dirname(path.dirname(script))), 'package.json');
  try {
    const info = statSync(manifest);
    if (!info.isFile() || info.size > 256 * 1024) return false;
    const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
    return canonical ? name === '@nord-forge/fonn-cli' : name === 'fonn' || name === '@nord-forge/fonn-cli';
  } catch { return false; }
}

/** Fonn's own entry, a lookalike that Fonn leaves alone, or neither. */
export function hookOwnership(command: unknown, agent: HookAgent): 'fonn' | 'lookalike' | 'none' {
  if (isFonnHookCommand(command, agent)) return 'fonn';
  return mentionsFonnHook(command, agent) ? 'lookalike' : 'none';
}

/** Splits a POSIX shell command into words. Returns undefined for anything it cannot read safely. */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return undefined;
      current += command.slice(index + 1, end);
      index = end;
      started = true;
    } else if (character === '"') {
      index++;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === '\\' && index + 1 < command.length) index++;
        current += command[index];
        index++;
      }
      if (index >= command.length) return undefined;
      started = true;
    } else if (character === '\\') {
      // A backslash before a newline joins lines, which is not a plain word.
      if (index + 1 >= command.length || command[index + 1] === '\n' || command[index + 1] === '\r') return undefined;
      current += command[++index];
      started = true;
    } else if (character === '\n' || character === '\r') {
      // An unquoted newline separates commands.
      return undefined;
    } else if (/\s/.test(character)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else if (/[;&|<>`$()]/.test(character)) {
      return undefined;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/**
 * True when an installed hook can no longer run: the program or script
 * before `hook` is an absolute path that does not exist any more.
 */
export async function brokenCommand(argv: readonly string[] | undefined): Promise<boolean> {
  if (!argv) return false;
  const end = argv.indexOf('hook');
  for (const word of argv.slice(0, end < 0 ? argv.length : end)) {
    if (path.isAbsolute(word) && !(await exists(word))) return true;
  }
  return false;
}
