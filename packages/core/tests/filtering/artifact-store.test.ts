import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactStore } from '../../src/filtering/index.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'fonn-filter-test-'));
  const root = join(directory, 'task');
  return { directory, root, store: createArtifactStore(root) };
}
const input = (response: unknown) => ({ toolName: 'Bash', sessionId: 'session', toolUseId: 'tool', response });

test('archives the full response as private atomic JSON, without observation metadata', async () => {
  const { root, store } = await setup();
  const response = { stdout: 'hello\nworld', stderr: 'warning', exitCode: 1, nested: { value: true } };
  const artifact = await store.save(input(response));
  assert.match(artifact.id, /^[a-f0-9-]{36}$/);
  assert.equal(artifact.characters, JSON.stringify(response, null, 2).length);
  assert.deepEqual(JSON.parse((await store.read(artifact.id)).text), response);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, `${artifact.id}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), [`${artifact.id}.json`]);
  assert.equal(await readFile(join(root, `${artifact.id}.json`), 'utf8'), JSON.stringify(response, null, 2));
});

test('bounded reads paginate serialized original and allow exact-end reads', async () => {
  const { store } = await setup();
  const response = { stdout: '😀'.repeat(15_000), stderr: 'kept' };
  const artifact = await store.save(input(response));
  const first = await store.read(artifact.id);
  assert.equal(first.text.length, 20_000);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 20_000);
  const second = await store.read(artifact.id, { offset: first.nextOffset!, limit: 20_000 });
  assert.equal(second.nextOffset, null);
  assert.equal(first.totalCharacters, artifact.characters);
  assert.equal(first.text + second.text, JSON.stringify(response, null, 2));
  assert.equal((await store.read(artifact.id, { offset: artifact.characters })).text, '');
  assert.equal((await store.read(artifact.id, { limit: 1 })).text.length, 1);
});

test('rejects invalid IDs, traversal, invalid bounds, and cross-task reads', async () => {
  const { store, directory } = await setup();
  const artifact = await store.save(input('test'));
  for (const id of ['../secret', `/tmp/${artifact.id}`, `${artifact.id}.json`, '', artifact.id.toUpperCase()]) {
    await assert.rejects(store.read(id), /Invalid artifact id/);
  }
  for (const options of [{ offset: -1 }, { offset: NaN }, { offset: 1.5 }, { offset: Infinity }, { limit: 0 }, { limit: -1 }, { limit: 20_001 }, { limit: 1.5 }, { limit: Infinity }]) {
    await assert.rejects(store.read(artifact.id, options), /Invalid artifact read bounds/);
  }
  await assert.rejects(store.read(artifact.id, { offset: artifact.characters + 1 }), /exceeds length/);
  await assert.rejects(createArtifactStore(join(directory, 'other-task')).read(artifact.id), /ENOENT/);
});

test('rejects symlink artifacts and root directories', async () => {
  const { store, directory, root } = await setup();
  const artifact = await store.save(input('test'));
  const external = join(directory, 'external');
  await writeFile(external, 'secret');
  const symlinkId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await symlink(external, join(root, `${symlinkId}.json`));
  await assert.rejects(store.read(symlinkId));
  const hardlinkId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await link(external, join(root, `${hardlinkId}.json`));
  await assert.rejects(store.read(hardlinkId), /Invalid artifact file/);
  const alias = join(directory, 'alias');
  await symlink(root, alias);
  await assert.rejects(createArtifactStore(alias).save(input('x')), /Invalid artifact directory/);
  await rename(root, join(directory, 'old-root'));
  await symlink(join(directory, 'old-root'), root);
  await assert.rejects(store.read(artifact.id), /Artifact directory changed/);
});

test('rejects empty roots rather than using the process working directory', () => {
  assert.throws(() => createArtifactStore(''), /Invalid artifact directory/);
  assert.throws(() => createArtifactStore('   '), /Invalid artifact directory/);
  assert.throws(() => createArtifactStore('bad\0root'), /Invalid artifact directory/);
});

test('serialization failures create no artifacts and existing root gets private permissions', async () => {
  const { store, root } = await setup();
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(store.save(input(cycle)));
  assert.deepEqual(await readdir(root), []);
  await store.save(input('okay'));
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
});
