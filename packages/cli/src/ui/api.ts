import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
// The data behind each fonn ui endpoint. Every function takes the config
// and state directories explicitly, so tests can point them at temporary
// folders. Reads never write to disk. Changes go through the same validated,
// locked stores as the CLI.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ArtifactStore, FilterRule, RunRecord } from '@nord-forge/fonn-core/contracts';
import { createOutputFilter, reduceRecognizedOutput } from '@nord-forge/fonn-core/filtering';
import { createProfileStore, effortSchema, modelSourceSchema, modelTextSchema, profiles as builtInProfiles, providerSchema } from '@nord-forge/fonn-core/profiles';
import { filterRulesSchema, findProjectRoot, LOCAL_SETTINGS_FILE, projectSettingsSchema, resolveSettings, SHARED_SETTINGS_FILE, writeProjectSettings, type ProjectSettings, projectRulesFingerprint } from '@nord-forge/fonn-core/settings';
import { readRun } from '@nord-forge/fonn-core/state';
import { HOOK_AGENTS, HOOK_AGENT_LABELS, type HookAgent, type HookOptions, type HookPlan, type HookStatus } from '../hooks/contract.js';
import { delegationGuidance } from '../native/delegation.js';
import { readNativeOutput } from '../native/index.js';
import { forgetProject, readKnownProjects, rememberProject } from './known-projects.js';
import { readStoredLaunch, type StoredLaunchRecord } from '../native/storage.js';
import type {
  ArtifactSliceResponse, DecisionSummary, EffectiveSettings, FilterTotals, GlobalSettingsResponse, InstructionContent,
  FilterTestResult, InstructionFile, LaunchDeleted, LaunchDetail, LaunchesResponse, LaunchSummary, Overview, ProfilesResponse,
  ProjectDetail, ProjectDetailWithWarning, ProjectsResponse, ProjectSummary, RunsResponse, RunSummary, SettingsFileInfo, RulesApproval, HookPlanResponse, RecordsCleanup } from './contract.js';

export interface UiDirectories {
  configDirectory: string;
  stateDirectory: string;
}

/** An expected failure with a status code and a message that is safe to show. */
export class ApiFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const INSTRUCTION_NAMES: readonly InstructionFile['name'][] = Object.freeze(['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']);
const LIST_LIMIT = 200;
const MAX_INSTRUCTION_BYTES = 200 * 1024;
const MAX_SETTINGS_BYTES = 16 * 1024;
const MAX_DECISION_BYTES = 64 * 1024;
export const DEFAULT_SLICE = 4000;
export const MAX_SLICE = 20_000;

const decisionSchema = z.object({
  status: z.enum(['filtered', 'observed', 'unchanged']),
  reason: z.string(),
  adapter: z.string().optional(),
  artifactId: z.string().optional(),
  originalCharacters: z.number().int().nonnegative(),
  deliveredCharacters: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
});

interface StoredLaunch {
  record: StoredLaunchRecord;
  directory: string;
  projectRoot: string;
}

/** Remembers project roots for the length of one request. */
type RootCache = Map<string, Promise<string>>;

function projectRootOf(cache: RootCache, cwd: string): Promise<string> {
  let root = cache.get(cwd);
  if (!root) {
    root = findProjectRoot(cwd).catch(() => path.resolve(cwd));
    cache.set(cwd, root);
  }
  return root;
}

function emptyTotals(): FilterTotals {
  return { decisions: 0, filtered: 0, observed: 0, unchanged: 0, originalCharacters: 0, deliveredCharacters: 0, removedLines: 0 };
}

function addTotals(totals: FilterTotals, decisions: readonly Pick<DecisionSummary, 'status' | 'originalCharacters' | 'deliveredCharacters' | 'removedLines'>[]): FilterTotals {
  for (const decision of decisions) {
    totals.decisions++;
    totals[decision.status]++;
    totals.originalCharacters += decision.originalCharacters;
    totals.deliveredCharacters += decision.deliveredCharacters;
    totals.removedLines += decision.removedLines;
  }
  return totals;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Every readable launch, newest first. Broken launch folders are skipped. */
async function loadLaunches(stateDirectory: string, cache: RootCache): Promise<StoredLaunch[]> {
  let names: string[];
  try {
    const native = path.join(stateDirectory, 'native');
    if (!(await lstat(native)).isDirectory()) return [];
    names = await readdir(native);
  } catch {
    return [];
  }
  const launches = await Promise.all(names.filter((name) => ID_PATTERN.test(name)).map(async (name) => {
    try {
      const { record, directory } = await readStoredLaunch(stateDirectory, name);
      return { record, directory, projectRoot: await projectRootOf(cache, record.cwd) };
    } catch {
      return undefined;
    }
  }));
  return launches
    .filter((launch): launch is StoredLaunch => launch !== undefined)
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || b.record.launchId.localeCompare(a.record.launchId));
}

/** Every readable SDK run, newest first. Unreadable runs are skipped. */
async function loadRuns(stateDirectory: string): Promise<RunRecord[]> {
  let names: string[];
  try {
    const tasks = path.join(stateDirectory, 'tasks');
    if (!(await lstat(tasks)).isDirectory()) return [];
    names = await readdir(tasks);
  } catch {
    return [];
  }
  const runs = await Promise.all(names.filter((name) => ID_PATTERN.test(name)).map((name) => readRun(name, stateDirectory).catch(() => undefined)));
  return runs
    .filter((run): run is RunRecord => run !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.taskId.localeCompare(a.taskId));
}

/** Decision files of one launch, newest first. Malformed files are skipped. */
async function loadDecisions(launchDirectory: string): Promise<DecisionSummary[]> {
  const folder = path.join(launchDirectory, 'filters');
  let names: string[];
  try {
    const info = await lstat(folder);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
    names = (await readdir(folder)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  } catch {
    return [];
  }
  const decisions = await Promise.all(names.map(async (name) => {
    try {
      const handle = await open(path.join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_DECISION_BYTES) return undefined;
        const parsed = decisionSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
        if (!parsed.success) return undefined;
        const { adapter, artifactId, ...rest } = parsed.data;
        const summary: DecisionSummary = { ...rest, adapter: adapter ?? null, artifactId: artifactId ?? null };
        return { summary, time: info.mtimeMs };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }));
  return decisions
    .filter((entry): entry is { summary: DecisionSummary; time: number } => entry !== undefined)
    .sort((a, b) => b.time - a.time)
    .map((entry) => entry.summary);
}

function runTotals(run: RunRecord): FilterTotals {
  return addTotals(emptyTotals(), run.filters);
}

async function launchSummary(launch: StoredLaunch, decisions?: DecisionSummary[]): Promise<LaunchSummary> {
  const { record } = launch;
  const hook = 'origin' in record && record.origin === 'hook';
  const snapshot = 'profileSnapshot' in record ? record.profileSnapshot : undefined;
  const provider = record.provider ?? snapshot?.provider ?? 'claude';
  return {
    launchId: record.launchId,
    origin: hook ? 'hook' : 'launch',
    provider,
    providerLabel: HOOK_AGENT_LABELS[provider],
    profile: 'profile' in record ? record.profile : null,
    model: snapshot?.model ?? null,
    cwd: record.cwd,
    projectRoot: launch.projectRoot,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt ?? null,
    exitCode: record.exitCode ?? null,
    filterMode: record.filterMode,
    // Launches saved before filter levels replay as strict.
    filterLevel: record.filterLevel ?? 'strict',
    // Launches saved before the preference keep delegation guidance off.
    subagents: record.subagents ?? 'off',
    totals: addTotals(emptyTotals(), decisions ?? await loadDecisions(launch.directory)),
  };
}

async function runSummary(run: RunRecord, cache: RootCache): Promise<RunSummary> {
  return {
    taskId: run.taskId,
    status: run.status,
    profile: run.profile.name,
    cwd: run.cwd,
    projectRoot: await projectRootOf(cache, run.cwd),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    filterMode: run.filterMode,
    filterLevel: run.filterLevel ?? null,
    estimatedCostUsd: run.usage.estimatedCostUsd,
    totals: runTotals(run),
  };
}

async function isRegularFile(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => undefined))?.isFile() ?? false;
}

async function collectProjects(directories: UiDirectories, cache: RootCache): Promise<ProjectSummary[]> {
  const [launches, runs] = await Promise.all([loadLaunches(directories.stateDirectory, cache), loadRuns(directories.stateDirectory)]);
  const projects = new Map<string, ProjectSummary>();
  const touch = (root: string, time: string) => {
    let project = projects.get(root);
    if (!project) {
      project = { root, name: path.basename(root) || root, launches: 0, runs: 0, lastUsed: null, hasSharedSettings: false, hasLocalSettings: false, savedAt: null };
      projects.set(root, project);
    }
    if (project.lastUsed === null || time > project.lastUsed) project.lastUsed = time;
    return project;
  };
  for (const launch of launches) touch(launch.projectRoot, launch.record.createdAt).launches++;
  for (const run of runs) touch(await projectRootOf(cache, run.cwd), run.startedAt).runs++;
  // Projects you set up here before any agent worked in them. They only count
  // while they still look like a project, so the list cannot point anywhere else.
  for (const known of await readKnownProjects(directories.configDirectory)) {
    const existing = projects.get(known.root);
    if (existing) { existing.savedAt = known.savedAt; continue; }
    if (!await looksLikeProject(known.root)) continue;
    projects.set(known.root, { root: known.root, name: path.basename(known.root) || known.root, launches: 0, runs: 0, lastUsed: null, hasSharedSettings: false, hasLocalSettings: false, savedAt: known.savedAt });
  }
  const list = [...projects.values()];
  await Promise.all(list.map(async (project) => {
    project.hasSharedSettings = await isRegularFile(path.join(project.root, SHARED_SETTINGS_FILE));
    project.hasLocalSettings = await isRegularFile(path.join(project.root, LOCAL_SETTINGS_FILE));
  }));
  const recent = (project: ProjectSummary) => [project.lastUsed ?? '', project.savedAt ?? ''].sort().at(-1)!;
  return list.sort((a, b) => recent(b).localeCompare(recent(a)) || a.root.localeCompare(b.root));
}

/** A folder that is plainly a project: a Git repository root or one with a Fonn settings file. */
async function looksLikeProject(root: string): Promise<boolean> {
  const folder = await lstat(root).catch(() => undefined);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) return false;
  if (await lstat(path.join(root, '.git')).catch(() => undefined)) return true;
  return await isRegularFile(path.join(root, SHARED_SETTINGS_FILE)) || await isRegularFile(path.join(root, LOCAL_SETTINGS_FILE));
}

/**
 * Turns a `root` value into a project root. Allowed are projects from launch
 * or run records, and folders that are Git repository roots or already have
 * a Fonn settings file. Anything else is refused, so the interface cannot be
 * used to look into or write to arbitrary folders.
 */
async function knownRoot(directories: UiDirectories, cache: RootCache, root: string | null | undefined): Promise<string> {
  if (!root || root.includes('\0') || !path.isAbsolute(root)) throw new ApiFailure(400, 'The root must be an absolute path.');
  const resolved = await projectRootOf(cache, root);
  const projects = await collectProjects(directories, cache);
  if (projects.some((project) => project.root === resolved) || await looksLikeProject(resolved)) return resolved;
  throw new ApiFailure(404, 'Unknown project.');
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

/** GET /api/session: the home folder, which the browser shows as ~ in paths. */
export function getSession(): { home: string } {
  return { home: homedir() };
}

export async function getOverview(directories: UiDirectories): Promise<Overview> {
  const cache: RootCache = new Map();
  const [version, listing, projects, launches, runs] = await Promise.all([
    packageVersion(),
    createProfileStore(directories.configDirectory).list().catch(() => ({ profiles: Object.values(builtInProfiles) })),
    collectProjects(directories, cache),
    loadLaunches(directories.stateDirectory, cache),
    loadRuns(directories.stateDirectory),
  ]);
  return {
    version,
    node: process.version,
    platform: process.platform,
    configDirectory: directories.configDirectory,
    stateDirectory: directories.stateDirectory,
    counts: { profiles: listing.profiles.length, projects: projects.length, launches: launches.length, runs: runs.length },
  };
}

export async function getProfiles(directories: UiDirectories): Promise<ProfilesResponse> {
  const listing = await createProfileStore(directories.configDirectory).list();
  return {
    defaultProfile: listing.defaultProfile,
    profiles: listing.profiles.map((profile) => ({
      name: profile.name,
      provider: profile.provider ?? 'claude',
      model: profile.model,
      effort: profile.effort,
      source: profile.source ?? null,
      builtIn: Object.hasOwn(builtInProfiles, profile.name),
      isDefault: profile.name === listing.defaultProfile,
    })),
  };
}

export async function getGlobalSettings(directories: UiDirectories): Promise<GlobalSettingsResponse> {
  const settings = await createProfileStore(directories.configDirectory).getGlobalSettings();
  return { file: path.join(directories.configDirectory, 'profiles.json'), settings: { ...settings }, delegationGuidance };
}

export async function getProjects(directories: UiDirectories): Promise<ProjectsResponse> {
  return { projects: (await collectProjects(directories, new Map())).slice(0, LIST_LIMIT) };
}

/** Reads one settings file without throwing, so an invalid file becomes a message. */
async function readSettingsInfo(file: string): Promise<SettingsFileInfo & { parsed?: ProjectSettings }> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (isMissing(error)) return { path: file, exists: false, version: MISSING_VERSION, settings: {}, parsed: {} };
    return { path: file, exists: true, version: UNREADABLE_VERSION, settings: {}, error: 'The file could not be read.' };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { path: file, exists: true, version: UNREADABLE_VERSION, settings: {}, error: 'Settings must be a regular file, not a symlink or folder.' };
  if (info.size > MAX_SETTINGS_BYTES) return { path: file, exists: true, version: UNREADABLE_VERSION, settings: {}, error: 'The file is larger than 16 KiB.' };
  let value: unknown;
  let version = UNREADABLE_VERSION;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await handle.readFile('utf8');
      version = createHash('sha256').update(text).digest('hex');
      value = JSON.parse(text);
    } finally { await handle.close(); }
  } catch {
    return { path: file, exists: true, version, settings: {}, error: 'The file is not valid JSON.' };
  }
  const parsed = projectSettingsSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ');
    return { path: file, exists: true, version, settings: {}, error: `Invalid settings: ${issues}. Allowed keys: profile, filterLevel, filterMode, subagents, rules.` };
  }
  return { path: file, exists: true, version, settings: { ...parsed.data }, parsed: parsed.data };
}

// A file's version is a hash of its contents, so a save can tell that it changed.
const MISSING_VERSION = 'missing';
const UNREADABLE_VERSION = 'unreadable';

type SettingsInfo = Awaited<ReturnType<typeof readSettingsInfo>>;

/** The fingerprint of a project's rules and whether the user approved it. Null when a file is invalid. */
async function rulesApproval(directories: UiDirectories, root: string, shared: SettingsInfo, local: SettingsInfo): Promise<RulesApproval | null> {
  if (!shared.parsed || !local.parsed) return null;
  const fingerprint = projectRulesFingerprint(root, { shared: { path: shared.path, exists: shared.exists, settings: shared.parsed }, local: { path: local.path, exists: local.exists, settings: local.parsed } }) ?? null;
  let approved = false;
  try { approved = fingerprint !== null && await createProfileStore(directories.configDirectory).projectRulesApproved(root, fingerprint); }
  catch { approved = false; }
  return { fingerprint, approved };
}

async function effectiveSettings(directories: UiDirectories, root: string, shared: SettingsInfo, local: SettingsInfo): Promise<EffectiveSettings | null> {
  if (!shared.parsed || !local.parsed) return null;
  let global;
  try { global = await createProfileStore(directories.configDirectory).getGlobalSettings(); }
  catch { return null; }
  const approval = await rulesApproval(directories, root, shared, local);
  return resolveSettings({
    files: {
      shared: { path: shared.path, exists: shared.exists, settings: shared.parsed },
      local: { path: local.path, exists: local.exists, settings: local.parsed },
    },
    global,
    projectRulesApproved: approval?.approved ?? false,
  });
}

async function listInstructions(root: string): Promise<InstructionFile[]> {
  return Promise.all(INSTRUCTION_NAMES.map(async (name) => {
    const file = await instructionPath(root, name).catch(() => undefined);
    const info = file ? await lstat(file).catch(() => undefined) : undefined;
    return info?.isFile() ? { name, exists: true, bytes: info.size } : { name, exists: false, bytes: 0 };
  }));
}

/** The real path of an instruction file, refusing symlinks anywhere below the root. */
async function instructionPath(root: string, name: InstructionFile['name']): Promise<string> {
  const realRoot = await realpath(root);
  const expected = path.join(realRoot, name);
  const info = await lstat(expected);
  if (info.isSymbolicLink() || !info.isFile()) throw new ApiFailure(404, 'Instruction file not found.');
  if (await realpath(expected) !== expected) throw new ApiFailure(404, 'Instruction file not found.');
  return expected;
}

export async function getProject(directories: UiDirectories, rootQuery: string | null): Promise<ProjectDetail> {
  const cache: RootCache = new Map();
  return projectDetail(directories, cache, await knownRoot(directories, cache, rootQuery));
}

async function projectDetail(directories: UiDirectories, cache: RootCache, root: string): Promise<ProjectDetail> {
  const [shared, local, launches, runs] = await Promise.all([
    readSettingsInfo(path.join(root, SHARED_SETTINGS_FILE)),
    readSettingsInfo(path.join(root, LOCAL_SETTINGS_FILE)),
    loadLaunches(directories.stateDirectory, cache),
    loadRuns(directories.stateDirectory),
  ]);
  const totals = emptyTotals();
  for (const launch of launches) {
    if (launch.projectRoot === root) addTotals(totals, await loadDecisions(launch.directory));
  }
  for (const run of runs) {
    if (await projectRootOf(cache, run.cwd) === root) addTotals(totals, run.filters);
  }
  const strip = ({ parsed: _parsed, ...info }: Awaited<ReturnType<typeof readSettingsInfo>>): SettingsFileInfo => info;
  return {
    root,
    name: path.basename(root) || root,
    shared: strip(shared),
    local: strip(local),
    effective: await effectiveSettings(directories, root, shared, local),
    rulesApproval: await rulesApproval(directories, root, shared, local),
    instructions: await listInstructions(root),
    totals,
  };
}

export async function getInstruction(directories: UiDirectories, rootQuery: string | null, nameQuery: string | null): Promise<InstructionContent> {
  const name = INSTRUCTION_NAMES.find((candidate) => candidate === nameQuery);
  if (!name) throw new ApiFailure(400, `The name must be one of: ${INSTRUCTION_NAMES.join(', ')}.`);
  const root = await knownRoot(directories, new Map(), rootQuery);
  const file = await instructionPath(root, name).catch((error: unknown) => {
    throw error instanceof ApiFailure ? error : new ApiFailure(404, 'Instruction file not found.');
  });
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ApiFailure(404, 'Instruction file not found.');
    const buffer = Buffer.alloc(Math.min(info.size, MAX_INSTRUCTION_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { name, text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: info.size > MAX_INSTRUCTION_BYTES };
  } finally {
    await handle.close();
  }
}

export async function getLaunches(directories: UiDirectories, rootQuery: string | null): Promise<LaunchesResponse> {
  const cache: RootCache = new Map();
  const root = rootQuery === null ? undefined : await knownRoot(directories, cache, rootQuery);
  const launches = (await loadLaunches(directories.stateDirectory, cache))
    .filter((launch) => root === undefined || launch.projectRoot === root)
    .slice(0, LIST_LIMIT);
  return { launches: await Promise.all(launches.map((launch) => launchSummary(launch))) };
}

function checkId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) throw new ApiFailure(400, `Invalid ${label} ID.`);
}

async function findLaunch(directories: UiDirectories, launchId: string): Promise<StoredLaunch> {
  checkId(launchId, 'launch');
  try {
    const { record, directory } = await readStoredLaunch(directories.stateDirectory, launchId);
    return { record, directory, projectRoot: await projectRootOf(new Map(), record.cwd) };
  } catch {
    throw new ApiFailure(404, 'Launch not found.');
  }
}

export async function getLaunch(directories: UiDirectories, launchId: string): Promise<LaunchDetail> {
  const launch = await findLaunch(directories, launchId);
  const decisions = await loadDecisions(launch.directory);
  return { launch: await launchSummary(launch, decisions), decisions: decisions.slice(0, LIST_LIMIT) };
}

export async function getArtifact(directories: UiDirectories, launchId: string, artifactId: string, offset: number, limit: number): Promise<ArtifactSliceResponse> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiFailure(400, 'The offset must be a whole number of at least 0.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SLICE) throw new ApiFailure(400, `The limit must be between 1 and ${MAX_SLICE}.`);
  checkId(artifactId, 'artifact');
  const launch = await findLaunch(directories, launchId);
  // The artifact store creates its folder on first use. Check first so a read never writes.
  const folder = await lstat(path.join(launch.directory, 'artifacts')).catch(() => undefined);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) throw new ApiFailure(404, 'Artifact not found.');
  let slice;
  try {
    slice = await readNativeOutput(launchId, artifactId.toLowerCase(), { offset, limit }, directories.stateDirectory);
  } catch (error) {
    if (error instanceof Error && error.message === 'Artifact offset exceeds length') throw new ApiFailure(400, 'The offset is past the end of the artifact.');
    throw new ApiFailure(404, 'Artifact not found.');
  }
  return { launchId, artifactId: slice.id, offset: slice.offset, text: slice.text, nextOffset: slice.nextOffset, totalCharacters: slice.totalCharacters };
}

export async function getRuns(directories: UiDirectories, rootQuery: string | null): Promise<RunsResponse> {
  const cache: RootCache = new Map();
  const root = rootQuery === null ? undefined : await knownRoot(directories, cache, rootQuery);
  const summaries: RunSummary[] = [];
  for (const run of await loadRuns(directories.stateDirectory)) {
    const summary = await runSummary(run, cache);
    if (root === undefined || summary.projectRoot === root) summaries.push(summary);
    if (summaries.length === LIST_LIMIT) break;
  }
  return { runs: summaries };
}

// ---------------------------------------------------------------------------
// Changes

const execute = promisify(execFile);
const MAX_TEST_COMMAND = 2000;
const MAX_TEST_STDOUT = 200_000;
/** The test bench archives nothing, so its store hands out one fixed, valid ID. */
const TEST_ARTIFACT_ID = '00000000-0000-4000-8000-000000000000';

interface ZodLikeError { issues: Array<{ path: PropertyKey[]; message: string }> }

function isZodError(error: unknown): error is ZodLikeError {
  return error instanceof Error && error.name === 'ZodError' && Array.isArray((error as Partial<ZodLikeError>).issues);
}

/** A short, safe summary of validation issues: field names and messages only. */
function describeIssues(error: ZodLikeError): string {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || 'value'}: ${issue.message}`).join('; ');
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiFailure(400, `Invalid request: ${describeIssues(parsed.error)}.`);
  return parsed.data;
}

// Profile store messages that describe a refused change and contain no paths.
const PROFILE_REFUSALS = [/^Profile already exists: /, /^Built-in profile .+ is immutable$/, /^Cannot delete the current default profile: /, /^Unknown profile: /, /^At most 100 custom profiles/, /^Profile configuration exceeds 128 KiB$/];

/** Turns store failures into 400s with their message, and a busy lock into a 409. */
async function profileChange<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    if (isZodError(error)) throw new ApiFailure(400, `Invalid profile: ${describeIssues(error)}.`);
    if (error instanceof Error && PROFILE_REFUSALS.some((pattern) => pattern.test(error.message))) throw new ApiFailure(400, error.message);
    if (error instanceof Error && error.message.startsWith('Profile configuration is busy')) throw new ApiFailure(409, 'Profile configuration is busy. Try again in a moment.');
    throw error;
  }
}

const globalSettingChangeSchema = z.object({
  key: z.enum(['profile', 'filterLevel', 'filterMode', 'subagents']),
  value: z.string().max(128).nullable(),
}).strict();

export async function putGlobalSetting(directories: UiDirectories, body: unknown): Promise<GlobalSettingsResponse> {
  const change = parseBody(globalSettingChangeSchema, body);
  const store = createProfileStore(directories.configDirectory);
  await profileChange(() => change.value === null ? store.unsetGlobalSetting(change.key) : store.setGlobalSetting(change.key, change.value));
  return getGlobalSettings(directories);
}

export async function putGlobalRules(directories: UiDirectories, body: unknown): Promise<GlobalSettingsResponse> {
  const { rules } = parseBody(z.object({ rules: filterRulesSchema }).strict(), body);
  await profileChange(() => createProfileStore(directories.configDirectory).setGlobalRules(rules));
  return getGlobalSettings(directories);
}

const projectSettingsChangeSchema = z.object({
  root: z.string(),
  scope: z.enum(['shared', 'local']),
  /** The file's version when the page loaded. */
  version: z.string().min(1).max(64),
  settings: projectSettingsSchema,
}).strict();

/** Exit code 1 from `git check-ignore` means the file is not ignored. */
async function notIgnoredByGit(root: string, file: string): Promise<boolean> {
  try {
    await execute('git', ['check-ignore', '-q', file], { cwd: root, timeout: 5000 });
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === 1;
  }
}

export async function putProjectSettings(directories: UiDirectories, body: unknown): Promise<ProjectDetailWithWarning> {
  const change = parseBody(projectSettingsChangeSchema, body);
  const cache: RootCache = new Map();
  const root = await knownRoot(directories, cache, change.root);
  // Rules the user writes here are their own. Keep the project's rules approved
  // only when they already were (or there were none), so a write never
  // approves rules someone else committed.
  const beforeShared = await readSettingsInfo(path.join(root, SHARED_SETTINGS_FILE));
  const beforeLocal = await readSettingsInfo(path.join(root, LOCAL_SETTINGS_FILE));
  // Refuse to overwrite a file that changed since the page loaded, for
  // example after a pull, a branch switch or an agent's edit.
  if ((change.scope === 'shared' ? beforeShared : beforeLocal).version !== change.version) {
    throw new ApiFailure(409, `${change.scope === 'shared' ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE} changed since this page loaded. Reload the page to see the new contents, then make your change again.`);
  }
  const before = await rulesApproval(directories, root, beforeShared, beforeLocal);
  const keepApproved = before !== null && (before.fingerprint === null || before.approved);
  // The rules this save should produce. Approval only carries over when the
  // files on disk afterwards match exactly, so rules that arrive meanwhile
  // (a pull, a checkout, an agent) are never approved unseen.
  const info = (settings: ProjectSettings | undefined, file: string) => ({ path: path.join(root, file), exists: true, settings: settings ?? {} });
  const expected = projectRulesFingerprint(root, {
    shared: info(change.scope === 'shared' ? change.settings : beforeShared.parsed, SHARED_SETTINGS_FILE),
    local: info(change.scope === 'local' ? change.settings : beforeLocal.parsed, LOCAL_SETTINGS_FILE),
  });
  let written: string;
  try {
    written = await writeProjectSettings(root, change.scope, change.settings);
  } catch (error) {
    if (isZodError(error)) throw new ApiFailure(400, `Invalid settings: ${describeIssues(error)}.`);
    // These messages only name files inside the project.
    if (error instanceof Error && /^(Refusing to replace|Project directory does not exist|Expected a folder at|Fonn settings would be larger)/.test(error.message)) throw new ApiFailure(400, error.message);
    throw error;
  }
  let detail: ProjectDetailWithWarning = await projectDetail(directories, cache, root);
  if (keepApproved && detail.rulesApproval?.fingerprint && detail.rulesApproval.fingerprint === expected && !detail.rulesApproval.approved) {
    await profileChange(() => createProfileStore(directories.configDirectory).approveProjectRules(root, detail.rulesApproval!.fingerprint));
    detail = await projectDetail(directories, cache, root);
  }
  if (change.scope === 'local' && Object.keys(change.settings).length > 0 && await notIgnoredByGit(root, written)) {
    detail.warning = `${LOCAL_SETTINGS_FILE} is not ignored by Git. Add .fonn/ to .gitignore to keep personal settings out of commits.`;
  }
  // Remember it, so it stays on the Projects page before any agent works in it.
  // The save already succeeded, so a failure here only costs that convenience.
  await rememberProject(directories.configDirectory, root).catch(() => undefined);
  return detail;
}

/** DELETE /api/projects/remembered?root=: Fonn forgets a project you saved settings for. Nothing in the project changes. */
export async function deleteRememberedProject(directories: UiDirectories, root: string | null): Promise<ProjectsResponse> {
  if (!root || root.includes('\0') || !path.isAbsolute(root)) throw new ApiFailure(400, 'The root must be an absolute path.');
  if (!await forgetProject(directories.configDirectory, root).catch(() => { throw new ApiFailure(400, 'Fonn could not update its list of projects.'); })) {
    throw new ApiFailure(404, 'Fonn does not remember that project.');
  }
  return getProjects(directories);
}

const rulesApprovalChangeSchema = z.object({ root: z.string(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable() }).strict();

/** Approves the project's current rules (the fingerprint must match them) or withdraws approval with null. */
export async function putRulesApproval(directories: UiDirectories, body: unknown): Promise<ProjectDetail> {
  const change = parseBody(rulesApprovalChangeSchema, body);
  const cache: RootCache = new Map();
  const root = await knownRoot(directories, cache, change.root);
  if (change.fingerprint !== null) {
    const current = await rulesApproval(directories, root,
      await readSettingsInfo(path.join(root, SHARED_SETTINGS_FILE)), await readSettingsInfo(path.join(root, LOCAL_SETTINGS_FILE)));
    if (current?.fingerprint !== change.fingerprint) throw new ApiFailure(409, 'The project rules changed since this page loaded. Review them again before approving.');
  }
  await profileChange(() => createProfileStore(directories.configDirectory).approveProjectRules(root, change.fingerprint));
  return projectDetail(directories, cache, root);
}

const profileCreateSchema = z.object({ name: z.string(), provider: providerSchema, model: z.string(), effort: effortSchema, source: modelSourceSchema.optional() }).strict();
const profileEditSchema = z.object({ provider: providerSchema.optional(), model: modelTextSchema.optional(), effort: effortSchema.optional(), source: modelSourceSchema.nullable().optional() }).strict()
  .refine((edit) => Object.keys(edit).length > 0, 'Change at least one of provider, model, effort or source');

export async function postProfile(directories: UiDirectories, body: unknown): Promise<ProfilesResponse> {
  const profile = parseBody(profileCreateSchema, body);
  await profileChange(() => createProfileStore(directories.configDirectory).create(profile));
  return getProfiles(directories);
}

export async function putProfile(directories: UiDirectories, name: string, body: unknown): Promise<ProfilesResponse> {
  const edit = parseBody(profileEditSchema, body);
  await profileChange(() => createProfileStore(directories.configDirectory).edit(name, edit));
  return getProfiles(directories);
}

export async function deleteProfile(directories: UiDirectories, name: string): Promise<ProfilesResponse> {
  await profileChange(() => createProfileStore(directories.configDirectory).delete(name));
  return getProfiles(directories);
}

const filterTestSchema = z.object({
  command: z.string().min(1).max(MAX_TEST_COMMAND),
  stdout: z.string().max(MAX_TEST_STDOUT),
  root: z.string().optional(),
  mode: z.enum(['filter', 'observe', 'off']).optional(),
  level: z.enum(['strict', 'standard', 'similar']).optional(),
  rules: filterRulesSchema.optional(),
  /** The rule builder's preview: show what the rules remove even from output too short for Fonn to shorten. */
  anySize: z.boolean().optional(),
}).strict();

/** The settings a test runs with: a project's effective values, otherwise the global ones. */
async function testSettings(directories: UiDirectories, root: string | undefined) {
  if (root !== undefined) {
    const cache: RootCache = new Map();
    const resolved = await knownRoot(directories, cache, root);
    const [shared, local] = await Promise.all([
      readSettingsInfo(path.join(resolved, SHARED_SETTINGS_FILE)),
      readSettingsInfo(path.join(resolved, LOCAL_SETTINGS_FILE)),
    ]);
    const effective = await effectiveSettings(directories, resolved, shared, local);
    if (!effective) throw new ApiFailure(400, 'The project settings are invalid. Fix them before testing.');
    return { mode: effective.filterMode.value, level: effective.filterLevel.value, rules: effective.rules.map(({ source: _source, ...rule }) => rule) };
  }
  const global = await createProfileStore(directories.configDirectory).getGlobalSettings();
  return { mode: global.filterMode ?? 'filter', level: global.filterLevel ?? 'standard', rules: global.rules ?? [] };
}

export async function postFilterTest(directories: UiDirectories, body: unknown): Promise<FilterTestResult> {
  const input = parseBody(filterTestSchema, body);
  const base = await testSettings(directories, input.root);
  const mode = input.mode ?? base.mode;
  const level = input.level ?? base.level;
  const rules: FilterRule[] = input.rules ?? base.rules;
  const store: ArtifactStore = {
    async save(artifact) {
      return { id: TEST_ARTIFACT_ID, createdAt: new Date().toISOString(), characters: JSON.stringify(artifact.response).length };
    },
    async read() {
      throw new Error('The test bench stores nothing.');
    },
  };
  if (input.anySize) {
    // The rule builder's preview: what the rules and adapters remove, at any size, without archiving or a footer.
    // Real sessions still only shorten output over the size limits, which the builder says.
    const reduction = mode === 'filter' ? reduceRecognizedOutput({ command: input.command }, input.stdout, { level, rules }) : undefined;
    const delivered = reduction?.text ?? input.stdout;
    const changed = delivered !== input.stdout;
    return {
      mode,
      level,
      rules,
      decision: { status: changed ? 'filtered' : 'unchanged', reason: changed ? 'safe_reduction' : 'no_safe_reduction', adapter: reduction?.adapter ?? null, artifactId: null, originalCharacters: input.stdout.length, deliveredCharacters: delivered.length, removedLines: reduction?.removedLines ?? 0 },
      delivered,
    };
  }
  const filter = createOutputFilter({ store, mode, level, rules, recoveryHint: (id) => `fonn native-output <launch-id> ${id}` });
  const response = { stdout: input.stdout, stderr: '', interrupted: false, isImage: false };
  const outcome = await filter.apply({ toolName: 'Bash', toolInput: { command: input.command }, response, sessionId: 'fonn-ui-test', toolUseId: 'fonn-ui-test', cwd: '/' });
  const delivered = outcome.response as { stdout?: unknown };
  const { status, reason, adapter, originalCharacters, deliveredCharacters, removedLines } = outcome.decision;
  return {
    mode,
    level,
    rules,
    // Nothing was archived, so no artifact can be recovered.
    decision: { status, reason, adapter: adapter ?? null, artifactId: null, originalCharacters, deliveredCharacters, removedLines },
    delivered: typeof delivered.stdout === 'string' ? delivered.stdout : input.stdout,
  };
}

/** A real folder that is not a symlink, checked without following the last component. */
async function realFolder(folder: string): Promise<boolean> {
  const info = await lstat(folder).catch(() => undefined);
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink();
}

export async function deleteLaunch(directories: UiDirectories, launchId: string, confirmRunning = false): Promise<LaunchDeleted> {
  checkId(launchId, 'launch');
  const state = path.resolve(directories.stateDirectory);
  const native = path.join(state, 'native');
  const target = path.join(native, launchId);
  for (const folder of [state, native]) {
    if (!(await realFolder(folder))) throw new ApiFailure(404, 'Launch not found.');
  }
  const info = await lstat(target).catch(() => undefined);
  if (!info) throw new ApiFailure(404, 'Launch not found.');
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ApiFailure(400, 'The launch folder is not a real folder, so it was not removed.');
  // A launch without a recorded finish may still be running, or may have
  // crashed. Removing a running launch's records breaks its recovery footers,
  // so that needs an explicit confirmation.
  if (!confirmRunning) {
    const record = await readFile(path.join(target, 'launch.json'), 'utf8').then((text) => JSON.parse(text) as { finishedAt?: string; origin?: string }).catch(() => undefined);
    // An unreadable record says nothing about whether it finished, so it needs confirming too.
    // A hook session never records a finish, and deleting its records while it
    // is open is harmless: its next command starts a new record.
    if (!record?.finishedAt && record?.origin !== 'hook') throw new ApiFailure(409, 'This launch has no recorded finish, so it may still be running. Confirm to delete it anyway.');
  }
  // rm does not follow symlinks inside the folder, so only this launch is removed.
  await rm(target, { recursive: true });
  return { deleted: launchId };
}

const cleanupSchema = z.object({ olderThanDays: z.number().int().min(1).max(3650), confirm: z.boolean() }).strict();

/**
 * POST /api/records/cleanup. Without confirm it only counts what would go;
 * with confirm it deletes those records, keeping any that became active.
 */
export async function postRecordsCleanup(directories: UiDirectories, body: unknown): Promise<RecordsCleanup> {
  const request = parseBody(cleanupSchema, body);
  const { deleteOldRecords, findOldRecords } = await import('../native/cleanup.js');
  const summary = await findOldRecords(request.olderThanDays, directories.stateDirectory);
  const counts = {
    olderThanDays: request.olderThanDays,
    records: summary.records.length,
    hookSessions: summary.records.filter((record) => record.origin === 'hook').length,
    bytes: summary.bytes,
    oldest: summary.records[0]?.lastActivity ?? null,
  };
  if (!request.confirm) return { ...counts, deleted: 0, kept: 0 };
  const result = await deleteOldRecords(summary, directories.stateDirectory);
  return { ...counts, deleted: result.deleted.length, kept: result.kept.length };
}

/** The hook dependency is injectable so HTTP tests never read user agent settings. */
export interface UiHooks {
  hookStatus(options?: HookOptions): Promise<HookStatus[]>;
  planHook(agent: HookAgent, action: HookPlan['action'], options?: HookOptions): Promise<HookPlan>;
  applyHookPlan(plan: HookPlan, options?: HookOptions): Promise<HookStatus>;
  /** Which file a plan was made for; part of the fingerprint apply checks. */
  planIdentity(plan: HookPlan): string;
  /** A copy of a config with likely secrets hidden, for showing only. */
  redactForDisplay(text: string, agent: HookAgent): string | null;
}

function hookAgent(agent: string): HookAgent {
  if (!HOOK_AGENTS.includes(agent as HookAgent)) throw new ApiFailure(404, 'Agent not found.');
  return agent as HookAgent;
}

async function hookRequest<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (error instanceof Error && (error.name === 'HookConflictError' || error.constructor.name === 'HookConflictError')) {
      throw new ApiFailure(409, 'The file changed. Review the new version.');
    }
    // Fonn's own config errors are written to be shown: they name the file and
    // the next step, never its contents. Anything else may carry private data.
    if (error instanceof Error && error.name === 'HookConfigError') throw new ApiFailure(400, error.message);
    if (error instanceof Error && /^Build fonn first/.test(error.message)) throw new ApiFailure(400, 'Build Fonn first with npm run build, then try again.');
    if (error instanceof Error) throw new ApiFailure(400, 'The hook settings could not be updated or read. Check the agent configuration and file permissions.');
    throw error;
  }
}

export function getHooks(directories: UiDirectories, hooks: UiHooks): Promise<HookStatus[]> {
  return hookRequest(() => hooks.hookStatus(directories));
}

/** The fingerprint apply compares, so the browser never has to send the file back. */
export const fingerprint = (text: string | null): string => (text === null ? 'missing' : createHash('sha256').update(text).digest('hex'));

/**
 * What would be written: the new content and any extra files. Apply refuses
 * when it differs from the plan the user reviewed, for example after a
 * Homebrew update moved the command between preview and click.
 */
export const afterFingerprint = (plan: Pick<HookPlan, 'after' | 'files'>): string => fingerprint(JSON.stringify([plan.after, plan.files]));

/**
 * The file as it was when planned: its content and which file it is. Apply
 * refuses when either changed, so a symlink pointed at another file with the
 * same bytes is caught too. `identity` comes from the hooks module's
 * planIdentity on the plan planHook returned.
 */
export const beforeFingerprint = (plan: Pick<HookPlan, 'before'>, identity: string): string => fingerprint(JSON.stringify([plan.before, identity]));

export function getHookPlan(directories: UiDirectories, hooks: UiHooks, agent: string, action: unknown): Promise<HookPlanResponse> {
  const validatedAgent = hookAgent(agent);
  const validatedAction = parseBody(z.enum(['install', 'uninstall']), action);
  return hookRequest(async () => {
    const plan = await hooks.planHook(validatedAgent, validatedAction, directories);
    // The browser only shows the plan, so it gets copies with likely secrets
    // hidden. The fingerprints come from the real contents, which apply checks.
    const shown = (text: string | null) => (text === null ? null : hooks.redactForDisplay(text, validatedAgent));
    return { ...plan, before: shown(plan.before), after: shown(plan.after), beforeHash: beforeFingerprint(plan, hooks.planIdentity(plan)), afterHash: afterFingerprint(plan) };
  });
}

export async function postHookApply(directories: UiDirectories, hooks: UiHooks, agent: string, body: unknown): Promise<HookStatus> {
  const validatedAgent = hookAgent(agent);
  const change = parseBody(z.object({
    action: z.enum(['install', 'uninstall']),
    beforeHash: z.string().regex(/^(?:[0-9a-f]{64}|missing)$/),
    afterHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(), body);
  return hookRequest(async () => {
    const plan = await hooks.planHook(validatedAgent, change.action, directories);
    if (beforeFingerprint(plan, hooks.planIdentity(plan)) !== change.beforeHash) throw new ApiFailure(409, 'The file changed. Review the new version.');
    if (afterFingerprint(plan) !== change.afterHash) throw new ApiFailure(409, 'The change Fonn would make is different now, for example after an update. Review the new version.');
    return hooks.applyHookPlan(plan, directories);
  });
}
