import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { dispatch, type CliDependencies } from '../../src/cli/main.js';
import { hookFixture, phpunitOutput } from './fixture.js';

function io(overrides: Partial<CliDependencies> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); }, interactive: false, env: {}, ...overrides } };
}

test('hooks install --yes writes the plan, and a second install changes nothing', async t => {
  const f = await hookFixture(t, 'cli-yes');
  const settings = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(settings));
  await writeFile(settings, '{\n  "model": "opus"\n}\n');
  const first = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'install', '--agent', 'claude', '--agent', 'codex', '--yes'], first.deps), 0);
  const text = first.out.join('');
  assert.match(text, /Claude Code: .*settings\.json/);
  assert.match(text, /- {3}"model": "opus"\n\+ {3}"model": "opus",\n\+ {3}"hooks": \{/);
  assert.match(text, /Claude Code: installed\./);
  assert.match(text, /Codex: installed\./);
  assert.match(text, /run \/hooks to review and trust/);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).model, 'opus');
  assert.ok(JSON.parse(await readFile(path.join(f.home, '.codex', 'hooks.json'), 'utf8')).hooks.PostToolUse);

  const second = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'install', '--agent', 'claude', '--yes'], second.deps), 0);
  assert.match(second.out.join(''), /already runs this Fonn hook/);

  const status = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'status', '--json'], status.deps), 0);
  const statuses = JSON.parse(status.out.join(''));
  assert.deepEqual(statuses.map((item: { agent: string; installed: boolean }) => [item.agent, item.installed]), [['claude', true], ['codex', true], ['crush', false], ['opencode', false]]);

  const removal = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'uninstall', '--agent', 'claude', '--yes'], removal.deps), 0);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { model: 'opus' });
});

test('without a terminal and without --yes, install and uninstall refuse and write nothing', async t => {
  const f = await hookFixture(t, 'cli-refuse');
  for (const action of ['install', 'uninstall']) {
    const run = io({ hookOptions: f.options });
    assert.equal(await dispatch(['hooks', action, '--agent', 'claude'], run.deps), 1);
    assert.match(run.err.join(''), /Run it in a terminal to confirm each change, or pass --yes/);
  }
  await assert.rejects(readFile(path.join(f.home, '.claude', 'settings.json')), { code: 'ENOENT' });
});

test('on a terminal each agent is asked, and only a yes writes', async t => {
  const f = await hookFixture(t, 'cli-ask');
  const questions: string[] = [];
  const answers = ['n', 'y'];
  const run = io({ hookOptions: { ...f.options, which: async (name: string) => name === 'claude' || name === 'crush' }, interactive: true, ask: async (question: string) => { questions.push(question); return answers.shift()!; } });
  // No --agent: every detected agent.
  assert.equal(await dispatch(['hooks', 'install'], run.deps), 0);
  assert.deepEqual(questions, ['Install the Fonn hook for Claude Code? [y/N] ', 'Install the Fonn hook for Crush? [y/N] ']);
  assert.match(run.out.join(''), /Claude Code: skipped\. Nothing was written\./);
  await assert.rejects(readFile(path.join(f.home, '.claude', 'settings.json')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(f.home, '.config', 'crush', 'crushrc'), 'utf8'), /hook add PostToolUse --name fonn/);
});

test('install with no detected agent asks for --agent, and errors are reported per agent', async t => {
  const f = await hookFixture(t, 'cli-none');
  const none = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'install', '--yes'], none.deps), 1);
  assert.match(none.err.join(''), /No supported agent was found/);
  const bad = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'install', '--agent', 'gemini'], bad.deps), 1);
  assert.match(bad.err.join(''), /--agent must be one of/);
  const settings = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(settings));
  await writeFile(settings, 'not json');
  const broken = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks', 'install', '--agent', 'claude', '--agent', 'crush', '--yes'], broken.deps), 1);
  assert.match(broken.err.join(''), /Claude Code: .*not valid JSON/);
  assert.match(broken.out.join(''), /Crush: installed\./);
  assert.equal(await readFile(settings, 'utf8'), 'not json');
});

test('hooks status prints each agent and warns about a stale hook', async t => {
  const f = await hookFixture(t, 'cli-status');
  const settings = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(settings));
  await writeFile(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "'/gone/node' '/gone/packages/cli/dist/cli/main.js' hook --agent claude" }] }] } }));
  const run = io({ hookOptions: f.options });
  assert.equal(await dispatch(['hooks'], run.deps), 0);
  const text = run.out.join('');
  assert.match(text, /Claude Code +needs updating/);
  assert.match(text, /OpenCode +not installed, agent not found/);
  assert.match(run.err.join(''), /Warning: Claude Code: the Fonn hook runs a program that no longer exists/);
});

test('fonn hook replies for the agent and always exits 0', async t => {
  const f = await hookFixture(t, 'cli-hook');
  const cwd = path.join(f.root, 'project');
  await mkdir(cwd);
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'bash', session_id: 's', tool_use_id: 't', tool_response: phpunitOutput, cwd });
  const ok = io({ hookOptions: f.options, readStdin: async () => payload });
  assert.equal(await dispatch(['hook', '--agent', 'crush'], ok.deps), 0);
  assert.equal(typeof JSON.parse(ok.out.join('')).updated_output, 'string');
  for (const args of [['hook', '--agent', 'claude'], ['hook', '--agent', 'nobody'], ['hook']]) {
    const run = io({ hookOptions: f.options, readStdin: async () => '{broken' });
    assert.equal(await dispatch(args, run.deps), 0);
    assert.equal(run.out.join(''), '{}\n');
  }
  const failing = io({ hookOptions: f.options, readStdin: async () => { throw new Error('Hook input exceeds the 10 MB limit.'); } });
  assert.equal(await dispatch(['hook', '--agent', 'claude'], failing.deps), 0);
  assert.equal(failing.out.join(''), '{}\n');
});

test('help lists the hooks commands', async () => {
  const top = io();
  assert.equal(await dispatch(['--help'], top.deps), 0);
  assert.match(top.out.join(''), /fonn hooks \[status\|install\|uninstall\]/);
  assert.match(top.out.join(''), /fonn hook --agent <agent>/);
  const help = io();
  assert.equal(await dispatch(['help', 'hooks'], help.deps), 0);
  assert.match(help.out.join(''), /Codex runs the hook only after you review and trust it in \/hooks/);
  const flag = io();
  assert.equal(await dispatch(['hooks', '--help'], flag.deps), 0);
  assert.equal(flag.out.join(''), help.out.join(''));
});
