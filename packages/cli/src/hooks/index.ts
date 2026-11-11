// Fonn's global hooks. See contract.ts for the shapes and the rules.
export { HOOK_AGENTS, HOOK_AGENT_LABELS } from './contract.js';
export type { HookAgent, HookOptions, HookPlan, HookSessionRecord, HookStatus } from './contract.js';
export { applyHookPlan, HookConfigError, HookConflictError, hookStatus, hookWarnings, planHook, planIdentity } from './config.js';
export { baseCommand, hookOwnership, isFonnHookCommand } from './command.js';
export { compactDiff } from './diff.js';
export { redactForDisplay } from './redact.js';
export type { HookRuntimeOptions } from './command.js';
export { hookSessionId, runHook } from './run.js';
