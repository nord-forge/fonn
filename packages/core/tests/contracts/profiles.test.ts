import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createProfileStore, effortSchema, getDefaultConfigDirectory, getProfile, modelSchema, profileNameSchema, profiles, providerSchema, resolveProfile, resolveProfileForProvider, taskProfileSchema } from '../../src/profiles.js';

test('profile CRUD persists defaults, preserves aliases and returns frozen snapshots without creating on reads', async () => {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'fonn-profiles-'));
  try {
    const directory = join(temporary, 'config');
    const store = createProfileStore(directory);
    assert.equal((await store.get()).name, 'opus-medium');
    assert.deepEqual((await store.list()).profiles, Object.values(profiles));
    assert.equal((await store.list()).profiles.length, 6);
    assert.deepEqual(getProfile('opus-medium'), { name: 'opus-medium', model: 'claude-opus-5-5', effort: 'medium' });
    for (const family of ['fable', 'mythos']) {
      assert.deepEqual(getProfile(`claude:${family}-medium`), { name: `claude:${family}-medium`, model: `claude-${family}-5-2`, effort: 'medium' });
    }
    assert.deepEqual(getProfile('codex:sol-medium'), { name: 'codex:sol-medium', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
    assert.equal((await resolveProfileForProvider('claude', undefined, directory)).name, 'opus-medium');
    assert.equal((await resolveProfileForProvider('codex', undefined, directory)).name, 'codex:sol-medium');
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    assert.equal(getDefaultConfigDirectory({ FONN_CONFIG_DIR: './chosen' }), resolve('chosen'));
    assert.equal(getDefaultConfigDirectory({ XDG_CONFIG_HOME: temporary }), join(temporary, 'fonn'));
    assert.equal(getDefaultConfigDirectory({ XDG_CONFIG_HOME: 'relative' }), join(homedir(), '.config', 'fonn'));

    await chmod(temporary, 0o755);
    const created = await store.create({ name: 'quick-check', model: 'haiku', effort: 'low' });
    assert.equal(Object.isFrozen(created), true);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(temporary)).mode & 0o777, 0o755);
    assert.equal((await stat(join(directory, 'profiles.json'))).mode & 0o777, 0o600);
    await assert.rejects(store.create(created), /already exists/);
    assert.deepEqual(await store.edit('quick-check', { model: 'claude-custom_1.2', effort: 'max' }), { name: 'quick-check', model: 'claude-custom_1.2', effort: 'max' });
    await store.setDefault('quick-check');
    assert.equal((await createProfileStore(directory).get()).name, 'quick-check');
    const oldFormat = JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8'));
    assert.equal(oldFormat.schemaVersion, 1);
    assert.equal(Object.hasOwn(oldFormat.profiles[0], 'provider'), false);
    assert.equal((await resolveProfileForProvider('claude', undefined, directory)).name, 'quick-check');
    assert.equal((await resolveProfileForProvider('codex', undefined, directory)).name, 'codex:sol-medium');
    assert.equal((await resolveProfile(undefined, directory)).effort, 'max');
    assert.equal((await store.setDefaultProvider('claude')).name, 'quick-check');
    assert.equal((await store.setDefaultProvider('codex')).name, 'codex:sol-medium');
    assert.equal((await createProfileStore(directory).get()).provider, 'codex');
    assert.equal((await store.setDefaultProvider('claude')).name, 'opus-medium');
    await store.setDefault('quick-check');
    await assert.rejects(store.delete('quick-check'), /current default/);
    const snapshot = await store.list();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.profiles), true);
    assert.ok(snapshot.profiles.every(Object.isFrozen));
    const codexCreated = await store.create({ name: 'codex-review', provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
    assert.equal(Object.isFrozen(codexCreated), true);
    assert.deepEqual(await createProfileStore(directory).get('codex-review'), codexCreated);
    await store.setDefault('codex-review');
    assert.equal((await resolveProfile(undefined, directory)).provider, 'codex');
    assert.equal((await resolveProfileForProvider('codex', undefined, directory)).name, 'codex-review');
    assert.equal((await resolveProfileForProvider('claude', undefined, directory)).name, 'opus-medium');
    await assert.rejects(resolveProfileForProvider('claude', 'codex-review', directory), /belongs to codex/);
    await assert.rejects(resolveProfileForProvider('codex', 'quick-check', directory), /belongs to claude/);
    await assert.rejects(store.edit('quick-check', { model: 'gpt-6.1-sol' }), /provider/);
    await assert.rejects(store.edit('codex-review', { model: 'claude-opus-5-5' }), /provider/);
    assert.deepEqual(await store.edit('quick-check', { provider: 'codex', model: 'o3-mini' }), { name: 'quick-check', provider: 'codex', model: 'o3-mini', effort: 'max' });
    assert.deepEqual(await store.edit('quick-check', { provider: 'claude', model: 'haiku' }), { name: 'quick-check', provider: 'claude', model: 'haiku', effort: 'max' });
    await store.setDefault('codex:sol-medium');
    assert.deepEqual(await resolveProfile(undefined, directory), getProfile('codex:sol-medium'));
    assert.equal((await resolveProfileForProvider('claude', undefined, directory)).name, 'opus-medium');
    await store.setDefault('sonnet-medium');
    await store.delete('quick-check');
    await assert.rejects(store.get('quick-check'), /Unknown profile/);
    assert.equal((await createProfileStore(directory).get()).name, 'sonnet-medium');
    assert.equal(getProfile().name, 'opus-medium');
    assert.equal(Object.isFrozen(profiles), true);
    assert.throws(() => getProfile('quick-check'), /Unknown profile/);
    // This exact v1 custom name was valid before adding Codex built-ins.
    const legacy = { name: 'sol-medium', model: 'sonnet', effort: 'medium' };
    await writeFile(join(directory, 'profiles.json'), JSON.stringify({ schemaVersion: 1, defaultProfile: legacy.name, profiles: [legacy] }));
    assert.deepEqual(await store.get(), legacy);
    assert.equal((await store.get('opus-medium')).name, 'opus-medium');
    assert.equal((await resolveProfileForProvider('claude', undefined, directory)).name, legacy.name);
    assert.equal((await resolveProfileForProvider('codex', undefined, directory)).name, 'codex:sol-medium');
    assert.equal((await store.list()).profiles.filter(profile => profile.name === legacy.name).length, 1);
    await store.edit(legacy.name, { effort: 'high' });
    await store.setDefault('opus-medium');
    await store.delete(legacy.name);
    for (const name of ['fable-medium', 'mythos-medium']) {
      const custom = await store.create({ name, model: 'sonnet', effort: 'high' });
      await store.setDefault(name);
      assert.deepEqual(await createProfileStore(directory).get(), custom);
      assert.equal(getProfile(`claude:${name}`).model, `claude-${name.split('-')[0]}-5-2`);
      await store.setDefault('opus-medium');
      await store.delete(name);
    }
    for (const family of ['fable', 'mythos']) {
      const saved = await store.create({ name: `${family}-custom`, model: family, effort: 'high' });
      assert.equal(saved.model, `claude-${family}-5-2`);
      assert.deepEqual(await createProfileStore(directory).get(saved.name), saved);
      await store.delete(saved.name);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('invalid names, schema versions, duplicate or shadowed profiles and broken defaults fail closed', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-profiles-invalid-'));
  try {
    const store = createProfileStore(directory);
    const profile = { name: 'custom', model: 'opus', effort: 'xhigh' } as const;
    for (const name of ['constructor', 'prototype', '__proto__', 'default', 'UPPER', 'a/b', '', 'a'.repeat(49)]) {
      assert.equal(profileNameSchema.safeParse(name).success, false);
      assert.throws(() => getProfile(name), /Unknown profile/);
      await assert.rejects(store.create({ ...profile, name }));
    }
    for (const model of ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-Test_1.2', 'gpt-6.1-sol', 'gpt-custom_1.2', 'o1', 'o3-mini', 'o4-mini']) assert.equal(modelSchema.parse(model), model);
    for (const family of ['fable', 'mythos']) assert.equal(modelSchema.parse(family), `claude-${family}-5-2`);
    for (const model of ['', 'unknown', 'claude-', 'gpt-', 'o', 'o0', 'opus --unsafe', 'claude-a/b', `claude-${'a'.repeat(128)}`]) assert.equal(modelSchema.safeParse(model).success, false);
    for (const provider of ['claude', 'codex']) assert.equal(providerSchema.safeParse(provider).success, true);
    assert.equal(providerSchema.safeParse('other').success, false);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(effortSchema.safeParse(effort).success, true);
    assert.equal(taskProfileSchema.safeParse({ ...profile, extra: true }).success, false);
    assert.equal(taskProfileSchema.safeParse({ ...profile, provider: 'claude' }).success, true);
    for (const model of ['gpt-6.1-sol', 'o3-mini']) {
      assert.equal(taskProfileSchema.safeParse({ ...profile, model }).success, false);
      assert.equal(taskProfileSchema.safeParse({ ...profile, provider: 'claude', model }).success, false);
      assert.equal(taskProfileSchema.safeParse({ ...profile, provider: 'codex', model }).success, true);
    }
    for (const model of ['claude-opus-5-5', 'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'claude-fable-5-2', 'claude-mythos-5-2']) assert.equal(taskProfileSchema.safeParse({ ...profile, provider: 'codex', model }).success, false);
    for (const builtin of Object.values(profiles)) {
      await assert.rejects(store.create(builtin), /immutable/);
      await assert.rejects(store.edit(builtin.name, { effort: 'low' }), /immutable/);
      await assert.rejects(store.delete(builtin.name), /immutable/);
    }
    const valid = { schemaVersion: 1, defaultProfile: 'opus-medium', profiles: [profile] };
    const invalid: unknown[] = [
      { ...valid, schemaVersion: 2 },
      { ...valid, profiles: [profile, profile] },
      { ...valid, profiles: [getProfile()] },
      { ...valid, defaultProfile: 'missing' },
      { ...valid, extra: true },
      { ...valid, profiles: [{ ...profile, model: 'gpt-6.1-sol' }] },
      { ...valid, profiles: [{ ...profile, provider: 'codex' }] },
      { ...valid, profiles: Array.from({ length: 101 }, (_, index) => ({ ...profile, name: `custom-${index}` })) },
    ];
    const path = join(directory, 'profiles.json');
    for (const config of invalid) {
      const content = JSON.stringify(config);
      await writeFile(path, content);
      await assert.rejects(store.list(), /Invalid profile configuration.*Repair or remove/s);
      await assert.rejects(store.setDefault('opus-high'), /Invalid profile configuration/);
      assert.equal(await readFile(path, 'utf8'), content);
    }
    for (const content of ['{', '{"accidental-secret-value" invalid}', ' '.repeat(128 * 1024 + 1)]) {
      await writeFile(path, content);
      await assert.rejects(store.get(), (error: Error) => {
        assert.match(error.message, /Invalid profile configuration/);
        assert.doesNotMatch(error.message, /accidental-secret-value/);
        return true;
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('symlink paths and nonregular files are rejected; concurrent mutations cannot overwrite each other', async () => {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'fonn-profiles-boundaries-'));
  try {
    const directory = join(temporary, 'config');
    await mkdir(directory);
    const alias = join(temporary, 'alias');
    await symlink(directory, alias);
    await assert.rejects(createProfileStore(alias).get(), /without symlinks/);
    await assert.rejects(createProfileStore(join(alias, 'child')).create({ name: 'no-follow', model: 'opus', effort: 'medium' }), /without symlinks/);

    const target = join(temporary, 'target.json');
    const content = JSON.stringify({ schemaVersion: 1, defaultProfile: 'opus-medium', profiles: [] });
    await writeFile(target, content);
    const path = join(directory, 'profiles.json');
    const store = createProfileStore(directory);
    await symlink(target, path);
    await assert.rejects(store.list(), /regular file without symlinks/);
    await assert.rejects(store.setDefault('opus-high'), /regular file without symlinks/);
    assert.equal(await readFile(target, 'utf8'), content);
    await unlink(path);
    await mkdir(path);
    await assert.rejects(store.get(), /regular file/);
    await rm(path, { recursive: true });

    const lock = join(directory, '.profiles.lock');
    await symlink(target, lock);
    await assert.rejects(store.setDefault('opus-high'), /busy/);
    assert.equal((await lstat(lock)).isSymbolicLink(), true);
    assert.equal(await readFile(target, 'utf8'), content);
    await unlink(lock);
    const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.create({ name: `parallel-${index}`, model: 'sonnet', effort: 'medium' })));
    const succeeded = writes.flatMap((result, index) => result.status === 'fulfilled' ? [`parallel-${index}`] : []);
    assert.ok(succeeded.length > 0);
    for (const result of writes) if (result.status === 'rejected') assert.match(String(result.reason), /busy/);
    assert.deepEqual((await store.list()).profiles.filter((profile) => profile.name.startsWith('parallel-')).map((profile) => profile.name).sort(), succeeded.sort());
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
    await writeFile(lock, 'owner from an interrupted writer');
    await assert.rejects(store.setDefault('opus-high'), /busy/);
    assert.equal(await readFile(lock, 'utf8'), 'owner from an interrupted writer');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
