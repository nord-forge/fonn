import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findProjectRoot, readProjectSettings, resolveSettings, writeProjectSettings } from '../../src/settings.js';

test('project settings: discovery, precedence, validation and atomic writes', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fonn-settings-'));
  try {
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, '.git'));

    // Without settings files, the Git root is the project.
    assert.equal(await findProjectRoot(nested), root);
    const empty = await readProjectSettings(root);
    assert.equal(empty.shared.exists, false);
    assert.equal(empty.local.exists, false);

    await writeProjectSettings(root, 'shared', { profile: 'sonnet-medium', filterLevel: 'similar', filterMode: 'observe' });
    await writeProjectSettings(root, 'local', { filterLevel: 'strict' });
    assert.match(await readFile(join(root, '.fonn.json'), 'utf8'), /"profile": "sonnet-medium"/);

    const files = await readProjectSettings(await findProjectRoot(nested));
    const global = { profile: 'opus-medium', filterLevel: 'standard' as const };
    const resolved = resolveSettings({ files, global });
    assert.deepEqual(resolved.profile, { value: 'sonnet-medium', source: 'shared' });
    assert.deepEqual(resolved.filterLevel, { value: 'strict', source: 'local' });
    assert.deepEqual(resolved.filterMode, { value: 'observe', source: 'shared' });
    assert.deepEqual(resolved.subagents, { value: 'auto', source: 'default' });
    assert.deepEqual(resolveSettings({ flags: { filterLevel: 'standard' }, files, global }).filterLevel, { value: 'standard', source: 'flag' });
    assert.deepEqual(resolveSettings({ global }).profile, { value: 'opus-medium', source: 'global' });

    // Removing the last key removes the file.
    await writeProjectSettings(root, 'local', {});
    assert.equal((await readProjectSettings(root)).local.exists, false);

    // Unknown keys, wrong values, bad JSON and symlinks are rejected, never ignored.
    await writeFile(join(root, '.fonn.json'), JSON.stringify({ profile: 'opus-high', hookCommand: 'rm -rf /' }));
    await assert.rejects(readProjectSettings(root), /Invalid Fonn settings.*hookCommand|Invalid Fonn settings/);
    await writeFile(join(root, '.fonn.json'), JSON.stringify({ filterLevel: 'loose' }));
    await assert.rejects(readProjectSettings(root), /Invalid Fonn settings/);
    await writeFile(join(root, '.fonn.json'), '{ not json');
    await assert.rejects(readProjectSettings(root), /not valid JSON/);
    await rm(join(root, '.fonn.json'));
    await writeFile(join(root, 'elsewhere.json'), '{}');
    await symlink(join(root, 'elsewhere.json'), join(root, '.fonn.json'));
    await assert.rejects(readProjectSettings(root), /regular file without symlinks/);
    await assert.rejects(writeProjectSettings(root, 'shared', { filterMode: 'off' }), /non-regular settings file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
