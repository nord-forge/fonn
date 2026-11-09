import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ArtifactStore, FilterDecision, RunRecord, RunTaskOptions, TaskUsage } from '../contracts.js';
import { createArtifactStore, createOutputFilter } from '../filtering/index.js';
import { getDefaultConfigDirectory, profileNameSchema, resolveProfile } from '../profiles.js';
import { taskResultSchema } from '../schema.js';
import { buildSdkOptions } from './options.js';
import { accountingResetError, emptyUsage, getDefaultStateDirectory, getTaskArtifactDirectory, listRuns, prepareTask, readRun, resumeBaseline, saveRun, taskIdSchema } from './storage.js';
import { createTaskRecoveryStore } from './recovery.js';
import { acquireResumeLock } from './resume-lock.js';

export { buildSdkOptions } from './options.js';
export { createRecoveryReader, createRecoveryServer, createTaskRecoveryStore } from './recovery.js';
export { getDefaultStateDirectory, getTaskArtifactDirectory, listRuns, readRun, runRecordSchema } from './storage.js';

export type QueryFactory = (input: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
export interface RuntimeDependencies {
  query?: QueryFactory;
  /** Only the explicit API key variable is read. Never read subscription credentials. */
  getApiKey?: () => string | undefined;
  environment?: NodeJS.ProcessEnv;
  answerQuestions?: RunTaskOptions['answerQuestions'];
  createOutputFilter?: typeof createOutputFilter;
}

const optionsSchema = z.object({
  prompt: z.string().trim().min(1), cwd: z.string().min(1), profile: profileNameSchema.optional(), configDirectory: z.string().min(1).optional(),
  budgetUsd: z.number().finite().positive().default(5), maxTurns: z.number().int().positive().default(20), filterMode: z.enum(['filter', 'observe', 'off']).default('filter'),
  stateDirectory: z.string().min(1).optional(), resumeTaskId: taskIdSchema.optional(), signal: z.instanceof(AbortSignal).optional(),
  approveTool: z.custom<NonNullable<RunTaskOptions['approveTool']>>((value) => typeof value === 'function').optional(),
  answerQuestions: z.custom<NonNullable<RunTaskOptions['answerQuestions']>>((value) => typeof value === 'function').optional(),
  onEvent: z.custom<NonNullable<RunTaskOptions['onEvent']>>((value) => typeof value === 'function').optional(),
}).strict();

function nonnegative(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }

/** Result messages contain cumulative snapshots, never incremental charges. */
function snapshotUsage(message: SDKResultMessage): TaskUsage {
  const usage = emptyUsage();
  usage.estimatedCostUsd = nonnegative(message.total_cost_usd);
  const models = Object.values(message.modelUsage ?? {});
  if (models.length > 0) {
    for (const model of models) {
      usage.inputTokens += nonnegative(model.inputTokens);
      usage.outputTokens += nonnegative(model.outputTokens);
      usage.cacheReadTokens += nonnegative(model.cacheReadInputTokens);
      usage.cacheWriteTokens += nonnegative(model.cacheCreationInputTokens);
    }
  } else if (message.usage) {
    usage.inputTokens = nonnegative(message.usage.input_tokens);
    usage.outputTokens = nonnegative(message.usage.output_tokens);
    usage.cacheReadTokens = nonnegative(message.usage.cache_read_input_tokens);
    usage.cacheWriteTokens = nonnegative(message.usage.cache_creation_input_tokens);
  }
  return usage;
}

export function createRuntime(dependencies: RuntimeDependencies = {}) {
  const invoke = dependencies.query ?? query;
  return {
    async runTask(input: RunTaskOptions): Promise<RunRecord> {
      const parsed = optionsSchema.safeParse(input);
      if (!parsed.success) throw new Error(`Invalid task options: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'options').join(', ')}`);
      // Snapshot all options before awaiting anything or calling user code.
      const options = Object.freeze({ ...parsed.data, prompt: input.prompt });
      const cwd = await realpath(resolve(options.cwd));
      if (!(await stat(cwd)).isDirectory()) throw new Error('Task cwd must be an existing directory');
      const stateDirectory = resolve(options.stateDirectory ?? getDefaultStateDirectory());
      const parent = options.resumeTaskId ? await readRun(options.resumeTaskId, stateDirectory) : undefined;
      if (parent && (parent.cwd !== cwd || !parent.sessionId)) throw new Error('Resume requires a saved session from the same project directory');
      if (parent && options.profile && options.profile !== parent.profile.name) throw new Error('A resumed task must retain its session profile');
      // Resumes use the saved snapshot even if its named profile was edited or deleted.
      const profile = Object.freeze({ ...(parent?.profile ?? await resolveProfile(options.profile, options.configDirectory ?? getDefaultConfigDirectory(dependencies.environment ?? process.env))) });
      // Hold the same-session lock across leaf validation, the query, and record persistence.
      const releaseResumeLock = parent ? await acquireResumeLock(parent.sessionId!, stateDirectory) : undefined;
      try {
      const baseline = parent ? await resumeBaseline(parent, stateDirectory) : emptyUsage();
      const ancestorStores: ArtifactStore[] = [];
      let ancestor = parent;
      while (ancestor) {
        // resumeBaseline already validated this finite chain and its cwd/session identity.
        ancestorStores.push(createArtifactStore(await getTaskArtifactDirectory(ancestor.taskId, stateDirectory)));
        ancestor = ancestor.parentTaskId ? await readRun(ancestor.parentTaskId, stateDirectory) : undefined;
      }
      const key = (dependencies.getApiKey ?? (() => process.env.ANTHROPIC_API_KEY))();
      if (typeof key !== 'string' || !key.trim()) throw new Error('An explicit nonempty ANTHROPIC_API_KEY is required. Subscription authentication is not supported.');
      const taskId = randomUUID();
      const artifacts = await prepareTask(stateDirectory, taskId);
      const filters: FilterDecision[] = [];
      const store = createArtifactStore(artifacts);
      const recoveryStore = createTaskRecoveryStore(store, ancestorStores);
      const filter = (dependencies.createOutputFilter ?? createOutputFilter)({ store, mode: options.filterMode, onDecision: (decision) => filters.push(structuredClone(decision)) });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const record: RunRecord = {
        schemaVersion: 1, taskId, ...(parent ? { parentTaskId: parent.taskId, sessionId: parent.sessionId } : {}),
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'failed',
        profile, cwd, budgetUsd: options.budgetUsd, maxTurns: options.maxTurns, filterMode: options.filterMode,
        usage: emptyUsage(), filters,
      };
      const cumulative = { ...baseline };
      const emit = (type: string, message: string) => { try { options.onEvent?.({ type, message }); } catch { /* UI failures do not lose run accounting. */ } };
      let lastResult: SDKResultMessage | undefined;
      let streamFailed = false;
      let accountingReset = false;
      const resetReported = emptyUsage();
      try {
        if (!controller.signal.aborted) {
          const sdkOptions = buildSdkOptions({ options, profile, cwd, apiKey: key, environment: dependencies.environment, store: recoveryStore, filter, abortController: controller, resumeSessionId: parent?.sessionId, answerQuestions: dependencies.answerQuestions });
          emit('started', `Task started with ${profile.name}. Budget USD ${options.budgetUsd} is an estimated SDK stop threshold and may be exceeded.`);
          for await (const message of invoke({ prompt: options.prompt, options: sdkOptions })) {
            if ('session_id' in message && typeof message.session_id === 'string' && message.session_id) {
              if (record.sessionId && record.sessionId !== message.session_id) throw new Error('Session identity changed');
              record.sessionId = message.session_id;
            }
            if (message.type === 'result') {
              lastResult = message;
              const snapshot = snapshotUsage(message);
              const zeroedError = message.subtype !== 'success' && Object.values(snapshot).every((value) => value === 0);
              if (!zeroedError && (Object.keys(cumulative) as Array<keyof TaskUsage>).some((key) => snapshot[key] < cumulative[key])) {
                accountingReset = true;
                // A reset destroys the baseline: retain observable counters without calling them
                // a verified delta or pretending the new request was free.
                for (const key of Object.keys(cumulative) as Array<keyof TaskUsage>) resetReported[key] = Math.max(resetReported[key], snapshot[key]);
              } else if (accountingReset && !zeroedError) {
                for (const key of Object.keys(cumulative) as Array<keyof TaskUsage>) resetReported[key] = Math.max(resetReported[key], snapshot[key]);
              }
              // Startup/crash results can be zeroed. Preserve the latest known spend.
              for (const key of Object.keys(cumulative) as Array<keyof TaskUsage>) cumulative[key] = Math.max(cumulative[key], snapshot[key]);
              for (const key of Object.keys(cumulative) as Array<keyof TaskUsage>) record.usage[key] = Math.max(0, cumulative[key] - baseline[key]);
              if (accountingReset) for (const key of Object.keys(cumulative) as Array<keyof TaskUsage>) record.usage[key] = Math.max(record.usage[key], resetReported[key]);
              emit('usage', 'Updated cumulative estimated SDK usage.');
            }
            if (controller.signal.aborted) break;
          }
        }
      } catch {
        streamFailed = true;
        // SDK errors can embed credentials, tool input, and prompts. Persist only a fixed diagnostic.
        record.error = 'The SDK stream failed; no successful result was established.';
      } finally {
        options.signal?.removeEventListener('abort', cancel);
      }
      if (accountingReset) {
        record.status = 'failed'; record.error = accountingResetError;
      } else if (controller.signal.aborted) {
        record.status = 'cancelled'; record.error = 'Task cancelled.';
      } else if (lastResult?.subtype === 'error_max_budget_usd' || record.usage.estimatedCostUsd > options.budgetUsd) {
        record.status = 'budget_exceeded'; record.error = 'The estimated SDK budget threshold was exceeded; a request may overshoot the threshold.';
      } else if (!streamFailed && lastResult?.subtype === 'success' && !lastResult.is_error) {
        const result = taskResultSchema.safeParse(lastResult.structured_output);
        if (result.success) { record.result = result.data; record.status = 'succeeded'; }
        else record.error = 'The SDK did not return a valid structured TaskResult.';
      } else if (!streamFailed) {
        record.error = lastResult?.subtype === 'error_max_turns' ? 'The SDK maximum turn limit was reached.' : lastResult ? 'The SDK returned an unsuccessful result.' : 'The SDK ended without a final result.';
      }
      record.finishedAt = new Date().toISOString();
      await saveRun(record, stateDirectory);
      emit('finished', `Task ${record.status}.`);
      return record;
      } finally { await releaseResumeLock?.(); }
    },
    listRuns,
    readRun,
  };
}

export const runTask = createRuntime().runTask;
