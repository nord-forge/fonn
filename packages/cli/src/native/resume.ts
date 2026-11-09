import { launchCodex } from './codex.js';
import { launchClaude } from './index.js';
import { readNativeSession } from './session.js';
import { readLaunch } from './storage.js';

/** Replays the saved project, profile and filtering while preserving native policy. */
export async function resumeNativeLaunch(launchId: string, options: { stateDirectory?: string; executable?: string; hookEntrypoint?: string } = {}): Promise<number> {
  const { root, record } = await readLaunch(options.stateDirectory, launchId);
  const sessionId = await readNativeSession(root, launchId);
  const provider = record.provider ?? record.profileSnapshot?.provider ?? 'claude';
  const launch = provider === 'codex' ? launchCodex : launchClaude;
  return launch({
    cwd: record.cwd,
    profile: record.profile,
    ...(record.profileSnapshot === undefined ? {} : { profileSnapshot: record.profileSnapshot }),
    filterMode: record.filterMode,
    // Legacy launches keep their original behavior rather than opting in on replay.
    subagents: record.subagents ?? 'off',
    stateDirectory: root,
    resume: sessionId ?? true,
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    ...(options.hookEntrypoint === undefined ? {} : { hookEntrypoint: options.hookEntrypoint }),
  });
}
