import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { dispatch } from '../../src/cli/main.js';
import { applyHookPlan, HookConflictError, hookOwnership, hookStatus, planHook, redactForDisplay } from '../../src/hooks/index.js';
import { opencodePlugin } from '../../src/hooks/opencode.js';
import { hookFixture } from './fixture.js';

async function status(options: Parameters<typeof hookStatus>[0], agent: string) {
  return (await hookStatus(options)).find(item => item.agent === agent)!;
}

test('only a complete Fonn invocation counts as Fonn\'s hook', () => {
  assert.equal(hookOwnership('fonn hook --agent claude', 'claude'), 'fonn');
  assert.equal(hookOwnership("'/opt/homebrew/bin/fonn' 'hook' '--agent' 'claude'", 'claude'), 'fonn');
  assert.equal(hookOwnership('"/usr/local/bin/fonn" hook "--agent" claude', 'claude'), 'fonn');
  assert.equal(hookOwnership("'/usr/bin/node' '/src/fonn/packages/cli/dist/cli/main.js' hook --agent claude", 'claude'), 'fonn');
  assert.equal(hookOwnership('/usr/bin/logger hook --agent claude', 'claude'), 'lookalike');
  assert.equal(hookOwnership('fonn hook --agent claude --verbose', 'claude'), 'lookalike');
  assert.equal(hookOwnership('fonn hook --agent claude; rm -rf /tmp/x', 'claude'), 'lookalike');
  assert.equal(hookOwnership('/usr/bin/node /tmp/other.js hook --agent claude', 'claude'), 'lookalike');
  assert.equal(hookOwnership("fonn 'hook --agent' claude", 'claude'), 'lookalike');
  assert.equal(hookOwnership('fonn hook --agent codex', 'claude'), 'none');
  assert.equal(hookOwnership('/usr/local/bin/lint', 'claude'), 'none');
});

test('lookalike hooks are kept on install and uninstall and reported in status', async t => {
  const f = await hookFixture(t, 'lookalike');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  const lookalikes = ['/usr/bin/logger hook --agent claude', 'fonn hook --agent claude --verbose'];
  const original = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: lookalikes.map(command => ({ type: 'command', command })) }] } };
  await writeFile(file, JSON.stringify(original, null, 2) + '\n');
  assert.equal((await status(f.options, 'claude')).installed, false);
  assert.match((await status(f.options, 'claude')).note!, /looks like Fonn's but is not managed/);
  await applyHookPlan(await planHook('claude', 'install', f.options), f.options);
  const installed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(installed.hooks.PostToolUse[0], original.hooks.PostToolUse[0]);
  assert.equal(installed.hooks.PostToolUse.length, 2);
  assert.equal((await status(f.options, 'claude')).current, true);
  await applyHookPlan(await planHook('claude', 'uninstall', f.options), f.options);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);

  const crushrc = path.join(f.home, '.config', 'crush', 'crushrc');
  await mkdir(path.dirname(crushrc), { recursive: true });
  const crushOriginal = 'hook add PostToolUse --name log --command "/usr/bin/logger hook --agent crush"\n';
  await writeFile(crushrc, crushOriginal);
  assert.match((await status(f.options, 'crush')).note!, /not managed/);
  await applyHookPlan(await planHook('crush', 'install', f.options), f.options);
  await applyHookPlan(await planHook('crush', 'uninstall', f.options), f.options);
  assert.equal(await readFile(crushrc, 'utf8'), crushOriginal);
});

test('Crush refuses a Fonn command it did not write as its own line', async t => {
  const f = await hookFixture(t, 'crush-forms');
  const file = path.join(f.home, '.config', 'crush', 'crushrc');
  await mkdir(path.dirname(file), { recursive: true });
  await applyHookPlan(await planHook('crush', 'install', f.options), f.options);
  const installed = await readFile(file, 'utf8');
  const fonnLine = installed.split('\n')[1]!;
  const cases = {
    'shared line': `${fonnLine}; provider add ollama --name Ollama\n`,
    'inside if': `if [ -n "$HOME" ]; then\n${fonnLine}\nfi\n`,
    'heredoc': `cat > /dev/null <<'EOF'\n${fonnLine}\nEOF\n`,
    'continued line': `echo start \\\n${fonnLine}\n`,
    'other shape': `hook add PostToolUse --timeout 9 --command "'${f.node}' '${f.main}' hook --agent crush"\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    await writeFile(file, text);
    for (const action of ['install', 'uninstall'] as const) {
      await assert.rejects(planHook('crush', action, f.options), /Remove it by hand/, `${name} ${action}`);
    }
    assert.equal(await readFile(file, 'utf8'), text, name);
    assert.match((await status(f.options, 'crush')).error!, /Remove it by hand/);
  }
  // A Fonn line at the top level next to other statements is still Fonn's.
  await writeFile(file, `provider add ollama --name Ollama\n${installed}if true; then\n  :\nfi\n`);
  const removal = await planHook('crush', 'uninstall', f.options);
  assert.equal(removal.after, 'provider add ollama --name Ollama\nif true; then\n  :\nfi\n');
});

test('apply refuses an edit or a retargeted link made during the write', async t => {
  const f = await hookFixture(t, 'race');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  await writeFile(file, '{}\n');
  const plan = await planHook('claude', 'install', f.options);
  const edit = { ...f.options, beforeCommit: async () => { await writeFile(file, '{"model": "sonnet"}\n'); } };
  await assert.rejects(applyHookPlan(plan, edit), HookConflictError);
  assert.equal(await readFile(file, 'utf8'), '{"model": "sonnet"}\n');
  assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp') || name.includes('lock')), []);

  const a = path.join(f.root, 'dotfiles', 'a.json');
  const b = path.join(f.root, 'dotfiles', 'b.json');
  await mkdir(path.dirname(a), { recursive: true });
  await writeFile(a, '{}\n');
  await writeFile(b, '{}\n');
  await rm(file);
  await symlink(a, file);
  const linked = await planHook('claude', 'install', f.options);
  const retarget = { ...f.options, beforeCommit: async () => { await rm(file); await symlink(b, file); } };
  await assert.rejects(applyHookPlan(linked, retarget), HookConflictError);
  assert.equal(await readFile(a, 'utf8'), '{}\n');
  assert.equal(await readFile(b, 'utf8'), '{}\n');
  // Retargeted between plan and apply, with the same content behind it.
  const again = await planHook('claude', 'install', f.options);
  await rm(file);
  await symlink(a, file);
  await assert.rejects(applyHookPlan(again, f.options), HookConflictError);
  assert.equal(await readFile(b, 'utf8'), '{}\n');

  // Writers are serialised by a lock next to the file.
  const lock = path.join(path.dirname(file), '.settings.json.fonn-lock');
  await writeFile(lock, '');
  await assert.rejects(applyHookPlan(await planHook('claude', 'install', f.options), f.options), /in progress/);
  assert.equal((await lstat(lock)).isFile(), true);
});

test('displayed configs hide likely secrets, and the CLI diff never prints them', async t => {
  const json = '{"env":{"ANTHROPIC_API_KEY":"sk-ant-1","DEBUG":"1"},"apiKeyHelper":"/bin/key","model":"opus","hooks":{}}';
  const shown = redactForDisplay(json, 'claude')!;
  assert.doesNotMatch(shown, /sk-ant-1|\/bin\/key|"DEBUG": "1"/);
  assert.match(shown, /"ANTHROPIC_API_KEY": "\[hidden\]"/);
  assert.match(shown, /"model": "opus"/);
  const text = 'export OPENAI_API_KEY=sk-1\napi_key = "sk-2"\nprovider add x --api-key "sk-3" --base-url http://localhost\nPATH=/usr/bin\n';
  const masked = redactForDisplay(text, 'crush')!;
  assert.doesNotMatch(masked, /sk-1|sk-2|sk-3/);
  assert.match(masked, /export OPENAI_API_KEY=\[hidden\]/);
  assert.match(masked, /api_key = "\[hidden\]"/);
  assert.match(masked, /--api-key "\[hidden\]" --base-url http:\/\/localhost/);
  assert.match(masked, /PATH=\/usr\/bin/);
  assert.equal(redactForDisplay(null, 'opencode'), null);

  const f = await hookFixture(t, 'redact');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  await writeFile(file, json);
  const out: string[] = [];
  assert.equal(await dispatch(['hooks', 'install', '--agent', 'claude', '--yes'], { stdout: text => { out.push(text); }, stderr: () => undefined, interactive: false, env: {}, hookOptions: f.options }), 0);
  assert.doesNotMatch(out.join(''), /sk-ant-1|\/bin\/key/);
  // The file itself keeps the real values.
  assert.equal(JSON.parse(await readFile(file, 'utf8')).env.ANTHROPIC_API_KEY, 'sk-ant-1');
});

test('an OpenCode plugin link is never followed: install refuses it, uninstall removes only the link', async t => {
  const f = await hookFixture(t, 'opencode-link');
  const plugin = path.join(f.home, '.config', 'opencode', 'plugins', 'fonn-hook.js');
  const target = path.join(f.root, 'kept', 'fonn-hook.js');
  await mkdir(path.dirname(plugin), { recursive: true });
  await mkdir(path.dirname(target), { recursive: true });
  const content = opencodePlugin([...f.options.command!, 'hook', '--agent', 'opencode']);
  await writeFile(target, content);
  await symlink(target, plugin);
  await assert.rejects(planHook('opencode', 'install', f.options), /symbolic link/);
  const removal = await planHook('opencode', 'uninstall', f.options);
  assert.equal(removal.after, null);
  await applyHookPlan(removal, f.options);
  await assert.rejects(lstat(plugin), { code: 'ENOENT' });
  assert.equal(await readFile(target, 'utf8'), content);
  await applyHookPlan(await planHook('opencode', 'install', f.options), f.options);
  assert.equal((await lstat(plugin)).isFile(), true);
  assert.equal((await status(f.options, 'opencode')).current, true);
});
