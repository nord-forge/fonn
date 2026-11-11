// These checks exercise storage and hook changes without opening a socket.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactStore } from '@nord-forge/fonn-core/filtering';
import { HOOK_AGENTS, HOOK_AGENT_LABELS, type HookPlan, type HookStatus } from '../../src/hooks/contract.js';
import { afterFingerprint, beforeFingerprint, deleteLaunch, fingerprint, getArtifact, getHookPlan, getHooks, getLaunch, getLaunches, postHookApply, type UiHooks } from '../../src/ui/api.js';

test('hook API re-plans before a write and safely reports both conflict windows', async () => {
  const directories = { configDirectory: '/synthetic/config', stateDirectory: '/synthetic/state' };
  const status: HookStatus = { agent: 'claude', label: 'Claude Code', configPath: '/synthetic/settings.json', detected: true, installed: false, current: false };
  let before: string | null = null;
  let writes = 0;
  let fail: Error | undefined;
  const hooks: UiHooks = {
    planIdentity: () => 'fixture-identity',
    redactForDisplay: (text) => text,
    async hookStatus(options) { assert.deepEqual(options, directories); return [status]; },
    async planHook(agent, action, options): Promise<HookPlan> {
      assert.deepEqual(options, directories);
      return { agent, action, configPath: status.configPath, changes: true, before, after: 'new settings', summary: ['Synthetic change.'], files: [] };
    },
    async applyHookPlan(plan, options) {
      assert.deepEqual(options, directories);
      if (fail) throw fail;
      assert.equal(plan.before, before);
      writes++;
      return { ...status, installed: true, current: true };
    },
  };
  assert.deepEqual(await getHooks(directories, hooks), [status]);
  const afterHash = afterFingerprint({ after: 'new settings', files: [] });
  const plan = await getHookPlan(directories, hooks, 'claude', 'install');
  assert.equal(plan.before, null);
  assert.equal(plan.beforeHash, beforeFingerprint({ before: null }, 'fixture-identity'));
  before = 'edited';
  await assert.rejects(postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: plan.beforeHash, afterHash: plan.afterHash }), { status: 409 });
  assert.equal(writes, 0);
  class HookConflictError extends Error {}
  fail = new HookConflictError('private contents');
  await assert.rejects(postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: beforeFingerprint({ before }, 'fixture-identity'), afterHash }), { status: 409, message: 'The file changed. Review the new version.' });
  fail = new SyntaxError('private contents');
  await assert.rejects(postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: beforeFingerprint({ before }, 'fixture-identity'), afterHash }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 400);
    assert.doesNotMatch((error as Error).message, /private contents/);
    return true;
  });
  fail = undefined;
  assert.equal((await postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: beforeFingerprint({ before }, 'fixture-identity'), afterHash })).installed, true);
  assert.equal(writes, 1);
  assert.throws(() => getHookPlan(directories, hooks, 'other', 'install'), { status: 404 });
  assert.throws(() => getHookPlan(directories, hooks, 'claude', 'other'), { status: 400 });
  await assert.rejects(postHookApply(directories, hooks, 'claude', { action: 'install' }), { status: 400 });
  await assert.rejects(postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: 'x'.repeat(64) }), { status: 400 });
  // A fingerprint stays small however large the config file is.
  before = 'x'.repeat(200_000);
  assert.equal(beforeFingerprint({ before }, 'fixture-identity').length, 64);
});

test('hook session storage supports every provider, recovery and deletion without trusting links or invalid records', async (t) => {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-ui-hooks-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directories = { configDirectory: path.join(base, 'config'), stateDirectory: path.join(base, 'state') };
  const native = path.join(directories.stateDirectory, 'native');
  const cwd = path.join(base, 'project');
  await mkdir(path.join(cwd, '.git'), { recursive: true });
  const records = HOOK_AGENTS.map((provider) => ({
    schemaVersion: 1, origin: 'hook', provider, agentSessionId: `synthetic-${provider}`, launchId: randomUUID(),
    cwd, filterMode: 'filter', filterLevel: 'standard', createdAt: '2026-02-01T00:00:00.000Z',
  }));
  for (const record of records) {
    const folder = path.join(native, record.launchId);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'launch.json'), JSON.stringify(record));
  }
  const badId = randomUUID();
  const linkedId = randomUUID();
  await mkdir(path.join(native, badId));
  await writeFile(path.join(native, badId, 'launch.json'), JSON.stringify({ ...records[0], launchId: badId, provider: 'unknown' }));
  await symlink(path.join(native, records[0]!.launchId), path.join(native, linkedId));
  const listing = await getLaunches(directories, null);
  assert.equal(listing.launches.length, 4);
  for (const record of records) {
    const detail = await getLaunch(directories, record.launchId);
    assert.equal(detail.launch.origin, 'hook');
    assert.equal(detail.launch.provider, record.provider);
    assert.equal(detail.launch.providerLabel, HOOK_AGENT_LABELS[record.provider]);
    assert.equal(detail.launch.profile, null);
  }
  await assert.rejects(getLaunch(directories, badId), { status: 404 });
  await assert.rejects(getLaunch(directories, linkedId), { status: 404 });
  const id = records[0]!.launchId;
  const artifact = await createArtifactStore(path.join(native, id, 'artifacts')).save({ toolName: 'Bash', sessionId: 'synthetic', toolUseId: 'synthetic', response: { stdout: 'recover me' } });
  const slice = await getArtifact(directories, id, artifact.id, 0, 100);
  assert.match(slice.text, /recover me/);
  await assert.rejects(getArtifact(directories, id, artifact.id, 0, 20_001), { status: 400 });
  // A hook session never records a finish; deleting it needs no running confirmation.
  assert.deepEqual(await deleteLaunch(directories, id), { deleted: id });
  assert.equal((await getLaunches(directories, null)).launches.length, 3);
});

test('records cleanup counts first and deletes only on confirm', async (t) => {
  const { postRecordsCleanup } = await import('../../src/ui/api.js');
  const { utimes } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-ui-cleanup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directories = { configDirectory: path.join(base, 'config'), stateDirectory: path.join(base, 'state') };
  const folder = path.join(directories.stateDirectory, 'native', randomUUID());
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'launch.json'), JSON.stringify({ origin: 'hook' }));
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await utimes(path.join(folder, 'launch.json'), old, old);
  await utimes(folder, old, old);
  const counted = await postRecordsCleanup(directories, { olderThanDays: 30, confirm: false });
  assert.deepEqual([counted.records, counted.hookSessions, counted.deleted], [1, 1, 0]);
  const done = await postRecordsCleanup(directories, { olderThanDays: 30, confirm: true });
  assert.equal(done.deleted, 1);
  await assert.rejects(postRecordsCleanup(directories, { olderThanDays: 0, confirm: true }), { status: 400 });
  await assert.rejects(postRecordsCleanup(directories, { olderThanDays: 30 }), { status: 400 });
});

test('apply refuses when the file is a different one, even with the same contents', async () => {
  const directories = { configDirectory: '/synthetic/config', stateDirectory: '/synthetic/state' };
  const status: HookStatus = { agent: 'claude', label: 'Claude Code', configPath: '/synthetic/settings.json', detected: true, installed: false, current: false };
  let identity = 'link to settings-a.json';
  let writes = 0;
  const hooks: UiHooks = {
    planIdentity: () => identity,
    redactForDisplay: (text) => text.replace(/sk-[a-z0-9]+/g, '[hidden]'),
    async hookStatus() { return [status]; },
    async planHook(agent, action): Promise<HookPlan> {
      return { agent, action, configPath: status.configPath, changes: true, before: '{"env":{"KEY":"sk-secret"}}', after: '{"hooks":[]}', summary: ['Synthetic change.'], files: [] };
    },
    async applyHookPlan() { writes++; return { ...status, installed: true, current: true }; },
  };
  const plan = await getHookPlan(directories, hooks, 'claude', 'install');
  assert.doesNotMatch(plan.before ?? '', /sk-secret/, 'the browser only sees redacted contents');
  identity = 'link to settings-b.json';
  await assert.rejects(postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: plan.beforeHash, afterHash: plan.afterHash }), { status: 409 });
  assert.equal(writes, 0);
  identity = 'link to settings-a.json';
  assert.equal((await postHookApply(directories, hooks, 'claude', { action: 'install', beforeHash: plan.beforeHash, afterHash: plan.afterHash })).installed, true);
});
