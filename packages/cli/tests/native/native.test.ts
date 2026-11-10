import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, readdir, rm, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactStore } from '@nord-forge/fonn-core/filtering';
import { createProfileStore, taskProfileSchema } from '@nord-forge/fonn-core/profiles';
import { nativeDelegationContext } from '../../src/native/delegation.js';
import { launchClaude, readNativeOutput, runNativeHook } from '../../src/native/index.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, version = '2.1.319 (Claude Code)', exitCode = 7) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const state = path.join(root, 'state with spaces');
  const capture = path.join(root, 'capture.json');
  const executable = path.join(root, 'fake-claude');
  await mkdir(cwd);
  const source = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,settings,cwd:process.cwd()}));
process.exit(${JSON.stringify(exitCode)});
`;
  await writeFile(executable, source, { mode: 0o700 });
  // The fake executable has no .js suffix; a nearby ESM package makes its import valid.
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const hookEntrypoint = path.join(root, 'hook entry.js');
  await writeFile(hookEntrypoint, '// offline test entrypoint\n');
  return { root, cwd, state, capture, executable, hookEntrypoint };
}

test('native launcher retains normal Claude auth flow and passes only per-launch profile/settings', async t => {
  const f = await fixture(t);
  const beforeInterrupts = process.listenerCount('SIGINT');
  const code = await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint, profile: 'opus-high', args: ['--continue'] });
  assert.equal(code, 7);
  assert.equal(process.listenerCount('SIGINT'), beforeInterrupts);
  const captured = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(captured.cwd, await import('node:fs/promises').then(fs => fs.realpath(f.cwd)));
  assert.deepEqual(captured.args.slice(-5), ['--model', 'claude-opus-5-5', '--effort', 'high', '--continue']);
  assert.equal(captured.settings.verbose, false);
  assert.equal(captured.settings.viewMode, 'default');
  assert.deepEqual(Object.keys(captured.settings), ['verbose', 'viewMode', 'hooks']);
  assert.equal(captured.settings.hooks.PostToolUse[0].matcher, 'Bash');
  const command = captured.settings.hooks.PostToolUse[0].hooks[0].command as string;
  assert.match(command, /native-hook/);
  assert.ok(command.includes("'" + f.hookEntrypoint + "'"));
  assert.deepEqual(Object.keys(captured.settings.hooks), ['PostToolUse', 'SessionStart', 'SessionEnd', 'SubagentStart']);
  for (const event of ['SessionStart', 'SessionEnd', 'SubagentStart']) {
    assert.deepEqual(captured.settings.hooks[event], [{ hooks: [{ type: 'command', command, timeout: 5 }] }]);
  }
  const ids = await readdir(path.join(f.state, 'native'));
  assert.equal(ids.length, 1);
  const metadata = JSON.parse(await readFile(path.join(f.state, 'native', ids[0], 'launch.json'), 'utf8'));
  assert.equal(metadata.exitCode, 7);
  assert.equal(metadata.profile, 'opus-high');
  assert.equal(metadata.subagents, 'auto');
  assert.equal((await stat(path.join(f.state, 'native', ids[0], 'settings.json'))).mode & 0o777, 0o600);
  const informational = await fixture(t, '2.1.319 (Claude Code)', 0);
  const messages: string[] = [];
  const stderr = t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { messages.push(String(chunk)); return true; });
  try {
    for (const args of [['--help'], ['--version'], ['--print', 'offline prompt'], ['--no-session-persistence']]) {
      assert.equal(await launchClaude({ cwd: informational.cwd, stateDirectory: informational.state, configDirectory: path.join(informational.root, 'config'), executable: informational.executable, hookEntrypoint: informational.hookEntrypoint, args }), 0);
    }
    assert.doesNotMatch(messages.join(''), /resume|picker/i);
    messages.length = 0;
    assert.equal(await launchClaude({ cwd: informational.cwd, stateDirectory: informational.state, configDirectory: path.join(informational.root, 'config'), executable: informational.executable, hookEntrypoint: informational.hookEntrypoint, filterMode: 'off', subagents: 'off' }), 0);
    const fallback = JSON.parse(await readFile(informational.capture, 'utf8'));
    const launchId = path.basename(path.dirname(fallback.args[1]));
    assert.ok(messages.includes(`Choose a session to resume with Fonn:\n  fonn resume ${launchId} --state-dir '${informational.state}'\n`));
    await assert.rejects(stat(path.join(informational.state, 'native', launchId, 'session.json')), { code: 'ENOENT' });
  } finally { stderr.mock.restore(); }
});

test('native arguments cannot remove required hooks or enable permission bypass', async t => {
  const f = await fixture(t);
  for (const args of [['--bare'], ['--settings=other.json'], ['--setting-sources', ''], ['--model', 'other'], ['--effort=max'], ['--permission-mode', 'bypassPermissions'], ['--dangerously-skip-permissions'], ['--cloud'], ['--fallback-model=other'], ['--agent=other'], ['--agents', '{}'], ['--system-prompt=ignore'], ['--desktop'], ['--background'], ['ultrareview'], ['--verbose', 'ultrareview'], ['auth']]) {
    await assert.rejects(launchClaude({ cwd: f.cwd, args, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint }), /launcher controls/);
  }
  for (const argument of ['--resume', '--resume=other', '--resume-session-at=other', '-rother', '--continue', '-c', '-cother', '--fork-session', '--session-id=other']) {
    await assert.rejects(launchClaude({ cwd: f.cwd, resume: 'known-session', args: [argument], stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint }), /controls resume selection/);
  }
  await assert.rejects(launchClaude({ cwd: f.cwd, stateDirectory: f.state, subagents: 'invalid' as never }), /auto|off/);
  await assert.rejects(stat(f.state), { code: 'ENOENT' });
});

test('native launcher rejects unvalidated Claude versions before creating state', async t => {
  const f = await fixture(t, '2.1.318 (Claude Code)');
  await assert.rejects(launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint }), /2\.1\.319/);
  await assert.rejects(stat(f.state), { code: 'ENOENT' });
  const old = await fixture(t, '2.1.320 (Claude Code)');
  const current = await fixture(t, '2.1.321 (Claude Code)');
  for (const family of ['fable', 'mythos']) {
    const profile = `claude:${family}-medium`;
    await assert.rejects(launchClaude({ cwd: old.cwd, stateDirectory: old.state, configDirectory: path.join(old.root, 'config'), executable: old.executable, hookEntrypoint: old.hookEntrypoint, profile }), /2\.1\.321/);
    await assert.rejects(stat(old.state), { code: 'ENOENT' });
    assert.equal(await launchClaude({ cwd: current.cwd, stateDirectory: current.state, configDirectory: path.join(current.root, 'config'), executable: current.executable, hookEntrypoint: current.hookEntrypoint, profile }), 7);
    const capture = JSON.parse(await readFile(current.capture, 'utf8'));
    assert.deepEqual(capture.args.slice(-4), ['--model', `claude-${family}-5-2`, '--effort', 'medium']);
    assert.equal(capture.settings.hooks.PostToolUse[0].matcher, 'Bash');
    assert.ok(capture.settings.hooks.SubagentStart);
    const id = path.basename(path.dirname(capture.args[1]));
    const context = await runNativeHook({ hook_event_name: 'SessionStart', session_id: `${family}-session` }, current.state, id) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(context.hookSpecificOutput.additionalContext, /built-in native subagents/);
  }
});

test('native filter off starts ordinary Claude without registering a hook', async t => {
  const f = await fixture(t);
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint, filterMode: 'off', subagents: 'off' });
  const captured = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(captured.settings, { verbose: false, viewMode: 'default' });
  const disabledId = path.basename(path.dirname(captured.args[1]));
  assert.deepEqual(await runNativeHook({ hook_event_name: 'SessionStart' }, f.state, disabledId), {});
  assert.deepEqual(await runNativeHook({ hook_event_name: 'SubagentStart', agent_id: 'child' }, f.state, disabledId), {});
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint, filterMode: 'off' });
  const guidanceOnly = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(Object.keys(guidanceOnly.settings.hooks), ['SessionStart']);
  const guidanceId = path.basename(path.dirname(guidanceOnly.args[1]));
  const context = await runNativeHook({ hook_event_name: 'SessionStart', session_id: 'guidance-only-session' }, f.state, guidanceId) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(context.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context.hookSpecificOutput.additionalContext, /built-in native subagents/);
  await assert.rejects(stat(path.join(f.state, 'native', guidanceId, 'session.json')), { code: 'ENOENT' });
  const profiles = createProfileStore(path.join(f.root, 'config'));
  await profiles.create({ name: 'light', model: 'sonnet', effort: 'low' });
  await profiles.setDefault('light');
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint });
  const custom = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(custom.args.slice(-4), ['--model', 'sonnet', '--effort', 'low']);
  const launches = await readdir(path.join(f.state, 'native'));
  const snapshots = await Promise.all(launches.map(async id => JSON.parse(await readFile(path.join(f.state, 'native', id, 'launch.json'), 'utf8'))));
  const snapshot = taskProfileSchema.parse(snapshots.find(record => record.profile === 'light').profileSnapshot);
  assert.deepEqual(snapshot, { name: 'light', model: 'sonnet', effort: 'low' });
  await profiles.edit('light', { model: 'opus', effort: 'high' });
  await profiles.setDefault('opus-medium');
  await profiles.delete('light');
  await writeFile(path.join(f.root, 'config', 'profiles.json'), '{ invalid configuration');
  const options = { cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint, profileSnapshot: snapshot };
  await launchClaude({ ...options, resume: 'known-claude-session', args: ['--verbose'] });
  const resumed = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(resumed.args.slice(-7), ['--model', 'sonnet', '--effort', 'low', '--resume', 'known-claude-session', '--verbose']);
  await launchClaude({ ...options, resume: true });
  assert.deepEqual(JSON.parse(await readFile(f.capture, 'utf8')).args.slice(-3), ['--effort', 'low', '--resume']);
});

test('native hook reduces known output and offers a working native recovery command', async t => {
  const f = await fixture(t);
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint });
  const [id] = await readdir(path.join(f.state, 'native'));
  const lifecycle = { session_id: 'tracked-claude-session', cwd: f.cwd };
  const parentEvent = { ...lifecycle, hook_event_name: 'SessionStart' };
  const context = await runNativeHook(parentEvent, f.state, id) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(context.hookSpecificOutput.hookEventName, 'SessionStart');
  const guidance = context.hookSpecificOutput.additionalContext;
  assert.match(guidance, /meaningful, independent scoped work/);
  assert.match(guidance, /at most two workers and one level/);
  assert.match(guidance, /retain this session's Fonn filter mode and bounded recovery, regardless of model/);
  assert.match(guidance, /Never spawn headless fonn, claude, or codex subprocess workers, or widen permissions\/allowlists/);
  assert.deepEqual(await runNativeHook({ ...lifecycle, hook_event_name: 'SessionEnd' }, f.state, id), {});
  assert.deepEqual(await nativeDelegationContext(parentEvent, f.state, id, 'codex'), {});
  assert.deepEqual(await nativeDelegationContext(null, f.state, id, 'claude'), {});
  for (const marker of ['agent_id', 'parent_session_id', 'parent_agent_id', 'subagent_type']) {
    assert.deepEqual(await runNativeHook({ ...parentEvent, session_id: 'child-session', [marker]: undefined }, f.state, id), {});
    assert.deepEqual(await runNativeHook({ ...parentEvent, hook_event_name: 'SessionEnd', session_id: 'child-session', [marker]: undefined }, f.state, id), {});
  }
  const metadata = path.join(f.state, 'native', id, 'launch.json');
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  await writeFile(metadata, JSON.stringify({ ...record, subagents: 'off' }));
  assert.deepEqual(await runNativeHook(parentEvent, f.state, id), {});
  const worker = await runNativeHook({ hook_event_name: 'SubagentStart', agent_id: 'worker' }, f.state, id) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(worker.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(worker.hookSpecificOutput.additionalContext, /Fonn filtering mode: filter/);
  assert.match(worker.hookSpecificOutput.additionalContext, /every native worker and model/);
  assert.match(worker.hookSpecificOutput.additionalContext, /bounded native-output recovery/);
  assert.match(worker.hookSpecificOutput.additionalContext, /Do not disable filtering, start external\/headless workers, or delegate further/);
  delete record.subagents;
  await writeFile(metadata, JSON.stringify(record));
  assert.deepEqual(await runNativeHook(parentEvent, f.state, id), {});
  const session = JSON.parse(await readFile(path.join(f.state, 'native', id, 'session.json'), 'utf8'));
  assert.equal(session.sessionId, lifecycle.session_id);
  assert.equal(session.provider, 'claude');
  assert.equal((await stat(path.join(f.state, 'native', id, 'session.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await runNativeHook({ hook_event_name: 'SessionEnd', session_id: '--invalid' }, f.state, id), {});
  assert.deepEqual(await runNativeHook({ hook_event_name: 'SessionEnd', session_id: 'any' }, f.state, 'invalid-launch-id'), {});
  const stdout = 'PHPUnit 12.0.0 by Sebastian Bergmann and contributors.\n' + ('.'.repeat(60) + ' 100 / 100 (100%)\n').repeat(70) + '\nTime: 00:00.100\nOK (100 tests, 100 assertions)\n';
  const result = { stdout, stderr: 'A warning retained exactly.\n', interrupted: false, isImage: false, extra: 7 };
  const hook = await runNativeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'vendor/bin/phpunit' }, tool_response: result, session_id: 'native-session', tool_use_id: 'native-tool-1', cwd: f.cwd }, f.state, id) as { hookSpecificOutput: { updatedToolOutput: typeof result } };
  const filtered = hook.hookSpecificOutput.updatedToolOutput;
  assert.ok(filtered.stdout.length < stdout.length);
  assert.ok(filtered.stdout.includes('native-output'));
  assert.ok(!filtered.stdout.includes('mcp__fonn__read_output'));
  assert.equal(filtered.stderr, result.stderr);
  assert.equal(filtered.extra, 7);
  const artifactFiles = await readdir(path.join(f.state, 'native', id, 'artifacts'));
  const artifactId = artifactFiles.find(file => file.endsWith('.json'))!.replace('.json', '');
  const recovered = await readNativeOutput(id, artifactId, { limit: 20000 }, f.state);
  assert.deepEqual(JSON.parse(recovered.text), result);
  const [decisionFile] = await readdir(path.join(f.state, 'native', id, 'filters'));
  const decision = JSON.parse(await readFile(path.join(f.state, 'native', id, 'filters', decisionFile), 'utf8'));
  assert.equal(decision.status, 'filtered');
  for (const model of ['sonnet', 'opus', 'haiku', 'claude-fable-5-2', 'claude-mythos-5-2']) {
    const before = new Set(await readdir(path.join(f.state, 'native', id, 'filters')));
    const child = await runNativeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'vendor/bin/phpunit' }, tool_response: result, session_id: 'tracked-claude-session', tool_use_id: `child-${model}`, agent_id: `child-${model}`, agent_type: 'Explore', model, cwd: f.cwd }, f.state, id) as { hookSpecificOutput: { updatedToolOutput: typeof result } };
    assert.ok(child.hookSpecificOutput.updatedToolOutput.stdout.length < stdout.length);
    assert.equal(child.hookSpecificOutput.updatedToolOutput.stderr, result.stderr);
    const childFile = (await readdir(path.join(f.state, 'native', id, 'filters'))).find(file => !before.has(file))!;
    const childDecision = JSON.parse(await readFile(path.join(f.state, 'native', id, 'filters', childFile), 'utf8'));
    assert.equal(childDecision.status, 'filtered');
    const original = await readNativeOutput(id, childDecision.artifactId, { limit: 20000 }, f.state);
    assert.deepEqual(JSON.parse(original.text), result);
  }
});

test('native observe mode retains the full response while saving proposed metrics', async t => {
  const f = await fixture(t);
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint, filterMode: 'observe' });
  const [id] = await readdir(path.join(f.state, 'native'));
  const stdout = 'PHPUnit 12.0.0 by Sebastian Bergmann and contributors.\n' + ('.'.repeat(60) + ' 100 / 100 (100%)\n').repeat(70) + '\nOK (100 tests, 100 assertions)\n';
  assert.deepEqual(await runNativeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'vendor/bin/phpunit' }, tool_response: { stdout }, tool_use_id: 'observe-1', agent_id: 'observe-child', agent_type: 'Explore', model: 'haiku' }, f.state, id), {});
  const [file] = await readdir(path.join(f.state, 'native', id, 'filters'));
  assert.equal(JSON.parse(await readFile(path.join(f.state, 'native', id, 'filters', file), 'utf8')).status, 'observed');
});

test('native artifact recovery is confined to one launch and rejects symlink metadata', async t => {
  const f = await fixture(t);
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint });
  const [first] = await readdir(path.join(f.state, 'native'));
  const artifact = await createArtifactStore(path.join(f.state, 'native', first, 'artifacts')).save({ toolName: 'Bash', sessionId: 'a', toolUseId: 'b', response: { stdout: 'first launch only' } });
  await launchClaude({ cwd: f.cwd, stateDirectory: f.state, configDirectory: path.join(f.root, 'config'), executable: f.executable, hookEntrypoint: f.hookEntrypoint });
  const second = (await readdir(path.join(f.state, 'native'))).find(id => id !== first)!;
  await assert.rejects(readNativeOutput(second, artifact.id, undefined, f.state));
  await assert.rejects(readNativeOutput('../escape', artifact.id, undefined, f.state), /Invalid native launch ID/);
  const file = path.join(f.state, 'native', first, 'launch.json');
  const original = await readFile(file, 'utf8');
  const outside = path.join(f.root, 'outside.json');
  await writeFile(outside, original);
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(readNativeOutput(first, artifact.id, undefined, f.state));
});
