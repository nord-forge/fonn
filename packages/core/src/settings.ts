// Project settings: per-repository defaults for launches and runs.
//
// Two files, both optional:
//   .fonn.json                 shared with the team, committed
//   .fonn/settings.local.json  personal, inside the .fonn/ folder that is
//                              already kept out of Git
//
// Precedence, highest first: command-line flag, local file, shared file, the
// global defaults in ~/.config/fonn, then built-in defaults. Only a few plain
// values are allowed. Paths, commands and credentials can never be set here,
// because a shared file comes from whoever wrote the repository.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import type { FilterLevel, FilterMode } from './contracts.js';
import { filterLevelSchema, profileNameSchema } from './profiles.js';

export const SHARED_SETTINGS_FILE = '.fonn.json';
export const LOCAL_SETTINGS_FILE = join('.fonn', 'settings.local.json');
const MAX_BYTES = 16 * 1024;

export const projectSettingsSchema = z.object({
  profile: profileNameSchema.optional(),
  filterLevel: filterLevelSchema.optional(),
  filterMode: z.enum(['filter', 'observe', 'off']).optional(),
  subagents: z.enum(['auto', 'off']).optional(),
}).strict();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type SettingKey = keyof ProjectSettings;
export type SettingScope = 'shared' | 'local';
export type SettingSource = 'flag' | 'local' | 'shared' | 'global' | 'default';

export const SETTING_KEYS: readonly SettingKey[] = Object.freeze(['profile', 'filterLevel', 'filterMode', 'subagents']);

export interface ProjectSettingsFiles {
  root: string;
  shared: { path: string; exists: boolean; settings: ProjectSettings };
  local: { path: string; exists: boolean; settings: ProjectSettings };
}

async function isFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined))?.isDirectory() ?? false;
}

/**
 * The project a directory belongs to: the nearest ancestor with a settings
 * file, otherwise the nearest Git root, otherwise the directory itself.
 */
export async function findProjectRoot(directory: string): Promise<string> {
  const start = resolve(directory);
  const top = parse(start).root;
  let gitRoot: string | undefined;
  for (let current = start; ; current = dirname(current)) {
    if (await isFile(join(current, SHARED_SETTINGS_FILE)) || await isFile(join(current, LOCAL_SETTINGS_FILE))) return current;
    if (!gitRoot && await lstat(join(current, '.git')).catch(() => undefined)) gitRoot = current;
    if (current === top) break;
  }
  return gitRoot ?? start;
}

async function readSettingsFile(path: string): Promise<{ exists: boolean; settings: ProjectSettings }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, settings: {} };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Fonn settings must be a regular file without symlinks: ${path}`);
  if (info.size > MAX_BYTES) throw new Error(`Fonn settings file is larger than 16 KiB: ${path}`);

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const text = await file.readFile('utf8');
    const parsed = projectSettingsSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ');
      throw new Error(`Invalid Fonn settings in ${path}: ${issues}. Allowed keys: ${SETTING_KEYS.join(', ')}.`);
    }
    return { exists: true, settings: parsed.data };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Fonn settings in ${path} are not valid JSON.`);
    throw error;
  } finally {
    await file.close();
  }
}

export async function readProjectSettings(root: string): Promise<ProjectSettingsFiles> {
  const sharedPath = join(root, SHARED_SETTINGS_FILE);
  const localPath = join(root, LOCAL_SETTINGS_FILE);
  return {
    root,
    shared: { path: sharedPath, ...await readSettingsFile(sharedPath) },
    local: { path: localPath, ...await readSettingsFile(localPath) },
  };
}

/** Replaces one scope's file atomically. An empty object removes the file. */
export async function writeProjectSettings(root: string, scope: SettingScope, settings: ProjectSettings): Promise<string> {
  const validated = projectSettingsSchema.parse(settings);
  const path = join(root, scope === 'shared' ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE);
  if (!(await stat(root)).isDirectory()) throw new Error(`Project directory does not exist: ${root}`);

  const existing = await lstat(path).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`Refusing to replace a non-regular settings file: ${path}`);

  if (Object.keys(validated).length === 0) {
    if (existing) await unlink(path);
    return path;
  }

  if (scope === 'local') {
    const folder = join(root, '.fonn');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await isDirectory(folder))) throw new Error(`Expected a folder at ${folder}`);
  }

  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return path;
}

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export interface ResolvedSettings {
  profile: ResolvedSetting<string>;
  filterLevel: ResolvedSetting<FilterLevel>;
  filterMode: ResolvedSetting<FilterMode>;
  subagents: ResolvedSetting<'auto' | 'off'>;
}

export interface SettingInputs {
  flags?: ProjectSettings;
  files?: Pick<ProjectSettingsFiles, 'shared' | 'local'>;
  global: { profile: string; filterLevel: FilterLevel };
}

const BUILT_IN = { filterMode: 'filter', subagents: 'auto' } as const;

/** Applies the precedence order and records where each value came from. */
export function resolveSettings({ flags = {}, files, global }: SettingInputs): ResolvedSettings {
  const layers: Array<[SettingSource, ProjectSettings]> = [
    ['flag', flags],
    ['local', files?.local.settings ?? {}],
    ['shared', files?.shared.settings ?? {}],
  ];
  function pick<K extends SettingKey>(key: K, fallback: ResolvedSetting<NonNullable<ProjectSettings[K]>>) {
    for (const [source, values] of layers) {
      const value = values[key];
      if (value !== undefined) return { value: value as NonNullable<ProjectSettings[K]>, source };
    }
    return fallback;
  }
  return {
    profile: pick('profile', { value: global.profile, source: 'global' }),
    filterLevel: pick('filterLevel', { value: global.filterLevel, source: 'global' }),
    filterMode: pick('filterMode', { value: BUILT_IN.filterMode, source: 'default' }),
    subagents: pick('subagents', { value: BUILT_IN.subagents, source: 'default' }),
  };
}

/** Values that came from a project file, for a short notice at launch. */
export function projectSourcedValues(settings: ResolvedSettings): Array<{ key: SettingKey; value: string; file: string }> {
  return SETTING_KEYS
    .filter((key) => settings[key].source === 'shared' || settings[key].source === 'local')
    .map((key) => ({ key, value: String(settings[key].value), file: settings[key].source === 'shared' ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE }));
}
