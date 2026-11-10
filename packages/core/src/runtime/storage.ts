import { mergedFilterRulesSchema } from '../rules.js';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunRecord, TaskUsage } from '../contracts.js';
import { taskProfileSchema } from '../profiles.js';
import { taskResultSchema } from '../schema.js';

export const taskIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const finite = z.number().finite().nonnegative();
const token = finite.int();
const usageSchema = z.object({ estimatedCostUsd: finite, inputTokens: token, outputTokens: token, cacheReadTokens: token, cacheWriteTokens: token }).strict();
const profileSchema = taskProfileSchema;
export const runRecordSchema = z.object({
  schemaVersion: z.literal(1), taskId: taskIdSchema, sessionId: z.string().min(1).optional(), parentTaskId: taskIdSchema.optional(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), status: z.enum(['succeeded', 'failed', 'cancelled', 'budget_exceeded']),
  profile: profileSchema, cwd: z.string().min(1), budgetUsd: z.number().finite().positive(), maxTurns: z.number().int().positive(), filterMode: z.enum(['filter', 'observe', 'off']), filterLevel: z.enum(['strict', 'standard', 'similar']).optional(), filterRules: mergedFilterRulesSchema.optional(),
  result: taskResultSchema.optional(), usage: usageSchema,
  filters: z.array(z.object({ mode: z.enum(['filter', 'observe', 'off']), status: z.enum(['filtered', 'observed', 'unchanged']), adapter: z.string().optional(), artifactId: z.string().optional(), originalCharacters: token, proposedCharacters: token, deliveredCharacters: token, removedLines: token, reason: z.string() }).strict()),
  error: z.string().optional(),
}).strict().refine((record) => record.status !== 'succeeded' || record.result !== undefined, 'Successful runs require a validated result');

export function getDefaultStateDirectory(): string {
  return join(homedir(), '.local', 'state', 'fonn');
}

/** Refuse symlink components, rather than following them outside the selected store. */
export async function checkedDirectory(path: string, create: boolean): Promise<string> {
  if (!path.trim() || path.includes('\0')) throw new Error('Invalid state directory');
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('State directories must be real directories, without symlinks');
  }
  return realpath(absolute);
}

export async function prepareTask(stateDirectory: string, taskId: string): Promise<string> {
  taskIdSchema.parse(taskId);
  const state = await checkedDirectory(stateDirectory, true);
  await chmod(state, 0o700);
  const tasks = await checkedDirectory(join(state, 'tasks'), true);
  await chmod(tasks, 0o700);
  const root = join(tasks, taskId);
  // A fresh ID must not reuse another task's files.
  await mkdir(root, { mode: 0o700 });
  await checkedDirectory(root, false);
  const artifacts = await checkedDirectory(join(root, 'artifacts'), true);
  return artifacts;
}

export async function getTaskArtifactDirectory(taskId: string, stateDirectory = getDefaultStateDirectory()): Promise<string> {
  if (!taskIdSchema.safeParse(taskId).success) throw new Error('Invalid task ID');
  return checkedDirectory(join(stateDirectory, 'tasks', taskId, 'artifacts'), false);
}

export async function saveRun(record: RunRecord, stateDirectory: string): Promise<void> {
  runRecordSchema.parse(record);
  const root = await checkedDirectory(join(stateDirectory, 'tasks', record.taskId), false);
  const temporary = join(root, `.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, join(root, 'run.json')); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function readRun(taskId: string, stateDirectory = getDefaultStateDirectory()): Promise<RunRecord> {
  if (!taskIdSchema.safeParse(taskId).success) throw new Error('Invalid task ID');
  const root = await checkedDirectory(join(stateDirectory, 'tasks', taskId), false);
  const file = await open(join(root, 'run.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 10_000_000) throw new Error('Invalid stored run file');
    let value: unknown;
    try { value = JSON.parse(await file.readFile('utf8')); } catch { throw new Error('Invalid stored run JSON'); }
    const parsed = runRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.taskId !== taskId) throw new Error('Invalid stored run record');
    return parsed.data;
  } finally { await file.close(); }
}

export async function listRuns(stateDirectory = getDefaultStateDirectory()): Promise<RunRecord[]> {
  let root: string;
  try { root = await checkedDirectory(join(stateDirectory, 'tasks'), false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const entries = await readdir(root, { withFileTypes: true });
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!taskIdSchema.safeParse(entry.name).success) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Invalid task directory');
    try { records.push(await readRun(entry.name, stateDirectory)); }
    catch (error) {
      // A running task has artifacts but no completed record yet.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.taskId.localeCompare(a.taskId));
}

export const emptyUsage = (): TaskUsage => ({ estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export const accountingResetError = 'SDK usage counters reset; resume accounting is indeterminate. Reported reset counters are preserved as observed estimates, not verified session deltas. Start a fresh task without --resume.';

/** Validate the full parent chain and sum only this session's persisted deltas. */
export async function resumeBaseline(parent: RunRecord, stateDirectory: string): Promise<TaskUsage> {
  const baseline = emptyUsage();
  const seen = new Set<string>();
  let record: RunRecord | undefined = parent;
  while (record) {
    if (seen.has(record.taskId)) throw new Error('Invalid cyclic run ancestry');
    seen.add(record.taskId);
    if (record.sessionId !== parent.sessionId || record.cwd !== parent.cwd) throw new Error('Resume ancestry does not match the session and project');
    if (record.error === accountingResetError) throw new Error('This session has indeterminate accounting after an SDK counter reset. Start a fresh task without --resume.');
    for (const key of Object.keys(baseline) as Array<keyof TaskUsage>) baseline[key] += record.usage[key];
    record = record.parentTaskId ? await readRun(record.parentTaskId, stateDirectory) : undefined;
  }
  // A resumed SDK session includes every saved turn, even if an older task ID was selected.
  // Require the latest leaf so an old parent cannot recount a later run's spend.
  const otherRuns = await listRuns(stateDirectory);
  if (otherRuns.some((run) => run.sessionId === parent.sessionId && !seen.has(run.taskId))) throw new Error('This session has newer task records. Resume its latest task instead.');
  return baseline;
}
