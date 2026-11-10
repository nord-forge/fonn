import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FilterLevel, FilterMode, ProfileName } from '@nord-forge/fonn-core/contracts';
import { profileNameSchema, taskProfileSchema } from '@nord-forge/fonn-core/profiles';
import { mergedFilterRulesSchema } from '@nord-forge/fonn-core/settings';
import { getDefaultStateDirectory } from '@nord-forge/fonn-core/state';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const launchSchema = z.object({
  schemaVersion: z.literal(1),
  launchId: z.string().regex(idPattern),
  provider: z.enum(['claude', 'codex']).optional(),
  cwd: z.string(),
  profile: profileNameSchema,
  profileSnapshot: taskProfileSchema.optional(),
  filterMode: z.enum(['filter', 'observe', 'off']),
  // Absent on launches saved before filter levels; those replay as strict.
  filterLevel: z.enum(['strict', 'standard', 'similar']).optional(),
  // The filter rules a launch started with; resume and the hook reuse them.
  filterRules: mergedFilterRulesSchema.optional(),
  subagents: z.enum(['auto', 'off']).optional(),
  createdAt: z.string(),
  hookEntrypoint: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
}).strict().refine(record => record.profileSnapshot === undefined || record.profileSnapshot.name === record.profile, 'Profile snapshot must match the launch profile').refine(record => record.provider === undefined || record.profileSnapshot === undefined || record.provider === (record.profileSnapshot.provider ?? 'claude'), 'Profile provider must match the launch provider');
export type LaunchRecord = z.infer<typeof launchSchema>;

export interface NativeLaunchOptions {
  cwd: string;
  profile?: ProfileName;
  configDirectory?: string;
  filterMode?: FilterMode;
  /** Defaults to standard. */
  filterLevel?: FilterLevel;
  /** User filter rules; validated again with the launch record. */
  filterRules?: Array<{ name: string; command: string; remove: string[] }>;
  subagents?: 'auto' | 'off';
  stateDirectory?: string;
  args?: string[];
  executable?: string;
  hookEntrypoint?: string;
  profileSnapshot?: import("@nord-forge/fonn-core/contracts").TaskProfile;
  resume?: string | true;
}

function validateId(id: string): void {
  if (!idPattern.test(id)) throw new Error('Invalid native launch ID.');
}

export async function privateDirectory(directory: string, create: boolean): Promise<string> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native state directories must be real directories.');
  return realpath(directory);
}

export async function launchDirectory(stateDirectory: string | undefined, launchId: string, create = false): Promise<{ root: string; directory: string }> {
  validateId(launchId);
  const root = await privateDirectory(path.resolve(stateDirectory ?? getDefaultStateDirectory()), create);
  const parent = await privateDirectory(path.join(root, 'native'), create);
  if (path.dirname(parent) !== root) throw new Error('Native state escaped its configured root.');
  const directory = await privateDirectory(path.join(parent, launchId), create);
  if (path.dirname(directory) !== parent) throw new Error('Native launch escaped its configured root.');
  return { root, directory };
}

export async function readLaunch(stateDirectory: string | undefined, launchId: string): Promise<{ root: string; directory: string; record: LaunchRecord }> {
  const location = await launchDirectory(stateDirectory, launchId);
  const handle = await open(path.join(location.directory, 'launch.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid native launch metadata.');
    const record = launchSchema.parse(JSON.parse(await handle.readFile('utf8')));
    if (record.launchId !== launchId) throw new Error('Native launch metadata does not match its directory.');
    return { ...location, record };
  } finally {
    await handle.close();
  }
}

export async function atomicJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
