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
const nativeLaunchSchema = z.object({
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
/** A launch started by `fonn claude` or `fonn codex`. */
export type LaunchRecord = z.infer<typeof nativeLaunchSchema>;

const agentSessionIdSchema = z.string().min(1).max(512).refine(id => !/[\u0000-\u001f\u007f]/.test(id), 'Invalid agent session ID');

/**
 * A session seen by the global hook (`fonn hook --agent <agent>`). It has no
 * profile, because the agent was started without Fonn. The directory name is
 * a UUID derived from the agent and its session ID.
 */
const hookLaunchSchema = z.object({
  schemaVersion: z.literal(1),
  launchId: z.string().regex(idPattern),
  origin: z.literal('hook'),
  provider: z.enum(['claude', 'codex', 'crush', 'opencode']),
  agentSessionId: agentSessionIdSchema,
  cwd: z.string(),
  filterMode: z.enum(['filter', 'observe', 'off']),
  filterLevel: z.enum(['strict', 'standard', 'similar']).optional(),
  filterRules: mergedFilterRulesSchema.optional(),
  subagents: z.enum(['auto', 'off']).optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
}).strict();
export type HookLaunchRecord = z.infer<typeof hookLaunchSchema>;
export type StoredLaunchRecord = LaunchRecord | HookLaunchRecord;

/** Every record under <state>/native/: native launches, and hook sessions with origin 'hook'. */
export const launchRecordSchema = z.union([nativeLaunchSchema, hookLaunchSchema]);
export const hookLaunchRecordSchema = hookLaunchSchema;

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

/**
 * Reads any record under <state>/native/<id>/, including hook sessions.
 * Use it where a hook session is as good as a launch, such as reading an
 * archived original.
 */
export async function readStoredLaunch(stateDirectory: string | undefined, launchId: string): Promise<{ root: string; directory: string; record: StoredLaunchRecord }> {
  const location = await launchDirectory(stateDirectory, launchId);
  const handle = await open(path.join(location.directory, 'launch.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid native launch metadata.');
    const record = launchRecordSchema.parse(JSON.parse(await handle.readFile('utf8')));
    if (record.launchId !== launchId) throw new Error('Native launch metadata does not match its directory.');
    return { ...location, record };
  } finally {
    await handle.close();
  }
}

/**
 * Reads a launch started by `fonn claude` or `fonn codex`. Hook sessions are
 * refused here, so resume and the launch hooks never act on them.
 */
export async function readLaunch(stateDirectory: string | undefined, launchId: string): Promise<{ root: string; directory: string; record: LaunchRecord }> {
  const location = await readStoredLaunch(stateDirectory, launchId);
  if ('origin' in location.record) throw new Error('This record belongs to a hook session, not a native launch.');
  return { ...location, record: location.record };
}

export async function atomicJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
