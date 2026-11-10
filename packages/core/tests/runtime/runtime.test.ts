import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HookInput, Options, PermissionResult, SDKMessage, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { FilterDecision, RunTaskOptions, TaskResult } from '../../src/contracts.js';
import { createArtifactStore } from '../../src/filtering/index.js';
import { createRecoveryReader, createRuntime, createTaskRecoveryStore, getTaskArtifactDirectory, listRuns, readRun } from '../../src/runtime/index.js';
import { createProfileStore } from '../../src/profiles.js';
import { acquireResumeLock } from '../../src/runtime/resume-lock.js';

const valid: TaskResult = { summary: 'Inspected the fixture', changes: [], checks: [{ name: 'fixture', status: 'not_run', details: 'No external checks were run.' }], unresolved: [], handoffs: [] };
const secret = 'fixture-key-never-persist';
const session = randomUUID();
function result(cost = 1, changes: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result', subtype: 'success', session_id: session, is_error: false, total_cost_usd: cost,
    modelUsage: { fixture: { inputTokens: cost * 100, outputTokens: cost * 20, cacheReadInputTokens: cost * 40, cacheCreationInputTokens: cost * 10 } },
    usage: { input_tokens: 99999, output_tokens: 99999 }, structured_output: valid, ...changes,
  } as unknown as SDKMessage;
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fonn-runtime-'));
  return { root, options: { prompt: 'private prompt fixture', cwd: root, stateDirectory: join(root, 'state'), configDirectory: join(root, 'config') } satisfies RunTaskOptions, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function hook(options: Options, name: 'PreToolUse' | 'PostToolUse', input: Record<string, unknown>) {
  const callback = options.hooks?.[name]?.[0]?.hooks[0];
  assert.ok(callback);
  return await callback({ hook_event_name: name, session_id: session, transcript_path: '', cwd: '/', tool_use_id: 'tool-1', ...input } as HookInput, 'tool-1', { signal: new AbortController().signal }) as SyncHookJSONOutput;
}
async function permission(options: Options, name: string, input: Record<string, unknown>, request: { signal: AbortSignal; decisionReason?: string }): Promise<PermissionResult> {
  const decision = await options.canUseTool!(name, input, { ...request, toolUseID: 'fixture', requestId: 'fixture' });
  assert.ok(decision);
  return decision;
}

test('task defaults preserve policy, explicit auth, bounded readonly agents, and private records', async () => {
  const f = await fixture();
  try {
    let captured: Options | undefined;
    const runtime = createRuntime({ getApiKey: () => secret, environment: { PATH: '/fixture/bin', HOME: '/fixture/home', CLAUDE_CONFIG_DIR: '/fixture/policy', CUSTOM_TARGET_ENV: 'retained', CLAUDE_CODE_OAUTH_TOKEN: 'unsupported-oauth', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '90', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'unsupported-refresh', ANTHROPIC_AUTH_TOKEN: 'unsupported-bearer', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1', CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_USE_MANTLE: '1', ANTHROPIC_IDENTITY_TOKEN: 'unsupported-identity', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '91', ANTHROPIC_IDENTITY_TOKEN_FILE: '/unsupported/identity', CLAUDE_CODE_HOST_CREDS_FILE: '/unsupported/host', CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '92' }, query: async function* ({ options }) { captured = options; yield result(); } });
    const run = await runtime.runTask(f.options);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.profile.name, 'opus-medium');
    assert.equal(run.budgetUsd, 5); assert.equal(run.maxTurns, 20); assert.equal(run.filterMode, 'filter');
    assert.equal(captured?.model, 'claude-opus-5-5'); assert.equal(captured.effort, 'medium');
    assert.deepEqual(captured.settingSources, ['user', 'project', 'local']);
    assert.equal(captured.permissionMode, 'default');
    assert.equal(captured.allowedTools, undefined); assert.equal(captured.allowDangerouslySkipPermissions, undefined);
    assert.equal(captured.env?.ANTHROPIC_API_KEY, secret);
    assert.equal(captured.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(captured.env?.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(captured.env?.CLAUDE_CODE_USE_BEDROCK, undefined);
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_IDENTITY_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR']) assert.equal(captured.env?.[name], undefined);
    assert.equal(captured.env?.PATH, '/fixture/bin'); assert.equal(captured.env?.HOME, '/fixture/home');
    assert.equal(captured.env?.CLAUDE_CONFIG_DIR, '/fixture/policy'); assert.equal(captured.env?.CUSTOM_TARGET_ENV, 'retained');
    assert.equal(captured.outputFormat?.type, 'json_schema');
    assert.equal(typeof captured.systemPrompt, 'object');
    for (const agent of Object.values(captured.agents ?? {})) {
      assert.deepEqual(agent.tools, ['Read', 'Grep', 'Glob']); assert.equal(agent.maxTurns, 6); assert.equal(agent.effort, 'medium'); assert.ok(agent.model); assert.equal(agent.background, false);
    }
    assert.ok(captured.mcpServers?.fonn);
    assert.deepEqual(run.usage, { estimatedCostUsd: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10 });
    const path = join(f.options.stateDirectory, 'tasks', run.taskId, 'run.json');
    const content = await readFile(path, 'utf8');
    assert.ok(!content.includes(secret)); assert.ok(!content.includes(f.options.prompt));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.options.stateDirectory, 'tasks', run.taskId))).mode & 0o777, 0o700);
    assert.deepEqual(await readRun(run.taskId, f.options.stateDirectory), run);
    assert.deepEqual(await listRuns(f.options.stateDirectory), [run]);
  } finally { await f.cleanup(); }
});

test('all invalid inputs and missing explicit key fail before query without exposing secrets', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const runtime = createRuntime({ getApiKey: () => ' ', query: async function* () { calls++; yield result(); } });
    await assert.rejects(runtime.runTask(f.options), /ANTHROPIC_API_KEY/);
    for (const extra of [{ prompt: '' }, { budgetUsd: 0 }, { budgetUsd: Infinity }, { maxTurns: 0 }, { maxTurns: 1.2 }, { filterMode: 'unknown' }, { resumeTaskId: '../bad' }, { answerQuestions: true }]) {
      await assert.rejects(runtime.runTask({ ...f.options, ...extra } as RunTaskOptions), /Invalid task options/);
    }
    await assert.rejects(runtime.runTask({ ...f.options, profile: 'unknown' }), /Unknown profile/);
    await assert.rejects(runtime.runTask({ ...f.options, profile: 'codex:sol-medium' }), /Claude profiles only/);
    await assert.rejects(runtime.runTask({ ...f.options, cwd: join(f.root, 'absent') }));
    assert.equal(calls, 0);
    const failing = createRuntime({ getApiKey: () => secret, query: async function* () { throw new Error(`${secret} ${f.options.prompt}`); } });
    const run = await failing.runTask(f.options);
    assert.equal(run.status, 'failed');
    assert.ok(!JSON.stringify(run).includes(secret)); assert.ok(!JSON.stringify(run).includes(f.options.prompt));
  } finally { await f.cleanup(); }
});

test('prose and wrong-schema structured output never establish success', async () => {
  const f = await fixture();
  try {
    for (const structured_output of [undefined, { summary: 'Looks good' }, { ...valid, checks: [{ name: 'test', status: 'passed' }] }, { ...valid, handoffs: [{ agent: 'unknown' }] }]) {
      const runtime = createRuntime({ getApiKey: () => secret, query: async function* () { yield result(0.1, { structured_output, result: JSON.stringify(valid) }); } });
      const run = await runtime.runTask(f.options);
      assert.equal(run.status, 'failed'); assert.equal(run.result, undefined); assert.match(run.error ?? '', /structured TaskResult/);
    }
  } finally { await f.cleanup(); }
});

test('cumulative result snapshots are deduplicated and resume bills only same-session delta', async () => {
  const f = await fixture();
  try {
    const first = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(0.5); yield result(1); yield result(1); } }).runTask(f.options);
    assert.equal(first.usage.estimatedCostUsd, 1);
    let resume: string | undefined;
    const second = await createRuntime({ getApiKey: () => secret, query: async function* ({ options }) { resume = options.resume; yield result(1.5); yield result(2); } }).runTask({ ...f.options, resumeTaskId: first.taskId });
    assert.equal(resume, session); assert.equal(second.parentTaskId, first.taskId);
    assert.equal(second.usage.estimatedCostUsd, 1); assert.equal(second.usage.inputTokens, 100);
    const third = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(2.5); } }).runTask({ ...f.options, resumeTaskId: second.taskId });
    assert.equal(third.usage.estimatedCostUsd, 0.5); assert.equal(third.usage.inputTokens, 50);
    await assert.rejects(createRuntime({ getApiKey: () => secret }).runTask({ ...f.options, resumeTaskId: first.taskId }), /newer task records/);
    assert.equal((await listRuns(f.options.stateDirectory))[0]?.taskId, third.taskId);
  } finally { await f.cleanup(); }
});

test('zeroed error snapshots and thrown errors retain known spend including on resume', async () => {
  const f = await fixture();
  try {
    const first = await createRuntime({ getApiKey: () => secret, query: async function* () {
      yield result(0.5); yield result(0, { subtype: 'error_during_execution', is_error: true, structured_output: undefined });
    } }).runTask(f.options);
    assert.equal(first.status, 'failed'); assert.equal(first.usage.estimatedCostUsd, 0.5);
    const second = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(1); throw new Error('failure'); } }).runTask({ ...f.options, resumeTaskId: first.taskId });
    assert.equal(second.status, 'failed'); assert.equal(second.usage.estimatedCostUsd, 0.5);
    const third = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(0, { subtype: 'error_during_execution', is_error: true }); } }).runTask({ ...f.options, resumeTaskId: second.taskId });
    assert.equal(third.usage.estimatedCostUsd, 0); assert.equal(third.usage.inputTokens, 0);
    assert.doesNotMatch(third.error ?? '', /indeterminate/);
  } finally { await f.cleanup(); }
});

test('a successful reset snapshot fails with observed usage and requires a fresh task', async () => {
  const f = await fixture();
  try {
    const first = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(2); } }).runTask(f.options);
    const reset = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(1); } }).runTask({ ...f.options, resumeTaskId: first.taskId });
    assert.equal(reset.status, 'failed'); assert.equal(reset.result, undefined);
    assert.equal(reset.usage.estimatedCostUsd, 1); assert.equal(reset.usage.inputTokens, 100);
    assert.match(reset.error ?? '', /counters reset.*indeterminate/); assert.match(reset.error ?? '', /fresh task without --resume/);
    assert.deepEqual(await readRun(reset.taskId, f.options.stateDirectory), reset);
    let called = false;
    await assert.rejects(createRuntime({ getApiKey: () => secret, query: async function* () { called = true; yield result(2); } }).runTask({ ...f.options, resumeTaskId: reset.taskId }), /indeterminate accounting/);
    assert.equal(called, false);
    assert.deepEqual(await readdir(join(f.options.stateDirectory, 'resume-locks')), []);
  } finally { await f.cleanup(); }
});

test('regressed nonzero budget/error snapshots also preserve observed usage as indeterminate', async () => {
  for (const subtype of ['error_max_budget_usd', 'error_during_execution', 'error_max_turns']) {
    const f = await fixture();
    try {
      const first = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(2); } }).runTask(f.options);
      const reset = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(1, { subtype, is_error: true }); } }).runTask({ ...f.options, resumeTaskId: first.taskId });
      assert.equal(reset.status, 'failed'); assert.equal(reset.usage.estimatedCostUsd, 1); assert.equal(reset.usage.inputTokens, 100);
      assert.match(reset.error ?? '', /counters reset.*indeterminate/);
    } finally { await f.cleanup(); }
  }
});

test('concurrent resumes admit exactly one query and preserve a resumable latest leaf', { timeout: 5000 }, async () => {
  const f = await fixture();
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  try {
    const first = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(1); } }).runTask(f.options);
    let started!: () => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    let rejected!: () => void;
    const lockRejected = new Promise<void>((resolve) => { rejected = resolve; });
    let queries = 0;
    const runtime = createRuntime({ getApiKey: () => secret, query: async function* () { queries++; started(); await gate; yield result(2); } });
    const attempts = [runtime.runTask({ ...f.options, resumeTaskId: first.taskId }), runtime.runTask({ ...f.options, resumeTaskId: first.taskId })];
    const observed = attempts.map((attempt) => attempt.then((run) => ({ run, error: undefined }), (error: unknown) => { rejected(); return { run: undefined, error }; }));
    await Promise.all([queryStarted, lockRejected]);
    assert.equal(queries, 1);
    unblock();
    const outcomes = await Promise.all(observed);
    const accepted = outcomes.find((outcome) => outcome.run)?.run;
    assert.ok(accepted); assert.equal(accepted.status, 'succeeded');
    assert.match(String(outcomes.find((outcome) => outcome.error)?.error), /already has a resume lock/);
    assert.equal((await listRuns(f.options.stateDirectory)).length, 2);
    assert.deepEqual(await readdir(join(f.options.stateDirectory, 'resume-locks')), []);
    const next = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(3); } }).runTask({ ...f.options, resumeTaskId: accepted.taskId });
    assert.equal(next.status, 'succeeded'); assert.equal(next.usage.estimatedCostUsd, 1);
    assert.equal((await listRuns(f.options.stateDirectory)).length, 3);
  } finally { unblock(); await f.cleanup(); }
});

test('resume locks release on SDK errors, cancellation and validation failures', async () => {
  for (const mode of ['error', 'cancelled', 'auth'] as const) {
    const f = await fixture();
    try {
      const first = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(1); } }).runTask(f.options);
      const controller = new AbortController();
      const runtime = createRuntime({ getApiKey: () => mode === 'auth' ? '' : secret, query: async function* () {
        if (mode === 'error') throw new Error('fixture error');
        controller.abort(); yield result(1.5);
      } });
      let parent = first;
      if (mode === 'auth') await assert.rejects(runtime.runTask({ ...f.options, resumeTaskId: first.taskId }), /ANTHROPIC_API_KEY/);
      else {
        parent = await runtime.runTask({ ...f.options, resumeTaskId: first.taskId, signal: controller.signal });
        assert.equal(parent.status, mode === 'error' ? 'failed' : 'cancelled');
      }
      assert.deepEqual(await readdir(join(f.options.stateDirectory, 'resume-locks')), []);
      const next = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(2); } }).runTask({ ...f.options, resumeTaskId: parent.taskId });
      assert.equal(next.status, 'succeeded');
      assert.deepEqual(await readdir(join(f.options.stateDirectory, 'resume-locks')), []);
    } finally { await f.cleanup(); }
  }
});

test('resume locks reject symlinks and never delete replacement owners or stale locks', async () => {
  const f = await fixture();
  try {
    const release = await acquireResumeLock('../../session-path-trick', f.options.stateDirectory);
    const locks = join(f.options.stateDirectory, 'resume-locks');
    const names = await readdir(locks);
    assert.equal(names.length, 1); assert.match(names[0]!, /^[0-9a-f]{64}\.lock$/);
    const path = join(locks, names[0]!);
    const owner = JSON.parse(await readFile(path, 'utf8')) as { owner: string; pid: number; createdAt: string };
    assert.equal(owner.pid, process.pid); assert.ok(owner.owner); assert.ok(owner.createdAt);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(acquireResumeLock('../../session-path-trick', f.options.stateDirectory), /manually remove only the verified stale lock/);
    await unlink(path);
    await writeFile(path, JSON.stringify({ owner: 'another-owner', pid: process.pid, createdAt: owner.createdAt }), { mode: 0o600 });
    await assert.rejects(release(), /ownership changed/);
    assert.match(await readFile(path, 'utf8'), /another-owner/);
    await unlink(path);
    const target = join(f.root, 'unrelated-private-file');
    await writeFile(target, 'retain this'); await symlink(target, path);
    await assert.rejects(acquireResumeLock('../../session-path-trick', f.options.stateDirectory), /already has a resume lock/);
    assert.equal(await readFile(target, 'utf8'), 'retain this');
  } finally { await f.cleanup(); }
});

test('budget, max-turn, cancellation, and absent final result remain unsuccessful', async () => {
  const f = await fixture();
  try {
    const budget = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(5.2, { subtype: 'error_max_budget_usd', is_error: true }); } }).runTask(f.options);
    assert.equal(budget.status, 'budget_exceeded'); assert.equal(budget.result, undefined); assert.equal(budget.usage.estimatedCostUsd, 5.2);
    const turns = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(0.2, { subtype: 'error_max_turns', is_error: true }); } }).runTask(f.options);
    assert.equal(turns.status, 'failed'); assert.match(turns.error ?? '', /turn limit/);
    const controller = new AbortController();
    const cancelled = await createRuntime({ getApiKey: () => secret, query: async function* () { yield result(0.3); controller.abort(); yield result(0.4); } }).runTask({ ...f.options, signal: controller.signal });
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result, undefined); assert.equal(cancelled.usage.estimatedCostUsd, 0.4);
    let called = false;
    const preCancelled = await createRuntime({ getApiKey: () => secret, query: async function* () { called = true; yield result(); } }).runTask({ ...f.options, signal: controller.signal });
    assert.equal(preCancelled.status, 'cancelled'); assert.equal(called, false);
    const empty = await createRuntime({ getApiKey: () => secret, query: async function* () {} }).runTask(f.options);
    assert.equal(empty.status, 'failed'); assert.match(empty.error ?? '', /without a final result/);
  } finally { await f.cleanup(); }
});

test('permission requests deny by default and forward explicit caller decisions', async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    await createRuntime({ getApiKey: () => secret, query: async function* ({ options }) {
      assert.equal((await permission(options, 'Bash', { command: 'fixture' }, { signal })).behavior, 'deny'); yield result();
    } }).runTask(f.options);
    const requests: unknown[] = [];
    await createRuntime({ getApiKey: () => secret, query: async function* ({ options }) {
      assert.equal((await permission(options, 'Write', { file_path: 'fixture' }, { signal, decisionReason: 'write' })).behavior, 'allow'); yield result();
    } }).runTask({ ...f.options, approveTool: async (request) => { requests.push(request); return true; } });
    assert.deepEqual(requests, [{ toolName: 'Write', input: { file_path: 'fixture' }, reason: 'write' }]);
    await createRuntime({ getApiKey: () => secret, query: async function* ({ options }) {
      assert.equal((await permission(options, 'Bash', {}, { signal })).behavior, 'deny'); yield result();
    } }).runTask({ ...f.options, approveTool: async () => { throw new Error(secret); } });
  } finally { await f.cleanup(); }
});

test('AskUserQuestion requires complete real user answers and never invents approval', async () => {
  const f = await fixture();
  const questions = [{ question: 'Choose?', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }] }];
  try {
    const runWith = async (answerQuestions?: RunTaskOptions['answerQuestions']) => createRuntime({ getApiKey: () => secret, query: async function* ({ options }) {
      const decision = await permission(options, 'AskUserQuestion', { questions }, { signal: new AbortController().signal });
      if (answerQuestions) assert.equal(decision.behavior, 'allow'); else assert.equal(decision.behavior, 'deny');
      if (decision.behavior === 'allow') assert.deepEqual(decision.updatedInput, { questions, answers: { 'Choose?': 'Two' } });
      yield result();
    } }).runTask({ ...f.options, approveTool: async () => true, ...(answerQuestions ? { answerQuestions } : {}) });
    await runWith();
    await runWith(async (request) => { assert.deepEqual(request.questions, questions); return { 'Choose?': 'Two' }; });
    await createRuntime({ getApiKey: () => secret, query: async function* ({ options }) {
      assert.equal((await permission(options, 'AskUserQuestion', { questions }, { signal: new AbortController().signal })).behavior, 'deny'); yield result();
    } }).runTask({ ...f.options, answerQuestions: async () => ({ unrelated: 'invented' }) });
  } finally { await f.cleanup(); }
});

test('subagent limits reject unrecognized, nested, background, and extra launches', async () => {
  const f = await fixture();
  try {
    await createRuntime({ getApiKey: () => secret, query: async function* ({ options }) {
      for (const input of [
        { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } },
        { tool_name: 'Agent', tool_input: { subagent_type: 'explorer', run_in_background: true } },
        { tool_name: 'Agent', tool_input: { subagent_type: 'explorer', model: 'haiku' } },
        { tool_name: 'Agent', tool_input: { subagent_type: 'explorer', effort: 'max' } },
        { tool_name: 'Agent', tool_input: { subagent_type: 'explorer', isolation: 'remote', run_in_background: false } },
        { tool_name: 'Agent', tool_input: { subagent_type: 'explorer', isolation: 'worktree' } },
        { tool_name: 'Agent', tool_input: { subagent_type: 'explorer' }, agent_id: 'nested' },
        { tool_name: 'Write', tool_input: {}, agent_id: 'nested' },
      ]) assert.equal((await hook(options, 'PreToolUse', input)).hookSpecificOutput && ((await hook(options, 'PreToolUse', input)).hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'deny');
      assert.deepEqual(await hook(options, 'PreToolUse', { tool_name: 'Read', tool_input: {}, agent_id: 'nested' }), {});
      assert.deepEqual(await hook(options, 'PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'explorer' }, tool_use_id: 'a' }), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { subagent_type: 'explorer', run_in_background: false } } });
      assert.deepEqual(await hook(options, 'PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' }, tool_use_id: 'b' }), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { subagent_type: 'reviewer', run_in_background: false } } });
      const third = await hook(options, 'PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'explorer' }, tool_use_id: 'c' });
      assert.equal((third.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'deny');
      yield result();
    } }).runTask(f.options);
  } finally { await f.cleanup(); }
});

test('PostToolUse only rewrites new filtered observations and fails open', async () => {
  const f = await fixture();
  try {
    let applies = 0;
    const decision: FilterDecision = { mode: 'filter', status: 'filtered', originalCharacters: 100, proposedCharacters: 10, deliveredCharacters: 10, removedLines: 1, reason: 'fixture' };
    await createRuntime({ getApiKey: () => secret, createOutputFilter: () => ({ apply: async () => { applies++; if (applies === 2) throw new Error('filter failure'); return { response: 'reduced', decision }; } }), query: async function* ({ options }) {
      const input = { tool_name: 'Bash', tool_input: {}, tool_response: 'original' };
      assert.deepEqual(await hook(options, 'PostToolUse', input), { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'reduced' } });
      assert.deepEqual(await hook(options, 'PostToolUse', input), {});
      assert.deepEqual(await hook(options, 'PostToolUse', { ...input, tool_use_id: 'different' }), {});
      yield result();
    } }).runTask(f.options);
    assert.equal(applies, 2);
    for (const status of ['observed', 'unchanged'] as const) await createRuntime({ getApiKey: () => secret, createOutputFilter: () => ({ apply: async () => ({ response: 'proposed', decision: { ...decision, status } }) }), query: async function* ({ options }) {
      assert.deepEqual(await hook(options, 'PostToolUse', { tool_name: 'Bash', tool_response: 'original' }), {}); yield result();
    } }).runTask(f.options);
  } finally { await f.cleanup(); }
});

test('recovery remains bounded and confined to task capabilities and validated paths', async () => {
  const f = await fixture();
  try {
    const runtime = createRuntime({ getApiKey: () => secret, query: async function* () { yield result(); } });
    const first = await runtime.runTask(f.options);
    const second = await runtime.runTask(f.options);
    const firstStore = createArtifactStore(await getTaskArtifactDirectory(first.taskId, f.options.stateDirectory));
    const secondStore = createArtifactStore(await getTaskArtifactDirectory(second.taskId, f.options.stateDirectory));
    const saved = await firstStore.save({ toolName: 'Bash', sessionId: session, toolUseId: 'fixture', response: 'a'.repeat(21_000) });
    const recover = createRecoveryReader(firstStore);
    assert.equal((await recover({ id: saved.id })).text.length, 20_000);
    assert.equal((await recover({ id: saved.id, offset: 20_000, limit: 1000 })).text.length, 1000);
    for (const input of [{ id: '../secret' }, { id: saved.id, offset: -1 }, { id: saved.id, limit: 20_001 }, { id: saved.id, limit: 0 }, { id: saved.id, offset: 0.5 }]) await assert.rejects(recover(input));
    await assert.rejects(createRecoveryReader(secondStore)({ id: saved.id }));
    const resumedRecovery = createRecoveryReader(createTaskRecoveryStore(secondStore, [firstStore]));
    assert.equal((await resumedRecovery({ id: saved.id, limit: 100 })).text.length, 100);
    const unrelatedStore = createArtifactStore(join(f.root, 'unrelated'));
    const unrelated = await unrelatedStore.save({ toolName: 'Bash', sessionId: randomUUID(), toolUseId: 'unrelated', response: 'unrelated private output' });
    await assert.rejects(resumedRecovery({ id: unrelated.id }), /does not belong/);
    await assert.rejects(getTaskArtifactDirectory('../escape', f.options.stateDirectory));
    const linkedState = join(f.root, 'linked');
    await symlink(f.options.stateDirectory, linkedState);
    await assert.rejects(readRun(first.taskId, linkedState), /symlink/);
    await assert.rejects(listRuns(linkedState), /symlink/);
    const recordPath = join(f.options.stateDirectory, 'tasks', first.taskId, 'run.json');
    await writeFile(recordPath, JSON.stringify({ ...first, result: undefined }));
    await assert.rejects(readRun(first.taskId, f.options.stateDirectory), /Invalid stored run/);
  } finally { await f.cleanup(); }
});

test('task-start profile snapshot is immutable and resume validates profile and cwd', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const options: RunTaskOptions = { ...f.options, profile: 'opus-high' };
    const runtime = createRuntime({ getApiKey: () => secret, query: async function* ({ options: sdk }) {
      assert.equal(sdk.model, 'claude-opus-5-5'); assert.equal(sdk.effort, 'high');
      options.profile = 'sonnet-medium'; yield result();
    } });
    const first = await runtime.runTask(options);
    assert.deepEqual(first.profile, { name: 'opus-high', model: 'claude-opus-5-5', effort: 'high' }); assert.ok(Object.isFrozen(first.profile));
    await assert.rejects(runtime.runTask({ ...f.options, resumeTaskId: first.taskId, profile: 'sonnet-medium' }), /retain its session profile/);
    await assert.rejects(runtime.runTask({ ...f.options, cwd: other.root, resumeTaskId: first.taskId }), /same project/);
    const resumed = await runtime.runTask({ ...f.options, resumeTaskId: first.taskId });
    assert.equal(resumed.profile.name, 'opus-high');

    for (const family of ['fable', 'mythos']) {
      const familySession = randomUUID();
      const familyRuntime = createRuntime({ getApiKey: () => secret, query: async function* ({ options: sdk }) {
        assert.equal(sdk.model, `claude-${family}-5-2`); assert.equal(sdk.effort, 'medium');
        assert.equal(sdk.permissionMode, 'default');
        assert.deepEqual(sdk.agents?.explorer.tools, ['Read', 'Grep', 'Glob']);
        yield result(1, { session_id: familySession });
      } });
      const first = await familyRuntime.runTask({ ...f.options, profile: `claude:${family}-medium` });
      assert.equal(first.status, 'succeeded');
      const replay = await familyRuntime.runTask({ ...f.options, resumeTaskId: first.taskId });
      assert.deepEqual(replay.profile, first.profile);
    }
    const store = createProfileStore(f.options.configDirectory);
    await store.create({ name: 'careful', model: 'sonnet', effort: 'low' });
    await store.setDefault('careful');
    const customSession = randomUUID();
    const customRuntime = createRuntime({ getApiKey: () => secret, query: async function* ({ options: sdk }) {
      assert.equal(sdk.model, 'sonnet'); assert.equal(sdk.effort, 'low');
      yield result(1, { session_id: customSession });
    } });
    const custom = await customRuntime.runTask(f.options);
    assert.deepEqual(custom.profile, { name: 'careful', model: 'sonnet', effort: 'low' });
    await store.edit('careful', { model: 'opus', effort: 'high' });
    assert.deepEqual((await readRun(custom.taskId, f.options.stateDirectory)).profile, custom.profile);
    const continued = await customRuntime.runTask({ ...f.options, resumeTaskId: custom.taskId, profile: 'careful' });
    assert.deepEqual(continued.profile, custom.profile);
    await store.setDefault('opus-medium');
    await store.delete('careful');
    // Even a broken current registry cannot change or block a saved SDK profile.
    await writeFile(join(f.options.configDirectory, 'profiles.json'), '{invalid');
    const afterDelete = await customRuntime.runTask({ ...f.options, resumeTaskId: continued.taskId });
    assert.deepEqual(afterDelete.profile, custom.profile);
  } finally { await f.cleanup(); await other.cleanup(); }
});
