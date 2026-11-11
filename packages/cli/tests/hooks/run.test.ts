import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { hookSessionId, runHook } from '../../src/hooks/index.js';
import { launchClaude, readNativeOutput } from '../../src/native/index.js';
import { readLaunch, readStoredLaunch } from '../../src/native/storage.js';
import { getArtifact, getLaunch, getLaunches } from '../../src/ui/api.js';
import { hookFixture, phpunitOutput } from './fixture.js';

async function project(root: string) {
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { recursive: true });
  return cwd;
}

function event(cwd: string, fields: Record<string, unknown>) {
  return JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-1', tool_use_id: 'tool-1', tool_input: { command: 'vendor/bin/phpunit' }, cwd, ...fields });
}

test('Claude: a noisy Bash result is filtered, recorded like a native launch and recoverable', async t => {
  const f = await hookFixture(t, 'run-claude');
  const cwd = await project(f.root);
  const response = { stdout: phpunitOutput, stderr: 'A warning retained exactly.\n', interrupted: false, isImage: false };
  const reply = JSON.parse(await runHook('claude', event(cwd, { tool_name: 'Bash', tool_response: response }), f.options));
  const output = reply.hookSpecificOutput.updatedToolOutput;
  assert.equal(reply.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(output.stdout.length < phpunitOutput.length);
  assert.equal(output.stderr, response.stderr);
  const id = hookSessionId('claude', 'session-1');
  assert.ok(output.stdout.includes(`'native-output' '${id}'`));
  assert.ok(output.stdout.includes(`'${f.node}' '${f.main}'`));

  const { record, directory } = await readStoredLaunch(f.options.stateDirectory, id);
  assert.equal(record.launchId, id);
  assert.ok('origin' in record && record.origin === 'hook');
  assert.equal(record.provider, 'claude');
  assert.equal('origin' in record && record.agentSessionId, 'session-1');
  assert.equal(record.filterMode, 'filter');
  assert.equal(record.filterLevel, 'standard');
  assert.equal(record.cwd, cwd);
  // Resume and the launch hooks never take a hook session for a native launch.
  await assert.rejects(readLaunch(f.options.stateDirectory, id), /hook session/);

  const decisions = await readdir(path.join(directory, 'filters'));
  assert.equal(decisions.length, 1);
  const decision = JSON.parse(await readFile(path.join(directory, 'filters', decisions[0]!), 'utf8'));
  assert.equal(decision.status, 'filtered');
  const original = await readNativeOutput(id, decision.artifactId, { offset: 0, limit: 20000 }, f.options.stateDirectory);
  assert.ok(original.text.includes('OK (100 tests, 100 assertions)'));

  // A second event of the same session uses the same record.
  await runHook('claude', event(cwd, { tool_name: 'Bash', tool_use_id: 'tool-2', tool_response: response }), f.options);
  assert.equal((await readdir(path.join(directory, 'filters'))).length, 2);
  assert.deepEqual(await readdir(path.join(f.options.stateDirectory!, 'native')), [id]);

  // The UI lists the hook session without any change to its code.
  const directories = { configDirectory: f.options.configDirectory!, stateDirectory: f.options.stateDirectory! };
  const { launches } = await getLaunches(directories, null);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.origin, 'hook');
  assert.equal(launches[0]!.provider, 'claude');
  assert.equal(launches[0]!.profile, null);
  assert.equal(launches[0]!.totals.filtered, 2);
  const detail = await getLaunch(directories, id);
  assert.equal(detail.launch.launchId, id);
  assert.equal(detail.decisions.length, 2);
  const slice = await getArtifact(directories, id, decision.artifactId, 0, 20000);
  assert.ok(JSON.stringify(slice).includes('OK (100 tests'));
});

test('unchanged output, other tools, malformed input and native launches all leave output alone', async t => {
  const f = await hookFixture(t, 'run-noop');
  const cwd = await project(f.root);
  const short = event(cwd, { tool_name: 'Bash', tool_response: { stdout: 'ok\n', stderr: '' } });
  assert.equal(await runHook('claude', short, f.options), '{}');
  const id = hookSessionId('claude', 'session-1');
  const { directory } = await readStoredLaunch(f.options.stateDirectory, id);
  const [file] = await readdir(path.join(directory, 'filters'));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'filters', file!), 'utf8')).status, 'unchanged');

  const other = await hookFixture(t, 'run-other');
  const otherCwd = await project(other.root);
  assert.equal(await runHook('claude', event(otherCwd, { tool_name: 'Read', tool_response: { stdout: phpunitOutput } }), other.options), '{}');
  assert.equal(await runHook('claude', event(otherCwd, { tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_response: { stdout: phpunitOutput } }), other.options), '{}');
  assert.equal(await runHook('crush', event(otherCwd, { tool_name: 'edit', tool_response: phpunitOutput }), other.options), '{}');
  assert.equal(await runHook('claude', '{not json', other.options), '{}');
  assert.equal(await runHook('claude', '', other.options), '{}');
  assert.equal(await runHook('claude', event(otherCwd, { tool_name: 'Bash', session_id: 'bad\nid', tool_response: { stdout: phpunitOutput } }), other.options), '{}');
  assert.equal(await runHook('claude', event('relative/path', { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } }), other.options), '{}');
  assert.equal(await runHook('nobody' as 'claude', event(otherCwd, { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } }), other.options), '{}');
  const noisy = event(otherCwd, { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } });
  const launch = '0b7c3c84-6f27-4a5b-9d3b-1f6c2a0e4d11';
  assert.equal(await runHook('claude', noisy, { ...other.options, env: { FONN_CLAUDE_LAUNCH_ID: launch } }), '{}');
  assert.equal(await runHook('codex', noisy, { ...other.options, env: { FONN_CODEX_LAUNCH_ID: launch } }), '{}');
  await assert.rejects(readdir(path.join(other.options.stateDirectory!, 'native')), { code: 'ENOENT' });
  // A state folder that cannot be used fails open too.
  await writeFile(path.join(other.root, 'not a folder'), '');
  assert.equal(await runHook('claude', noisy, { ...other.options, stateDirectory: path.join(other.root, 'not a folder') }), '{}');
});

test('Codex replies with continue false and keeps problem lines', async t => {
  const f = await hookFixture(t, 'run-codex');
  const cwd = await project(f.root);
  const stdout = 'building module ok\n'.repeat(200) + 'Error: the build failed in step 3\n' + 'building module ok\n'.repeat(5);
  const reply = JSON.parse(await runHook('codex', event(cwd, { tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout, exit_code: 2 } }), f.options));
  assert.equal(reply.continue, false);
  const shown = JSON.parse(reply.stopReason);
  assert.ok(shown.stdout.length < stdout.length);
  assert.ok(shown.stdout.includes('Error: the build failed in step 3'));
  assert.equal(shown.exit_code, 2);
  const record = (await readStoredLaunch(f.options.stateDirectory, hookSessionId('codex', 'session-1'))).record;
  assert.equal(record.provider, 'codex');
});

test('Crush and OpenCode get updated_output for the bash tool', async t => {
  const f = await hookFixture(t, 'run-text');
  const cwd = await project(f.root);
  for (const agent of ['crush', 'opencode'] as const) {
    const reply = JSON.parse(await runHook(agent, event(cwd, { tool_name: 'bash', tool_response: phpunitOutput }), f.options));
    assert.equal(typeof reply.updated_output, 'string');
    assert.ok(reply.updated_output.length < phpunitOutput.length);
    assert.ok(reply.updated_output.includes('native-output'));
    assert.equal((await readStoredLaunch(f.options.stateDirectory, hookSessionId(agent, 'session-1'))).record.provider, agent);
  }
  // Each agent session is its own record.
  assert.equal((await readdir(path.join(f.options.stateDirectory!, 'native'))).length, 2);
  assert.equal(await runHook('crush', event(cwd, { tool_name: 'bash', tool_response: { stdout: phpunitOutput } }), f.options), '{}');
});

test('project settings choose the mode, and unapproved project rules are not applied', async t => {
  const f = await hookFixture(t, 'run-settings');
  const cwd = await project(f.root);
  await writeFile(path.join(cwd, '.fonn.json'), JSON.stringify({ filterMode: 'observe', rules: [{ name: 'drop', command: 'make', remove: ['building'] }] }));
  const reply = await runHook('claude', event(cwd, { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } }), f.options);
  assert.equal(reply, '{}');
  const { record, directory } = await readStoredLaunch(f.options.stateDirectory, hookSessionId('claude', 'session-1'));
  assert.equal(record.filterMode, 'observe');
  assert.equal(record.filterRules, undefined);
  const [file] = await readdir(path.join(directory, 'filters'));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'filters', file!), 'utf8')).status, 'observed');

  await writeFile(path.join(cwd, '.fonn.json'), JSON.stringify({ filterMode: 'off' }));
  const off = await hookFixture(t, 'run-off');
  assert.equal(await runHook('claude', event(cwd, { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } }), off.options), '{}');
  await assert.rejects(readdir(path.join(off.options.stateDirectory!, 'native')), { code: 'ENOENT' });
});

test('fonn claude marks its session so the global hook leaves it to the launch hook', async t => {
  const f = await hookFixture(t, 'run-marker');
  const cwd = await project(f.root);
  const capture = path.join(f.root, 'env.json');
  const executable = path.join(f.root, 'fake-claude');
  // A stand-in for Claude Code that only records its environment.
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('2.1.319 (Claude Code)'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ marker: process.env.FONN_CLAUDE_LAUNCH_ID }));
`, { mode: 0o700 });
  await writeFile(path.join(f.root, 'package.json'), '{"type":"commonjs"}');
  const code = await launchClaude({ cwd, stateDirectory: f.options.stateDirectory, configDirectory: f.options.configDirectory, executable, hookEntrypoint: f.main, profile: 'opus-high' });
  assert.equal(code, 0);
  const { marker } = JSON.parse(await readFile(capture, 'utf8'));
  assert.match(marker, /^[0-9a-f-]{36}$/);
  assert.equal((await readLaunch(f.options.stateDirectory, marker)).record.launchId, marker);
  assert.equal(await runHook('claude', event(cwd, { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } }), { ...f.options, env: { FONN_CLAUDE_LAUNCH_ID: marker } }), '{}');
});

test('each launch marker only skips its own agent', async t => {
  const f = await hookFixture(t, 'run-markers');
  const cwd = await project(f.root);
  const launch = '0b7c3c84-6f27-4a5b-9d3b-1f6c2a0e4d11';
  const both = { ...f.options, env: { FONN_CLAUDE_LAUNCH_ID: launch, FONN_CODEX_LAUNCH_ID: launch } };
  const insideClaude = { ...f.options, env: { FONN_CLAUDE_LAUNCH_ID: launch } };
  const insideCodex = { ...f.options, env: { FONN_CODEX_LAUNCH_ID: launch } };
  const shell = event(cwd, { tool_name: 'Bash', tool_response: { stdout: phpunitOutput } });
  const text = event(cwd, { tool_name: 'bash', tool_response: phpunitOutput });
  // Codex started inside fonn claude, and Claude inside fonn codex, still filter.
  assert.equal(JSON.parse(await runHook('codex', shell, insideClaude)).continue, false);
  assert.ok(JSON.parse(await runHook('claude', shell, insideCodex)).hookSpecificOutput);
  for (const agent of ['crush', 'opencode'] as const) {
    assert.equal(typeof JSON.parse(await runHook(agent, text, both)).updated_output, 'string');
  }
});
