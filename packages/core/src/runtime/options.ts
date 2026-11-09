import type { AgentDefinition, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ArtifactStore, OutputFilter, RunTaskOptions, TaskProfile } from '../contracts.js';
import { createRecoveryServer } from './recovery.js';
import { handoffSchema, taskResultJsonSchema } from '../schema.js';
import { z } from 'zod';

export interface BuildOptionsContext {
  options: Readonly<RunTaskOptions>;
  profile: Readonly<TaskProfile>;
  apiKey: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
  store: ArtifactStore;
  filter: OutputFilter;
  abortController: AbortController;
  resumeSessionId?: string;
  answerQuestions?: RunTaskOptions['answerQuestions'];
}

const agentNames = new Set(['explorer', 'reviewer']);
const delegationTools = new Set(['Agent', 'Task']);
const readonlyTools = ['Read', 'Grep', 'Glob'];
const questionInputSchema = z.object({ questions: z.array(z.object({
  question: z.string().trim().min(1), header: z.string().optional(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
})).min(1).max(4) });

function apiEnvironment(context: BuildOptionsContext): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...(context.environment ?? process.env), ANTHROPIC_API_KEY: context.apiKey };
  for (const name of [
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_API_KEY_FILE_DESCRIPTOR',
    'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_IDENTITY_TOKEN_FILE',
    'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE',
  ]) environment[name] = undefined;
  return environment;
}

function subagent(agent: 'explorer' | 'reviewer'): AgentDefinition {
  return {
    description: agent === 'explorer' ? 'Read-only repository exploration with concrete file evidence.' : 'Read-only review of a bounded proposed change with concrete file evidence.',
    prompt: `You are the ${agent}. Inspect only the assigned scope with Read, Grep and Glob. Never write, execute commands, delegate, or start background work. Return only one JSON object matching this evidence handoff schema: ${JSON.stringify(z.toJSONSchema(handoffSchema))}. Set agent to "${agent}". Give concrete paths and line numbers when available. Report uncertainty and checks you did not run; never invent evidence.`,
    tools: [...readonlyTools],
    disallowedTools: ['Agent', 'Task', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Skill', 'mcp__*'],
    model: agent === 'explorer' ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
    effort: 'medium', maxTurns: 6, background: false, permissionMode: 'default',
  };
}

/** Construct options without starting the SDK. Each call closes over one task's capabilities. */
export function buildSdkOptions(context: BuildOptionsContext): Options {
  const { options, profile, filter, store, abortController } = context;
  if (profile.provider === 'codex') throw new Error('The Claude SDK cannot run a Codex profile. Use the native Codex launcher.');
  const seenObservations = new Set<string>();
  const startedDelegations = new Set<string>();
  const activeDelegations = new Set<string>();
  const denied = (message: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: message } });
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    // Do not depend on the prompt or a caller approval to enforce subagent boundaries.
    if (input.agent_id && !readonlyTools.includes(input.tool_name)) return denied('Fonn subagents may only use Read, Grep, and Glob; nested delegation is disabled.');
    if (!delegationTools.has(input.tool_name)) return {};
    const value = input.tool_input as Record<string, unknown> | null;
    const name = value?.subagent_type;
    if (input.agent_id || typeof name !== 'string' || !agentNames.has(name) || value?.run_in_background === true || value?.resume !== undefined || value?.model !== undefined || value?.effort !== undefined || value?.isolation !== undefined || value?.mode !== undefined) {
      return denied('Only foreground explorer and reviewer agents with the fixed task-start configuration are supported.');
    }
    const id = input.tool_use_id;
    // A maximum of two launches in the task bounds concurrency even after failure/cancellation.
    if (!startedDelegations.has(id) && startedDelegations.size >= 2) return denied('This task has reached its limit of two bounded subagent launches.');
    if (!activeDelegations.has(id) && activeDelegations.size >= 2) return denied('At most two fonn subagents may run concurrently.');
    startedDelegations.add(id);
    activeDelegations.add(id);
    // AgentInput in this SDK defaults to background; force the foreground path explicitly.
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...value, run_in_background: false } } };
  };
  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    activeDelegations.delete(input.tool_use_id);
    const key = `${input.session_id}:${input.tool_use_id}`;
    if (seenObservations.has(key)) return {};
    seenObservations.add(key);
    // The core recognizes formats; an error or unknown shape retains the original observation.
    try {
      const outcome = await filter.apply({ toolName: input.tool_name, toolInput: input.tool_input, response: input.tool_response, sessionId: input.session_id, toolUseId: input.tool_use_id, cwd: input.cwd });
      if (outcome.decision.status !== 'filtered') return {};
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: outcome.response } };
    } catch { return {}; }
  };
  return {
    cwd: context.cwd,
    model: profile.model, effort: profile.effort,
    maxBudgetUsd: options.budgetUsd ?? 5, maxTurns: options.maxTurns ?? 20,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Use explorer and reviewer only for bounded read-only work, at most two launches total. Include their validated evidence handoffs in the final structured task result. Never claim a check passed without observed evidence. Tool-output filtering preserves originals in this task’s fonn read_output tool; use artifact IDs to recover bounded slices when details matter. SDK cost and budget figures are estimates, and requests can overshoot a stop threshold.' },
    permissionMode: 'default',
    disallowedTools: ['SendMessage', 'TeamCreate', 'TeamDelete'],
    // Explicit API key authentication only. Do not inspect or extract OAuth credentials.
    env: apiEnvironment(context),
    abortController,
    ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
    agents: { explorer: subagent('explorer'), reviewer: subagent('reviewer') },
    hooks: {
      PreToolUse: [{ hooks: [preToolUse], onFailure: 'block' }],
      PostToolUse: [{ hooks: [postToolUse] }],
      PostToolUseFailure: [{ hooks: [async (input) => { if (input.hook_event_name === 'PostToolUseFailure') activeDelegations.delete(input.tool_use_id); return {}; }] }],
    },
    mcpServers: { fonn: createRecoveryServer(store) },
    outputFormat: { type: 'json_schema', schema: taskResultJsonSchema },
    canUseTool: async (toolName, input, request) => {
      if (request.signal.aborted || abortController.signal.aborted) return { behavior: 'deny', message: 'Task cancelled.' };
      if (toolName === 'AskUserQuestion') {
        const answerQuestions = options.answerQuestions ?? context.answerQuestions;
        if (!answerQuestions) return { behavior: 'deny', message: 'This host has no question-answer callback. Leave the question unresolved and explain which answer is needed.' };
        try {
          const questions = questionInputSchema.parse(input).questions;
          if (new Set(questions.map((question) => question.question)).size !== questions.length) throw new Error('Duplicate question');
          const answers = await answerQuestions({ questions });
          if (answers && Object.keys(answers).length === questions.length && questions.every((question) => Object.hasOwn(answers, question.question) && typeof answers[question.question] === 'string' && answers[question.question]!.trim().length > 0 && answers[question.question]!.length <= 10_000) && !request.signal.aborted && !abortController.signal.aborted) return { behavior: 'allow', updatedInput: { ...input, answers } };
        } catch { /* A failing host cannot approve a question. */ }
        return { behavior: 'deny', message: 'No user answers were supplied.' };
      }
      if (!options.approveTool) return { behavior: 'deny', message: 'No approval callback is configured; tool permission denied.' };
      try {
        const approved = await options.approveTool({ toolName, input, reason: request.decisionReason });
        if (approved === true && !request.signal.aborted && !abortController.signal.aborted) return { behavior: 'allow', updatedInput: input };
      } catch { /* Fail closed when the caller cannot decide. */ }
      return { behavior: 'deny', message: 'The caller did not approve this tool request.' };
    },
  };
}
