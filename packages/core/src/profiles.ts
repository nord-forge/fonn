import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import type { FilterLevel, ProfileName, ProfileProvider, TaskProfile } from './contracts.js';

export const profiles: Readonly<Record<ProfileName, TaskProfile>> = Object.freeze({
  'opus-high': Object.freeze({ name: 'opus-high', model: 'claude-opus-5-5', effort: 'high' }),
  'opus-medium': Object.freeze({ name: 'opus-medium', model: 'claude-opus-5-5', effort: 'medium' }),
  'sonnet-medium': Object.freeze({ name: 'sonnet-medium', model: 'claude-sonnet-5-5', effort: 'medium' }),
  'claude:fable-medium': Object.freeze({ name: 'claude:fable-medium', model: 'claude-fable-5-2', effort: 'medium' }),
  'claude:mythos-medium': Object.freeze({ name: 'claude:mythos-medium', model: 'claude-mythos-5-2', effort: 'medium' }),
  'codex:sol-medium': Object.freeze({ name: 'codex:sol-medium', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }),
});

/** Synchronous compatibility API: resolves built-in profiles only. */
export function getProfile(name: string = 'opus-medium'): TaskProfile {
  if (!Object.hasOwn(profiles, name)) throw new Error(`Unknown profile: ${name}. Choose ${Object.keys(profiles).join(', ')}.`);
  return profiles[name as ProfileName]!;
}

export const profileNameSchema = z.string().max(48).refine(name => /^[a-z][a-z0-9-]*$/.test(name) || Object.hasOwn(profiles, name), 'Use lowercase letters, digits and hyphens for custom profile names')
  .refine((name) => !['constructor', 'prototype', '__proto__', 'default'].includes(name), 'This profile name is reserved');
export const providerSchema = z.enum(['claude', 'codex']);
const claudeModelPattern = /^(?:claude-[A-Za-z0-9._-]+|opus|sonnet|haiku|fable|mythos)$/;
const codexModelPattern = /^(?:gpt-[A-Za-z0-9._-]+|o[1-9][0-9]*(?:-[A-Za-z0-9._-]+)?)$/;
// Fonn's new family names are pinned before persistence, launch and replay.
const pinnedClaudeAliases: Readonly<Record<string, string>> = Object.freeze({ fable: 'claude-fable-5-2', mythos: 'claude-mythos-5-2' });
/** Syntactic validation only; model availability and supported efforts are checked upstream. */
export const modelSchema = z.string().max(128).refine((model) => claudeModelPattern.test(model) || codexModelPattern.test(model), 'Expected a Claude model ID or alias, GPT model ID, or o-series model ID')
  .transform(model => Object.hasOwn(pinnedClaudeAliases, model) ? pinnedClaudeAliases[model]! : model);
/**
 * Where a Codex profile's model runs. Absent: OpenAI, through the user's
 * Codex sign-in. `ollama` or `lmstudio`: a local model through `codex --oss`.
 * `provider:<name>`: a model provider the user configured in Codex's own
 * config.toml (for example Mistral, DeepSeek, Kimi or OpenRouter). Fonn only
 * stores the name; credentials stay in Codex.
 */
export const modelSourceSchema = z.union([
  z.enum(['ollama', 'lmstudio']),
  z.string().regex(/^provider:[A-Za-z0-9_-]{1,64}$/, 'Use provider:<name>, where name is a model_providers entry in your Codex config'),
]);
// Open-weight and hosted model names, such as qwen3-coder:30b or mistralai/devstral-small.
const openModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** Model text for edits; the full profile check decides which names are allowed. */
export const modelTextSchema = z.string().min(1).max(128);
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const filterLevelSchema = z.enum(['strict', 'standard', 'similar']);
export const taskProfileSchema = z.object({
  name: profileNameSchema, provider: providerSchema.optional(),
  model: z.string().max(128).transform(model => Object.hasOwn(pinnedClaudeAliases, model) ? pinnedClaudeAliases[model]! : model),
  effort: effortSchema, source: modelSourceSchema.optional(),
}).strict().superRefine((profile, context) => {
  const provider = profile.provider ?? 'claude';
  if (profile.source !== undefined) {
    if (provider !== 'codex') context.addIssue({ code: 'custom', path: ['source'], message: 'A model source is only available for Codex profiles' });
    else if (!openModelPattern.test(profile.model)) context.addIssue({ code: 'custom', path: ['model'], message: 'Use the model name your source knows, such as qwen3-coder:30b' });
    return;
  }
  const matches = provider === 'claude' ? claudeModelPattern.test(profile.model) : codexModelPattern.test(profile.model);
  if (!matches) context.addIssue({ code: 'custom', path: ['model'], message: provider === 'claude' ? 'Claude profiles require a Claude model ID or alias; OpenAI model IDs require provider codex' : 'Codex profiles require a GPT or o-series model ID; Claude models require provider claude' });
});

const maximumConfigBytes = 128 * 1024;
const configSchema = z.object({
  schemaVersion: z.literal(1),
  defaultProfile: profileNameSchema,
  /** Saved output-filter level for launches and runs without --filter-level. */
  defaultFilterLevel: filterLevelSchema.optional(),
  /** Saved filter mode and subagent preference; unset means the built-in default. */
  defaultFilterMode: z.enum(['filter', 'observe', 'off']).optional(),
  defaultSubagents: z.enum(['auto', 'off']).optional(),
  profiles: z.array(taskProfileSchema).max(100),
}).strict().superRefine((config, context) => {
  const names = new Set<string>();
  for (const [index, profile] of config.profiles.entries()) {
    if (Object.hasOwn(profiles, profile.name) || names.has(profile.name)) {
      context.addIssue({ code: 'custom', path: ['profiles', index, 'name'], message: 'Profile names must be unique and cannot shadow built-in profiles' });
    }
    names.add(profile.name);
  }
  if (!Object.hasOwn(profiles, config.defaultProfile) && !names.has(config.defaultProfile)) {
    context.addIssue({ code: 'custom', path: ['defaultProfile'], message: 'Default profile must exist' });
  }
});
type ProfileConfig = z.infer<typeof configSchema>;
const emptyConfig = (): ProfileConfig => ({ schemaVersion: 1, defaultProfile: 'opus-medium', profiles: [] });

/** Explicit FONN_CONFIG_DIR paths are resolved; relative XDG_CONFIG_HOME values are ignored. */
export function getDefaultConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.FONN_CONFIG_DIR) return resolve(environment.FONN_CONFIG_DIR);
  if (environment.XDG_CONFIG_HOME && isAbsolute(environment.XDG_CONFIG_HOME)) return join(environment.XDG_CONFIG_HOME, 'fonn');
  return join(homedir(), '.config', 'fonn');
}

/** Check every existing path component; only the leaf is chmodded by writers. */
async function checkDirectory(directory: string, create: boolean): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Profile configuration directories must be real directories without symlinks: ${current}`);
  }
}

async function checkConfigFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Profile configuration must be a regular file without symlinks: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readConfig(directory: string): Promise<ProfileConfig> {
  const path = join(directory, 'profiles.json');
  try { await checkDirectory(directory, false); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw error;
  }
  await checkConfigFile(path);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumConfigBytes) throw new Error('Expected a regular JSON file of at most 128 KiB');
    const buffer = Buffer.alloc(maximumConfigBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumConfigBytes) throw new Error('JSON exceeds 128 KiB');
    return configSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } catch {
    throw new Error(`Invalid profile configuration at ${path}. Repair or remove this file before retrying.`);
  } finally { await file.close(); }
}

function lookup(config: ProfileConfig, name: string): TaskProfile {
  if (Object.hasOwn(profiles, name)) return getProfile(name);
  const profile = config.profiles.find((profile) => profile.name === name);
  if (!profile) throw new Error(`Unknown profile: ${name}. List profiles to choose an existing name.`);
  return Object.freeze({ ...profile });
}

export type GlobalSettingKey = 'profile' | 'filterLevel' | 'filterMode' | 'subagents';
export interface GlobalSettings {
  profile: string;
  filterLevel?: FilterLevel;
  filterMode?: 'filter' | 'observe' | 'off';
  subagents?: 'auto' | 'off';
}

export function createProfileStore(directory = getDefaultConfigDirectory()) {
  if (!directory.trim() || directory.includes('\0')) throw new Error('Invalid profile configuration directory');
  const root = resolve(directory);
  const path = join(root, 'profiles.json');
  const lockPath = join(root, '.profiles.lock');

  async function mutate<T>(change: (config: ProfileConfig) => T): Promise<T> {
    await checkDirectory(root, true);
    await chmod(root, 0o700);
    let lock;
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Profile configuration is busy: ${lockPath}. Retry after the current writer finishes. After a crash, inspect this lock and verify its owner has stopped before manually removing it.`);
      }
      throw error;
    }
    const lockInfo = await lock.stat();
    let temporary: string | undefined;
    try {
      await lock.writeFile(JSON.stringify({ owner: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }));
      const config = await readConfig(root);
      const result = change(config);
      configSchema.parse(config);
      const content = `${JSON.stringify(config, null, 2)}\n`;
      if (Buffer.byteLength(content) > maximumConfigBytes) throw new Error('Profile configuration exceeds 128 KiB');
      await checkDirectory(root, false);
      await checkConfigFile(path);
      temporary = join(root, `.profiles-${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      temporary = undefined;
      return result;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close();
      // A replaced lock belongs to somebody else, even if it has the same name.
      const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (current && !current.isSymbolicLink() && current.dev === lockInfo.dev && current.ino === lockInfo.ino) await unlink(lockPath);
    }
  }

  function assertCustom(name: string): void {
    profileNameSchema.parse(name);
    if (Object.hasOwn(profiles, name)) throw new Error(`Built-in profile ${name} is immutable`);
  }

  return {
    async list(): Promise<{ profiles: readonly TaskProfile[]; defaultProfile: string }> {
      const config = await readConfig(root);
      return Object.freeze({ profiles: Object.freeze([...Object.values(profiles), ...config.profiles.map((profile) => Object.freeze({ ...profile }))]), defaultProfile: config.defaultProfile });
    },
    async get(name?: string): Promise<TaskProfile> {
      const config = await readConfig(root);
      return lookup(config, name ?? config.defaultProfile);
    },
    async create(profile: TaskProfile): Promise<TaskProfile> {
      const validated = taskProfileSchema.parse(profile);
      assertCustom(validated.name);
      return mutate((config) => {
        if (config.profiles.some((item) => item.name === validated.name)) throw new Error(`Profile already exists: ${validated.name}`);
        if (config.profiles.length >= 100) throw new Error('At most 100 custom profiles are allowed');
        config.profiles.push(validated);
        return Object.freeze({ ...validated });
      });
    },
    /** `source: null` removes the source, so the profile uses OpenAI again. */
    async edit(name: string, changes: { provider?: ProfileProvider; model?: string; effort?: TaskProfile['effort']; source?: TaskProfile['source'] | null }): Promise<TaskProfile> {
      assertCustom(name);
      const validated = z.object({ provider: providerSchema.optional(), model: modelTextSchema.optional(), effort: effortSchema.optional(), source: modelSourceSchema.nullable().optional() }).strict().parse(changes);
      return mutate((config) => {
        const profile = lookup(config, name);
        const { source: previous, ...rest } = profile;
        const source = validated.source === undefined ? previous : validated.source ?? undefined;
        const updated = taskProfileSchema.parse({ ...rest, ...(validated.provider === undefined ? {} : { provider: validated.provider }), model: validated.model ?? profile.model, effort: validated.effort ?? profile.effort, ...(source === undefined ? {} : { source }) });
        config.profiles[config.profiles.findIndex((item) => item.name === name)] = updated;
        return Object.freeze({ ...updated });
      });
    },
    async delete(name: string): Promise<void> {
      assertCustom(name);
      await mutate((config) => {
        lookup(config, name);
        if (config.defaultProfile === name) throw new Error(`Cannot delete the current default profile: ${name}. Select another default first.`);
        config.profiles = config.profiles.filter((profile) => profile.name !== name);
      });
    },
    async setDefaultProvider(provider: ProfileProvider): Promise<TaskProfile> {
      providerSchema.parse(provider);
      return mutate((config) => {
        const current = lookup(config, config.defaultProfile);
        const profile = (current.provider ?? 'claude') === provider
          ? current
          : getProfile(provider === 'codex' ? 'codex:sol-medium' : 'opus-medium');
        config.defaultProfile = profile.name;
        return profile;
      });
    },
    /** Global settings that are actually saved, plus the default profile. */
    async getGlobalSettings(): Promise<GlobalSettings> {
      const config = await readConfig(root);
      return Object.freeze({
        profile: config.defaultProfile,
        ...(config.defaultFilterLevel === undefined ? {} : { filterLevel: config.defaultFilterLevel }),
        ...(config.defaultFilterMode === undefined ? {} : { filterMode: config.defaultFilterMode }),
        ...(config.defaultSubagents === undefined ? {} : { subagents: config.defaultSubagents }),
      });
    },
    /** Saves one global setting. The profile must exist. */
    async setGlobalSetting(key: GlobalSettingKey, value: string): Promise<void> {
      if (key === 'profile') {
        await this.setDefault(value);
        return;
      }
      const parsed = key === 'filterLevel' ? filterLevelSchema.parse(value)
        : key === 'filterMode' ? z.enum(['filter', 'observe', 'off']).parse(value)
          : z.enum(['auto', 'off']).parse(value);
      await mutate((config) => {
        if (key === 'filterLevel') config.defaultFilterLevel = parsed as FilterLevel;
        else if (key === 'filterMode') config.defaultFilterMode = parsed as 'filter' | 'observe' | 'off';
        else config.defaultSubagents = parsed as 'auto' | 'off';
      });
    },
    /** Removes one global setting. The profile goes back to the built-in default. */
    async unsetGlobalSetting(key: GlobalSettingKey): Promise<void> {
      await mutate((config) => {
        if (key === 'profile') config.defaultProfile = 'opus-medium';
        else if (key === 'filterLevel') delete config.defaultFilterLevel;
        else if (key === 'filterMode') delete config.defaultFilterMode;
        else delete config.defaultSubagents;
      });
    },
    async getDefaultFilterLevel(): Promise<FilterLevel> {
      return (await readConfig(root)).defaultFilterLevel ?? 'standard';
    },
    async setDefaultFilterLevel(level: FilterLevel): Promise<FilterLevel> {
      const validated = filterLevelSchema.parse(level);
      return mutate((config) => {
        config.defaultFilterLevel = validated;
        return validated;
      });
    },
    async setDefault(name: string): Promise<TaskProfile> {
      profileNameSchema.parse(name);
      return mutate((config) => {
        const profile = lookup(config, name);
        config.defaultProfile = name;
        return profile;
      });
    },
  };
}

export async function resolveProfile(name?: string, directory?: string): Promise<TaskProfile> {
  return createProfileStore(directory).get(name);
}

/** Explicit launchers use their provider's built-in default when the global default belongs to another provider. */
export async function resolveProfileForProvider(provider: ProfileProvider, name?: string, directory?: string): Promise<TaskProfile> {
  providerSchema.parse(provider);
  const profile = await resolveProfile(name, directory);
  if ((profile.provider ?? 'claude') === provider) return profile;
  if (name !== undefined) throw new Error(`Profile ${name} belongs to ${profile.provider ?? 'claude'}, not ${provider}. Select a ${provider} profile.`);
  return getProfile(provider === 'codex' ? 'codex:sol-medium' : 'opus-medium');
}
