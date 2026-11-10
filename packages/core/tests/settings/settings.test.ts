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

test('project filter rules only apply once approved, and changes need approving again', async () => {
  const { createProfileStore } = await import('../../src/profiles.js');
  const { projectRulesFingerprint } = await import('../../src/settings.js');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fonn-rules-'));
  try {
    const project = join(root, 'project');
    await mkdir(join(project, '.git'), { recursive: true });
    const store = createProfileStore(join(root, 'config'));
    await store.setGlobalRules([{ name: 'mine', command: 'make', remove: ['noise'] }]);
    await writeProjectSettings(project, 'shared', { rules: [{ name: 'theirs', command: 'npm audit', remove: ['vulnerab'] }] });

    const resolve = async () => {
      const files = await readProjectSettings(project);
      const approved = await store.projectRulesApproved(project, projectRulesFingerprint(project, files));
      return { files, settings: resolveSettings({ files, global: await store.getGlobalSettings(), projectRulesApproved: approved }) };
    };

    // Unapproved: global rules apply, the project's are reported but skipped.
    let { files, settings } = await resolve();
    assert.deepEqual(settings.rules.map((rule) => rule.name), ['mine']);
    assert.deepEqual(settings.unapprovedRules.map((rule) => rule.name), ['theirs']);

    await store.approveProjectRules(project, projectRulesFingerprint(project, files)!);
    ({ files, settings } = await resolve());
    assert.deepEqual(settings.rules.map((rule) => rule.name), ['mine', 'theirs']);
    assert.equal(settings.unapprovedRules.length, 0);

    // Someone changes the committed rules: approval lapses.
    await writeProjectSettings(project, 'shared', { rules: [{ name: 'theirs', command: 'npm', remove: ['found'] }] });
    ({ settings } = await resolve());
    assert.deepEqual(settings.rules.map((rule) => rule.name), ['mine']);

    // A file that reads would refuse is never written.
    const big = Array.from({ length: 40 }, (_, i) => ({ name: `rule ${i}`, command: 'npm', remove: ['x'.repeat(120), 'y'.repeat(120), 'z'.repeat(120)] }));
    await assert.rejects(writeProjectSettings(project, 'shared', { rules: big }), /larger than 16 KiB/);
    await readProjectSettings(project);

    // A hand-edited global rule that breaks the rule limits is refused on read, before it reaches a launch.
    const configFile = join(root, 'config', 'profiles.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...config, rules: [{ name: 'empty', command: 'npm', remove: [''] }] }));
    await assert.rejects(store.getGlobalSettings());
    await writeFile(configFile, JSON.stringify(config));

    // A project without rules needs no approval.
    await writeProjectSettings(project, 'shared', {});
    assert.equal(projectRulesFingerprint(project, await readProjectSettings(project)), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
