import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyHookPlan, HookConfigError, HookConflictError, hookStatus, hookWarnings, planHook } from '../../src/hooks/index.js';
import { baseCommand } from '../../src/hooks/command.js';
import { compactDiff } from '../../src/hooks/diff.js';
import { opencodePlugin } from '../../src/hooks/opencode.js';
import { hookFixture } from './fixture.js';

const claudeSettings = {
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard' }] }],
    PostToolUse: [
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '/usr/local/bin/lint' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit', timeout: 9 }] },
    ],
  },
  model: 'opus',
};

async function status(options: Parameters<typeof hookStatus>[0], agent: string) {
  return (await hookStatus(options)).find(item => item.agent === agent)!;
}

test('Claude install merges one entry, keeps other hooks and settings, and is idempotent', async t => {
  const f = await hookFixture(t, 'claude');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  const original = JSON.stringify(claudeSettings, null, 2) + '\n';
  await writeFile(file, original);

  const plan = await planHook('claude', 'install', f.options);
  assert.equal(plan.changes, true);
  assert.equal(plan.before, original);
  assert.match(plan.summary.join(' '), /Other hooks and settings stay/);
  const after = JSON.parse(plan.after!);
  assert.deepEqual(after.permissions, claudeSettings.permissions);
  assert.deepEqual(after.hooks.PreToolUse, claudeSettings.hooks.PreToolUse);
  assert.deepEqual(after.hooks.PostToolUse.slice(0, 2), claudeSettings.hooks.PostToolUse);
  assert.deepEqual(after.hooks.PostToolUse[2], { matcher: 'Bash', hooks: [{ type: 'command', command: `'${f.node}' '${f.main}' 'hook' '--agent' 'claude'`, timeout: 5 }] });
  assert.equal(after.model, 'opus');
  assert.ok(compactDiff(plan.before, plan.after).includes('+ '));

  const installed = await applyHookPlan(plan, f.options);
  assert.equal(installed.installed, true);
  assert.equal(installed.current, true);
  assert.equal(await readFile(`${file}.fonn-backup`, 'utf8'), original);

  const again = await planHook('claude', 'install', f.options);
  assert.equal(again.changes, false);
  assert.equal(again.after, again.before);
  await applyHookPlan(again, f.options);
  assert.equal(await readFile(file, 'utf8'), plan.after);

  const removal = await planHook('claude', 'uninstall', f.options);
  await applyHookPlan(removal, f.options);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), claudeSettings);
  // The backup is the first original, and only one is kept.
  assert.equal(await readFile(`${file}.fonn-backup`, 'utf8'), original);
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['settings.json', 'settings.json.fonn-backup']);
  assert.equal((await status(f.options, 'claude')).installed, false);
});

test('a new config file is created private, and uninstall leaves no empty hooks behind', async t => {
  const f = await hookFixture(t, 'new');
  const plan = await planHook('claude', 'install', f.options);
  assert.equal(plan.before, null);
  await applyHookPlan(plan, f.options);
  const file = path.join(f.home, '.claude', 'settings.json');
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await applyHookPlan(await planHook('claude', 'uninstall', f.options), f.options);
  assert.equal(await readFile(file, 'utf8'), '{}\n');
});

test('status tells a current hook from a stale and a broken one, and install repairs it in place', async t => {
  const f = await hookFixture(t, 'stale');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  const other = path.join(f.root, 'other', 'packages', 'cli', 'dist', 'cli', 'main.js');
  await mkdir(path.dirname(other), { recursive: true });
  await writeFile(other, '// another Fonn\n');
  await writeFile(path.join(f.root, 'other', 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@nord-forge/fonn-cli' }));
  const stale = { ...claudeSettings, hooks: { ...claudeSettings.hooks, PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: `'${f.node}' '${other}' hook --agent claude`, timeout: 5 }, { type: 'command', command: '/usr/local/bin/audit' }] },
    ...claudeSettings.hooks.PostToolUse,
  ] } };
  await writeFile(file, JSON.stringify(stale, null, 2) + '\n');
  let current = await status(f.options, 'claude');
  assert.equal(current.installed, true);
  assert.equal(current.current, false);
  assert.match(current.note!, /another Fonn installation/);
  assert.deepEqual(await hookWarnings(f.options), ['Claude Code: the Fonn hook points at another Fonn installation. Run fonn hooks install --agent claude.']);

  await writeFile(file, JSON.stringify(stale, null, 2).replace(other, path.join(f.root, 'gone', 'packages', 'cli', 'dist', 'cli', 'main.js')) + '\n');
  current = await status(f.options, 'claude');
  assert.equal(current.current, false);
  assert.match(current.note!, /no longer exists/);
  assert.match((await hookWarnings(f.options))[0]!, /no longer exists/);

  const plan = await planHook('claude', 'install', f.options);
  assert.match(plan.summary[0]!, /Update the Fonn hook/);
  const after = JSON.parse(plan.after!);
  // Updated where it was, next to the other hook in the same group.
  assert.equal(after.hooks.PostToolUse.length, 3);
  assert.equal(after.hooks.PostToolUse[0].hooks[0].command, `'${f.node}' '${f.main}' 'hook' '--agent' 'claude'`);
  assert.equal(after.hooks.PostToolUse[0].hooks[1].command, '/usr/local/bin/audit');
  await applyHookPlan(plan, f.options);
  assert.equal((await status(f.options, 'claude')).current, true);
  assert.deepEqual(await hookWarnings(f.options), []);
});

test('an invalid config is refused and left untouched', async t => {
  const f = await hookFixture(t, 'invalid');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  await writeFile(file, '{ "hooks": [ }');
  await assert.rejects(planHook('claude', 'install', f.options), HookConfigError);
  const current = await status(f.options, 'claude');
  assert.match(current.error!, /not valid JSON/);
  await writeFile(file, '{"hooks": {"PostToolUse": {"matcher": "Bash"}}}');
  await assert.rejects(planHook('claude', 'install', f.options), /must be a list/);
  assert.equal(await readFile(file, 'utf8'), '{"hooks": {"PostToolUse": {"matcher": "Bash"}}}');
  await assert.rejects(readFile(`${file}.fonn-backup`), { code: 'ENOENT' });
});

test('applyHookPlan refuses a file that changed after the plan, and a plan for another file', async t => {
  const f = await hookFixture(t, 'conflict');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  await writeFile(file, '{}\n');
  const plan = await planHook('claude', 'install', f.options);
  await writeFile(file, '{"model": "sonnet"}\n');
  await assert.rejects(applyHookPlan(plan, f.options), HookConflictError);
  assert.equal(await readFile(file, 'utf8'), '{"model": "sonnet"}\n');
  await assert.rejects(applyHookPlan({ ...plan, before: '{"model": "sonnet"}\n', configPath: path.join(f.root, 'elsewhere.json') }, f.options), /different file/);
});

test('a symlinked settings file is written through, keeping the link', async t => {
  const f = await hookFixture(t, 'symlink');
  const dotfiles = path.join(f.root, 'dotfiles', 'claude-settings.json');
  await mkdir(path.dirname(dotfiles), { recursive: true });
  await writeFile(dotfiles, '{\n\t"model": "opus"\n}\n');
  await mkdir(path.join(f.home, '.claude'));
  const file = path.join(f.home, '.claude', 'settings.json');
  await symlink(dotfiles, file);
  await applyHookPlan(await planHook('claude', 'install', f.options), f.options);
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  const text = await readFile(dotfiles, 'utf8');
  assert.match(text, /^\{\n\t"model": "opus",\n\t"hooks"/);
  assert.equal(await readFile(`${dotfiles}.fonn-backup`, 'utf8'), '{\n\t"model": "opus"\n}\n');
});

test('Codex install writes hooks.json in its home, keeps other hooks, and reminds about trust', async t => {
  const f = await hookFixture(t, 'codex');
  const folder = path.join(f.home, '.codex');
  await mkdir(folder);
  const original = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/bin/hello' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/audit' }] }] } };
  await writeFile(path.join(folder, 'hooks.json'), JSON.stringify(original, null, 2) + '\n');
  await writeFile(path.join(folder, 'config.toml'), 'model = "gpt-6.1-sol"\n');
  const plan = await planHook('codex', 'install', f.options);
  assert.equal(plan.configPath, path.join(folder, 'hooks.json'));
  assert.match(plan.summary.join(' '), /trust it in \/hooks/);
  const after = JSON.parse(plan.after!);
  assert.deepEqual(after.hooks.SessionStart, original.hooks.SessionStart);
  assert.equal(after.hooks.PostToolUse.length, 2);
  assert.equal(after.hooks.PostToolUse[1].hooks[0].command, `'${f.node}' '${f.main}' 'hook' '--agent' 'codex'`);
  const installed = await applyHookPlan(plan, f.options);
  assert.equal(installed.current, true);
  assert.match(installed.note!, /\/hooks/);
  assert.equal(await readFile(path.join(folder, 'config.toml'), 'utf8'), 'model = "gpt-6.1-sol"\n');
  // A Fonn hook in config.toml is reported, never edited.
  await writeFile(path.join(folder, 'config.toml'), `[[hooks.PostToolUse]]\nmatcher = "Bash"\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = "fonn hook --agent codex"\n`);
  assert.match((await status(f.options, 'codex')).note!, /config.toml also has a Fonn hook/);
  await applyHookPlan(await planHook('codex', 'uninstall', f.options), f.options);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'hooks.json'), 'utf8')), original);
});

test('Crush install appends one line to crushrc and uninstall restores it exactly', async t => {
  const f = await hookFixture(t, 'crush');
  const file = path.join(f.home, '.config', 'crush', 'crushrc');
  await mkdir(path.dirname(file), { recursive: true });
  const original = `provider add ollama --name Ollama --type ollama --base-url "http://localhost:11434/v1/"\n\nhook add PreToolUse \\\n  --matcher '^bash$' \\\n  --command "/home/you/no-rm.sh"\n`;
  await writeFile(file, original);
  const plan = await planHook('crush', 'install', f.options);
  assert.ok(plan.after!.startsWith(original));
  assert.match(plan.after!, /\nhook add PostToolUse --name fonn --matcher '\^bash\$' --command "'.*' 'hook' '--agent' 'crush'" --timeout 5\n$/);
  await applyHookPlan(plan, f.options);
  assert.equal((await status(f.options, 'crush')).current, true);
  assert.equal((await planHook('crush', 'install', f.options)).changes, false);
  assert.equal(await readFile(`${file}.fonn-backup`, 'utf8'), original);
  await applyHookPlan(await planHook('crush', 'uninstall', f.options), f.options);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('Crush refuses an invalid crushrc and quotes paths for Bash', async t => {
  const f = await hookFixture(t, 'crush bad');
  const file = path.join(f.home, '.config', 'crush', 'crushrc');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'hook add PreToolUse --command "unterminated\n');
  await assert.rejects(planHook('crush', 'install', f.options), /not a valid crushrc/);
  assert.equal(await readFile(file, 'utf8'), 'hook add PreToolUse --command "unterminated\n');
  await writeFile(file, '');
  const odd = { ...f.options, command: ['/opt/odd $HOME "dir"/node', '/opt/it\'s/packages/cli/dist/cli/main.js'] };
  const plan = await planHook('crush', 'install', odd);
  // Bash reads the line back to exactly the words of the command.
  const script = `hook() { while [ $# -gt 0 ]; do if [ "$1" = --command ]; then eval "set -- $2"; printf '%s\\n' "$@"; return; fi; shift; done; }\n${plan.after}`;
  const words = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(words.stdout, [...odd.command, 'hook', '--agent', 'crush'].join('\n') + '\n');
});

test('OpenCode install writes Fonn\'s own plugin and refuses a file it did not write', async t => {
  const f = await hookFixture(t, 'opencode');
  const file = path.join(f.home, '.config', 'opencode', 'plugins', 'fonn-hook.js');
  const plan = await planHook('opencode', 'install', f.options);
  assert.equal(plan.configPath, file);
  assert.equal(plan.before, null);
  await applyHookPlan(plan, f.options);
  assert.equal((await status(f.options, 'opencode')).current, true);
  assert.equal((await planHook('opencode', 'install', f.options)).changes, false);
  const removal = await planHook('opencode', 'uninstall', f.options);
  assert.equal(removal.after, null);
  await applyHookPlan(removal, f.options);
  await assert.rejects(lstat(file), { code: 'ENOENT' });
  await writeFile(file, 'export const Mine = async () => ({});\n');
  await assert.rejects(planHook('opencode', 'install', f.options), /not written by Fonn/);
  assert.match((await status(f.options, 'opencode')).error!, /not written by Fonn/);
});

test('the OpenCode plugin passes bash output through the hook command and fails open', async t => {
  const f = await hookFixture(t, 'plugin');
  const script = path.join(f.root, 'fake-hook.mjs');
  await writeFile(script, `let input = '';\nprocess.stdin.on('data', c => { input += c; });\nprocess.stdin.on('end', () => { const event = JSON.parse(input); process.stdout.write(JSON.stringify({ updated_output: event.tool_name + ':' + event.session_id + ':' + event.tool_response.toUpperCase() })); });\n`);
  const write = async (name: string, argv: string[]) => {
    const file = path.join(f.root, name);
    await writeFile(file, opencodePlugin(argv));
    return (await import(pathToFileURL(file).href)) as { FonnHook: (context: { directory: string }) => Promise<Record<string, (input: unknown, output: { output: unknown }) => Promise<void>>> };
  };
  const plugin = await write('plugin-ok.mjs', [process.execPath, script, 'hook', '--agent', 'opencode']);
  const hooks = await plugin.FonnHook({ directory: f.root });
  const output = { output: 'hello' };
  await hooks['tool.execute.after']!({ tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'ls' } }, output);
  assert.equal(output.output, 'bash:s1:HELLO');
  const other = { output: 'hello' };
  await hooks['tool.execute.after']!({ tool: 'read', sessionID: 's1' }, other);
  assert.equal(other.output, 'hello');
  const broken = await (await write('plugin-broken.mjs', [path.join(f.root, 'missing-node')])).FonnHook({ directory: f.root });
  const kept = { output: 'hello' };
  await broken['tool.execute.after']!({ tool: 'bash', sessionID: 's1' }, kept);
  assert.equal(kept.output, 'hello');
});

test('detection uses PATH or the agent folder', async t => {
  const f = await hookFixture(t, 'detect');
  await mkdir(path.join(f.home, '.codex'));
  const statuses = await hookStatus({ ...f.options, which: async name => name === 'crush' });
  assert.deepEqual(statuses.filter(item => item.detected).map(item => item.agent), ['codex', 'crush']);
  assert.deepEqual(statuses.map(item => item.configPath), [
    path.join(f.home, '.claude', 'settings.json'), path.join(f.home, '.codex', 'hooks.json'),
    path.join(f.home, '.config', 'crush', 'crushrc'), path.join(f.home, '.config', 'opencode', 'plugins', 'fonn-hook.js'),
  ]);
});

test('a Homebrew install uses the stable bin link, never the versioned Caskroom path', async t => {
  const f = await hookFixture(t, 'brew');
  const prefix = path.join(f.root, 'homebrew');
  const version = path.join(prefix, 'Caskroom', 'fonn', '0.2.0');
  const main = path.join(version, 'fonn', 'packages', 'cli', 'dist', 'cli', 'main.js');
  const wrapper = path.join(version, '.homebrew-command-wrappers', 'fonn');
  await mkdir(path.dirname(main), { recursive: true });
  await mkdir(path.dirname(wrapper), { recursive: true });
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  await writeFile(main, '// cask build\n');
  await writeFile(wrapper, '#!/bin/sh\n', { mode: 0o755 });
  await symlink(wrapper, path.join(prefix, 'bin', 'fonn'));
  const options = { ...f.options, command: undefined, entrypoint: main, brewPrefixes: [prefix] };
  const base = await baseCommand(options);
  assert.deepEqual(base.argv, [path.join(await realpath(prefix), 'bin', 'fonn')]);
  const plan = await planHook('claude', 'install', options);
  assert.match(plan.after!, /"'[^']*\/bin\/fonn' 'hook' '--agent' 'claude'"/);
  assert.doesNotMatch(plan.after!, /Caskroom/);
});

test('a source checkout prefers a stable Node link and notes a versioned Node path', async t => {
  const f = await hookFixture(t, 'checkout');
  const prefix = path.join(f.root, 'homebrew');
  const cellarNode = path.join(prefix, 'Cellar', 'node', '24.1.0', 'bin', 'node');
  await mkdir(path.dirname(cellarNode), { recursive: true });
  await writeFile(cellarNode, '#!/bin/sh\n', { mode: 0o755 });
  await mkdir(path.join(prefix, 'opt'), { recursive: true });
  await symlink(path.join(prefix, 'Cellar', 'node', '24.1.0'), path.join(prefix, 'opt', 'node'));
  const options = { ...f.options, command: undefined, entrypoint: f.main, execPath: cellarNode, brewPrefixes: [prefix] };
  assert.deepEqual((await baseCommand(options)).argv, [path.join(prefix, 'opt', 'node', 'bin', 'node'), f.main]);

  const nvmNode = path.join(f.home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin', 'node');
  await mkdir(path.dirname(nvmNode), { recursive: true });
  await writeFile(nvmNode, '#!/bin/sh\n', { mode: 0o755 });
  const nvm = { ...options, execPath: nvmNode };
  const base = await baseCommand(nvm);
  assert.deepEqual(base.argv, [nvmNode, f.main]);
  assert.equal(base.versionedNode, true);
  await applyHookPlan(await planHook('claude', 'install', nvm), nvm);
  assert.match((await status(nvm, 'claude')).note!, /Node update/);
});

test('a script at the canonical path counts as Fonn\'s only with Fonn\'s package, or when it is gone', async t => {
  const f = await hookFixture(t, 'canonical');
  const { hookOwnership } = await import('../../src/hooks/command.js');
  const foreign = path.join(f.root, 'unrelated', 'packages', 'cli', 'dist', 'cli', 'main.js');
  await mkdir(path.dirname(foreign), { recursive: true });
  await writeFile(foreign, '// some other CLI\n');
  await writeFile(path.join(f.root, 'unrelated', 'packages', 'cli', 'package.json'), JSON.stringify({ name: 'unrelated-cli' }));
  assert.equal(hookOwnership(`'${f.node}' '${foreign}' hook --agent claude`, 'claude'), 'lookalike');
  assert.equal(hookOwnership(`'${f.node}' '${f.main}' hook --agent claude`, 'claude'), 'fonn');
  const gone = path.join(f.root, 'moved-away', 'packages', 'cli', 'dist', 'cli', 'main.js');
  assert.equal(hookOwnership(`'${f.node}' '${gone}' hook --agent claude`, 'claude'), 'fonn', 'a removed checkout is a stale Fonn hook uninstall can clean up');
});
