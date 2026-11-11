import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyHookPlan, hookOwnership, hookStatus, planHook, planIdentity, redactForDisplay } from '../../src/hooks/index.js';
import { hookFixture } from './fixture.js';

test('planIdentity changes when a link is retargeted to a file with the same bytes', async t => {
  const f = await hookFixture(t, 'identity');
  const file = path.join(f.home, '.claude', 'settings.json');
  const a = path.join(f.root, 'dotfiles', 'a.json');
  const b = path.join(f.root, 'dotfiles', 'b.json');
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(a), { recursive: true });
  assert.equal(planIdentity(await planHook('claude', 'install', f.options)), 'missing');
  await writeFile(a, '{}\n');
  await writeFile(b, '{}\n');
  await symlink(a, file);
  const first = await planHook('claude', 'install', f.options);
  const same = await planHook('claude', 'install', f.options);
  assert.equal(planIdentity(first), planIdentity(same));
  await rm(file);
  await symlink(b, file);
  const second = await planHook('claude', 'install', f.options);
  assert.equal(first.before, second.before);
  assert.notEqual(planIdentity(first), planIdentity(second));
  assert.equal(planIdentity({ ...first }), 'unknown');
});

test('redaction masks credentials inside strings, every assignment and known token shapes', () => {
  const secrets = {
    header: 'curl -H "Authorization: Bearer abc123" https://example.test',
    apiKey: "curl -H 'X-Api-Key: def456' https://example.test",
    url: 'git clone https://user:pass789@example.test/repo.git',
    flag: 'tool --token ghi012 --verbose',
    assignment: 'export DEBUG=1 OPENAI_API_KEY=jkl345 && run',
  };
  const tokens = ['sk-ant-api03-abcdefgh', 'sk-proj-abcdefghijkl', 'ghp_abcdefghij1234567890', 'gho_abcdefghij1234567890', 'github_pat_abcdefghij_1234', 'xoxb-1234567-abcdef', 'AKIAABCDEFGHIJKLMNOP', 'AIzaSyAbcdefghijklmnopqrstu', 'glpat-abcdefghij12345'];
  const config = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [...Object.values(secrets), ...tokens.map(token => `echo ${token}`)].map(command => ({ type: 'command', command })) }] } });
  const shown = redactForDisplay(config, 'claude')!;
  for (const secret of ['abc123', 'def456', 'pass789', 'ghi012', 'jkl345', ...tokens]) assert.doesNotMatch(shown, new RegExp(secret), secret);
  assert.match(shown, /Authorization: Bearer \[hidden\]/);
  assert.match(shown, /X-Api-Key: \[hidden\]/);
  assert.match(shown, /https:\/\/user:\[hidden\]@example\.test/);
  assert.match(shown, /--token \[hidden\] --verbose/);
  assert.match(shown, /export DEBUG=1 OPENAI_API_KEY=\[hidden\] && run/);
  assert.match(shown, /"type": "command"/);
  const text = redactForDisplay('export DEBUG=1 OPENAI_API_KEY=jkl345\nhook add PostToolUse --command "curl -H \'Authorization: Bearer abc123\' https://u:pw1@h"\necho sk-proj-abcdefghijkl\n', 'crush')!;
  assert.doesNotMatch(text, /jkl345|abc123|pw1|sk-proj/);
  assert.match(text, /export DEBUG=1 OPENAI_API_KEY=\[hidden\]/);
});

test('ownership rejects command separators and scripts that are not Fonn\'s CLI', async t => {
  assert.equal(hookOwnership('fonn hook\n--agent claude', 'claude'), 'lookalike');
  assert.notEqual(hookOwnership('fonn hook \\\n--agent claude', 'claude'), 'fonn');
  for (const separator of [';', '&', '|']) assert.notEqual(hookOwnership(`fonn hook --agent claude ${separator} true`, 'claude'), 'fonn');
  assert.equal(hookOwnership('/usr/bin/node /x/packages/cli/dist/cli/main.js hook --agent claude', 'claude'), 'fonn');
  assert.equal(hookOwnership('/usr/bin/node /x/other/cli/main.js hook --agent claude', 'claude'), 'lookalike');
  assert.equal(hookOwnership('/usr/bin/node relative/packages/cli/dist/cli/main.js hook --agent claude', 'claude'), 'lookalike');
  const f = await hookFixture(t, 'manifest');
  const script = path.join(f.root, 'checkout', 'dist', 'cli', 'main.js');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, '');
  const command = `/usr/bin/node '${script}' hook --agent claude`;
  assert.equal(hookOwnership(command, 'claude'), 'lookalike');
  await writeFile(path.join(f.root, 'checkout', 'package.json'), '{"name": "something-else"}');
  assert.equal(hookOwnership(command, 'claude'), 'lookalike');
  await writeFile(path.join(f.root, 'checkout', 'package.json'), '{"name": "fonn"}');
  assert.equal(hookOwnership(command, 'claude'), 'fonn');
  await writeFile(path.join(f.root, 'checkout', 'package.json'), '{"name": "@nord-forge/fonn-cli"}');
  assert.equal(hookOwnership(command, 'claude'), 'fonn');
  await writeFile(path.join(f.root, 'checkout', 'package.json'), '{not json');
  assert.equal(hookOwnership(command, 'claude'), 'lookalike');
});

test('without Bash, every Crush change is refused', async t => {
  const f = await hookFixture(t, 'no-bash');
  const options = { ...f.options, bash: path.join(f.root, 'missing-bash') };
  const file = path.join(f.home, '.config', 'crush', 'crushrc');
  for (const action of ['install', 'uninstall'] as const) {
    await assert.rejects(planHook('crush', action, options), /Fonn needs Bash to check crushrc safely/);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'provider add ollama --name Ollama\n');
  await assert.rejects(planHook('crush', 'install', options), /Fonn needs Bash/);
  assert.match((await hookStatus(options)).find(item => item.agent === 'crush')!.error!, /Fonn needs Bash/);
  assert.equal(await readFile(file, 'utf8'), 'provider add ollama --name Ollama\n');
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(done => child.once('exit', done));
  return child.pid!;
}

test('a stale lock is replaced, and a live one is reported', async t => {
  const f = await hookFixture(t, 'stale-lock');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  const lock = path.join(path.dirname(file), '.settings.json.fonn-lock');

  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await assert.rejects(applyHookPlan(await planHook('claude', 'install', f.options), f.options), /Another Fonn change to .* is in progress/);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);

  // The owner is gone.
  await writeFile(lock, JSON.stringify({ pid: await deadPid(), createdAt: new Date().toISOString() }));
  await applyHookPlan(await planHook('claude', 'install', f.options), f.options);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });

  // Older than ten minutes, even though the owner is alive.
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  await applyHookPlan(await planHook('claude', 'uninstall', f.options), f.options);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });

  // An unreadable lock is judged by its age.
  await writeFile(lock, '');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(lock, old, old);
  await applyHookPlan(await planHook('claude', 'install', f.options), f.options);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
});
