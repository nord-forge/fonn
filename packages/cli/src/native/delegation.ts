import type { ProfileProvider } from '@nord-forge/fonn-core/contracts';
import { readLaunch } from './storage.js';

const delegationGuidance = `Use built-in native subagents proactively for meaningful, independent scoped work; handle trivial tasks directly. Aim for at most two workers and one level of delegation. Use read-only workers for exploration/review; give builders disjoint files and retain normal approvals. Verify concise handoffs with findings, changed files, checks, and blockers. Tell native workers to retain this session's Fonn filter mode and bounded recovery, regardless of model. Respect all stricter user, project, managed, and provider policies. Never spawn headless fonn, claude, or codex subprocess workers, or widen permissions/allowlists to retry rejected delegation. If delegation is unavailable or rejected, continue in the parent or report the blocker.`;

/** Adds parent delegation guidance or a worker's session-wide filtering notice. */
export async function nativeDelegationContext(event: unknown, stateDirectory: string, launchId: string, provider: ProfileProvider): Promise<unknown> {
  if (typeof event !== 'object' || event === null) return {};
  const input = event as Record<string, unknown>;
  if (input.hook_event_name !== 'SessionStart' && input.hook_event_name !== 'SubagentStart') return {};
  if (input.hook_event_name === 'SessionStart' && ['agent_id', 'parent_session_id', 'parent_agent_id', 'subagent_type'].some(key => Object.hasOwn(input, key))) return {};
  const { record } = await readLaunch(stateDirectory, launchId);
  if ((record.provider ?? record.profileSnapshot?.provider ?? 'claude') !== provider) return {};
  if (input.hook_event_name === 'SubagentStart') {
    if (record.filterMode === 'off') return {};
    return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `Fonn filtering mode: ${record.filterMode}. Session-wide Fonn hooks apply to every native worker and model. Keep these hooks enabled; use the bounded native-output recovery command in shortened observations when full originals are needed. Do not disable filtering, start external/headless workers, or delegate further. Respect all stricter policies and normal approvals.` } };
  }
  if (record.subagents !== 'auto') return {};
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: delegationGuidance } };
}
