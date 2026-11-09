import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProfileProvider, TaskProfile } from '@nord-forge/fonn-core/contracts';
import { createProfileStore } from '@nord-forge/fonn-core/profiles';
import { resumeNativeLaunch } from '../../src/native/resume.js';
import { captureNativeSession, nativeResumeArguments, printNativeResumeHint, readNativeSession, resolveNativeProfile } from '../../src/native/session.js';
import { atomicJson, launchDirectory, shellQuote } from '../../src/native/storage.js';
import type { LaunchRecord } from '../../src/native/storage.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const state = path.join(root, "state 'with spaces");
  const config = path.join(root, 'config');
  const capture = path.join(root, 'capture.json');
  const hookEntrypoint = path.join(root, 'hook.cjs');
  await mkdir(cwd);
  await writeFile(hookEntrypoint, '');
  return { root, cwd, state, config, capture, hookEntrypoint };
}

async function saveLaunch(f: Awaited<ReturnType<typeof fixture>>, profile: TaskProfile, legacy = false) {
  const launchId = randomUUID();
  const location = await launchDirectory(f.state, launchId, true);
  const record: LaunchRecord = {
    schemaVersion: 1, launchId, cwd: f.cwd, profile: profile.name,
    ...(legacy ? {} : { provider: profile.provider ?? 'claude', profileSnapshot: profile }),
    filterMode: 'observe', createdAt: new Date().toISOString(), hookEntrypoint: f.hookEntrypoint,
  };
  await atomicJson(path.join(location.directory, 'launch.json'), record);
  return { record, directory: location.directory, file: path.join(location.directory, 'session.json') };
}

async function stderrFrom(action: () => Promise<void>): Promise<string> {
  const previous = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try { await action(); }
  finally { process.stderr.write = previous; }
  return output;
}

test('native tracking validates lifecycle/provider boundaries, bounded private metadata and safe resume hints', async t => {
  const f = await fixture(t);
  const saved = await saveLaunch(f, { name: 'saved', model: 'sonnet', effort: 'medium' });
  const id = saved.record.launchId;
  const event = { hook_event_name: 'SessionStart', session_id: 'thr_123:abc.456' };
  assert.equal(await readNativeSession(f.state, id), undefined);
  for (const value of [null, {}, { ...event, hook_event_name: 'PostToolUse' }, { ...event, agent_id: 'child' }, ...['', '-bad', ' a', 'a\n', '../escape', 'a/../escape', 'a/./b', 'a/b', 'a\\b', 'a'.repeat(129)].map(session_id => ({ ...event, session_id }))]) {
    await captureNativeSession(value, f.state, id, 'claude');
  }
  await captureNativeSession(event, f.state, id, 'codex');
  assert.equal(await readNativeSession(f.state, id), undefined);
  const codex = await saveLaunch(f, { name: 'saved-codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
  await captureNativeSession({ ...event, agent_id: 'child' }, f.state, codex.record.launchId, 'codex');
  assert.equal(await readNativeSession(f.state, codex.record.launchId), undefined);
  await captureNativeSession(event, f.state, codex.record.launchId, 'codex');
  assert.equal(await readNativeSession(f.state, codex.record.launchId), event.session_id);
  codex.record.filterMode = 'off';
  await atomicJson(path.join(codex.directory, 'launch.json'), codex.record);
  await rm(codex.file);
  await captureNativeSession(event, f.state, codex.record.launchId, 'codex');
  assert.equal(await readNativeSession(f.state, codex.record.launchId), undefined);
  const original = await readFile(path.join(saved.directory, 'launch.json'), 'utf8');
  for (const session_id of [randomUUID(), 'abc123', event.session_id]) {
    await captureNativeSession({ ...event, hook_event_name: 'SessionEnd', session_id }, f.state, id, 'claude');
    assert.equal(await readNativeSession(f.state, id), session_id);
  }
  assert.equal(await readFile(path.join(saved.directory, 'launch.json'), 'utf8'), original);
  assert.equal((await stat(saved.file)).mode & 0o777, 0o600);
  const command = `fonn resume ${id} --state-dir ${shellQuote(f.state)}`;
  assert.equal(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, [], 7)), `Resume with Fonn:\n  ${command}\n`);
  for (const args of [['--help'], ['-V'], ['--print=hello'], ['--no-session-persistence'], ['--bare'], ['--init-only']]) {
    assert.equal(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, args, 0)), '');
  }
  assert.match(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, ['--', '--print'], 0)), /^Resume with Fonn:/);
  const valid = await readFile(saved.file, 'utf8');
  for (const corrupt of ['{', '{"private":"synthetic-session-secret", broken}', ' '.repeat(4097), JSON.stringify({ ...JSON.parse(valid), launchId: randomUUID() }), JSON.stringify({ ...JSON.parse(valid), provider: 'codex' }), JSON.stringify({ ...JSON.parse(valid), sessionId: '-bad' }), JSON.stringify({ ...JSON.parse(valid), sessionId: 'abc\n' })]) {
    await writeFile(saved.file, corrupt);
    await assert.rejects(readNativeSession(f.state, id), error => {
      assert.equal((error as Error).message, 'Invalid native session metadata.');
      assert.ok(!(error as Error).message.includes('synthetic-session-secret'));
      return true;
    });
    assert.equal(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, [], 0)), '');
  }
  await rm(saved.file);
  const outside = path.join(f.root, 'outside.json');
  await writeFile(outside, valid);
  await symlink(outside, saved.file);
  await assert.rejects(readNativeSession(f.state, id));
  assert.equal(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, [], 0)), '');
  await rm(saved.file);
  assert.equal(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, [], 1)), '');
  for (const exitCode of [0, 130, 143]) {
    assert.equal(await stderrFrom(() => printNativeResumeHint(saved.record, f.state, [], exitCode)), `Choose a session to resume with Fonn:\n  ${command}\n`);
  }
  assert.deepEqual(nativeResumeArguments('claude', true), ['--resume']);
  assert.deepEqual(nativeResumeArguments('codex', 'thr_123'), ['resume', 'thr_123']);
  assert.deepEqual(nativeResumeArguments('codex', undefined), []);
  assert.throws(() => nativeResumeArguments('claude', '--last'));
  for (const sessionId of ['abc/def', 'abc\\def', 'abc\n']) assert.throws(() => nativeResumeArguments('codex', sessionId));
  const snapshot = { name: 'saved', model: 'sonnet', effort: 'high' } as const;
  const resolved = await resolveNativeProfile({ cwd: f.cwd, profile: 'saved', profileSnapshot: snapshot, configDirectory: path.join(f.root, 'unread') }, 'claude');
  assert.ok(Object.isFrozen(resolved));
  assert.notEqual(resolved, snapshot);
  await assert.rejects(resolveNativeProfile({ cwd: f.cwd, profile: 'other', profileSnapshot: snapshot }, 'claude'));
  await assert.rejects(resolveNativeProfile({ cwd: f.cwd, profileSnapshot: snapshot }, 'codex'));
});

test('native replay restores deleted profile snapshots for both providers and uses an explicit picker when tracking is absent', async t => {
  const f = await fixture(t);
  const previousConfig = process.env.FONN_CONFIG_DIR;
  process.env.FONN_CONFIG_DIR = f.config;
  t.after(async () => { if (previousConfig === undefined) delete process.env.FONN_CONFIG_DIR; else process.env.FONN_CONFIG_DIR = previousConfig; });
  const profiles = createProfileStore(f.config);
  const saved: Array<{ provider: ProfileProvider; profile: TaskProfile; launch: Awaited<ReturnType<typeof saveLaunch>> }> = [];
  for (const provider of ['claude', 'codex'] as const) {
    const profile: TaskProfile = { name: `archived-${provider}`, provider, model: provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol', effort: 'low' };
    await profiles.create(profile);
    await profiles.setDefault(profile.name);
    const launch = await saveLaunch(f, profile);
    launch.record.subagents = provider === 'claude' ? 'auto' : 'off';
    await atomicJson(path.join(launch.directory, 'launch.json'), launch.record);
    await profiles.edit(profile.name, { effort: 'high' });
    await profiles.setDefault('opus-medium');
    await profiles.delete(profile.name);
    saved.push({ provider, profile, launch });
  }
  await captureNativeSession({ hook_event_name: 'SessionStart', session_id: 'claude-session' }, f.state, saved[0]!.launch.record.launchId, 'claude');
  // A valid snapshot must not even read the now-unusable current registry.
  await writeFile(path.join(f.config, 'profiles.json'), '{');
  for (const { provider, profile, launch } of saved) {
    const executable = path.join(f.root, `fake-${provider}.cjs`);
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(provider === 'claude' ? '2.1.319 (Claude Code)' : 'codex-cli 0.167.0')}); process.exit(0); }
fs.writeFileSync(${JSON.stringify(f.capture)}, JSON.stringify({ args, cwd: process.cwd() }));
process.exit(7);
`, { mode: 0o700 });
    assert.equal(await resumeNativeLaunch(launch.record.launchId, { stateDirectory: f.state, executable, hookEntrypoint: f.hookEntrypoint }), 7);
    const captured = JSON.parse(await readFile(f.capture, 'utf8')) as { args: string[]; cwd: string };
    assert.equal(captured.cwd, f.cwd);
    assert.equal(captured.args[captured.args.indexOf('--model') + 1], profile.model);
    if (provider === 'claude') {
      assert.deepEqual(captured.args.slice(-2), ['--resume', 'claude-session']);
      assert.equal(captured.args[captured.args.indexOf('--effort') + 1], 'low');
    } else {
      assert.equal(captured.args.at(-1), 'resume');
      assert.ok(captured.args.includes('model_reasoning_effort="low"'));
    }
    assert.ok(!captured.args.some(arg => /--last|bypass|permission-mode|ask-for-approval|sandbox/.test(arg)));
    const records = await Promise.all((await readdir(path.join(f.state, 'native'))).map(async id => JSON.parse(await readFile(path.join(f.state, 'native', id, 'launch.json'), 'utf8')) as LaunchRecord));
    const replay = records.find(record => record.launchId !== launch.record.launchId && record.profile === profile.name)!;
    assert.ok(replay);
    assert.deepEqual(replay.profileSnapshot, profile);
    assert.equal(replay.filterMode, 'observe');
    assert.equal(replay.subagents, launch.record.subagents);
    assert.equal(replay.cwd, f.cwd);
  }
  // Old records without a snapshot still use the explicitly saved profile name.
  await rm(path.join(f.config, 'profiles.json'));
  const legacy = await saveLaunch(f, { name: 'opus-high', model: 'claude-opus-5-5', effort: 'high' }, true);
  assert.equal(await readNativeSession(f.state, legacy.record.launchId), undefined);
  assert.equal(await resumeNativeLaunch(legacy.record.launchId, { stateDirectory: f.state, executable: path.join(f.root, 'fake-claude.cjs'), hookEntrypoint: f.hookEntrypoint }), 7);
  const legacyCapture = JSON.parse(await readFile(f.capture, 'utf8')) as { args: string[] };
  assert.equal(legacyCapture.args.at(-1), '--resume');
  assert.equal(legacyCapture.args[legacyCapture.args.indexOf('--effort') + 1], 'high');
  const ids = await readdir(path.join(f.state, 'native'));
  const records: LaunchRecord[] = await Promise.all(ids.map(async id => JSON.parse(await readFile(path.join(f.state, 'native', id, 'launch.json'), 'utf8'))));
  assert.equal(records.find(record => record.launchId !== legacy.record.launchId && record.profile === 'opus-high')?.subagents, 'off');
});
