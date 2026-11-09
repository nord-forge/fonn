import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ProfileProvider, TaskProfile } from '@nord-forge/fonn-core/contracts';
import { providerSchema, resolveProfileForProvider, taskProfileSchema } from '@nord-forge/fonn-core/profiles';
import { getDefaultStateDirectory } from '@nord-forge/fonn-core/state';
import { atomicJson, readLaunch, shellQuote } from './storage.js';
import type { LaunchRecord, NativeLaunchOptions } from './storage.js';

const maximumSessionBytes = 4096;
const sessionIdSchema = z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine(id => id === id.trim(), 'Invalid native session ID');
const sessionSchema = z.object({
  schemaVersion: z.literal(1),
  launchId: z.string(),
  provider: providerSchema,
  sessionId: sessionIdSchema,
}).strict();

function launchProvider(record: LaunchRecord): ProfileProvider {
  return record.provider ?? record.profileSnapshot?.provider ?? 'claude';
}

/** Records only the documented session identifier supplied by lifecycle hooks. */
export async function captureNativeSession(event: unknown, stateDirectory: string, launchId: string, provider: ProfileProvider): Promise<void> {
  providerSchema.parse(provider);
  if (typeof event !== 'object' || event === null) return;
  const input = event as Record<string, unknown>;
  if (input.hook_event_name !== 'SessionStart' && input.hook_event_name !== 'SessionEnd') return;
  // Never let explicit child lifecycle metadata replace the parent's resume ID.
  if (['agent_id', 'parent_session_id', 'parent_agent_id', 'subagent_type'].some(key => Object.hasOwn(input, key))) return;
  const sessionId = sessionIdSchema.safeParse(input.session_id);
  if (!sessionId.success) return;
  const location = await readLaunch(stateDirectory, launchId);
  if (location.record.filterMode === 'off' || launchProvider(location.record) !== provider) return;
  await atomicJson(path.join(location.directory, 'session.json'), {
    schemaVersion: 1, launchId, provider, sessionId: sessionId.data,
  });
}

/** Missing tracking falls back to the provider picker; malformed tracking fails closed. */
export async function readNativeSession(stateDirectory: string | undefined, launchId: string): Promise<string | undefined> {
  const location = await readLaunch(stateDirectory, launchId);
  let file;
  try {
    file = await open(path.join(location.directory, 'session.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumSessionBytes) throw new Error('Invalid native session metadata.');
    const buffer = Buffer.alloc(maximumSessionBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumSessionBytes) throw new Error('Invalid native session metadata.');
    const session = sessionSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    if (session.launchId !== launchId || session.provider !== launchProvider(location.record)) {
      throw new Error('Native session metadata does not match its launch.');
    }
    return session.sessionId;
  } catch {
    throw new Error('Invalid native session metadata.');
  } finally {
    await file.close();
  }
}

/** Replay uses the saved profile without consulting a changed or removed registry. */
export async function resolveNativeProfile(options: NativeLaunchOptions, provider: ProfileProvider): Promise<TaskProfile> {
  providerSchema.parse(provider);
  if (options.profileSnapshot === undefined) return resolveProfileForProvider(provider, options.profile, options.configDirectory);
  const profile = taskProfileSchema.parse(options.profileSnapshot);
  if ((profile.provider ?? 'claude') !== provider || (options.profile !== undefined && options.profile !== profile.name)) {
    throw new Error('Native profile snapshot does not match the launch profile and provider.');
  }
  return Object.freeze(profile);
}

export function nativeResumeArguments(provider: ProfileProvider, resume: string | true | undefined): string[] {
  providerSchema.parse(provider);
  if (resume === undefined) return [];
  const command = provider === 'claude' ? '--resume' : 'resume';
  return resume === true ? [command] : [command, sessionIdSchema.parse(resume)];
}

function persistentLaunch(args: string[]): boolean {
  const nonpersistent = new Set([
    '--help', '-h', '--version', '-v', '-V', '--print', '-p', '--no-session-persistence',
    '--bare', '--init-only', '--maintenance', '--setup-only', '--remote', '--remote-control',
    '--teleport', '--web', '--desktop', '--cloud', '--background', '--bg',
  ]);
  for (const argument of args) {
    if (argument === '--') break;
    if (nonpersistent.has(argument.split('=', 1)[0]) || argument === 'help') return false;
  }
  return true;
}

/** The footer is best effort and must never change the native process's exit status. */
export async function printNativeResumeHint(record: LaunchRecord, stateDir: string, args: string[], exitCode: number): Promise<void> {
  if (!persistentLaunch(args)) return;
  try {
    const location = await readLaunch(stateDir, record.launchId);
    const sessionId = await readNativeSession(location.root, record.launchId);
    if (sessionId === undefined && ![0, 130, 143].includes(exitCode)) return;
    const defaultPath = path.resolve(getDefaultStateDirectory());
    const defaultRoot = await realpath(defaultPath).catch(() => defaultPath);
    // Shell quoting preserves paths, but raw terminal controls are unsafe in a footer.
    if (/[\x00-\x1f\x7f-\x9f]/.test(location.root)) return;
    const stateFlag = location.root === defaultRoot ? '' : ` --state-dir ${shellQuote(location.root)}`;
    const label = sessionId === undefined ? 'Choose a session to resume with Fonn:' : 'Resume with Fonn:';
    process.stderr.write(`${label}\n  fonn resume ${location.record.launchId}${stateFlag}\n`);
  } catch {
    // Corrupt/unavailable state must not produce a broken recovery command.
  }
}
