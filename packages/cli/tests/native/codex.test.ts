import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, readFile, readdir, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createProfileStore } from '@nord-forge/fonn-core/profiles';
import { launchCodex, runCodexHook } from '../../src/native/codex.js';
import { launchClaude, readNativeOutput, runNativeHook } from '../../src/native/index.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, exitCode = 7) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const state = path.join(root, 'state with spaces');
  const capture = path.join(root, 'capture.json');
  const executable = path.join(root, 'fake-codex');
  const versionFile = path.join(root, 'version.txt');
  const config = path.join(root, 'config');
  await mkdir(cwd);
  await writeFile(versionFile, 'codex-cli 0.167.0');
  await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8')); process.exit(0); }
// Capture only synthetic test env and public launch markers, never real auth.
const keys = ['FONN_CODEX_LAUNCH_ID','FONN_CODEX_STATE_DIR'];
if (process.env.OPENAI_API_KEY === 'synthetic-test-key' && process.env.FONN_TEST_INHERIT === 'retained') keys.push('FONN_TEST_INHERIT','OPENAI_API_KEY','CODEX_HOME');
const env = Object.fromEntries(keys.map(key => [key,process.env[key]]));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,env,cwd:process.cwd()}));
process.exit(${JSON.stringify(exitCode)});
`, { mode: 0o700 });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const hookEntrypoint = path.join(root, "hook 'entry.js");
  await writeFile(hookEntrypoint, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  return { root, cwd, state, capture, executable, hookEntrypoint, config, versionFile };
}

test('Codex inherits auth/environment, snapshots its profile, and keeps hook definitions stable', async t => {
  const f = await fixture(t);
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_HOME: process.env.CODEX_HOME, FONN_TEST_INHERIT: process.env.FONN_TEST_INHERIT };
  Object.assign(process.env, { OPENAI_API_KEY: 'synthetic-test-key', CODEX_HOME: path.join(f.root, 'unchanged codex home'), FONN_TEST_INHERIT: 'retained' });
  t.after(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const profiles = createProfileStore(f.config);
  await profiles.create({ name: 'codex-light', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  await profiles.setDefault('codex-light');
  const options = { cwd: f.cwd, stateDirectory: f.state, configDirectory: f.config, executable: f.executable, hookEntrypoint: f.hookEntrypoint };
  const interrupts = process.listenerCount('SIGINT');
  const terminations = process.listenerCount('SIGTERM');
  assert.equal(await launchCodex({ ...options, args: ['--no-alt-screen', '--image', 'test.png', 'Explain this image'] }), 7);
  const first = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(first.args.slice(0, 4), ['--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(first.args.slice(-5), ['--no-alt-screen', '--image', 'test.png', '--', 'Explain this image']);
  assert.equal(first.cwd, f.cwd);
  assert.equal(first.env.OPENAI_API_KEY, 'synthetic-test-key');
  assert.equal(first.env.CODEX_HOME, process.env.CODEX_HOME);
  assert.equal(first.env.FONN_TEST_INHERIT, 'retained');
  assert.equal(first.env.FONN_CODEX_STATE_DIR, f.state);
  const hook = first.args[5] as string;
  assert.match(hook, /^hooks\.PostToolUse=\[\{matcher="Bash"/);
  assert.match(hook, /codex-hook/);
  const lifecycleHooks = first.args.filter((argument: string) => /^hooks\.(?:Session(?:Start|End)|SubagentStart)=/.test(argument));
  assert.equal(lifecycleHooks.length, 3);
  const command = JSON.parse(/command=("(?:\\.|[^"\\])*")/.exec(hook)![1]) as string;
  const invoked = await promisify(execFile)('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(invoked.stdout), ['codex-hook']);
  for (const [index, event] of ['SessionStart', 'SessionEnd', 'SubagentStart'].entries()) {
    assert.equal(lifecycleHooks[index], `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
  }
  assert.ok(!hook.includes(first.env.FONN_CODEX_LAUNCH_ID));
  assert.ok(!hook.includes(f.state));
  assert.ok(!first.args.some((argument: string) => /bypass|sandbox|approval|provider|CODEX_HOME/.test(argument)));
  assert.equal(await launchCodex({ ...options, args: ['future-command'] }), 7);
  const second = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(second.args[5], hook);
  assert.deepEqual(second.args.filter((argument: string) => /^hooks\./.test(argument)), [hook, ...lifecycleHooks]);
  assert.deepEqual(second.args.slice(-2), ['--', 'future-command']);
  assert.notEqual(second.env.FONN_CODEX_LAUNCH_ID, first.env.FONN_CODEX_LAUNCH_ID);
  assert.equal(process.listenerCount('SIGINT'), interrupts);
  assert.equal(process.listenerCount('SIGTERM'), terminations);
  const directory = path.join(f.state, 'native', first.env.FONN_CODEX_LAUNCH_ID);
  const record = JSON.parse(await readFile(path.join(directory, 'launch.json'), 'utf8'));
  assert.equal(record.provider, 'codex');
  assert.equal(record.subagents, 'auto');
  assert.deepEqual(record.profileSnapshot, { name: 'codex-light', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  assert.equal(record.exitCode, 7);
  assert.equal((await stat(path.join(directory, 'launch.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await profiles.edit('codex-light', { model: 'gpt-6.1-other', effort: 'high' });
  await profiles.setDefault('codex:sol-medium');
  await profiles.delete('codex-light');
  await writeFile(path.join(f.config, 'profiles.json'), '{ invalid configuration');
  await launchCodex({ ...options, profileSnapshot: record.profileSnapshot, resume: 'known-codex-session', args: ['--no-alt-screen'] });
  const resumed = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(resumed.args.slice(0, 4), ['--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(resumed.args.slice(-3), ['resume', 'known-codex-session', '--no-alt-screen']);
  assert.deepEqual(resumed.args.filter((argument: string) => /^hooks\./.test(argument)), [hook, ...lifecycleHooks]);
  await launchCodex({ ...options, profileSnapshot: record.profileSnapshot, resume: true });
  const picker = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(picker.args.at(-1), 'resume');
  assert.ok(!picker.args.includes('--last'));
  const informational = await fixture(t, 0);
  const messages: string[] = [];
  const stderr = t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { messages.push(String(chunk)); return true; });
  try {
    for (const args of [['--help'], ['--version']]) {
      assert.equal(await launchCodex({ cwd: informational.cwd, stateDirectory: informational.state, configDirectory: informational.config, executable: informational.executable, hookEntrypoint: informational.hookEntrypoint, args }), 0);
    }
  } finally { stderr.mock.restore(); }
  assert.doesNotMatch(messages.join(''), /resume|picker/i);
});

test('Codex rejects config/policy/auth/trust overrides, other commands, wrong profiles, and old versions before state', async t => {
  const f = await fixture(t);
  const options = { cwd: f.cwd, stateDirectory: f.state, configDirectory: f.config, executable: f.executable, hookEntrypoint: f.hookEntrypoint };
  for (const args of [
    ['--model=gpt-other'], ['-mfoo'], ['-cmodel="other"'], ['--config', 'hooks={}'], ['--profile=other'], ['-pother'],
    ['--oss'], ['--local-provider=ollama'], ['--api-key=key'], ['--codex-home=other'], ['--sandbox=read-only'], ['-sworkspace-write'],
    ['--ask-for-approval=never'], ['-anever'], ['--full-auto'], ['--yolo'], ['--dangerously-bypass-approvals-and-sandbox'],
    ['--dangerously-bypass-hook-trust'], ['--enable', 'hooks'], ['--unknown'], ['--image'],
    ['exec', 'hello'], ['review'], ['--no-alt-screen', 'login'], ['cloud'], ['resume'], ['fork'], ['help'], ['two', 'prompts'],
    ['agents'], ['remote-control'], ['exec-server'], ['queue'], ['archive'], ['delete'], ['migrate-rollouts'], ['migrate-nfs-db'], ['unarchive'],
  ]) await assert.rejects(launchCodex({ ...options, args }), /native Codex launcher/);
  await assert.rejects(launchCodex({ ...options, profile: 'opus-medium' }), /provider|claude|codex/i);
  await writeFile(f.versionFile, 'codex-cli 0.166.9');
  await assert.rejects(launchCodex(options), /0\.167\.0/);
  await writeFile(f.versionFile, 'codex-cli 0.167.0-alpha');
  await assert.rejects(launchCodex(options), /0\.167\.0/);
  await assert.rejects(launchCodex({ ...options, subagents: 'invalid' as never }), /auto|off/);
  await assert.rejects(stat(f.state), { code: 'ENOENT' });
});

test('Codex off/observe/filter preserve originals, diagnostics, unknown responses, and provider isolation', async t => {
  const f = await fixture(t);
  const options = { cwd: f.cwd, stateDirectory: f.state, configDirectory: f.config, executable: f.executable, hookEntrypoint: f.hookEntrypoint };
  const stdout = 'PHPUnit 12.0.0 by Sebastian Bergmann and contributors.\n' + ('.'.repeat(60) + ' 100 / 100 (100%)\n').repeat(70) + '\nTime: 00:00.100\nOK (100 tests, 100 assertions)\n';
  const response = { stdout, stderr: 'Warning retained exactly.\n', exit_code: 0, extra: { retained: true } };
  const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'vendor/bin/phpunit' }, tool_response: response, session_id: 'test-session', tool_use_id: 'test-tool', cwd: f.cwd };
  for (const mode of ['off', 'observe', 'filter'] as const) {
    await launchCodex({ ...options, filterMode: mode, ...(mode === 'off' ? { subagents: 'off' as const } : {}) });
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    const id = capture.env.FONN_CODEX_LAUNCH_ID;
    assert.equal(capture.args.filter((arg: string) => /^hooks\./.test(arg)).length, mode === 'off' ? 0 : 4);
    const lifecycle = { session_id: 'tracked-codex-session', cwd: f.cwd };
    const parentEvent = { ...lifecycle, hook_event_name: 'SessionStart' };
    const context = await runCodexHook(parentEvent, f.state, id) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
    if (mode === 'off') assert.deepEqual(context, {});
    else {
      assert.equal(context.hookSpecificOutput!.hookEventName, 'SessionStart');
      assert.match(context.hookSpecificOutput!.additionalContext, /built-in native subagents/);
    }
    assert.deepEqual(await runCodexHook({ ...lifecycle, hook_event_name: 'SessionEnd' }, f.state, id), {});
    assert.deepEqual(await runNativeHook(parentEvent, f.state, id), {});
    for (const marker of ['agent_id', 'parent_session_id', 'parent_agent_id', 'subagent_type']) {
      assert.deepEqual(await runCodexHook({ ...parentEvent, session_id: 'child-session', [marker]: undefined }, f.state, id), {});
      assert.deepEqual(await runCodexHook({ ...parentEvent, hook_event_name: 'SessionEnd', session_id: 'child-session', [marker]: undefined }, f.state, id), {});
    }
    const workerEvent = { hook_event_name: 'SubagentStart', agent_id: 'codex-child', agent_type: 'explorer', model: 'gpt-6.1-sol' };
    const notice = await runCodexHook(workerEvent, f.state, id) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
    if (mode === 'off') assert.deepEqual(notice, {});
    else {
      assert.equal(notice.hookSpecificOutput!.hookEventName, 'SubagentStart');
      assert.match(notice.hookSpecificOutput!.additionalContext, new RegExp(`Fonn filtering mode: ${mode}`));
      assert.match(notice.hookSpecificOutput!.additionalContext, /bounded native-output recovery/);
      assert.match(notice.hookSpecificOutput!.additionalContext, /or delegate further/);
    }
    assert.deepEqual(await runNativeHook(workerEvent, f.state, id), {});
    const sessionFile = path.join(f.state, 'native', id, 'session.json');
    if (mode === 'off') await assert.rejects(stat(sessionFile), { code: 'ENOENT' });
    else {
      const session = JSON.parse(await readFile(sessionFile, 'utf8'));
      assert.equal(session.sessionId, lifecycle.session_id);
      assert.equal(session.provider, 'codex');
      assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await runCodexHook({ hook_event_name: 'SessionEnd', session_id: '--invalid' }, f.state, id), {});
    assert.deepEqual(await runCodexHook({ hook_event_name: 'SessionEnd', session_id: 'any' }, f.state, 'invalid-launch-id'), {});
    const output = await runCodexHook({ ...event, agent_id: 'worker-observation', agent_type: 'explorer', model: 'gpt-6.1-sol' }, f.state, id) as { continue?: boolean; stopReason?: string };
    assert.deepEqual(await runNativeHook(event, f.state, id), {});
    const directory = path.join(f.state, 'native', id);
    const [metrics] = await readdir(path.join(directory, 'filters'));
    const decision = JSON.parse(await readFile(path.join(directory, 'filters', metrics), 'utf8'));
    assert.equal(decision.status, mode === 'filter' ? 'filtered' : mode === 'observe' ? 'observed' : 'unchanged');
    if (mode === 'filter') {
      assert.equal(output.continue, false);
      assert.deepEqual(Object.keys(output), ['continue', 'stopReason']);
      const filtered = JSON.parse(output.stopReason!);
      assert.ok(filtered.stdout.length < stdout.length);
      assert.match(filtered.stdout, /native-output/);
      assert.equal(filtered.stderr, response.stderr);
      assert.equal(filtered.exit_code, 0);
      assert.deepEqual(filtered.extra, response.extra);
      const recovered = await readNativeOutput(id, decision.artifactId, { limit: 20000 }, f.state);
      assert.deepEqual(JSON.parse(recovered.text), response);
      const before = new Set(await readdir(path.join(directory, 'filters')));
      const child = await runCodexHook({ ...event, tool_use_id: 'codex-child-tool', agent_id: 'codex-child', agent_type: 'explorer', model: 'gpt-6.1-sol' }, f.state, id) as { continue: boolean; stopReason: string };
      assert.equal(child.continue, false);
      assert.ok(JSON.parse(child.stopReason).stdout.length < stdout.length);
      const childFile = (await readdir(path.join(directory, 'filters'))).find(file => !before.has(file))!;
      const childDecision = JSON.parse(await readFile(path.join(directory, 'filters', childFile), 'utf8'));
      assert.equal(childDecision.status, 'filtered');
      assert.deepEqual(JSON.parse((await readNativeOutput(id, childDecision.artifactId, { limit: 20000 }, f.state)).text), response);
      const metadata = path.join(directory, 'launch.json');
      const saved = JSON.parse(await readFile(metadata, 'utf8'));
      await writeFile(metadata, JSON.stringify({ ...saved, subagents: 'off' }));
      assert.deepEqual(await runCodexHook(parentEvent, f.state, id), {});
      assert.deepEqual(await runCodexHook(workerEvent, f.state, id), notice);
      const bounded = await readNativeOutput(id, decision.artifactId, { limit: 20 }, f.state);
      assert.equal(bounded.text.length, 20);
      assert.equal(bounded.nextOffset, 20);
      assert.deepEqual(await runCodexHook({ ...event, tool_response: { content: [{ type: 'text', text: stdout }] } }, f.state, id), {});
      assert.deepEqual(await runCodexHook({ ...event, tool_response: 'Unknown output\n'.repeat(300) }, f.state, id), {});
      assert.deepEqual(await runCodexHook({ ...event, tool_response: { ...response, is_error: true } }, f.state, id), {});
      const stringOutput = await runCodexHook({ ...event, tool_response: stdout }, f.state, id) as { continue: boolean; stopReason: string };
      assert.equal(stringOutput.continue, false);
      assert.match(stringOutput.stopReason, /OK \(100 tests, 100 assertions\)/);
    } else assert.deepEqual(output, {});
  }
  await launchCodex({ ...options, filterMode: 'off' });
  const guidanceOnly = JSON.parse(await readFile(f.capture, 'utf8'));
  const guidanceId = guidanceOnly.env.FONN_CODEX_LAUNCH_ID;
  assert.equal(guidanceOnly.args.filter((argument: string) => /^hooks\./.test(argument)).length, 1);
  assert.ok(guidanceOnly.args.some((argument: string) => /^hooks\.SessionStart=/.test(argument)));
  const guidance = await runCodexHook({ hook_event_name: 'SessionStart', session_id: 'guidance-only' }, f.state, guidanceId) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(guidance.hookSpecificOutput.additionalContext, /built-in native subagents/);
  await assert.rejects(stat(path.join(f.state, 'native', guidanceId, 'session.json')), { code: 'ENOENT' });
  assert.deepEqual(await runCodexHook({ hook_event_name: 'SubagentStart', agent_id: 'child' }, f.state, guidanceId), {});
  // A legacy Claude record has no provider field and must never run this adapter.
  const [id] = await readdir(path.join(f.state, 'native'));
  const metadata = path.join(f.state, 'native', id, 'launch.json');
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  delete record.provider;
  record.profile = 'opus-medium';
  delete record.profileSnapshot;
  await writeFile(metadata, JSON.stringify(record));
  assert.deepEqual(await runCodexHook(event, f.state, id), {});
  // Claude also rejects a Codex-only profile before starting a process.
  await assert.rejects(launchClaude({ ...options, profile: 'codex:sol-medium' }), /provider|claude|codex/i);
});
