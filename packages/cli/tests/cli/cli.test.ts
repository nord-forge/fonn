import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RunRecord, RunTaskOptions } from '@nord-forge/fonn-core/contracts';
import { dispatch, type CliDependencies } from '../../src/cli/main.js';
import { renderRun, terminalText } from '../../src/cli/render.js';

const emptyConfigDirectory = join(await realpath(tmpdir()), `fonn-cli-no-profiles-${process.pid}-${randomUUID()}`);

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return { schemaVersion: 1, taskId: 'task-1', startedAt: '2026-11-09T10:00:00Z', finishedAt: '2026-11-09T10:01:00Z', status: 'succeeded', profile: { name: 'opus-medium', model: 'claude-opus-5-5', effort: 'medium' }, cwd: '/tmp/project', budgetUsd: 5, maxTurns: 30, filterMode: 'filter', result: { summary: 'Fixed the issue.', changes: ['Updated one file'], checks: [{ name: 'unit', status: 'passed', details: '2 tests' }], unresolved: [], handoffs: [] }, usage: { estimatedCostUsd: 0.12, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, filters: [], ...overrides };
}
function harness(extra: Partial<CliDependencies> = {}) {
  let out = '';
  let err = '';
  const options: RunTaskOptions[] = [];
  const deps: Partial<CliDependencies> = { stdout: text => { out += text; }, stderr: text => { err += text; }, nodeVersion: '22.0.0', interactive: false, onInterrupt: () => () => {}, runTask: async value => { options.push(value); return record(); }, listRuns: async () => [record()], readRun: async () => record(), ...extra, env: { FONN_CONFIG_DIR: emptyConfigDirectory, ...extra.env } };
  return { run: (args: string[]) => dispatch(args, deps), out: () => out, err: () => err, options };
}

test('help, profiles and version run offline and do not import/execute the SDK', async () => {
  const h = harness({ runTask: async () => { throw new Error('must not run'); } });
  assert.equal(await h.run(['--help']), 0);
  assert.match(h.out(), /--resume/);
  assert.match(h.out(), /--subagents/);
  assert.equal(await h.run(['help']), 0);
  for (const args of [['help', 'profiles'], ['profiles', '--help']]) {
    const profileHelp = harness();
    assert.equal(await profileHelp.run(args), 0);
    assert.match(profileHelp.out(), /profiles create <name>/);
  }
  for (const args of [['help', 'codex'], ['codex', '--help']]) {
    const codexHelp = harness({ env: { FONN_CONFIG_DIR: '/dev/null/unreadable' } });
    assert.equal(await codexHelp.run(args), 0);
    assert.match(codexHelp.out(), /manual review\/trust in \/hooks/);
  }
  const resumeHelp = harness({ env: { FONN_CONFIG_DIR: '/dev/null/unreadable' } });
  assert.equal(await resumeHelp.run(['help', 'resume']), 0);
  assert.match(resumeHelp.out(), /never guesses with --last/);
  const p = harness();
  assert.equal(await p.run(['profiles', '--json']), 0);
  assert.equal(JSON.parse(p.out()).length, 13);
  const v = harness();
  assert.equal(await v.run(['--version']), 0);
  assert.match(v.out(), /^0\.2\.3\n$/);
});

test('profile commands persist custom choices, manage the default and reject invalid arguments', async () => {
  const configDirectory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-profiles-'));
  const env = { FONN_CONFIG_DIR: configDirectory };
  const invoke = async (args: string[]) => {
    const h = harness({ env });
    assert.equal(await h.run(['profiles', ...args]), 0, h.err());
    return h.out();
  };
  try {
    for (const family of ['fable', 'mythos']) {
      assert.equal(JSON.parse(await invoke(['show', `claude:${family}-medium`, '--json'])).model, `claude-${family}-5-2`);
      const profile = JSON.parse(await invoke(['create', `${family}-high`, '--model', family, '--effort', 'high', '--json']));
      assert.equal(profile.model, `claude-${family}-5-2`);
      await invoke(['delete', profile.name]);
    }
    const custom = { name: 'quick', model: 'haiku', effort: 'low' };
    assert.deepEqual(JSON.parse(await invoke(['create', 'quick', '--model', 'haiku', '--effort', 'low', '--json'])), custom);
    assert.deepEqual(JSON.parse(await invoke(['show', 'quick', '--json'])), custom);
    assert.equal(JSON.parse(await invoke(['edit', 'quick', '--effort', 'max', '--json'])).effort, 'max');
    assert.equal(JSON.parse(await invoke(['default', 'quick', '--json'])).name, 'quick');
    assert.equal(JSON.parse(await invoke(['default', '--json'])).name, 'quick');
    assert.match(await invoke(['list']), /quick \[claude\]: haiku, effort max \(default\)/);
    assert.equal(JSON.parse(await invoke(['list', '--json'])).length, 14);
    const fresh = harness({ env });
    assert.equal(await fresh.run(['run', 'Use configured default']), 0);
    assert.equal(fresh.options[0]?.profile, 'quick');
    const codex = { name: 'my-sol', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
    assert.deepEqual(JSON.parse(await invoke(['create', 'my-sol', '--provider', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--json'])), codex);
    assert.match(await invoke(['show', 'my-sol']), /my-sol \[codex\]/);
    assert.equal(JSON.parse(await invoke(['edit', 'my-sol', '--provider', 'claude', '--model', 'sonnet', '--json'])).provider, 'claude');
    await invoke(['edit', 'my-sol', '--provider', 'codex', '--model', 'gpt-6.1-sol']);
    const sdkCodex = harness({ env });
    assert.equal(await sdkCodex.run(['run', 'Unsupported SDK provider', '--profile', 'my-sol']), 1);
    assert.match(sdkCodex.err(), /Use fonn codex --profile my-sol/);
    assert.equal(sdkCodex.options.length, 0);
    await invoke(['default', 'my-sol']);
    const sdkDefault = harness({ env });
    assert.equal(await sdkDefault.run(['run', 'Unsupported default']), 1);
    assert.equal(sdkDefault.options.length, 0);
    const agent = async (args: string[]) => {
      const h = harness({ env, launchClaude: async () => { throw new Error('Must not launch'); }, launchCodex: async () => { throw new Error('Must not launch'); } });
      assert.equal(await h.run(['--default', ...args, '--json']), 0, h.err());
      assert.equal(h.options.length, 0);
      return JSON.parse(h.out());
    };
    // Selecting the current agent keeps its custom model/effort profile.
    assert.deepEqual(await agent(['codex']), { provider: 'codex', profile: 'my-sol' });
    assert.deepEqual(await agent(['claude']), { provider: 'claude', profile: 'opus-medium' });
    assert.deepEqual(await agent(['codex']), { provider: 'codex', profile: 'codex:sol-medium' });
    assert.deepEqual(await agent([]), { provider: 'codex', profile: 'codex:sol-medium' });
    await invoke(['default', 'quick']);
    assert.deepEqual(await agent(['claude']), { provider: 'claude', profile: 'quick' });
    const human = harness({ env });
    assert.equal(await human.run(['--default']), 0);
    assert.match(human.out(), /Default agent: claude \(profile: quick\)/);
    for (const args of [['--default', 'other'], ['--default', 'codex', 'extra'], ['--default', 'codex', '--cwd', '/tmp'], ['--default', '--json', '--json']]) {
      const invalid = harness({ env });
      assert.equal(await invalid.run(args), 1);
      assert.equal(invalid.out(), '');
    }
    assert.deepEqual(await agent([]), { provider: 'claude', profile: 'quick' });
    for (const args of [ ['edit', 'quick'], ['create', 'missing', '--model', 'haiku'], ['show', 'quick', 'extra'], ['default', 'quick', 'extra'], ['list', '--model', 'haiku'], ['delete', 'quick'], ['delete', 'opus-high'], ['edit', 'opus-high', '--effort', 'low'], ['create', 'bad', '--model', 'haiku', '--effort', 'invalid'], ['create', 'bad', '--provider', 'other', '--model', 'haiku', '--effort', 'low'], ['create', 'bad', '--provider', 'codex', '--model', 'haiku', '--effort', 'low'], ['edit', 'quick', '--provider', 'codex'], ['unknown'] ]) {
      const invalid = harness({ env });
      assert.equal(await invalid.run(['profiles', ...args]), 1, args.join(' '));
      assert.equal(invalid.out(), '');
    }
    await invoke(['default', 'opus-medium']);
    assert.deepEqual(JSON.parse(await invoke(['delete', 'quick', '--json'])), { deleted: 'quick' });
    await invoke(['delete', 'my-sol']);
    assert.equal(JSON.parse(await invoke(['--json'])).length, 13);
  } finally { await rm(configDirectory, { recursive: true, force: true }); }
});

test('doctor shows only key presence and requires supported Node plus a key', async () => {
  const h = harness({ env: { ANTHROPIC_API_KEY: 'sk-SECRET' } });
  assert.equal(await h.run(['doctor', '--json']), 0);
  assert.equal(JSON.parse(h.out()).apiKeyPresent, true);
  assert.equal(JSON.parse(h.out()).networkChecked, false);
  assert.doesNotMatch(h.out(), /sk-SECRET/);
  assert.equal(await harness().run(['doctor']), 1);
  assert.equal(await harness({ env: { ANTHROPIC_API_KEY: 'x' }, nodeVersion: '20.1.0' }).run(['doctor']), 1);
});

test('run passes validated options and JSON stdout contains exactly one value', async () => {
  const h = harness({ runTask: async options => { options.onEvent?.({ type: 'progress', message: 'Working' }); return record(); } });
  assert.equal(await h.run(['run', 'Fix it', '--cwd', '/tmp/repo', '--profile', 'sonnet-medium', '--budget', '1.25', '--max-turns', '7', '--filter', 'observe', '--state-dir', '/tmp/state', '--json']), 0);
  assert.equal(JSON.parse(h.out()).taskId, 'task-1');
  assert.equal(h.out().trim().split('\n').length, 1);
  assert.match(h.err(), /progress: Working/);
  const c = harness();
  assert.equal(await c.run(['run', 'Fix it', '--cwd', '/tmp/repo', '--profile', 'sonnet-medium', '--budget', '1.25', '--max-turns', '7', '--filter', 'observe', '--state-dir', '/tmp/state']), 0);
  assert.equal(c.options[0]?.cwd, '/tmp/repo');
  assert.equal(c.options[0]?.profile, 'sonnet-medium');
  assert.equal(c.options[0]?.budgetUsd, 1.25);
  assert.equal(c.options[0]?.maxTurns, 7);
  assert.equal(c.options[0]?.filterMode, 'observe');
  assert.equal(c.options[0]?.stateDirectory, '/tmp/state');
});

test('resume lets runtime preserve the saved profile unless explicit', async () => {
  const configDirectory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-resume-'));
  try {
    await writeFile(join(configDirectory, 'profiles.json'), '{broken configuration');
    const h = harness({ env: { FONN_CONFIG_DIR: configDirectory } });
    assert.equal(await h.run(['run', 'Continue', '--resume', 'task-1']), 0);
    assert.equal(h.options[0]?.profile, undefined);
    assert.equal(h.options[0]?.resumeTaskId, 'task-1');
    assert.equal(await h.run(['run', 'Continue', '--resume', 'task-1', '--profile', 'deleted-custom-profile']), 0);
    assert.equal(h.options[1]?.profile, 'deleted-custom-profile');
  } finally { await rm(configDirectory, { recursive: true, force: true }); }
});

test('strict argument errors are helpful and never invoke runtime', async () => {
  for (const args of [ ['run'], ['run', 'a', 'b'], ['run', 'a', '--budget'], ['run', 'a', '--budget', '0'], ['run', 'a', '--budget', 'NaN'], ['run', 'a', '--max-turns', '1.5'], ['run', 'a', '--profile', 'unknown'], ['run', 'a', '--filter', 'yes'], ['run', 'a', '--yes'], ['run', 'a', '--budget', '1', '--budget', '2'], ['show'], ['runs', 'extra'], ['unknown'], ['output', 'task', 'artifact', '--offset', '-1'], ['output', 'task', 'artifact', '--limit', '20001'] ]) {
    const h = harness();
    assert.equal(await h.run(args), 1, args.join(' '));
    assert.match(h.err(), /Error:/);
    assert.equal(h.out(), '');
    assert.equal(h.options.length, 0);
  }
});

test('noninteractive permission requests deny and keep untrusted input on stderr', async () => {
  let approved: boolean | undefined;
  const h = harness({ ask: async () => { throw new Error('must not ask'); }, runTask: async options => { approved = await options.approveTool!({ toolName: 'Bash', input: { command: '\u001b[31mrm file' }, reason: 'write' }); return record(); } });
  assert.equal(await h.run(['run', 'Task', '--json']), 0);
  assert.equal(approved, false);
  assert.match(h.err(), /untrusted tool input/);
  assert.match(h.err(), /Denied/);
  assert.doesNotMatch(h.err(), /\u001b/);
  assert.equal(JSON.parse(h.out()).status, 'succeeded');
});

test('interactive permission requires explicit yes', async () => {
  for (const answer of ['yes', 'YES', 'y', '', 'no']) {
    let approved: boolean | undefined;
    const h = harness({ interactive: true, ask: async () => answer, runTask: async options => { approved = await options.approveTool!({ toolName: 'Edit', input: { path: 'file' } }); return record(); } });
    await h.run(['run', 'Task']);
    assert.equal(approved, answer.toLowerCase() === 'yes');
  }
});

test('questions use interactive text answers and remain unresolved headlessly', async () => {
  for (const interactive of [true, false]) {
    let answers: Record<string, string> | undefined;
    const h = harness({ interactive, ask: async () => 'Small scope', runTask: async options => {
      answers = await options.answerQuestions!({ questions: [{ question: 'Which scope?', options: [{ label: 'Small scope', description: 'One file' }] }] });
      return record();
    } });
    assert.equal(await h.run(['run', 'Task', '--json']), 0);
    assert.equal(answers?.['Which scope?'], interactive ? 'Small scope' : undefined);
    assert.equal(JSON.parse(h.out()).taskId, 'task-1');
  }
});

test('native provider routing preserves passthrough and follows explicit or default profiles', async () => {
  let called = false;
  const h = harness({ launchClaude: async options => {
    called = true;
    assert.deepEqual(options, { cwd: '/tmp/project', profile: 'opus-high', filterMode: 'observe', filterLevel: 'standard', subagents: 'auto', stateDirectory: '/tmp/state', configDirectory: emptyConfigDirectory, args: ['--resume', 'session-id'] });
    return 7;
  } });
  assert.equal(await h.run(['claude', '--cwd', '/tmp/project', '--profile', 'opus-high', '--filter', 'observe', '--state-dir', '/tmp/state', '--', '--resume', 'session-id']), 7);
  assert.equal(called, true);
  for (const family of ['fable', 'mythos']) {
    const profile = `claude:${family}-medium`;
    const native = harness({ launchClaude: async options => { assert.equal(options.profile, profile); return 0; } });
    assert.equal(await native.run(['--profile', profile]), 0);
    assert.equal(await native.run(['claude', '--profile', profile]), 0);
    const sdk = harness();
    assert.equal(await sdk.run(['run', 'Offline model routing', '--profile', profile]), 0);
    assert.equal(sdk.options[0]?.profile, profile);
  }
  // Leading launcher options and no arguments use native Claude by default.
  assert.equal(await h.run(['--cwd', '/tmp/project', '--profile', 'opus-high', '--filter', 'observe', '--state-dir', '/tmp/state', '--', '--resume', 'session-id']), 7);
  const configDirectory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-native-'));
  try {
    const env = { FONN_CONFIG_DIR: configDirectory };
    const setup = harness({ env });
    assert.equal(await setup.run(['profiles', 'create', 'quick', '--model', 'haiku', '--effort', 'low']), 0);
    assert.equal(await setup.run(['profiles', 'default', 'quick']), 0);
    const defaultLaunch = harness({ env, launchClaude: async options => {
      assert.equal(options.cwd, process.cwd());
      assert.equal(options.profile, 'quick');
      assert.equal(options.subagents, 'auto');
      assert.equal(options.configDirectory, configDirectory);
      assert.deepEqual(options.args, []);
      return 0;
    } });
    assert.equal(await defaultLaunch.run([]), 0);
    assert.equal(await defaultLaunch.run(['--profile', 'quick']), 0);
    let codexArgs = ['--search'];
    const codexLaunch = harness({ env, launchCodex: async options => {
      assert.deepEqual(options, { cwd: process.cwd(), profile: 'codex:sol-medium', filterMode: 'filter', filterLevel: 'standard', subagents: 'auto', stateDirectory: undefined, configDirectory, args: codexArgs });
      return 3;
    } });
    // An explicit provider falls back to its built-in when the global default differs.
    assert.equal(await codexLaunch.run(['codex', '--', '--search']), 3);
    assert.equal(await codexLaunch.run(['--profile', 'codex:sol-medium', '--', '--search']), 3);
    assert.equal(await setup.run(['profiles', 'default', 'codex:sol-medium']), 0);
    assert.equal(await codexLaunch.run(['--', '--search']), 3);
    codexArgs = [];
    assert.equal(await codexLaunch.run([]), 3);
    const claudeFallback = harness({ env, launchClaude: async options => {
      assert.equal(options.profile, 'opus-medium');
      return 0;
    } });
    assert.equal(await claudeFallback.run(['claude']), 0);
    for (const args of [['claude', '--profile', 'codex:sol-medium'], ['codex', '--profile', 'quick']]) {
      const wrongProvider = harness({ env, launchClaude: async () => { throw new Error('must not launch'); }, launchCodex: async () => { throw new Error('must not launch'); } });
      assert.equal(await wrongProvider.run(args), 1);
      assert.doesNotMatch(wrongProvider.err(), /must not launch/);
    }
  } finally { await rm(configDirectory, { recursive: true, force: true }); }
  for (const provider of ['claude', 'codex'] as const) {
    const off = harness({ [provider === 'claude' ? 'launchClaude' : 'launchCodex']: async (options: Parameters<CliDependencies['launchClaude']>[0]) => {
      assert.equal(options.subagents, 'off'); return 0;
    } });
    assert.equal(await off.run([provider, '--subagents', 'off']), 0);
  }
  const implicitOff = harness({ launchClaude: async options => { assert.equal(options.subagents, 'off'); return 0; } });
  assert.equal(await implicitOff.run(['--subagents', 'off']), 0);
  const levelOff = harness({ launchClaude: async () => { throw new Error('must not launch'); } });
  assert.equal(await levelOff.run(['claude', '--filter-level', 'similar', '--filter', 'off']), 1);
  assert.match(levelOff.err(), /--filter-level has no effect with --filter off/);
  assert.equal(await harness().run(['--filter-level', 'loose']), 1);
  const levelConfig = await mkdtemp(join(await realpath(tmpdir()), 'fonn-level-'));
  try {
    const levelEnv = { FONN_CONFIG_DIR: levelConfig };
    const saved = harness({ env: levelEnv });
    assert.equal(await saved.run(['--default-filter-level', 'similar']), 0);
    assert.match(saved.out(), /Default filter level: similar/);
    const usesSaved = harness({ env: levelEnv, launchCodex: async options => { assert.equal(options.filterLevel, 'similar'); return 0; } });
    assert.equal(await usesSaved.run(['codex']), 0);
    const overrides = harness({ env: levelEnv, launchClaude: async options => { assert.equal(options.filterLevel, 'strict'); return 0; } });
    assert.equal(await overrides.run(['--filter-level', 'strict']), 0);
    const savedOff = harness({ env: levelEnv, launchClaude: async options => { assert.equal(options.filterMode, 'off'); return 0; } });
    assert.equal(await savedOff.run(['--filter', 'off']), 0);
    assert.equal(await harness({ env: levelEnv }).run(['--default-filter-level', 'loose']), 1);
  } finally { await rm(levelConfig, { recursive: true, force: true }); }
  const invalid = harness({ launchClaude: async () => { throw new Error('must not launch'); } });
  assert.equal(await invalid.run(['--subagents', 'always']), 1);
  assert.match(invalid.err(), /--subagents must be auto or off/);
  assert.equal(await harness().run(['claude', '--subagents']), 1);
  assert.equal(await harness().run(['run', 'Task', '--subagents', 'auto']), 1);
  assert.equal(h.out(), '');
  assert.equal(await harness().run(['claude', '--budget', '2']), 1);
  assert.equal(await harness().run(['claude', '--json']), 1);
  assert.equal(await harness().run(['codex', '--budget', '2']), 1);
  assert.equal(await harness().run(['codex', '--json']), 1);
});

test('native hook reads stdin JSON and writes one JSON response', async () => {
  const h = harness({ readStdin: async () => '{"hook_event_name":"PostToolUse"}', runNativeHook: async (event, state, launch) => {
    assert.deepEqual(event, { hook_event_name: 'PostToolUse' });
    assert.equal(state, '/tmp/state'); assert.equal(launch, 'launch-1');
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' } };
  } });
  assert.equal(await h.run(['native-hook', '--launch-id', 'launch-1', '--state-dir', '/tmp/state']), 0);
  assert.equal(JSON.parse(h.out()).hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(h.err(), '');
  assert.equal(await harness().run(['native-hook', '--launch-id', 'launch-1']), 1);
  const invalid = harness({ readStdin: async () => 'bad' });
  assert.equal(await invalid.run(['native-hook', '--launch-id', 'launch-1', '--state-dir', '/tmp/state']), 1);
  assert.match(invalid.err(), /JSON event/);
  const codex = harness({ env: { FONN_CODEX_STATE_DIR: '/tmp/state', FONN_CODEX_LAUNCH_ID: 'launch-codex' }, readStdin: async () => '{"hook_event_name":"PostToolUse"}', runCodexHook: async (event, state, launch) => {
    assert.deepEqual(event, { hook_event_name: 'PostToolUse' });
    assert.equal(state, '/tmp/state'); assert.equal(launch, 'launch-codex');
    return { continue: false, stopReason: 'Filtered output' };
  } });
  assert.equal(await codex.run(['codex-hook']), 0);
  assert.deepEqual(JSON.parse(codex.out()), { continue: false, stopReason: 'Filtered output' });
  assert.equal(await harness().run(['codex-hook']), 1);
  assert.equal(await harness({ env: { FONN_CODEX_STATE_DIR: ' ', FONN_CODEX_LAUNCH_ID: 'launch' } }).run(['codex-hook']), 1);
  const badCodexEvent = harness({ env: { FONN_CODEX_STATE_DIR: '/tmp/state', FONN_CODEX_LAUNCH_ID: 'launch' }, readStdin: async () => 'bad' });
  assert.equal(await badCodexEvent.run(['codex-hook']), 1);
  assert.match(badCodexEvent.err(), /JSON event/);
  assert.equal(await codex.run(['codex-hook', 'extra']), 1);
});

test('native output routes bounded recovery to the launch store', async () => {
  const h = harness({ readNativeOutput: async (launch, artifact, options) => {
    assert.equal(launch, 'launch-1'); assert.equal(artifact, 'artifact-1'); assert.deepEqual(options, { offset: 0, limit: 4000 });
    return { id: artifact, text: 'Original', offset: 0, nextOffset: null, totalCharacters: 8 };
  } });
  assert.equal(await h.run(['native-output', 'launch-1', 'artifact-1']), 0);
  assert.equal(h.out(), 'Original\n');
  const resume = harness({ resumeNativeLaunch: async (id, options) => {
    assert.equal(id, 'launch-1');
    assert.deepEqual(options, { stateDirectory: '/tmp/saved-state' });
    return 7;
  } });
  assert.equal(await resume.run(['resume', 'launch-1', '--state-dir', '/tmp/saved-state']), 7);
  assert.equal(await resume.run(['resume']), 1);
  assert.equal(await resume.run(['resume', 'launch-1', '--profile', 'opus-high']), 1);
});

test('SIGINT aborts and cleans handlers while rendering saved cancellation', async () => {
  let interrupt: (() => void) | undefined;
  let detached = false;
  const h = harness({ onInterrupt: handler => { interrupt = handler; return () => { detached = true; }; }, runTask: async options => { interrupt!(); assert.equal(options.signal?.aborted, true); return record({ status: 'cancelled', error: 'Interrupted' }); } });
  assert.equal(await h.run(['run', 'Task', '--json']), 1);
  assert.equal(detached, true);
  assert.equal(JSON.parse(h.out()).status, 'cancelled');
});

test('runtime errors clean handlers, redact API keys and keep stdout empty', async () => {
  let detached = false;
  const h = harness({ env: { ANTHROPIC_API_KEY: 'secret-value' }, onInterrupt: () => () => { detached = true; }, runTask: async () => { throw new Error('bad secret-value\u001b[2J'); } });
  assert.equal(await h.run(['run', 'Task', '--json']), 1);
  assert.equal(detached, true);
  assert.equal(h.out(), '');
  assert.doesNotMatch(h.err(), /secret-value|\u001b/);
  assert.match(h.err(), /REDACTED/);
});

test('failed, budget and cancelled runs and failed checks exit nonzero', async () => {
  for (const status of ['failed', 'budget_exceeded', 'cancelled'] as const) {
    const h = harness({ runTask: async () => record({ status }) });
    assert.equal(await h.run(['run', 'Task']), 1);
    assert.match(h.out(), new RegExp(status.toUpperCase()));
  }
  const saved = record();
  saved.result!.checks[0]!.status = 'failed';
  assert.equal(await harness({ readRun: async () => saved }).run(['show', 'task-1']), 1);
});

test('lists/shows saved runs, validates structured results before rendering', async () => {
  const h = harness();
  assert.equal(await h.run(['runs', '--json']), 0);
  assert.equal(JSON.parse(h.out())[0].taskId, 'task-1');
  const show = harness();
  assert.equal(await show.run(['show', 'task-1', '--json']), 0);
  assert.equal(JSON.parse(show.out()).taskId, 'task-1');
  const bad = record({ result: { summary: 'bad' } as RunRecord['result'] });
  const invalid = harness({ readRun: async () => bad });
  assert.equal(await invalid.run(['show', 'task-1']), 1);
  assert.match(invalid.err(), /invalid structured result/);
});

test('artifact output uses bounded recovery arguments and escapes terminal controls', async () => {
  const h = harness({ readArtifact: async (taskId, artifactId, options, state) => {
    assert.equal(taskId, 'task-1'); assert.equal(artifactId, 'artifact-1'); assert.deepEqual(options, { offset: 10, limit: 20 }); assert.equal(state, '/tmp/state');
    return { id: artifactId, text: '\u001b[31mraw', offset: 10, nextOffset: 20, totalCharacters: 50 };
  } });
  assert.equal(await h.run(['output', 'task-1', 'artifact-1', '--offset', '10', '--limit', '20', '--state-dir', '/tmp/state']), 0);
  assert.match(h.out(), /\\u001b\[31mraw/);
  assert.match(h.err(), /next --offset 20/);
});

test('renderer is concise, preserves failed checks and bounds handoffs', () => {
  const value = record();
  value.result!.checks[0]!.status = 'failed';
  value.result!.summary = 'Summary\u001b[2J\u202e';
  value.result!.handoffs = Array.from({ length: 8 }, () => ({ agent: 'reviewer', task: 'Review', findings: ['x'.repeat(2000)], evidence: [], unresolved: ['Investigate'] }));
  const rendered = renderRun(value);
  assert.match(rendered, /\[FAILED\]/);
  assert.match(rendered, /Estimated API cost/);
  assert.match(rendered, /Further handoffs/);
  assert.equal((rendered.match(/Handoff \(reviewer\)/g) ?? []).length, 4);
  assert.doesNotMatch(rendered, /\u001b|\u202e/);
  assert.equal(terminalText('safe\ntext'), 'safe\ntext');
});

test('project settings drive launches and fonn config edits them', async () => {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-project-'));
  try {
    const launches: Array<Parameters<CliDependencies['launchClaude']>[0]> = [];
    const capture = async (options: Parameters<CliDependencies['launchClaude']>[0]) => { launches.push(options); return 0; };
    const h = () => harness({ launchClaude: capture, launchCodex: capture });

    const shared = h();
    assert.equal(await shared.run(['config', 'set', 'filterLevel', 'similar', '--shared', '--cwd', project]), 0);
    assert.equal(await h().run(['config', 'set', 'subagents', 'off', '--cwd', project]), 0);
    assert.equal(await h().run(['config', 'set', 'profile', 'codex:sol-medium', '--shared', '--cwd', project]), 0);

    const show = h();
    assert.equal(await show.run(['config', '--cwd', project]), 0);
    assert.match(show.out(), /filterLevel\s+similar\s+shared \(\.fonn\.json\)/);
    assert.match(show.out(), /subagents\s+off\s+personal/);
    const get = h();
    assert.equal(await get.run(['config', 'get', 'filter-level', '--cwd', project, '--json']), 0);
    assert.deepEqual(JSON.parse(get.out()), { key: 'filterLevel', value: 'similar', source: 'shared' });

    // Implicit launch: the project's Codex profile chooses Codex, with a notice.
    const implicit = h();
    assert.equal(await implicit.run(['--cwd', project]), 0);
    assert.equal(launches.at(-1)?.profile, 'codex:sol-medium');
    assert.equal(launches.at(-1)?.filterLevel, 'similar');
    assert.equal(launches.at(-1)?.subagents, 'off');
    assert.match(implicit.err(), /Project settings: profile codex:sol-medium \(\.fonn\.json\)/);

    // Explicit Claude ignores the Codex project profile; flags still win.
    const claude = h();
    assert.equal(await claude.run(['claude', '--cwd', project, '--filter-level', 'strict']), 0);
    assert.equal(launches.at(-1)?.profile, 'opus-medium');
    assert.equal(launches.at(-1)?.filterLevel, 'strict');
    assert.match(claude.err(), /Ignoring profile codex:sol-medium from \.fonn\.json/);

    // A project profile that does not exist fails clearly.
    assert.equal(await h().run(['config', 'set', 'profile', 'missing-profile', '--shared', '--cwd', project]), 0);
    const missing = h();
    assert.equal(await missing.run(['--cwd', project]), 1);
    assert.match(missing.err(), /Profile missing-profile set in \.fonn\.json does not exist/);

    assert.equal(await h().run(['config', 'unset', 'profile', '--shared', '--cwd', project]), 0);
    const bad = h();
    assert.equal(await bad.run(['config', 'set', 'filterMode', 'sometimes', '--cwd', project]), 1);
    assert.match(bad.err(), /Invalid value for filterMode/);
    assert.equal(await h().run(['config', 'set', 'colour', 'blue', '--cwd', project]), 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('global settings apply everywhere unless a project or flag overrides them', async () => {
  const configDirectory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-global-'));
  const elsewhere = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-elsewhere-'));
  const project = await mkdtemp(join(await realpath(tmpdir()), 'fonn-cli-global-project-'));
  try {
    const env = { FONN_CONFIG_DIR: configDirectory };
    const launches: Array<Parameters<CliDependencies['launchClaude']>[0]> = [];
    const h = () => harness({ env, launchClaude: async (options) => { launches.push(options); return 0; } });

    assert.equal(await h().run(['config', 'set', 'filterMode', 'observe', '--global']), 0);
    assert.equal(await h().run(['config', 'set', 'subagents', 'off', '--global']), 0);
    assert.equal(await h().run(['config', 'set', 'filterLevel', 'similar', '--global']), 0);
    assert.equal(await h().run(['claude', '--cwd', elsewhere]), 0);
    assert.deepEqual([launches.at(-1)?.filterMode, launches.at(-1)?.subagents, launches.at(-1)?.filterLevel], ['observe', 'off', 'similar']);

    const show = h();
    assert.equal(await show.run(['config', '--cwd', elsewhere]), 0);
    assert.match(show.out(), /filterMode\s+observe\s+global default/);

    // A project file beats the global value; a flag beats both.
    assert.equal(await h().run(['config', 'set', 'filterMode', 'filter', '--shared', '--cwd', project]), 0);
    assert.equal(await h().run(['claude', '--cwd', project]), 0);
    assert.equal(launches.at(-1)?.filterMode, 'filter');
    assert.equal(await h().run(['claude', '--cwd', project, '--filter', 'off']), 0);
    assert.equal(launches.at(-1)?.filterMode, 'off');

    assert.equal(await h().run(['config', 'unset', 'filterMode', '--global']), 0);
    const after = h();
    assert.equal(await after.run(['config', 'get', 'filterMode', '--cwd', elsewhere, '--json']), 0);
    assert.deepEqual(JSON.parse(after.out()), { key: 'filterMode', value: 'filter', source: 'default' });
    assert.equal(await h().run(['config', 'set', 'profile', 'no-such-profile', '--global']), 1);
    assert.equal(await h().run(['config', 'set', 'subagents', 'off', '--global', '--shared']), 1);
  } finally {
    for (const directory of [configDirectory, elsewhere, project]) await rm(directory, { recursive: true, force: true });
  }
});
